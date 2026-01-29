const express = require('express');
const multer = require('multer');
const path = require('path');
require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const Deployer = require('./lib/deployer');
const NginxGenerator = require('./lib/nginx-generator');
const PortManager = require('./lib/port-manager');
const HistoryManager = require('./lib/history-manager');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Configure multer for temp uploads
const upload = multer({
    dest: path.resolve(process.env.UPLOAD_ROOT || 'uploads'),
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 1024 * 1024 * 1024 } // 1GB
});

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Debug endpoint to check file content
app.get('/api/debug/check-docker-input', (req, res) => {
    const fs = require('fs');
    const indexPath = path.join(__dirname, 'public', 'index.html');
    const content = fs.readFileSync(indexPath, 'utf8');
    
    // Check for Docker-related strings
    const hasDockerLabel = content.includes('Docker Image File (.tar/.tar.gz)');
    const hasTarAccept = content.includes('accept=".tar,.tar.gz,.tgz');
    const hasZipAccept = content.includes('accept=".zip"');
    const dockerTabContent = content.substring(
        content.indexOf('id="dockerTab"'),
        content.indexOf('id="dockerTab"') + 500
    );
    
    res.json({
        hasDockerLabel,
        hasTarAccept,
        hasZipAccept,
        dockerTabPreview: dockerTabContent,
        timestamp: new Date().toISOString()
    });
});
app.use(express.json());

const Auth = require('./lib/auth');

// Auth Middleware
const requireAuth = (req, res, next) => {
    const userStr = req.headers['x-user']; // Simple header auth for now (from frontend)
    if (!userStr) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const user = JSON.parse(userStr);
        // Verify user exists
        const validUser = Auth.getUser(user.username);
        if (!validUser || validUser.role !== user.role) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        req.user = validUser;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid auth header' });
    }
};

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await Auth.login(username, password);
    if (user) {
        res.json(user);
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// Check system status (Protected - Role based filtering)
app.get('/api/status', requireAuth, async (req, res) => {
    try {
        const allApps = await PortManager.getAllAllocations();
        const history = await HistoryManager.getHistory();

        if (req.user.role === 'admin') {
            const developers = Auth.getAllDevelopers();
            // Get statuses for all docker apps
            const dockerApps = Object.entries(allApps).filter(([_, data]) => (typeof data === 'object' && data.type === 'docker')).map(([name, _]) => name);
            const statuses = await Deployer.getContainerStatuses(dockerApps);

            // Enrich app data with status
            for (const name of dockerApps) {
                if (allApps[name]) allApps[name].status = statuses[name];
            }

            res.json({ status: 'ok', apps: allApps, developers, history });
        } else {
            // Filter apps and history for developer
            const myApps = {};
            const myDockerApps = [];
            for (const [name, data] of Object.entries(allApps)) {
                if ((typeof data === 'object' ? data.owner : null) === req.user.username) {
                    myApps[name] = data;
                    if (data.type === 'docker') myDockerApps.push(name);
                }
            }

            const statuses = await Deployer.getContainerStatuses(myDockerApps);
            for (const name of myDockerApps) {
                if (myApps[name]) myApps[name].status = statuses[name];
            }

            const myHistory = history.filter(h => h.owner === req.user.username);
            res.json({ status: 'ok', apps: myApps, history: myHistory });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload endpoint
app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
    // Only developers can upload
    if (req.user.role !== 'developer') {
        return res.status(403).json({ error: 'Only developers can upload applications' });
    }

    const file = req.file;
    const appName = req.body.appName;

    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (!appName) return res.status(400).json({ error: 'App name is required' });

    try {
        // Pass owner to deployer -> allocatePort
        // We need to update Deployer to accept owner
        // For now, let's assume Deployer.deploy calls allocatePort.
        // We should patch Deployer too.

        // Actually, let's call allocatePort check here first? 
        // No, deployer handles logic.
        // Let's pass user.username to deployer options
        const result = await Deployer.deploy(appName, file.path, req.user.username);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Upload failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Docker Deploy endpoint
app.post('/api/deploy-docker', requireAuth, async (req, res) => {
    // Only developers can deploy
    if (req.user.role !== 'developer') {
        return res.status(403).json({ error: 'Only developers can deploy applications' });
    }

    const { appName, imageName, internalPort, category } = req.body;

    if (!appName || !imageName) {
        return res.status(400).json({ error: 'App name and image name are required' });
    }

    try {
        const result = await Deployer.deployDocker(appName, imageName, req.user.username, internalPort || 80, category || 'backend');
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Docker deployment failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Docker Image Upload endpoint
app.post('/api/upload-docker-image', requireAuth, upload.single('file'), async (req, res) => {
    // Only developers can deploy
    if (req.user.role !== 'developer') {
        return res.status(403).json({ error: 'Only developers can deploy applications' });
    }

    const file = req.file;
    const { appName, internalPort, category } = req.body;

    if (!file) return res.status(400).json({ error: 'No image file uploaded' });
    if (!appName) return res.status(400).json({ error: 'App name is required' });
    
    // Validate app name format
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(appName) || appName.length < 3 || appName.length > 50) {
        return res.status(400).json({ error: 'App name must be 3-50 chars, lowercase alphanumeric with hyphens only' });
    }
    
    // Validate internal port
    const port = parseInt(internalPort) || 80;
    if (port < 1 || port > 65535) {
        return res.status(400).json({ error: 'Internal port must be between 1 and 65535' });
    }
    
    // Validate category
    if (!['frontend', 'backend'].includes(category)) {
        return res.status(400).json({ error: 'Category must be frontend or backend' });
    }

    try {
        const result = await Deployer.loadAndDeployDocker(appName, file.path, req.user.username, port, category);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Docker local deployment failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete endpoint
app.delete('/api/apps/:appName', requireAuth, async (req, res) => {
    const { appName } = req.params;

    // Check if admin (Read-Only)
    if (req.user.role === 'admin') {
        return res.status(403).json({ error: 'Admins are read-only' });
    }

    try {
        // 1. Check Metadata for type
        const meta = await PortManager.getAppMetadata(appName);
        if (meta && meta.owner !== req.user.username) {
            return res.status(403).json({ error: 'Forbidden: You do not own this app' });
        }

        const port = meta ? (typeof meta === 'number' ? meta : meta.port) : 'unknown';
        console.log(`\n=== DELETING APP: ${appName} ===`);
        console.log(`Type: ${meta ? meta.type : 'unknown'}`);
        console.log(`Port: ${port}`);
        console.log(`Owner: ${req.user.username}`);

        // 2. Remove Nginx Configs
        console.log(`[${appName}] Removing Nginx configs...`);
        await NginxGenerator.removeConfigs(appName);

        // Extra safety: remove any OTHER stale build-* site configs that still listen on this port.
        // This prevents persistent 500s and "port already allocated" issues after deletes.
        if (port !== 'unknown') {
            await NginxGenerator.removeSiteConfigsListeningOnPort(port);
        }

        // 3. Handle specific type cleanup
        if (meta && meta.type === 'docker') {
            console.log(`[${appName}] Stopping and removing Docker container...`);
            const { exec } = require('child_process');
            const util = require('util');
            const execAsync = util.promisify(exec);
            try {
                await execAsync(`sudo docker rm -f ${appName}`);
                console.log(`[${appName}] Docker container removed`);
            } catch (e) {
                console.warn(`[${appName}] Failed to remove container:`, e.message);
            }
        } else {
            // Remove Build Files (Physical) for ZIP builds
            const fs = require('fs');
            const buildPath = path.join(__dirname, 'builds', appName);
            if (fs.existsSync(buildPath)) {
                console.log(`[${appName}] Removing build directory...`);
                fs.rmSync(buildPath, { recursive: true, force: true });
                console.log(`[${appName}] Build directory removed`);
            }
        }

        // 4. Release Port (Logical - Writes to ports.json)
        console.log(`[${appName}] Releasing port...`);
        await PortManager.releasePort(appName);

        // 5. Reload Nginx
        console.log(`[${appName}] Reloading Nginx...`);
        await NginxGenerator.reloadNginx();

        // 6. Log History
        await HistoryManager.log('delete', appName, req.user.username);

        console.log(`[${appName}] ✅ Deletion completed successfully\n`);
        res.json({ success: true, message: `App '${appName}' deleted successfully. Port ${port} has been freed.` });
    } catch (error) {
        console.error(`[${appName}] ❌ Deletion failed:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Container Control endpoint
app.post('/api/apps/:appName/:action', requireAuth, async (req, res) => {
    const { appName, action } = req.params;

    if (!['stop', 'start'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use stop or start.' });
    }

    try {
        // 1. Verify ownership and type
        const meta = await PortManager.getAppMetadata(appName);
        if (!meta) {
            return res.status(404).json({ error: 'Application not found' });
        }

        if (meta.owner !== req.user.username && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: You do not own this app' });
        }

        if (meta.type !== 'docker') {
            return res.status(400).json({ error: 'Only Docker applications can be stopped or started' });
        }

        // 2. Perform action
        const result = await Deployer.manageContainer(appName, action);

        // 3. Log History
        await HistoryManager.log(`docker_${action}`, appName, req.user.username, { success: true });

        res.json(result);
    } catch (error) {
        console.error(`Container ${action} failed:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Global error handler to ensure JSON responses
app.use((err, req, res, next) => {
    console.error('Fatal Error:', err);
    if (res.headersSent) {
        return next(err);
    }
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
        code: err.code
    });
});

app.listen(PORT, HOST, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Upload UI: http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// --- Automatic Nginx reconciliation ---
// Keeps ports.json, builds/, and /etc/nginx configs in sync to avoid persistent 500s
// due to duplicate "listen <port>" server blocks or stale build-* configs.
const NGINX_AUTO_RECONCILE = (process.env.NGINX_AUTO_RECONCILE || 'true').toLowerCase() === 'true';
const NGINX_RECONCILE_INTERVAL_MS = parseInt(process.env.NGINX_RECONCILE_INTERVAL_MS || '300000'); // 5 min

async function runNginxReconcile(reason) {
    if (!NGINX_AUTO_RECONCILE) return;
    try {
        const scriptPath = path.join(__dirname, 'reconcile_nginx.js');
        const { stdout, stderr } = await execAsync(`node ${scriptPath}`);
        if (stdout && stdout.trim()) console.log(`[nginx-reconcile] ${reason}:\n${stdout.trim()}`);
        if (stderr && stderr.trim()) console.warn(`[nginx-reconcile] ${reason} stderr:\n${stderr.trim()}`);
    } catch (e) {
        console.warn(`[nginx-reconcile] ${reason} failed: ${e.message}`);
    }
}

// Run once shortly after startup, then periodically.
setTimeout(() => {
    runNginxReconcile('startup');
}, 2000);

if (Number.isFinite(NGINX_RECONCILE_INTERVAL_MS) && NGINX_RECONCILE_INTERVAL_MS > 0) {
    setInterval(() => {
        runNginxReconcile('interval');
    }, NGINX_RECONCILE_INTERVAL_MS);
}
