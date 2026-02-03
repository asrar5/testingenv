const fs = require('fs');
const path = require('path');
require('dotenv').config();
const lockfile = require('proper-lockfile');

const HISTORY_FILE = process.env.AUTH_HISTORY_FILE || path.join(__dirname, '../data/history.json');
const MAX_ENTRIES = parseInt(process.env.HISTORY_MAX_ENTRIES) || 100;

// Ensure file exists
if (!fs.existsSync(path.dirname(HISTORY_FILE))) {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
}
if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, '[]');
}

class HistoryManager {
    static async log(action, appName, owner, details = {}) {
        const release = await lockfile.lock(HISTORY_FILE, { retries: 5 });
        try {
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            const entry = {
                timestamp: new Date().toISOString(),
                action, // 'upload' or 'delete'
                appName,
                owner,
                ...details
            };
            data.unshift(entry); // Newest first

            // Keep last MAX_ENTRIES entries
            if (data.length > MAX_ENTRIES) data.length = MAX_ENTRIES;

            fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
            return entry;
        } finally {
            await release();
        }
    }

    static async deleteAppHistory(appName) {
        const release = await lockfile.lock(HISTORY_FILE, { retries: 5 });
        try {
            if (!fs.existsSync(HISTORY_FILE)) return;
            let data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            const filtered = data.filter(entry => entry.appName !== appName);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(filtered, null, 2));
        } catch (e) {
            console.error('Failed to delete history for app ' + appName, e);
        } finally {
            await release();
        }
    }

    static async getHistory() {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        try {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) {
            return [];
        }
    }
}

module.exports = HistoryManager;
