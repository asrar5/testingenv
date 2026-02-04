const fs = require('fs');
const path = require('path');
require('dotenv').config();
const lockfile = require('proper-lockfile');

const USERS_FILE = process.env.AUTH_USERS_FILE || path.join(__dirname, '../data/users.json');

// Ensure users file exists with default users
if (!fs.existsSync(path.dirname(USERS_FILE))) {
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
}
if (!fs.existsSync(USERS_FILE)) {
    const defaultUsers = {
        "admin": { "password": "admin123", "role": "admin" },
        "dev": { "password": "dev123", "role": "developer" }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
}

class Auth {
    static async login(username, password) {
        // Simple file read (concurrency is low for login)
        // ideally use lock if writing, but we are only reading
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const user = users[username];

        if (user && user.password === password) {
            // Return simple user object (in real app, return JWT)
            return { username, role: user.role };
        }
        return null;
    }

    static getUser(username) {
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        return users[username] ? { username, role: users[username].role } : null;
    }

    static getAllDevelopers() {
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        return Object.keys(users)
            .filter(username => users[username].role === 'developer')
            .sort();
    }

    static async getAllUsers() {
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        return Object.keys(users).map(username => ({
            username,
            role: users[username].role
        }));
    }

    static async _withLock(fn) {
        const release = await lockfile.lock(USERS_FILE, { retries: 3 });
        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            const updated = await fn(users);
            fs.writeFileSync(USERS_FILE, JSON.stringify(updated, null, 2));
        } finally {
            await release();
        }
    }

    static async createUser(username, password, role = 'developer') {
        await this._withLock(users => {
            if (users[username]) {
                throw new Error('User already exists');
            }
            users[username] = { password, role };
            return users;
        });
    }

    static async updateUser(username, { newUsername, password, role }) {
        await this._withLock(users => {
            const user = users[username];
            if (!user) {
                throw new Error('User not found');
            }

            const targetUsername = newUsername && newUsername !== username ? newUsername : username;
            if (newUsername && newUsername !== username && users[newUsername]) {
                throw new Error('New username already exists');
            }

            const updated = { ...user };
            if (typeof password === 'string' && password.length > 0) {
                updated.password = password;
            }
            if (role === 'admin' || role === 'developer') {
                updated.role = role;
            }

            if (targetUsername !== username) {
                delete users[username];
            }
            users[targetUsername] = updated;
            return users;
        });
    }

    static async deleteUser(username) {
        await this._withLock(users => {
            if (!users[username]) {
                throw new Error('User not found');
            }

            // Prevent deleting the last admin account
            const isAdmin = users[username].role === 'admin';
            if (isAdmin) {
                const adminCount = Object.values(users).filter(u => u.role === 'admin').length;
                if (adminCount <= 1) {
                    throw new Error('Cannot delete the last admin user');
                }
            }

            delete users[username];
            return users;
        });
    }
}

module.exports = Auth;
