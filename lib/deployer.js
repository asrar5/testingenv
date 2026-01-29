const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PortManager = require('./port-manager');
const NginxGenerator = require('./nginx-generator');
const Validator = require('./validator');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const BUILD_ROOT = process.env.BUILD_ROOT || path.join(__dirname, '../builds');
const BACKUP_ROOT = process.env.BACKUP_ROOT || path.join(BUILD_ROOT, '.backups');
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, '../uploads');
const DOCKER_MEMORY_LIMIT = process.env.DOCKER_MEMORY_LIMIT || '512m';
const DOCKER_CPU_LIMIT = process.env.DOCKER_CPU_LIMIT || '1';
const DOCKER_RESTART_POLICY = process.env.DOCKER_RESTART_POLICY || 'always';

class Deployer {
    static async deploy(appName, zipFilePath, owner) {
        const tempExtractPath = path.join(BUILD_ROOT, `.temp-${appName}-${Date.now()}`);
        const finalPath = path.join(BUILD_ROOT, appName);
        let allocatedPort = null;
        let backupPath = null;
        let previousPortMeta = null;

        try {
            // 1. Validate
            console.log(`[${appName}] Validating...`);
            Validator.validateAppName(appName);
            await Validator.validateZipAndCheckIndex(zipFilePath);

            // Capture current allocation so we can restore it on failure
            previousPortMeta = await PortManager.getAppMetadata(appName);

            // 2. Allocate Port (with owner, type and category)
            console.log(`[${appName}] Allocating port...`);
            allocatedPort = await PortManager.allocatePort(appName, { username: owner, type: 'zip', category: 'frontend' });
            console.log(`[${appName}] Using port ${allocatedPort}`);

            // 2b. Cleanup existing Docker container with same name if any
            try {
                await execAsync(`sudo docker rm -f ${appName}`);
            } catch (e) { }

            // 3. Extract to temp
            console.log(`[${appName}] Extracting ZIP file...`);
            await Validator.extractZip(zipFilePath, tempExtractPath);

            // 4. Backup existing if any
            if (fs.existsSync(finalPath)) {
                console.log(`[${appName}] Backing up existing...`);
                backupPath = path.join(BACKUP_ROOT, `${appName}-${Date.now()}`);
                fs.mkdirSync(BACKUP_ROOT, { recursive: true });
                fs.renameSync(finalPath, backupPath);
            }

            // 5. Move new build to final
            console.log(`[${appName}] Finalizing build files...`);
            fs.renameSync(tempExtractPath, finalPath);

            // Ensure Nginx can read the deployed files (common cause of 500 redirect cycles)
            try {
                await execAsync(`sudo chmod -R a+rX ${finalPath}`);
            } catch (e) {
                console.warn(`[${appName}] Warning: could not chmod build directory: ${e.message}`);
            }

            // Sanity check: ensure Nginx SPA config won't 500 due to missing index.html
            const deployedIndexPath = path.join(finalPath, 'index.html');
            if (!fs.existsSync(deployedIndexPath)) {
                throw new Error('Deployment invalid: index.html not found at build root after extraction');
            }

            // 6. Generate Nginx Configs
            console.log(`[${appName}] Generating Nginx config...`);
            await NginxGenerator.generateAppConfig(appName, allocatedPort);
            await NginxGenerator.updateGatewayConfig(appName, allocatedPort);

            // 7. Reload Nginx
            console.log(`[${appName}] Reloading Nginx...`);
            await NginxGenerator.reloadNginx();

            console.log(`[${appName}] Deployed successfully on port ${allocatedPort}`);

            // Clean up upload
            if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);

            // Log History
            const HistoryManager = require('./history-manager');
            await HistoryManager.log('upload', appName, owner, { port: allocatedPort });

            return {
                appName,
                port: allocatedPort,
                url: `/${appName}/` // Relative URL for the public gateway
            };

        } catch (error) {
            console.error(`[${appName}] Deployment failed:`, error);

            // ROLLBACK
            console.log(`[${appName}] Rolling back...`);

            // Restore file backup
            if (backupPath && fs.existsSync(backupPath)) {
                if (fs.existsSync(finalPath)) {
                    fs.rmSync(finalPath, { recursive: true, force: true });
                }
                fs.renameSync(backupPath, finalPath);
            } else if (!backupPath && fs.existsSync(finalPath)) {
                // If we created it fresh and failed, maybe we should remove it? 
                // If it didn't exist before, finalPath is the NEW one.
                // If we failed after step 5.
                // Check if it was a new deployment (no backupPath)
                fs.rmSync(finalPath, { recursive: true, force: true });
            }

            // Clean temp extract
            if (fs.existsSync(tempExtractPath)) {
                fs.rmSync(tempExtractPath, { recursive: true, force: true });
            }

            // Clean upload
            if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);

            // Nginx rollback?
            // If we generated configs, try to remove them
            await NginxGenerator.removeConfigs(appName);
            try { await NginxGenerator.reloadNginx(); } catch (e) { }

            // Restore previous port allocation (or release if this was a new allocation)
            try {
                if (previousPortMeta) {
                    await PortManager.setAppMetadata(appName, previousPortMeta);
                } else {
                    await PortManager.releasePort(appName);
                }
            } catch (e) {
                console.warn(`[${appName}] Failed to restore port allocation: ${e.message}`);
            }

            throw error;
        }
    }

    static async deployDocker(appName, imageName, owner, internalPort = 80, category = 'backend') {
        let allocatedPort = null;
        let previousPortMeta = null;
        const attemptedPorts = new Set();

        try {
            // 1. Validate App Name
            console.log(`[${appName}] Validating Docker deployment...`);
            Validator.validateAppName(appName);

            // Capture current allocation so we can restore it on failure
            previousPortMeta = await PortManager.getAppMetadata(appName);

            // 2. Allocate Port
            console.log(`[${appName}] Allocating port for container...`);
            allocatedPort = await PortManager.allocatePort(appName, { username: owner, type: 'docker', category: category });
            console.log(`[${appName}] Using port ${allocatedPort}`);

            // 3. Cleanup existing resources (Container and Nginx configs)
            console.log(`[${appName}] Cleaning up existing resources...`);
            try {
                // Remove container if it exists
                await execAsync(`sudo docker rm -f ${appName}`);
                console.log(`[${appName}] Removed existing container`);
            } catch (e) {
                console.log(`[${appName}] No existing container to remove`);
            }

            try {
                // Remove any Nginx configs (especially ZIP-style ones that bind to the port)
                await NginxGenerator.removeConfigs(appName);
                console.log(`[${appName}] Removed existing Nginx configs`);
            } catch (e) {
                console.log(`[${appName}] No existing Nginx configs to remove`);
            }

            // Also remove any OTHER stale build-* site configs that might still be listening on this port.
            // Docker needs the port free so it can bind the host port.
            await NginxGenerator.removeSiteConfigsListeningOnPort(allocatedPort);

            // 4. Pull and Run Docker Container
            const maxPortAttempts = 5;
            let started = false;

            for (let attempt = 1; attempt <= maxPortAttempts; attempt++) {
                attemptedPorts.add(allocatedPort);
                console.log(`[${appName}] Starting container (attempt ${attempt}/${maxPortAttempts}): ${imageName} on port ${allocatedPort}:${internalPort}...`);

                // Use -d for detached, --restart always for persistence, with resource limits
                const dockerCmd = `sudo docker run -d --name ${appName} -p ${allocatedPort}:${internalPort} --restart ${DOCKER_RESTART_POLICY} --memory ${DOCKER_MEMORY_LIMIT} --cpus ${DOCKER_CPU_LIMIT} ${imageName}`;

                try {
                    await execAsync(dockerCmd);
                    console.log(`[${appName}] Container started`);
                    started = true;
                    break;
                } catch (e) {
                    const details = `${e.stderr || ''} ${e.message || ''}`;
                    const isPortInUse = details.includes('address already in use') || details.includes('failed to bind host port') || details.includes('Bind for 0.0.0.0');

                    // Cleanup any partially-created container (name conflict on retry)
                    try { await execAsync(`sudo docker rm -f ${appName}`); } catch (cleanupErr) { }

                    if (!isPortInUse || attempt === maxPortAttempts) {
                        throw e;
                    }

                    console.warn(`[${appName}] Port ${allocatedPort} is busy; reallocating a new port and retrying...`);
                    allocatedPort = await PortManager.allocatePort(
                        appName,
                        { username: owner, type: 'docker', category: category },
                        { reuseExisting: false, excludePorts: Array.from(attemptedPorts) }
                    );
                }
            }

            if (!started) {
                throw new Error('Container failed to start after multiple port attempts');
            }

            // 5. Verify container is running (with retries)
            let isRunning = false;
            let retries = 5;
            while (retries > 0 && !isRunning) {
                try {
                    const { stdout } = await execAsync(`sudo docker inspect -f '{{.State.Running}}' ${appName}`);
                    isRunning = stdout.trim() === 'true';
                    if (isRunning) {
                        console.log(`[${appName}] Container verified as running`);
                        break;
                    }
                } catch (e) {
                    console.log(`[${appName}] Container check failed, retrying... (${retries} retries left)`);
                }
                retries--;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
            }

            if (!isRunning) {
                throw new Error('Container failed to start or stopped unexpectedly');
            }

            // 6. Update Gateway Config
            console.log(`[${appName}] Updating gateway config...`);
            await NginxGenerator.updateGatewayConfig(appName, allocatedPort);

            // 7. Reload Nginx
            console.log(`[${appName}] Reloading Nginx...`);
            await NginxGenerator.reloadNginx();

            // 8. Verify route is accessible
            console.log(`[${appName}] Verifying route accessibility...`);
            try {
                const { stdout } = await execAsync(`curl -s -o /dev/null -w "%{http_code}" http://localhost/${appName}/`);
                if (stdout === '200' || stdout === '301' || stdout === '302') {
                    console.log(`[${appName}] Route verified - HTTP ${stdout}`);
                } else {
                    console.warn(`[${appName}] Route returned HTTP ${stdout} - may need manual verification`);
                }
            } catch (e) {
                console.warn(`[${appName}] Could not verify route: ${e.message}`);
            }

            console.log(`[${appName}] Docker container deployed successfully on port ${allocatedPort}`);

            // Log History
            const HistoryManager = require('./history-manager');
            await HistoryManager.log('docker_deploy', appName, owner, { port: allocatedPort, image: imageName, category: category });

            return {
                appName,
                port: allocatedPort,
                url: `/${appName}/`
            };

        } catch (error) {
            console.error(`[${appName}] Docker deployment failed:`, error);

            // ROLLBACK
            console.log(`[${appName}] Rolling back...`);

            // Remove container if it was created
            if (allocatedPort) {
                try {
                    await execAsync(`sudo docker rm -f ${appName}`);
                    console.log(`[${appName}] Rolled back container`);
                } catch (e) {
                    console.error(`[${appName}] Failed to rollback container:`, e.message);
                }

                // Remove Nginx configs
                try {
                    await NginxGenerator.removeConfigs(appName);
                    console.log(`[${appName}] Rolled back Nginx configs`);
                } catch (e) {
                    console.error(`[${appName}] Failed to rollback Nginx configs:`, e.message);
                }
            }

            // Restore previous port allocation (or release if this was a new allocation)
            try {
                if (previousPortMeta) {
                    await PortManager.setAppMetadata(appName, previousPortMeta);
                } else {
                    await PortManager.releasePort(appName);
                }
            } catch (e) {
                console.warn(`[${appName}] Failed to restore port allocation: ${e.message}`);
            }

            throw error;
        }
    }

    static async loadAndDeployDocker(appName, tarPath, owner, internalPort = 80, category = 'backend') {
        try {
            console.log(`[${appName}] Loading Docker image from tar: ${tarPath}...`);

            // 1. Load the image
            const { stdout, stderr } = await execAsync(`sudo docker load -i ${tarPath}`);
            console.log(`[${appName}] Docker load output: ${stdout.trim()}`);
            if (stderr) console.log(`[${appName}] Docker load stderr: ${stderr.trim()}`);

            // 2. Extract image name from output (e.g., "Loaded image: myapp:latest")
            // Handle multiple lines and extract the last "Loaded image" line
            const lines = stdout.split('\n');
            let imageName = null;
            
            for (let i = lines.length - 1; i >= 0; i--) {
                const match = lines[i].match(/Loaded image:\s*(.+?)(?:\s|$)/);
                if (match && match[1]) {
                    imageName = match[1].trim();
                    break;
                }
            }
            
            if (!imageName) {
                throw new Error('Failed to extract image name from docker load output. Output: ' + stdout);
            }
            
            console.log(`[${appName}] Image name extracted: ${imageName}`);

            // 3. Verify image exists
            try {
                await execAsync(`sudo docker inspect ${imageName}`);
                console.log(`[${appName}] Image verified: ${imageName}`);
            } catch (e) {
                throw new Error(`Image ${imageName} failed verification: ${e.message}`);
            }

            // 4. Deploy the container using the loaded image
            const result = await this.deployDocker(appName, imageName, owner, internalPort, category);

            // 5. Clean up the uploaded tar file
            if (fs.existsSync(tarPath)) {
                fs.unlinkSync(tarPath);
                console.log(`[${appName}] Cleaned up tar file: ${tarPath}`);
            }

            return result;

        } catch (error) {
            console.error(`[${appName}] Docker load and deploy failed:`, error);
            if (fs.existsSync(tarPath)) {
                fs.unlinkSync(tarPath);
                console.log(`[${appName}] Cleaned up tar file after error: ${tarPath}`);
            }
            throw error;
        }
    }

    static async manageContainer(appName, action) {
        try {
            console.log(`[${appName}] Attempting to ${action} container...`);

            // Check if container exists and its status
            let isRunning = false;
            try {
                const { stdout } = await execAsync(`sudo docker inspect -f '{{.State.Running}}' ${appName}`);
                isRunning = stdout.trim() === 'true';
            } catch (e) {
                throw new Error(`Container ${appName} not found or inaccessible`);
            }

            if (action === 'stop') {
                if (!isRunning) {
                    console.log(`[${appName}] Container already stopped.`);
                    return { success: true, message: 'Already stopped' };
                }
                await execAsync(`sudo docker stop ${appName}`);
            } else if (action === 'start') {
                if (isRunning) {
                    console.log(`[${appName}] Container already running.`);
                    return { success: true, message: 'Already running' };
                }
                await execAsync(`sudo docker start ${appName}`);
            } else {
                throw new Error(`Invalid action: ${action}`);
            }

            console.log(`[${appName}] Container ${action}ed successfully.`);
            return { success: true };
        } catch (error) {
            console.error(`[${appName}] Failed to ${action} container:`, error);
            throw error;
        }
    }

    static async stopApp(appName) {
        return this.manageContainer(appName, 'stop');
    }

    static async startApp(appName) {
        return this.manageContainer(appName, 'start');
    }

    static async getContainerStatuses(appNames) {
        if (!appNames || appNames.length === 0) return {};
        try {
            // Get all running container names
            const { stdout } = await execAsync(`sudo docker ps --format '{{.Names}}'`);
            const runningNames = new Set(stdout.split('\n').map(n => n.trim()).filter(n => n));

            const statuses = {};
            for (const name of appNames) {
                statuses[name] = runningNames.has(name) ? 'running' : 'stopped';
            }
            return statuses;
        } catch (e) {
            console.warn('Failed to get docker statuses:', e.message);
            return {};
        }
    }
}

module.exports = Deployer;
