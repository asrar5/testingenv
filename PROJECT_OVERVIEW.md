# TestingEnv / Build Hosting Platform – Project Overview

## 1. What This Project Is

This project is aself‑hosted Testing Environment. It lets you upload application builds (ZIP archives or Docker images), automatically loads them, assigns them a dedicated port, and exposes them through Nginx so they are accessible via clean URLs.

It includes:
- A **web dashboard** (admin/developer UI) for managing uploads, deployments, and history.
- A **login page** with simple role‑based access (admin vs developer).
- A **Node.js/Express backend** that handles uploads, deployment logic, and status APIs.
- **Static ZIP deployment** for traditional web builds served via Nginx.
- **Docker-based deployment** for containerized apps from uploaded tar(docker image).
- **Nginx integration** so each hosted app is reachable behind a single gateway via app name or port.
- A **CI/CD workflow** (GitHub Actions + PM2) to deploy updates to a self‑hosted server.

## 2. What Problem It Solves

Typical problems this project addresses:
- **Scattered test deployments** – Developers often spin up ad‑hoc servers/ports to test builds. This app centralizes them into one dashboard.
- **Port management pain** – Manually choosing and tracking which port each app uses is error‑prone. This platform automatically allocates and tracks ports.
- **Manual Nginx config** – Writing and reloading Nginx virtual host files by hand is slow and fragile. This project generates and reconciles Nginx configs for each app.
- **Lack of visibility** – Teams can’t easily see who deployed what, when, and where. The history view and per‑user ownership solve this.

In short, it gives you a **single place to upload, host, and manage many test apps** on one server in a controlled, auditable way.

## 3. High‑Level Architecture

- **Frontend (public/)**
  - `public/html/index.html`: Main dashboard UI (apps list, upload forms, history).
  - `public/html/login.html`: Login page.
  - `public/css/style.css`: Styles for the dashboard.
  - `public/js/app.js`: Client‑side logic for uploads, auth, and rendering.

- **Backend (server.js + lib/)**
  - `server.js`: Express server; serves the UI, APIs, and file uploads.
  - `lib/port-manager.js`: Manages port allocations and app metadata.
  - `lib/deployer.js`: Handles deploying ZIP builds and Docker apps, including Docker/NGINX steps.
  - `lib/nginx-generator.js`: Generates / removes Nginx config files for each app.
  - `lib/history-manager.js`: Records and reads deployment history.
  - `lib/auth.js`: Simple user storage and authentication (admin/developer roles).

- **Configuration / Infrastructure**
  - `.env`: Server, path, and Nginx configuration (port range, data paths, etc.).
  - `nginx/gateway.conf`: Nginx gateway config that proxies `/`, `/upload`, and `/api/*` to the Node app.
  - `.github/workflows/deploy.yml`: GitHub Actions workflow for deploying to a self‑hosted runner using PM2.

## 4. How It Works – End to End

### 4.1 Authentication and Roles

- Users open the **login page** at `/login.html` (or are redirected there if not logged in).
- The login form posts to `POST /api/login` with username and password.
- `server.js` uses `lib/auth.js` to validate credentials and returns a `user` object (with `username` and `role`).
- The frontend stores this `user` in `localStorage` and sends it on each API call in the `x-user` header.
- The `requireAuth` middleware in `server.js` reads `x-user`, verifies it against `auth.js`, and attaches the user to `req.user`.
- Two roles:
  - **admin**: Read‑only; can see all apps and full history.
  - **developer**: Can upload/deploy their own apps and see their own history.

#### 4.1.1 Admin User Management (Add/Remove/Update Users)

- Admins can manage login accounts via admin‑only APIs under `/api/admin/users`:
  - `GET /api/admin/users` – list all users (username + role, no passwords).
  - `POST /api/admin/users` – create a new user with a username, password, and role (admin/developer).
  - `PATCH /api/admin/users/:username` – update an existing user’s password, role, or even rename the username.
  - `DELETE /api/admin/users/:username` – remove a user (with a safety check that prevents deleting the last admin).
- All these endpoints are protected by the same header‑based auth (`x-user`) and require the caller’s role to be **admin**.

#### 4.1.2 Self‑Service Credential Updates (Developers/Admins)

- Any logged‑in user (developer or admin) can update their **own** credentials from the dashboard:
  - The "Account Settings" card lets them enter a new username and/or new password.
  - Submitting the form calls `PATCH /api/me`, which updates only that account while preserving the existing role.
- On success, the frontend updates the stored `user` object in `localStorage` and refreshes the header so the new username is reflected immediately.

### 4.2 Uploading and Deploying ZIP Builds

1. A logged‑in developer opens the dashboard (`/`).
2. In the **ZIP Upload** tab:
   - Enters an app name.
   - Uploads a `.zip` file via drag‑and‑drop or file picker.
3. The frontend (`public/js/app.js`) sends the file and `appName` to `POST /upload` with the `x-user` header.
4. `server.js` checks:
   - User is authenticated and has `developer` role.
   - File is present and app name is valid.
5. `lib/deployer.deploy(appName, filePath, owner)` is called:
   - Uses `lib/port-manager` to **allocate a free port** within the configured range.
   - Unzips the build into the builds directory.
   - Asks `lib/nginx-generator` to **generate Nginx config** for the app (mapping a URL to the allocated port).
   - Restarts/reloads Nginx as needed.
6. `lib/history-manager` records the deployment (who, what, when, which port).
7. The response goes back to the frontend, which updates the dashboard and history view.

### 4.3 Deploying Docker‑Based Apps

There are two ways to deploy Docker apps from the dashboard (in the **Docker** tab):


1. **Uploading a Docker image** (`POST /api/upload-docker-image`)
   - Developer uploads a `.tar`, `.tar.gz`, or `.tgz` image file and fills in `App Name`, `Internal Port`, and `Category`.
   - The frontend sends a multipart request to `/api/upload-docker-image` with the `x-user` header.
   - The backend:
     - Validates the file and metadata.
     - Uses `lib/deployer.loadAndDeployDocker` to load the image into Docker Engine, then calls `deployDocker` internally.
     - The end result is the same: a running container behind an Nginx route like `/<appName>/`, tracked in history and visible on the dashboard. Which can be accessed by `/<appName>/` or by port.

### 4.4 Port Management and Nginx

- **PortManager**:
  - Keeps track of which ports are in use and which app owns which port.
  - Stores this info in JSON files under `data/` (configured via `.env`).
  - Ensures new deployments get a free port within `MIN_PORT`–`MAX_PORT`.

- **NginxGenerator**:
  - Writes app‑specific Nginx config files into the directories defined in `.env` (`NGINX_SITES_AVAILABLE`, `NGINX_SITES_ENABLED`, `NGINX_GATEWAY_ROUTES`).
  - Ensures routes for apps point to `localhost:<allocatedPort>`.
  - Cleans up configs on app deletion.

- The static gateway config `nginx/gateway.conf`:
  - Listens on port 80.
  - Proxies `/`, `/upload`, and `/api/*` to the Node app on the configured port.
  - Includes additional app routes from `gateway-routes`.

### 4.5 Dashboard, Status, and History

- The frontend periodically calls `GET /api/status` using `fetchWithAuth` (with `x-user`).
- `server.js` uses:
  - `PortManager.getAllAllocations()` to get all apps and their ports/types.
  - `HistoryManager.getHistory()` to read deployment history.
  - `Deployer.getContainerStatuses()` to query running Docker containers.
- If the user is an **admin**:
  - Receives all apps, all developers, and full history.
- If the user is a **developer**:
  - Receives only their own apps and history.
- The frontend renders:
  - App cards with status, owner, and port.
  - A history list of deploy/delete events.
  - For **admins**, an additional "User Management" panel in the sidebar that lists all users and lets the admin add new users, edit usernames/roles/passwords, and remove users (backed by the `/api/admin/users` endpoints).

### 4.6 CI/CD and Runtime

- **GitHub Actions** (`.github/workflows/deploy.yml`):
  - Triggered on pushes to `main`.
  - Runs on a self‑hosted runner.
  - Fixes workspace permissions with sudo.
  - Checks out the code and runs `npm install --production`.
  - Ensures `uploads`, `builds`, and `data` directories exist.
  - Uses `pm2` (with sudo) to restart or start `server.js` under the name `build-hosting-platform` and saves the process list.

- **Runtime Process Management**:
  - `pm2` keeps the Node/Express app alive and restarts it on failures or server reboot (after `pm2 save` and `pm2 startup` are configured).

## 5. How to Use It (High Level)

1. **Set up the server**:
   - Install Node.js, npm, pm2, Docker, and Nginx.
   - Clone this repo to your server.
   - Configure `.env` paths and Nginx directories for your environment.

2. **Configure Nginx**:
   - Place `nginx/gateway.conf` into your Nginx config (or include it).
   - Ensure `NGINX_GATEWAY_ROUTES` and related paths exist and are writable(Sudo Permissions).

3. **Run locally (for testing)**:
   - `npm install`
   - `npm start`
   - Visit `http://<server>:3000/` to access the dashboard.

4. **Deploy via CI**:
   - Set up a self‑hosted GitHub Actions runner on your server.
   - Configure sudo/PM2 permissions and any required secrets.
   - Push to `main` to trigger the workflow and update the running app.

This document is meant as an overview; for exact API shapes and data formats, inspect `server.js` and the modules under `lib/` alongside the frontend logic in `public/js/app.js`.

  ## 6. Detailed Deployment Flows (Static & Docker)

  ### 6.1 Static (ZIP) App Deployment Internals

  When you upload a ZIP build, the backend uses `Deployer.deploy` in `lib/deployer.js`:

  1. **Validation**
    - `Validator.validateAppName(appName)` ensures the name is safe/unique.
    - `Validator.validateZipAndCheckIndex(zipFilePath)` checks the archive and confirms an `index.html` exists at the root.

  2. **Port allocation & metadata**
    - `PortManager.getAppMetadata(appName)` reads any existing allocation so it can be restored on failure.
    - `PortManager.allocatePort(appName, { username: owner, type: 'zip', category: 'frontend' })` reserves a free port and records metadata.

  3. **File extraction & backup**
    - The ZIP is extracted to a temporary path under `BUILD_ROOT`.
    - If an app with the same name already exists, its directory is moved into `BACKUP_ROOT` as a backup.

  4. **Finalizing the build directory**
    - `BUILD_ROOT` is created if missing and traversal permissions are fixed with `chmod` so Nginx can read it.
    - The extracted temp directory is moved to the final path `BUILD_ROOT/<appName>`.
    - Permissions on the app directory are relaxed with `chmod -R a+rX` so Nginx can serve the files.
    - A final sanity check ensures `index.html` exists at the app root.

  5. **Nginx configuration**
    - `NginxGenerator.generateAppConfig(appName, port)` writes a per‑app config pointing `/appName/` to the static build directory/port.
    - `NginxGenerator.updateGatewayConfig(appName, port)` adds or updates the route in the main gateway config.
    - `NginxGenerator.reloadNginx()` reloads Nginx so the new config takes effect.

  6. **History and cleanup**
    - `HistoryManager.log('upload', appName, owner, { port })` records the deployment event.
    - The uploaded ZIP file and any temp directories are removed.

  7. **Rollback on failure**
    - If any step fails, the deployer:
      - Restores the previous build from `BACKUP_ROOT` (if there was one).
      - Cleans temp directories and the uploaded file.
      - Removes Nginx configs for this app and reloads Nginx.
      - Restores or releases the port metadata in `PortManager`.

  ### 6.2 Docker Image Deployment Internals

  There are two Docker-based flows, both implemented in `lib/deployer.js`.

  #### 6.2.1 Deploying an existing image (`deployDocker`)

  Triggered by `POST /api/deploy-docker`:

  1. **Validation & metadata**
    - `Validator.validateAppName(appName)` validates the name.
    - `PortManager.getAppMetadata(appName)` captures existing metadata for rollback.

  2. **Port allocation**
    - `PortManager.allocatePort(appName, { username: owner, type: 'docker', category })` reserves a port and stores metadata (owner, type, category).

  3. **Cleaning existing resources**
    - Attempts to remove any existing Docker container with the same name: `sudo docker rm -f <appName>`.
    - Calls `NginxGenerator.removeConfigs(appName)` to delete old Nginx configs for this app.
    - Calls `NginxGenerator.removeSiteConfigsListeningOnPort(port)` to free up that host port.
    - Reloads Nginx so any stale bindings are released.

  4. **Starting the container (with retries)**
    - Builds a `docker run` command like:
      - `sudo docker run -d --name <appName> -p 0.0.0.0:<port>:<internalPort> --restart <policy> --memory <limit> --cpus <limit> <imageName>`
    - If Docker reports that the port is already in use, it:
      - Requests a new port from `PortManager` (excluding previously tried ports).
      - Cleans any configs on the new port and reloads Nginx.
      - Retries up to a few times before giving up.

  5. **Verifying the container**
    - Uses `sudo docker inspect -f '{{.State.Running}}' <appName>` with retries to confirm the container is running.

  6. **Nginx routing and verification**
    - Calls `NginxGenerator.updateGatewayConfig(appName, port)` to map `/appName/` to the container port.
    - Reloads Nginx.
    - Optionally uses `curl http://localhost/<appName>/` to confirm that the route responds (HTTP 200/301/302).

  7. **History and rollback**
    - Logs a `docker_deploy` event via `HistoryManager.log(...)` with port, image, and category.
    - On failure, it:
      - Removes the container if it was created.
      - Removes any Nginx configs for this app and reloads Nginx.
      - Restores previous port metadata or releases the new allocation.

  #### 6.2.2 Deploying from a Docker image tarball (`loadAndDeployDocker`)

  Triggered by `POST /api/upload-docker-image`:

  1. **Load the image**
    - Runs `sudo docker load -i <tarPath>` to import the image from the uploaded tarball.
    - Parses Docker’s output to extract the loaded image name (from lines like `Loaded image: myapp:latest`).

  2. **Verify the image**
    - Runs `sudo docker inspect <imageName>` to ensure the image exists and is valid.

  3. **Deploy using the normal Docker flow**
    - Calls `deployDocker(appName, imageName, owner, internalPort, category)` to follow the same steps as an existing image deployment (port allocation, container run, Nginx update, history, rollback handling).

  4. **Cleanup**
    - Deletes the uploaded tar file on success or failure to avoid leaving large artifacts on disk.