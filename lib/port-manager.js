const fs = require('fs');
const path = require('path');
const net = require('net');
require('dotenv').config();
const lockfile = require('proper-lockfile');

const PORTS_FILE = process.env.AUTH_PORTS_FILE || path.join(__dirname, '../data/ports.json');
const MIN_PORT = parseInt(process.env.MIN_PORT) || 3320;
const MAX_PORT = parseInt(process.env.MAX_PORT) || 3990;

// Ensure data directory and file exist
if (!fs.existsSync(path.dirname(PORTS_FILE))) {
    fs.mkdirSync(path.dirname(PORTS_FILE), { recursive: true });
}
if (!fs.existsSync(PORTS_FILE)) {
    fs.writeFileSync(PORTS_FILE, '{}');
}

class PortManager {
    static async isPortFree(port) {
        return await new Promise((resolve) => {
            const server = net.createServer();

            server.once('error', (err) => {
                if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
                    resolve(false);
                } else {
                    resolve(false);
                }
            });

            server.once('listening', () => {
                server.close(() => resolve(true));
            });

            server.listen(port, '0.0.0.0');
        });
    }

    static async setAppMetadata(appName, metadata) {
        const release = await lockfile.lock(PORTS_FILE, { retries: 5 });
        try {
            const data = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
            if (!metadata) {
                delete data[appName];
            } else {
                data[appName] = metadata;
            }
            fs.writeFileSync(PORTS_FILE, JSON.stringify(data, null, 2));
        } finally {
            await release();
        }
    }

    static async allocatePort(appName, owner, options = {}) {
        // Retry settings for lock
        const release = await lockfile.lock(PORTS_FILE, { retries: 5 });

        try {
            const data = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));

            // Normalize owner, type, and category from input
            const appType = typeof owner === 'object' ? owner.type : 'zip';
            const actualOwner = typeof owner === 'object' ? owner.username : owner;
            const category = typeof owner === 'object' ? owner.category : 'frontend'; // Default to frontend for ZIPs

            const reuseExisting = options.reuseExisting !== false;

            // Check if app already has a port
            if (data[appName] && reuseExisting) {
                const existing = data[appName];
                const existingPort = typeof existing === 'number' ? existing : existing.port;
                const existingOwner = typeof existing === 'number' ? null : existing.owner;

                // Check ownership
                if (existingOwner && existingOwner !== actualOwner && actualOwner !== 'admin') {
                    throw new Error(`App name "${appName}" is already owned by ${existingOwner}. You cannot redeploy another user's app.`);
                }

                // Allow owner or admin to redeploy - reuse the same port
                console.log(`[${appName}] Redeploying app - reusing port ${existingPort}`);
                data[appName] = {
                    port: existingPort,
                    owner: actualOwner,
                    type: appType,
                    category: category,
                    uploadedAt: new Date().toISOString()
                };
                fs.writeFileSync(PORTS_FILE, JSON.stringify(data, null, 2));

                return existingPort;
            }

            // If caller requested a new port assignment, drop the existing entry first.
            if (data[appName] && !reuseExisting) {
                delete data[appName];
            }

            // Find used ports
            const usedPorts = new Set(Object.values(data).map(d => typeof d === 'number' ? d : d.port));

            // Find first available port
            for (let port = MIN_PORT; port <= MAX_PORT; port++) {
                if (!usedPorts.has(port)) {
                    // Also ensure the port is actually free on the host (ports.json can be stale)
                    // NOTE: This check is best-effort; deployer also retries on bind failures.
                    // eslint-disable-next-line no-await-in-loop
                    const free = await this.isPortFree(port);
                    if (!free) continue;

                    data[appName] = {
                        port,
                        owner: actualOwner,
                        type: appType,
                        category: category,
                        uploadedAt: new Date().toISOString()
                    };
                    fs.writeFileSync(PORTS_FILE, JSON.stringify(data, null, 2));
                    console.log(`[${appName}] New deployment - allocated port ${port}`);
                    return port;
                }
            }

            throw new Error('No available ports in range ' + MIN_PORT + '-' + MAX_PORT);
        } finally {
            await release();
        }
    }

    static async releasePort(appName) {
        const release = await lockfile.lock(PORTS_FILE, { retries: 5 });

        try {
            const data = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
            if (data[appName]) {
                const port = typeof data[appName] === 'number' ? data[appName] : data[appName].port;
                delete data[appName];
                fs.writeFileSync(PORTS_FILE, JSON.stringify(data, null, 2));
                console.log(`[${appName}] Released port ${port}`);
                return true;
            }
            console.log(`[${appName}] No port allocation found to release`);
            return false;
        } finally {
            await release();
        }
    }

    static async getPort(appName) {
        const release = await lockfile.lock(PORTS_FILE, { retries: 5 });
        try {
            const data = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
            const entry = data[appName];
            if (!entry) return null;
            return typeof entry === 'number' ? entry : entry.port;
        } finally {
            await release();
        }
    }

    static async getAppMetadata(appName) {
        const release = await lockfile.lock(PORTS_FILE, { retries: 5 });
        try {
            const data = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
            const entry = data[appName];
            if (!entry) return null;
            return typeof entry === 'number' ? { port: entry, owner: null, type: 'zip' } : entry;
        } finally {
            await release();
        }
    }

    static async getAppOwner(appName) {
        const meta = await this.getAppMetadata(appName);
        return meta ? meta.owner : null;
    }

    static async getAllAllocations() {
        if (!fs.existsSync(PORTS_FILE)) return {};
        const data = fs.readFileSync(PORTS_FILE, 'utf8');
        try {
            return JSON.parse(data);
        } catch (e) {
            return {};
        }
    }
}

module.exports = PortManager;
