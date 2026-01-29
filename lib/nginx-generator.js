const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Configuration
const REQUIRED_DOMAIN = process.env.NGINX_DOMAIN || 'yourdomain.com';
const SITES_AVAILABLE = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
const SITES_ENABLED = process.env.NGINX_SITES_ENABLED || '/etc/nginx/sites-enabled';
const GATEWAY_ROUTES = process.env.NGINX_GATEWAY_ROUTES || '/etc/nginx/gateway-routes';
const BUILD_ROOT = process.env.BUILD_ROOT || path.join(__dirname, '../builds');

class NginxGenerator {
    static async removeSiteConfigsListeningOnPort(port, keepConfigName = null) {
        const p = parseInt(port);
        if (!Number.isFinite(p)) return;

        // Find all site configs that listen on this port.
        // Using sudo grep so we can read /etc/nginx.
        try {
            const { stdout } = await execAsync(`sudo grep -R "listen ${p};" -n ${SITES_AVAILABLE} 2>/dev/null || true`);
            const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);

            const files = new Set();
            for (const line of lines) {
                // Format: /etc/nginx/sites-available/build-foo:2:    listen 3321;
                const idx = line.indexOf(':');
                if (idx > 0) files.add(line.slice(0, idx));
            }

            for (const filePath of files) {
                const fileName = path.basename(filePath);
                if (keepConfigName && fileName === keepConfigName) continue;

                // Only touch our generated configs
                if (!fileName.startsWith('build-')) continue;

                await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${fileName} ${SITES_ENABLED}/${fileName}`);
            }
        } catch (e) {
            // Best-effort cleanup; don't fail deployments just because pruning couldn't run.
            console.warn(`Warning: could not prune configs on port ${port}: ${e.message}`);
        }
    }

    static async getServerName() {
        try {
            // Try to get public IP for EC2 or external access
            const { stdout } = await execAsync('curl -s --max-time 5 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || curl -s --max-time 5 http://checkip.amazonaws.com 2>/dev/null || echo "localhost"');
            const ip = stdout.trim();
            if (ip && ip !== 'localhost') {
                return `${ip} localhost`;
            }
        } catch (e) {
            // Ignore errors, fallback to localhost
        }
        return 'localhost';
    }

    static async generateAppConfig(appName, port) {
        const serverName = await this.getServerName();
        const configName = `build-${appName}`;

        // CRITICAL: avoid duplicate server blocks on the same port.
        // If stale configs exist (from previous bad deployments), Nginx may serve the wrong root and 500.
        await this.removeSiteConfigsListeningOnPort(port, configName);

        const configContent = `server {
    listen ${port};
    server_name ${serverName};
    
    root ${BUILD_ROOT}/${appName};
    index index.html;
    
    # SPA routing - try file, then directory, then index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Break infinity loop if index.html is missing
    location = /index.html {
        try_files $uri =404;
    }
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    
    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}`;

        // Write locally first then move with sudo
        const tempPath = path.join(__dirname, `../nginx/temp_${appName}`);
        fs.writeFileSync(tempPath, configContent);

        try {
            await execAsync(`sudo mv ${tempPath} ${SITES_AVAILABLE}/${configName}`);
            // Force link if not exists
            await execAsync(`sudo ln -sf ${SITES_AVAILABLE}/${configName} ${SITES_ENABLED}/${configName}`);
            return true;
        } catch (error) {
            console.error('Failed to install Nginx config:', error);
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); // Cleanup
            throw error;
        }
    }

    static async updateGatewayConfig(appName, port) {
        // We append the location block to the gateway config
        // NOTE: This assumes a specific structure of gateway file or we include separate files.
        // A cleaner way for Gateway is to include a wildcard folder, e.g. include /etc/nginx/gateway.d/*.conf
        // But per constraints "One public Nginx gateway".
        // Let's use the sed approach or just append if the structure allows.
        // Or better: Create a snippet file for this app's route and include it in gateway?
        // User requested "Internal Nginx server block per build" and "One public Nginx gateway routes paths to ports".

        // Strategy: We will have one main gateway file, but we can't easily parse and edit it safely with regex.
        // Safer: The gateway config 'include's a directory of routes.
        // Let's check if we can setup gateway to include /etc/nginx/gateway-routes/*.conf

        // For compliance with "Auto generate gateway routing rule", let's create a route snippet
        // and assume gateway.conf has `include /etc/nginx/gateway-routes/*.conf;`

        const routeContent = `
# Route /${appName}/ to localhost:${port}
location /${appName}/ {
    proxy_pass http://localhost:${port}/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # No auth/cookie injection
    proxy_pass_request_headers on;
}
`;
        const tempPath = path.join(__dirname, `../nginx/route_${appName}`);
        fs.writeFileSync(tempPath, routeContent);

        try {
            // We'll put these in a specific folder using the environment variable
            const routeDir = GATEWAY_ROUTES;
            await execAsync(`sudo mkdir -p ${routeDir}`);
            await execAsync(`sudo mv ${tempPath} ${routeDir}/${appName}.conf`);
            return true;
        } catch (error) {
            console.error('Failed to update gateway config:', error);
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            throw error;
        }
    }

    static async removeConfigs(appName) {
        try {
            const configName = `build-${appName}`;
            await execAsync(`sudo rm -f ${SITES_AVAILABLE}/${configName}`);
            await execAsync(`sudo rm -f ${SITES_ENABLED}/${configName}`);
            await execAsync(`sudo rm -f ${GATEWAY_ROUTES}/${appName}.conf`);
            return true;
        } catch (error) {
            console.error('Error removing configs:', error);
            return false; // Don't throw, just log
        }
    }

    static async reloadNginx() {
        try {
            console.log('Testing Nginx configuration...');
            await execAsync('sudo nginx -t');
            console.log('Nginx configuration test passed');
            
            console.log('Reloading Nginx...');
            await execAsync('sudo systemctl reload nginx');
            console.log('Nginx reloaded successfully');
            
            // Verify Nginx is running
            const { stdout } = await execAsync('sudo systemctl is-active nginx');
            if (stdout.trim() !== 'active') {
                throw new Error('Nginx is not active after reload');
            }
            console.log('Nginx verified as active');
            
            return true;
        } catch (error) {
            console.error('Nginx reload error:', error);
            throw new Error(`Nginx reload failed: ${error.message}`);
        }
    }
}

module.exports = NginxGenerator;
