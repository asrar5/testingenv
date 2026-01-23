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
}

module.exports = Auth;
