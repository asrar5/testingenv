// Force cache clear on page load
const CURRENT_VERSION = '20250122-001';
const STORED_VERSION = localStorage.getItem('appVersion');

if (STORED_VERSION !== CURRENT_VERSION) {
    console.log('Version mismatch. Clearing cache and reloading...');
    localStorage.setItem('appVersion', CURRENT_VERSION);
    // Clear all localStorage for this app
    Object.keys(localStorage).forEach(key => {
        if (key !== 'appVersion' && key !== 'user') {
            localStorage.removeItem(key);
        }
    });
    // Force reload without cache
    window.location.reload(true);
}

// Cache busting and version indicator
document.getElementById('cacheVersion').textContent = new Date().toLocaleTimeString();

const form = document.getElementById('uploadForm');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
const status = document.getElementById('status');
const submitBtn = document.getElementById('submitBtn');
const appsList = document.getElementById('appsList');
const breadcrumbs = document.getElementById('breadcrumbs');
const viewContainer = document.getElementById('viewContainer');
const dockerForm = document.getElementById('dockerForm');
const dockerSubmitBtn = document.getElementById('dockerSubmitBtn');
const dockerDropZone = document.getElementById('dockerDropZone');
const dockerFileInput = document.getElementById('dockerFileInput');
const dockerFileName = document.getElementById('dockerFileName');
const adminUsersSection = document.getElementById('adminUsersSection');
const adminUsersListEl = document.getElementById('adminUsersList');
const adminUserForm = document.getElementById('adminUserForm');
const adminUserOriginalEl = document.getElementById('adminUserOriginal');
const adminUsernameEl = document.getElementById('adminUsername');
const adminPasswordEl = document.getElementById('adminPassword');
const adminRoleEl = document.getElementById('adminRole');
const adminUserResetBtn = document.getElementById('adminUserResetBtn');
const adminUserSubmitBtn = document.getElementById('adminUserSubmitBtn');

// Docker File Drag & Drop
dockerDropZone.addEventListener('dragover', (e) => { e.preventDefault(); dockerDropZone.classList.add('dragover'); });
dockerDropZone.addEventListener('dragleave', () => { dockerDropZone.classList.remove('dragover'); });
dockerDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dockerDropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        const file = e.dataTransfer.files[0];
        console.log('Docker file dropped:', file.name, 'Type:', file.type, 'Size:', file.size);
        dockerFileInput.files = e.dataTransfer.files;
        dockerFileName.textContent = 'Selected: ' + file.name;
    }
});
dockerDropZone.addEventListener('click', () => dockerFileInput.click());
dockerFileInput.addEventListener('change', () => {
    if (dockerFileInput.files.length) {
        const file = dockerFileInput.files[0];
        console.log('Docker file selected:', file.name, 'Type:', file.type, 'Size:', file.size);
        dockerFileName.textContent = 'Selected: ' + file.name;
    }
});

// Tabs Logic
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        console.log('Tab clicked:', tab.dataset.tab);
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const targetTab = document.getElementById(`${tab.dataset.tab}Tab`);
        targetTab.classList.add('active');
        console.log('Activated tab:', targetTab.id);
        status.style.display = 'none';
    });
});

// Auth Check
const userStr = localStorage.getItem('user');
if (!userStr) {
    window.location.href = '/html/login.html';
}
const user = JSON.parse(userStr);

// Hide upload form for Admin and show admin sections
if (user.role === 'admin') {
    const uploadCard = document.querySelector('.upload-card');
    if (uploadCard) uploadCard.style.display = 'none';
    if (adminUsersSection) adminUsersSection.style.display = 'block';
}

document.getElementById('userInfo').innerHTML = `
    <span>Logged in as <b>${user.username}</b></span>
    <button id="logoutBtn" class="btn-ghost" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;">Logout</button>`;

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('user');
    window.location.reload();
});

async function fetchWithAuth(url, options = {}) {
    options.headers = {
        ...options.headers,
        'x-user': JSON.stringify(user)
    };
    const res = await fetch(url, options);
            if (res.status === 401) {
                localStorage.removeItem('user');
                window.location.href = '/html/login.html';
            }
    return res;
}

// Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        updateFileName();
    }
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', updateFileName);

function updateFileName() {
    if (fileInput.files.length) {
        fileName.textContent = 'Selected: ' + fileInput.files[0].name;
    }
}

// Multi-Step Logic
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const nextBtn = document.getElementById('nextBtn');
const backBtn = document.getElementById('backBtn');
const appNameInput = document.getElementById('appName');
const displayAppName = document.getElementById('displayAppName');

nextBtn.addEventListener('click', () => {
    if (!appNameInput.checkValidity()) {
        appNameInput.reportValidity();
        return;
    }
    displayAppName.textContent = "App: " + appNameInput.value;
    step1.style.display = 'none';
    step2.style.display = 'block';
    status.style.display = 'none';
});

backBtn.addEventListener('click', () => {
    step1.style.display = 'block';
    step2.style.display = 'none';
});

function resetForm() {
    form.reset();
    appNameInput.value = '';
    fileName.textContent = '';
    step1.style.display = 'block';
    step2.style.display = 'none';
}

// Upload
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    console.log('=== ZIP FORM SUBMITTED ===');
    const formData = new FormData();
    formData.append('appName', appNameInput.value);
    formData.append('file', fileInput.files[0]);

    console.log('ZIP form data:', { appName: appNameInput.value, file: fileInput.files[0] });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Deploying...';
    status.style.display = 'none';

    try {
        console.log('Submitting to /upload');
        // Use XMLHttpRequest for progress
        const res = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload', true);
            xhr.setRequestHeader('x-user', JSON.stringify(user));

            xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable) return;
                const pct = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
                status.className = 'status-msg info';
                status.textContent = `Uploading... ${pct}%`;
                status.style.display = 'block';
            };

            xhr.upload.onload = () => {
                status.className = 'status-msg info';
                status.textContent = 'Upload complete. Deploying...';
                status.style.display = 'block';
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
                else {
                    let msg = 'Upload failed';
                    try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) { }
                    reject(new Error(msg));
                }
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(formData);
        });

        status.className = 'status-msg success';
        const host = window.location.hostname;
        const link = `http://${host}:${res.port}/`;
        status.innerHTML = `✅ Deployed successfully! <a href="${link}" target="_blank">Open App</a>`;
        status.style.display = 'block';
        resetForm();
        loadApps();
    } catch (err) {
        console.error('ZIP deployment error:', err);
        status.className = 'status-msg error';
        status.textContent = '❌ Error: ' + err.message;
        status.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Deploy Build';
    }
});

// Docker Deploy
dockerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    console.log('=== DOCKER FORM SUBMITTED ===');
    const appName = document.getElementById('dockerAppName').value;
    const internalPort = document.getElementById('internalPort').value;
    const category = document.getElementById('dockerCategory').value;

    console.log('Docker form data:', { appName, internalPort, category });
    console.log('Docker file:', dockerFileInput.files[0]);

    dockerSubmitBtn.disabled = true;
    dockerSubmitBtn.textContent = 'Deploying...';
    status.style.display = 'none';

    try {
        const formData = new FormData();
        formData.append('appName', appName);
        formData.append('internalPort', internalPort);
        formData.append('category', category);
        formData.append('file', dockerFileInput.files[0]);

        console.log('Submitting to /api/upload-docker-image');
        const result = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload-docker-image', true);
            xhr.setRequestHeader('x-user', JSON.stringify(user));

            xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable) return;
                const pct = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
                status.className = 'status-msg info';
                status.textContent = `Uploading image... ${pct}%`;
                status.style.display = 'block';
            };

            xhr.upload.onload = () => {
                status.className = 'status-msg info';
                status.textContent = 'Upload complete. Loading image & deploying...';
                status.style.display = 'block';
            };

            xhr.onload = () => {
                let body = null;
                try { body = JSON.parse(xhr.responseText); } catch (e) { }
                if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
                const msg = (body && body.error) ? body.error : 'Deployment failed';
                reject(new Error(msg));
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(formData);
        });

        if (!result || !result.port) {
            throw new Error('Deployment succeeded but response was invalid');
        }
        status.className = 'status-msg success';
        const host = window.location.hostname;
        const link = `http://${host}:${result.port}/`;
        status.innerHTML = `✅ Container deployed successfully! <a href="${link}" target="_blank">Open App</a>`;
        status.style.display = 'block';
        dockerForm.reset();
        dockerFileName.textContent = '';
        loadApps();
    } catch (err) {
        console.error('Docker deployment error:', err);
        status.className = 'status-msg error';
        status.textContent = '❌ Error: ' + err.message;
        status.style.display = 'block';
    } finally {
        dockerSubmitBtn.disabled = false;
        dockerSubmitBtn.textContent = 'Deploy Container';
    }
});

// --- DASHBOARD LOGIC ---

// State
let allApps = {};
let allDevelopers = [];
let allHistory = [];
let historyFilter = 'all';
let historyQuery = '';
let adminUsers = [];

const historySearchEl = document.getElementById('historySearch');
const historyFiltersEl = document.getElementById('historyFilters');
const statsRowEl = document.getElementById('statsRow');

function updateStats(apps) {
    if (!statsRowEl) return;

    const entries = Object.entries(apps || {});
    const total = entries.length;
    let zipCount = 0;
    let dockerCount = 0;
    let running = 0;
    let stopped = 0;

    for (const [, info] of entries) {
        const type = (typeof info === 'object' && info.type) ? info.type : 'zip';
        const status = (typeof info === 'object' && info.status) ? info.status : (type === 'zip' ? 'running' : 'unknown');

        if (type === 'docker') dockerCount += 1;
        else zipCount += 1;

        if (status === 'running') running += 1;
        if (status === 'stopped') stopped += 1;
    }

    statsRowEl.innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Total Apps</div>
            <div class="stat-value">${total}</div>
            <div class="stat-hint">Across your account</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">ZIP Deploys</div>
            <div class="stat-value">${zipCount}</div>
            <div class="stat-hint">Static builds</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Docker Apps</div>
            <div class="stat-value">${dockerCount}</div>
            <div class="stat-hint">Containers</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Running / Stopped</div>
            <div class="stat-value">${running}<span style="color: var(--text-muted); font-weight: 900;"> / </span>${stopped}</div>
            <div class="stat-hint">Docker status</div>
        </div>
    `;

    statsRowEl.style.display = 'grid';
}

function setActiveHistoryFilter(nextFilter) {
    historyFilter = nextFilter;
    if (!historyFiltersEl) return;
    historyFiltersEl.querySelectorAll('[data-history-filter]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.historyFilter === historyFilter);
    });
}

function applyHistoryFilter() {
    const q = (historyQuery || '').trim().toLowerCase();
    const filtered = (allHistory || []).filter(item => {
        const rawAction = (item.action || (item.deletedAt ? 'delete' : 'upload'));
        const matchesType = historyFilter === 'all' ? true : rawAction.includes(historyFilter);
        if (!matchesType) return false;

        if (!q) return true;
        const haystack = `${item.appName || ''} ${item.owner || ''} ${rawAction}`.toLowerCase();
        return haystack.includes(q);
    });

    renderHistory(filtered, { total: (allHistory || []).length });
}

if (historyFiltersEl) {
    historyFiltersEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-history-filter]');
        if (!btn) return;
        setActiveHistoryFilter(btn.dataset.historyFilter);
        applyHistoryFilter();
    });
}

if (historySearchEl) {
    historySearchEl.addEventListener('input', () => {
        historyQuery = historySearchEl.value;
        applyHistoryFilter();
    });
}

async function loadApps() {
    try {
        const res = await fetchWithAuth('/api/status');
        const data = await res.json();
        allApps = data.apps || {};
        allDevelopers = data.developers || [];
        allHistory = data.history || [];

        updateStats(allApps);

        if (user.role === 'admin') {
            renderAdminView(allApps);
            loadAdminUsers();
        } else {
            renderAppList(allApps);
        }
        applyHistoryFilter();
        document.getElementById('historySection').style.display = 'block';
    } catch (err) {
        console.error(err);
        viewContainer.innerHTML = `<div style="padding: 2rem; text-align: center; color: #ef4444">
            <h3>Failed to load apps</h3>
            <p>${err.message}</p>
            <pre style="text-align: left; background: #f1f5f9; padding: 1rem; overflow: auto; font-size: 0.8rem;">${err.stack}</pre>
        </div>`;
    }
}

// --- ADMIN USER MANAGEMENT ---

async function loadAdminUsers() {
    if (!adminUsersSection || user.role !== 'admin') return;
    try {
        if (adminUsersListEl) {
            adminUsersListEl.innerHTML = '<div style="padding: 0.75rem 1rem; font-size: 0.85rem; color: var(--text-muted);">Loading users...</div>';
        }
        const res = await fetchWithAuth('/api/admin/users');
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Failed to load users');
        }
        const data = await res.json();
        adminUsers = data.users || [];
        renderAdminUsers();
    } catch (e) {
        console.error('Failed to load admin users:', e);
        if (adminUsersListEl) {
            adminUsersListEl.innerHTML = `<div style="padding: 0.75rem 1rem; font-size: 0.85rem; color: #b91c1c;">Failed to load users: ${e.message}</div>`;
        }
    }
}

function resetAdminUserForm() {
    if (!adminUserForm) return;
    adminUserForm.reset();
    if (adminUserOriginalEl) adminUserOriginalEl.value = '';
    if (adminUserSubmitBtn) adminUserSubmitBtn.textContent = 'Create User';
}

function renderAdminUsers() {
    if (!adminUsersListEl) return;

    if (!adminUsers || adminUsers.length === 0) {
        adminUsersListEl.innerHTML = '<div style="padding: 0.75rem 1rem; font-size: 0.85rem; color: var(--text-muted);">No users found. Create a new user below.</div>';
        return;
    }

    adminUsersListEl.innerHTML = adminUsers.map(u => {
        const isSelf = u.username === user.username;
        return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e5e7eb; font-size: 0.85rem;">
                <div>
                    <div style="font-weight: 600;">${u.username}</div>
                    <div style="font-size: 0.75rem; color: var(--text-muted);">Role: ${u.role}</div>
                </div>
                <div style="display: flex; gap: 0.35rem;">
                    <button type="button" class="btn-ghost" data-admin-user="${u.username}" data-action="edit" style="font-size: 0.7rem;">Edit</button>
                    <button type="button" class="btn-danger" data-admin-user="${u.username}" data-action="delete" style="font-size: 0.7rem;" ${isSelf ? 'disabled title="Cannot delete current logged-in admin"' : ''}>Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

if (adminUsersListEl) {
    adminUsersListEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-admin-user]');
        if (!btn) return;
        const username = btn.getAttribute('data-admin-user');
        const action = btn.getAttribute('data-action');

        if (action === 'edit') {
            const userObj = adminUsers.find(u => u.username === username);
            if (!userObj || !adminUsernameEl || !adminRoleEl || !adminUserOriginalEl || !adminUserSubmitBtn) return;
            adminUsernameEl.value = userObj.username;
            adminRoleEl.value = userObj.role;
            adminPasswordEl && (adminPasswordEl.value = '');
            adminUserOriginalEl.value = userObj.username;
            adminUserSubmitBtn.textContent = 'Save Changes';
        } else if (action === 'delete') {
            if (!confirm(`Delete user "${username}"?`)) return;
            try {
                const res = await fetchWithAuth(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
                const body = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(body.error || 'Failed to delete user');
                }
                await loadAdminUsers();
            } catch (err) {
                alert('Failed to delete user: ' + err.message);
            }
        }
    });
}

if (adminUserForm && adminUserSubmitBtn) {
    adminUserForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = adminUsernameEl ? adminUsernameEl.value.trim() : '';
        const password = adminPasswordEl ? adminPasswordEl.value : '';
        const role = adminRoleEl ? adminRoleEl.value : 'developer';
        const original = adminUserOriginalEl ? adminUserOriginalEl.value : '';

        if (!username) {
            alert('Username is required');
            return;
        }

        adminUserSubmitBtn.disabled = true;
        const originalLabel = adminUserSubmitBtn.textContent;
        adminUserSubmitBtn.textContent = 'Saving...';

        try {
            let res;
            if (!original) {
                // Create new user
                if (!password) {
                    alert('Password is required for new users');
                    adminUserSubmitBtn.disabled = false;
                    adminUserSubmitBtn.textContent = originalLabel;
                    return;
                }
                res = await fetchWithAuth('/api/admin/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, role })
                });
            } else {
                // Update existing user
                const payload = { newUsername: username, role };
                if (password) payload.password = password;
                res = await fetchWithAuth(`/api/admin/users/${encodeURIComponent(original)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }

            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(body.error || 'Failed to save user');
            }
            resetAdminUserForm();
            await loadAdminUsers();
        } catch (err) {
            alert('Failed to save user: ' + err.message);
        } finally {
            adminUserSubmitBtn.disabled = false;
            adminUserSubmitBtn.textContent = originalLabel;
        }
    });
}

if (adminUserResetBtn) {
    adminUserResetBtn.addEventListener('click', () => {
        resetAdminUserForm();
    });
}

function renderAdminView(apps) {
    // Group by owner
    const appsByOwner = {};

    // Start with all developers from API
    let owners = new Set(allDevelopers);

    // Populate groups
    for (const [name, info] of Object.entries(apps)) {
        let owner = (typeof info === 'object' && info.owner) ? info.owner : 'unknown';
        if (!appsByOwner[owner]) appsByOwner[owner] = {};
        appsByOwner[owner][name] = info;
        owners.add(owner);
    }

    const ownerList = Array.from(owners).sort();

    if (ownerList.length === 0) {
        viewContainer.innerHTML = '<div style="padding: 2rem; text-align: center; color: #64748b">No developers found</div>';
        return;
    }

    // Controls for Admin
    const controlsHtml = `
        <div class="controls" style="margin-bottom: 2rem; display: flex; justify-content: flex-end; gap: 0.5rem;">
            <button class="btn-ghost" onclick="expandAll()" style="font-size: 0.8rem;">Expand All</button>
            <button class="btn-ghost" onclick="collapseAll()" style="font-size: 0.8rem;">Collapse All</button>
        </div>
    `;

    const accordionHtml = ownerList.map(owner => {
        const devApps = appsByOwner[owner] || {};
        const appCount = Object.keys(devApps).length;

        return `
            <div class="dev-section" id="section-${owner}">
                <div class="dev-header" onclick="toggleSection('${owner}')" id="header-${owner}">
                    <div class="dev-name">${owner}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">${appCount} Deployments</div>
                </div>
                <div class="dev-content card" id="content-${owner}" style="display: none; padding: 0; border-top: none; border-top-left-radius: 0; border-top-right-radius: 0;">
                    ${renderAppListHtml(devApps)}
                </div>
            </div>
        `;
    }).join('');

    viewContainer.innerHTML = controlsHtml + accordionHtml;
}

window.expandAll = () => {
    document.querySelectorAll('.dev-content').forEach(c => c.style.display = 'block');
    document.querySelectorAll('.dev-header').forEach(h => h.classList.add('open'));
};

window.collapseAll = () => {
    document.querySelectorAll('.dev-content').forEach(c => c.style.display = 'none');
    document.querySelectorAll('.dev-header').forEach(h => h.classList.remove('open'));
};

window.toggleSection = (owner) => {
    const content = document.getElementById(`content-${owner}`);
    const header = document.getElementById(`header-${owner}`);
    const willOpen = content.style.display === 'none';
    content.style.display = willOpen ? 'block' : 'none';
    if (header) header.classList.toggle('open', willOpen);
};

function renderAppListHtml(apps) {
    if (Object.keys(apps).length === 0) {
        return '<div style="padding: 3rem; text-align: center; color: var(--text-muted); font-size: 0.9rem;">No deployments found.</div>';
    }

    return `
        <div class="apps-list">
            ${Object.entries(apps).map(([name, info]) => {
        const port = typeof info === 'object' ? info.port : info;
        const owner = typeof info === 'object' ? info.owner : 'unknown';
        const type = info.type || 'zip';
        const status = info.status || (type === 'zip' ? 'running' : 'unknown');
        const category = info.category || 'frontend';

        return `
                    <div class="app-item" id="app-${name}">
                        <div class="app-details" style="display: flex; flex-direction: column; gap: 0.25rem;">
                            <div style="display: flex; align-items: center; gap: 0.75rem;">
                                <span style="font-weight: 700; color: var(--text-main); font-size: 1.1rem;">${name}</span>
                                <span class="category-tag tag-${category}">${category}</span>
                                ${type === 'docker' ? `<span class="status-badge status-${status}">${status}</span>` : ''}
                            </div>
                            <div style="display: flex; align-items: center; gap: 1rem; color: var(--text-muted); font-size: 0.8rem; font-weight: 500;">
                                <span>Port: <b>${port}</b></span>
                                <span>Type: <b>${type.toUpperCase()}</b></span>
                                <span>Owner: <b>${owner}</b></span>
                            </div>
                        </div>
                        <div class="app-actions">
                            <a href="http://${window.location.hostname}:${port}/" target="_blank" class="app-link" style="text-decoration: none;">
                                <button class="btn-ghost" style="padding: 0.5rem 1rem; font-size: 0.8rem;">Open</button>
                            </a>
                            ${(type === 'docker' && user.role !== 'admin') ? `
                                <button onclick="controlContainer('${name}', 'start')" class="btn-ghost" style="color: var(--success); border-color: #dcfce7; padding: 0.5rem 1rem; font-size: 0.8rem;" ${status === 'running' ? 'disabled' : ''}>Start</button>
                                <button onclick="controlContainer('${name}', 'stop')" class="btn-ghost" style="color: var(--warning); border-color: #fef3c7; padding: 0.5rem 1rem; font-size: 0.8rem;" ${status === 'stopped' ? 'disabled' : ''}>Stop</button>
                            ` : ''}
                            ${user.role !== 'admin' ?
            `<button onclick="deleteApp('${name}')" class="btn-danger" style="padding: 0.5rem 1rem; font-size: 0.8rem;">Delete</button>`
            : ''}
                        </div>
                    </div>
                `;
    }).join('')}
        </div>
    `;
}

function renderAppList(apps) {
    viewContainer.innerHTML = renderAppListHtml(apps);
}

function renderHistory(history, opts = {}) {
    const list = document.getElementById('historyList');
    const meta = document.getElementById('historyMeta');
    if (history.length === 0) {
        const total = typeof opts.total === 'number' ? opts.total : history.length;
        if (meta) meta.textContent = total ? `0/${total} events` : 'No events yet';
        list.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-muted)">No history recorded</div>';
        return;
    }

    if (meta) {
        const total = typeof opts.total === 'number' ? opts.total : history.length;
        meta.textContent = total !== history.length
            ? `${history.length}/${total} events`
            : `${history.length} event${history.length === 1 ? '' : 's'}`;
    }

    list.innerHTML = history.map(item => {
        const rawAction = (item.action || (item.deletedAt ? 'delete' : 'upload'));
        const action = rawAction.replaceAll('_', ' ');
        const owner = item.owner || 'unknown';
        const appName = item.appName || 'Unknown App';
        const timestamp = item.timestamp || item.deletedAt || item.deployedAt;

        const badgeClass = rawAction.includes('docker') ? 'docker' : (rawAction.includes('delete') ? 'delete' : (rawAction.includes('upload') ? 'upload' : ''));
        const badgeLabel = rawAction.includes('docker') ? 'docker' : (rawAction.includes('delete') ? 'delete' : (rawAction.includes('upload') ? 'upload' : rawAction));

        return `
        <div class="history-item">
            <div class="history-main">
                <div class="history-title">
                    <span class="history-badge ${badgeClass}">${badgeLabel}</span>
                    <span class="history-action">${action}</span>
                    <span style="color: var(--text-muted);">•</span>
                    <span class="history-app" title="${appName}">${appName}</span>
                </div>
                <div class="history-meta">
                    Performed by <b>${owner}</b>${item.port ? ` • Port <b>${item.port}</b>` : ''}${item.image ? ` • Image <b>${item.image}</b>` : ''}${item.category ? ` • Category <b>${item.category}</b>` : ''}
                </div>
            </div>
            <div class="history-time">${timestamp ? new Date(timestamp).toLocaleString() : 'N/A'}</div>
        </div>
    `;}).join('');
}

window.deleteApp = async function (name) {
    if (!confirm(`Are you sure you want to delete ${name}?`)) return;
    try {
        const res = await fetchWithAuth(`/api/apps/${name}`, { method: 'DELETE' });
        if (res.ok) {
            loadApps();
        } else {
            const data = await res.json();
            alert('Failed to delete: ' + data.error);
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
};

window.showAdminView = function () {
    breadcrumbs.style.display = 'none';
    renderAdminView(allApps);
}

window.controlContainer = async function (name, action) {
    const btn = event.target;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const res = await fetchWithAuth(`/api/apps/${name}/${action}`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            loadApps();
        } else {
            alert(`Failed to ${action}: ` + (data.error || 'Unknown error'));
            btn.disabled = false;
            btn.textContent = originalText;
        }
    } catch (e) {
        alert('Error: ' + e.message);
        btn.disabled = false;
        btn.textContent = originalText;
    }
};

// Live Validation & Auto-Correction
function setupNameValidation(inputId, errorId) {
    const input = document.getElementById(inputId);
    const error = document.getElementById(errorId);
    
    if (!input || !error) return;

    input.addEventListener('input', () => {
        // 1. Auto-convert to lowercase (addresses "Why not uppercase")
        const original = input.value;
        const lower = original.toLowerCase();
        if (original !== lower) {
            input.value = lower;
        }

        const value = input.value;
        
        // 2. Real-time validation (addresses "Error before uploading")
        if (value.length === 0) {
            error.style.display = 'none';
            input.setCustomValidity('');
            return;
        }

        let params = { valid: true, msg: '' };

        if (value.length < 3) params = { valid: false, msg: 'Name must be at least 3 characters.' };
        else if (value.length > 50) params = { valid: false, msg: 'Name must be less than 50 characters.' };
        else if (!/^[a-z0-9]/.test(value)) params = { valid: false, msg: 'Must start with a letter or number.' };
        else if (!/[a-z0-9]$/.test(value)) {
            // Start/End check - if ending with hyphen, it's invalid but common while typing
            // We can be lenient or strict. Let's be strict but clear.
            if (value.endsWith('-')) params = { valid: false, msg: 'Cannot end with a hyphen.' };
            else params = { valid: false, msg: 'Must end with a letter or number.' };
        }
        else if (value.includes('--')) params = { valid: false, msg: 'Consecutive hyphens (--) are not allowed.' };
        else if (!/^[a-z0-9-]+$/.test(value)) params = { valid: false, msg: 'Only letters, numbers, and hyphens allowed.' };
        
        if (params.valid) {
            error.style.display = 'none';
            input.setCustomValidity('');
        } else {
            error.textContent = params.msg;
            error.style.display = 'block';
            input.setCustomValidity(params.msg);
        }
    });
}

setupNameValidation('appName', 'appNameError');
setupNameValidation('dockerAppName', 'dockerAppNameError');

loadApps();
setInterval(loadApps, 15000);
