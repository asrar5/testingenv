const fs = require('fs');
const path = require('path');
require('dotenv').config();
const yauzl = require('yauzl');
const { Transform } = require('stream');

const MAX_ZIP_SIZE = parseInt(process.env.MAX_ZIP_SIZE) || 1024 * 1024 * 1024; // 1GB

class Validator {
    static validateAppName(name) {
        // Alphanumeric + hyphens only, must not start/end with hyphen
        const regex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
        if (!name || name.length < 3 || name.length > 50) {
            throw new Error('App name must be between 3 and 50 characters');
        }
        if (!regex.test(name)) {
            throw new Error('App name must contain only lowercase letters, numbers, and hyphens');
        }
        return true;
    }

    static validateZipAndCheckIndex(zipFilePath) {
        return new Promise((resolve, reject) => {
            const stats = fs.statSync(zipFilePath);
            if (stats.size > MAX_ZIP_SIZE) {
                return reject(new Error('ZIP file exceeds 1GB limit'));
            }

            yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
                if (err) return reject(err);

                let hasIndexHtml = false;

                zipfile.readEntry();
                zipfile.on('entry', (entry) => {
                    // Check for malicious paths
                    if (entry.fileName.includes('..')) {
                        zipfile.close();
                        return reject(new Error('Zip contains malicious path traversal'));
                    }

                    // Look for index.html at root or immediate subfolder 
                    // (Some zips put everything in a top-level folder)
                    // For now, strict requirement: index.html at root of zip? 
                    // User requirements say "Validate zip contains index.html".
                    // Usually flexible is better, but let's stick to root for simplicity as per common hosting standards.
                    if (entry.fileName === 'index.html') {
                        hasIndexHtml = true;
                    }

                    zipfile.readEntry();
                });

                zipfile.on('end', () => {
                    if (!hasIndexHtml) {
                        return reject(new Error('ZIP must contain index.html at the root level'));
                    }
                    resolve(true);
                });

                zipfile.on('error', (err) => {
                    reject(err);
                });
            });
        });
    }

    static extractZip(zipFilePath, destDir) {
        return new Promise((resolve, reject) => {
            // Ensure destination exists
            fs.mkdirSync(destDir, { recursive: true });

            yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
                if (err) return reject(err);

                zipfile.readEntry();
                zipfile.on('entry', (entry) => {
                    if (/\/$/.test(entry.fileName)) {
                        // Directory
                        fs.mkdirSync(path.join(destDir, entry.fileName), { recursive: true });
                        zipfile.readEntry();
                    } else {
                        // File
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) return reject(err);

                            const destPath = path.join(destDir, entry.fileName);
                            const destParent = path.dirname(destPath);

                            // Ensure parent dir exists
                            fs.mkdirSync(destParent, { recursive: true });

                            const writeStream = fs.createWriteStream(destPath);
                            readStream.pipe(writeStream);

                            writeStream.on('finish', () => {
                                zipfile.readEntry();
                            });

                            writeStream.on('error', reject);
                        });
                    }
                });

                zipfile.on('end', () => {
                    resolve();
                });

                zipfile.on('error', reject);
            });
        });
    }
}

module.exports = Validator;
