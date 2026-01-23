const fs = require('fs');
const path = require('path');
require('dotenv').config();
const NginxGenerator = require('./lib/nginx-generator');
const PortManager = require('./lib/port-manager');

async function reconcile() {
    console.log('Starting Nginx reconciliation...');
    try {
        const apps = await PortManager.getAllAllocations();
        const appNames = Object.keys(apps);

        if (appNames.length === 0) {
            console.log('No apps found in ports.json');
            return;
        }

        for (const appName of appNames) {
            const data = apps[appName];
            const port = typeof data === 'object' ? data.port : data;

            console.log(`Generating config for ${appName} on port ${port}...`);
            await NginxGenerator.generateAppConfig(appName, port);
            await NginxGenerator.updateGatewayConfig(appName, port);
        }

        console.log('Reloading Nginx...');
        await NginxGenerator.reloadNginx();

        // --- PRUNING LOGIC ---
        console.log('Pruning orphaned directories...');
        const buildsDir = process.env.BUILD_ROOT || path.join(__dirname, 'builds');
        if (fs.existsSync(buildsDir)) {
             const dirs = fs.readdirSync(buildsDir).filter(f => {
                const stat = fs.statSync(path.join(buildsDir, f));
                return stat.isDirectory() && !f.startsWith('.'); // Ignore .backups and .temp-...
            });

            for (const dirName of dirs) {
                if (!appNames.includes(dirName)) {
                    console.log(`Pruning orphaned directory: ${dirName}`);
                    fs.rmSync(path.join(buildsDir, dirName), { recursive: true, force: true });
                    // Also try to remove Nginx configs if they exist
                    await NginxGenerator.removeConfigs(dirName);
                }
            }
        } else {
             console.log('Builds directory not found, skipping pruning.');
        }

        // Also prune temp files older than 1 hour? 
        // For now let's just do known orphans.

        console.log('Reconciliation and Pruning complete!');
    } catch (error) {
        console.error('Reconciliation failed:', error);
    }
}

reconcile();
