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

async function reconcile() {
    console.log('Starting Nginx reconciliation...');
    // Ensure BUILD_ROOT has correct permissions so Nginx (www-data) can traverse it
    try {
        console.log(`Fixing permissions on BUILD_ROOT: ${BUILD_ROOT}`);
        await execAsync(`sudo chmod +x ${path.dirname(BUILD_ROOT)}`); 
        await execAsync(`sudo chmod +x ${BUILD_ROOT}`);
    } catch (e) {
        console.warn('Could not fix permissions on BUILD_ROOT:', e.message);
    }

    try {
        const apps = await PortManager.getAllAllocations();
        const appNames = Object.keys(apps);

        if (appNames.length === 0) {
            console.log('No apps found in ports.json');
            return;
        }

        // Build desired port/type map from ports.json
        const desired = {};
        for (const appName of appNames) {
            const data = apps[appName];
            desired[appName] = (typeof data === 'object') ? data : { port: data, type: 'zip' };
        }

        // Pre-prune: remove stale/mismatched build-* configs so we don't end up with duplicates
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
                if ((meta.type || 'zip') === 'docker') {
                    console.log(`Removing docker site config (should not exist): ${file}`);
                    await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${file} ${SITES_ENABLED}/${file}`);
                    continue;
                }

                // If the config's listen port doesn't match ports.json, remove it.
                // We'll regenerate the correct one later.
                const expectedPort = meta.port;
                try {
                    const { stdout: cfg } = await execAsync(`sudo cat ${SITES_AVAILABLE}/${file} 2>/dev/null || true`);
                    const m = cfg.match(/\blisten\s+(\d+)\s*;/);
                    const actualPort = m ? parseInt(m[1]) : NaN;
                    if (!Number.isFinite(actualPort) || actualPort !== expectedPort) {
                        console.log(`Removing mismatched site config: ${file} (expected ${expectedPort}, got ${Number.isFinite(actualPort) ? actualPort : 'unknown'})`);
                        await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${file} ${SITES_ENABLED}/${file}`);
                    }
                } catch (e) {
                    console.warn(`Could not inspect ${file}: ${e.message}`);
                }
            }
        } catch (e) {
            console.warn('Pre-prune failed:', e.message);
        }

        for (const appName of appNames) {
            const data = apps[appName];
            const meta = (typeof data === 'object') ? data : { port: data, type: 'zip' };
            const port = meta.port;
            const type = meta.type || 'zip';

            if (type === 'docker') {
                // IMPORTANT: Do NOT generate a static file server for docker apps.
                // The container is expected to bind to this port, and an nginx server block would steal it.
                console.log(`Ensuring docker route for ${appName} -> localhost:${port} (no listen server)...`);
                await NginxGenerator.removeConfigs(appName);
                await NginxGenerator.updateGatewayConfig(appName, port);
                continue;
            }

            // ZIP Checks: Ensure content is valid before creating configuration
            const appBuildPath = path.join(BUILD_ROOT, appName);
            const indexFile = path.join(appBuildPath, 'index.html');
            
            if (!fs.existsSync(appBuildPath) || !fs.existsSync(indexFile)) {
                console.error(`[ERROR] App ${appName} is missing build directory or index.html. Skipping Nginx generation to prevent 500 errors.`);
                // Clean up any bad state implies "site down" rather than "broken loop"
                await NginxGenerator.removeConfigs(appName);
                // Also remove gateway route so it shows 404
                try {
                    await execAsync(`sudo rm -f ${GATEWAY_ROUTES}/${appName}.conf`);
                } catch (e) {}
                continue;
            }

            console.log(`Ensuring static site + route for ${appName} on port ${port}...`);
            await NginxGenerator.generateAppConfig(appName, port);
            await NginxGenerator.updateGatewayConfig(appName, port);
        }

        console.log('Reloading Nginx...');
        await NginxGenerator.reloadNginx();

        // --- PRUNING LOGIC ---
        console.log('Pruning orphaned directories...');
        // const buildsDir = BUILD_ROOT; // Already defined globally
        if (fs.existsSync(BUILD_ROOT)) {
             const dirs = fs.readdirSync(BUILD_ROOT).filter(f => {
                const stat = fs.statSync(path.join(BUILD_ROOT, f));
                return stat.isDirectory() && !f.startsWith('.'); // Ignore .backups and .temp-...
            });

            for (const dirName of dirs) {
                if (!appNames.includes(dirName)) {
                    console.log(`Pruning orphaned directory: ${dirName}`);
                    fs.rmSync(path.join(BUILD_ROOT, dirName), { recursive: true, force: true });
                    // Also try to remove Nginx configs if they exist
                    await NginxGenerator.removeConfigs(dirName);
                }
            }
        } else {
             console.log('Builds directory not found, skipping pruning.');
        }

        // Prune orphaned nginx site configs even if the build dir is already gone
        console.log('Pruning orphaned Nginx site configs/routes...');
        const desiredApps = new Set(appNames);

        try {
            const { stdout } = await execAsync(`sudo ls -1 ${SITES_AVAILABLE} 2>/dev/null || true`);
            const files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
            const buildFiles = files.filter(f => f.startsWith('build-'));
            for (const file of buildFiles) {
                const orphanApp = file.replace(/^build-/, '');
                const meta = apps[orphanApp];
                const type = (typeof meta === 'object' && meta && meta.type) ? meta.type : null;

                // Remove if not in ports.json OR if it's a docker app (docker should not have a build-* site)
                if (!desiredApps.has(orphanApp) || type === 'docker') {
                    console.log(`Removing orphaned site config: ${file}`);
                    await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${file} ${SITES_ENABLED}/${file}`);
                }
            }
        } catch (e) {
            console.warn('Could not prune sites-available:', e.message);
        }

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
        } catch (e) {
            console.warn('Could not prune gateway-routes:', e.message);
        }

        // Also prune temp files older than 1 hour? 
        // For now let's just do known orphans.

        console.log('Reconciliation and Pruning complete!');
    } catch (error) {
        console.error('Reconciliation failed:', error);
    }
}

reconcile();
