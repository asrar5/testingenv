const fs = require('fs');
const path = require('path');
require('dotenv').config();
const NginxGenerator = require('./lib/nginx-generator');
const PortManager = require('./lib/port-manager');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const SITES_AVAILABLE = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
const SITES_ENABLED = process.env.NGINX_SITES_ENABLED || '/etc/nginx/sites-enabled';
const GATEWAY_ROUTES = process.env.NGINX_GATEWAY_ROUTES || '/etc/nginx/gateway-routes';
const BUILD_ROOT = process.env.BUILD_ROOT || path.join(__dirname, 'builds');

const MIN_PORT = parseInt(process.env.MIN_PORT) || 3320;
const MAX_PORT = parseInt(process.env.MAX_PORT) || 3990;

async function reconcile() {
    console.log('Starting System Reconciliation (Nginx + Docker + Files)...');

    // PERMISSION FIX: Ensure Nginx (www-data) can traverse from Root -> Build Dir
    try {
        if (!fs.existsSync(BUILD_ROOT)) {
             fs.mkdirSync(BUILD_ROOT, { recursive: true });
        }
        
        let currentDir = BUILD_ROOT;
        const fsRoot = path.parse(BUILD_ROOT).root; // "/"
        
        // Walk up until we hit the filesystem root
        while (currentDir !== fsRoot) {
            try {
                // chmod o+x (others + execute) allows traversal
                await execAsync(`sudo chmod o+x "${currentDir}"`);
            } catch (e) { /* Ignore */ }
            currentDir = path.dirname(currentDir);
        }
        // Ensure the build root itself is accessible
        await execAsync(`sudo chmod 777 "${BUILD_ROOT}"`);
    } catch (e) {
        console.warn('Could not fix permissions on BUILD_ROOT:', e.message);
    }

    try {
        const apps = await PortManager.getAllAllocations();
        const appNames = Object.keys(apps);
        const desiredApps = new Set(appNames);

        // --- DOCKER SYNC START ---
        console.log('Syncing Docker containers...');
        try {
            // Get all containers with their ports and names
            // Format: ID|Names|Ports
            const { stdout: dockerOut } = await execAsync(`sudo docker ps -a --format "{{.ID}}|{{.Names}}|{{.Ports}}"`);
            const containers = dockerOut.split('\n').filter(Boolean).map(line => {
                const [id, name, ports] = line.split('|');
                return { id, name, ports };
            });

            // 1. Prune Zombie Containers (Running/Allocated but not in ports.json)
            for (const container of containers) {
                // Check if container binds to any port in our managed range
                // Ports format examples: "0.0.0.0:3326->80/tcp", "3326/tcp"
                const portMatch = container.ports.match(/:(\d+)->/);
                const boundPort = portMatch ? parseInt(portMatch[1]) : null;

                const isManagedPort = boundPort && boundPort >= MIN_PORT && boundPort <= MAX_PORT;
                
                // If it's using one of our ports OR it has a name of a deleted app (if we tracked that?)
                // Strategy: If it's using a Managed Port AND it is NOT in the desiredApps list -> KILL
                // Strategy 2: If the container Name is in desiredApps list?
                
                // Match by NAME is stronger.
                // If container.name exists in ports.json:
                if (desiredApps.has(container.name)) {
                    // Check if it's running. If stopped, try to start?
                    // We can check status if needed, but 'docker start' is idempotent-ish if running
                    // We won't auto-start here to avoid loops, but we leave it alone.
                } else {
                    // It is NOT in ports.json. 
                    // Should we delete it? Only if it conflicts with our ports?
                    // Or if we own the machine, we assume all containers are ours?
                    // Safer: Only delete if it holds a managed port.
                    
                    if (isManagedPort) {
                        console.log(`[Docker Prune] Found Zombie Container '${container.name}' holding managed port ${boundPort}. Removing...`);
                        try {
                            await execAsync(`sudo docker rm -f ${container.id}`);
                            console.log(`[Docker Prune] Removed ${container.name}`);
                        } catch (e) {
                            console.error(`[Docker Prune] Failed to remove ${container.name}:`, e.message);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Docker sync failed:', e.message);
        }
        // --- DOCKER SYNC END ---

        /* ... existing logic ... */
        if (appNames.length === 0) {
            // ... (keep logic) but careful about return, we want to run the rest
        }

        // Build desired port/type map from ports.json
        const desired = {};
        for (const appName of appNames) {
            const data = apps[appName];
            desired[appName] = (typeof data === 'object') ? data : { port: data, type: 'zip' };
        }

        // Pre-prune matches ports.json vs sites-available etc.
        // ... (Keep existing pre-prune logic loop) ...
        console.log('Pre-pruning mismatched Nginx site configs...');
        try {
            const { stdout } = await execAsync(`sudo ls -1 ${SITES_AVAILABLE} 2>/dev/null || true`);
            const files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
            const buildFiles = files.filter(f => f.startsWith('build-'));

            for (const file of buildFiles) {
                const appFromFile = file.replace(/^build-/, '');
                const meta = desired[appFromFile];

                // Orphaned -> remove
                if (!meta) {
                    console.log(`Removing orphaned site config: ${file}`);
                    await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${file} ${SITES_ENABLED}/${file}`);
                    continue;
                }

                // Docker apps must not have build-* site configs
                if (meta.type === 'docker') {
                    console.log(`Removing docker site config (should not exist): ${file}`);
                    await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${file} ${SITES_ENABLED}/${file}`);
                    continue;
                }
                
                // Port mismatch check
                const expectedPort = meta.port;
                try {
                    const { stdout: cfg } = await execAsync(`sudo cat ${SITES_AVAILABLE}/${file} 2>/dev/null || true`);
                    const m = cfg.match(/\blisten\s+(\d+)\s*;/);
                    const actualPort = m ? parseInt(m[1]) : NaN;
                    if (Number.isFinite(actualPort) && actualPort !== expectedPort) {
                        console.log(`Removing mismatched site config: ${file} (expected ${expectedPort}, got ${actualPort})`);
                        await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${file} ${SITES_ENABLED}/${file}`);
                    }
                } catch (e) {}
            }
        } catch (e) {
            console.warn('Pre-prune failed:', e.message);
        }

        // --- GATEWAY UPDATE LOOP ---
        for (const appName of appNames) {
            const data = apps[appName];
            const meta = (typeof data === 'object') ? data : { port: data, type: 'zip' };
            const port = meta.port;
            const type = meta.type || 'zip';

            if (type === 'docker') {
                // Ensure no static server exists for docker
                await NginxGenerator.removeConfigs(appName);
                // Ensure gateway config exists
                await NginxGenerator.updateGatewayConfig(appName, port);
                
                // --- Revive Docker if missing? ---
                // If the app is in ports.json, we expect it to be running.
                // We did a sweeping check earlier. Detailed check here:
                /*
                try {
                    // Check if running
                    await execAsync(`sudo docker inspect ${appName}`);
                } catch (e) {
                    console.warn(`[Sync] Docker app '${appName}' is in DB but not running. Manual redeploy may be required.`);
                }
                */
                continue;
            }

            // ZIP Checks
            const appBuildPath = path.join(BUILD_ROOT, appName);
            const indexFile = path.join(appBuildPath, 'index.html');
            
            if (!fs.existsSync(appBuildPath) || !fs.existsSync(indexFile)) {
                console.error(`[Reconcile] Corrupt state detected for ${appName}: Build directory or index.html missing.`);
                await NginxGenerator.removeConfigs(appName);
                try { await execAsync(`sudo rm -f ${GATEWAY_ROUTES}/${appName}.conf`); } catch (e) {}
                console.log(`[Reconcile] Removing ${appName} from database.`);
                await PortManager.releasePort(appName);
                continue;
            }

            // Ensure static config
            // We can optimize by checking if it already exists and is correct?
            // For now, regenerating is safe and ensures consistency.
            // console.log(`Ensuring static site + route for ${appName}...`);
            await NginxGenerator.generateAppConfig(appName, port);
            await NginxGenerator.updateGatewayConfig(appName, port);
        }

        console.log('Reloading Nginx...');
        await NginxGenerator.reloadNginx();

        // --- PRUNING LOGIC (FILES) ---
        console.log('Pruning orphaned directories...');
        if (fs.existsSync(BUILD_ROOT)) {
             const dirs = fs.readdirSync(BUILD_ROOT).filter(f => {
                const stat = fs.statSync(path.join(BUILD_ROOT, f));
                return stat.isDirectory() && !f.startsWith('.');
            });

            for (const dirName of dirs) {
                if (!appNames.includes(dirName)) {
                    console.log(`Pruning orphaned directory: ${dirName}`);
                    fs.rmSync(path.join(BUILD_ROOT, dirName), { recursive: true, force: true });
                }
            }
        }
        
        // Final Nginx Prune (Specific to Gateway Routes)
        // ... (Keep existing gateway prune) ...
        try {
            const { stdout } = await execAsync(`sudo ls -1 ${GATEWAY_ROUTES} 2>/dev/null || true`);
            const files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
            const routeFiles = files.filter(f => f.endsWith('.conf'));
            for (const file of routeFiles) {
                const orphanApp = file.replace(/\.conf$/, '');
                if (!desiredApps.has(orphanApp)) {
                    console.log(`Removing orphaned route: ${file}`);
                    await execAsync(`sudo rm -f ${GATEWAY_ROUTES}/${file}`);
                }
            }
        } catch (e) {}

        console.log('System Reconciliation Complete');
    } catch (error) {
        console.error('Reconciliation failed:', error);
    }
}

reconcile();
