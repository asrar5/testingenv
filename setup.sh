#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

printf "${GREEN}Starting Build Hosting Platform Setup...${NC}\n"

# 1. Environment Configuration
if [ ! -f .env ]; then
    printf "${GREEN}Creating .env file from defaults...${NC}\n"
    cat > .env <<ENV
# Server Configuration
PORT=3000
HOST=0.0.0.0

# Nginx Configuration
NGINX_DOMAIN=yourdomain.com
NGINX_SITES_AVAILABLE=/etc/nginx/sites-available
NGINX_SITES_ENABLED=/etc/nginx/sites-enabled
NGINX_GATEWAY_ROUTES=/etc/nginx/gateway-routes
NGINX_GATEWAY_CONFIG=/etc/nginx/gateway.conf

# Directory Paths (Absolute paths recommended)
BUILD_ROOT=$(pwd)/builds
UPLOAD_ROOT=$(pwd)/uploads
BACKUP_ROOT=$(pwd)/builds/.backups

# Data Store Paths
AUTH_PORTS_FILE=$(pwd)/data/ports.json
AUTH_HISTORY_FILE=$(pwd)/data/history.json
AUTH_USERS_FILE=$(pwd)/data/users.json

# Port Allocation Range
MIN_PORT=3320
MAX_PORT=3990

# Docker/Container Limits
DOCKER_MEMORY_LIMIT=512m
DOCKER_CPU_LIMIT=1
DOCKER_RESTART_POLICY=always

# Application Settings
HISTORY_MAX_ENTRIES=100
MAX_FILE_SIZE=1073741824
ENV
    printf "${GREEN}.env file created.${NC}\n"
else
    printf "${GREEN}Using existing .env file.${NC}\n"
fi

# Load Environment Variables
set -a
source .env
set +a

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
    printf "${RED}Node.js is not installed. Please install Node.js first.${NC}\n"
    exit 1
fi

# Check for Nginx
if ! command -v nginx >/dev/null 2>&1; then
    printf "${RED}Nginx is not installed. Please install Nginx first.${NC}\n"
    exit 1
fi

# Install dependencies
echo "Installing Node.js dependencies..."
npm install

# Create directories based on ENV
echo "Creating necessary directories..."
mkdir -p "$UPLOAD_ROOT" "$BUILD_ROOT" "$BACKUP_ROOT"
# Create parent dir for data files if needed
mkdir -p "$(dirname "$AUTH_PORTS_FILE")"
mkdir -p "$(dirname "$AUTH_HISTORY_FILE")"
mkdir -p "$(dirname "$AUTH_USERS_FILE")"

sudo mkdir -p "$NGINX_GATEWAY_ROUTES"

# Setup Nginx Gateway
echo "Setting up Nginx Gateway..."

# setup_sudoers function to auto-resolve permission issues
configure_sudoers() {
    local USERNAME=$(whoami)
    local SUDOORS_FILE="/etc/sudoers.d/hosting-platform-$USERNAME"
    
    if [ "$EUID" -ne 0 ]; then 
        echo "Please run setup.sh with sudo to automatically configure permissions."
        return
    fi

    # Do not run if we are root (unless we are configuring for a specific user, but usually we run setup as the user with sudo)
    # Actually, a better pattern is: 
    # if I am root, who is the real user? $SUDO_USER
    
    if [ -n "$SUDO_USER" ]; then
        USERNAME="$SUDO_USER"
    fi

    echo "Configuring passwordless sudo for user: $USERNAME"
    
    # List of commands required
    CMDS="/usr/bin/docker,/usr/bin/lsof,/bin/chmod,/bin/rm,/bin/mv,/bin/ln,/bin/mkdir,/bin/grep,/usr/sbin/nginx,/bin/systemctl,/usr/bin/systemctl"
    
    echo "$USERNAME ALL=(ALL) NOPASSWD: $CMDS" > "$SUDOORS_FILE"
    chmod 0440 "$SUDOORS_FILE"
    
    echo "Sudo permissions configured in $SUDOORS_FILE"
}

# Attempt to configure sudoers if running as root
if [ "$EUID" -eq 0 ]; then
    configure_sudoers
    
    # Also define the real user for permission fixing later
    REAL_USER=$(logname 2>/dev/null || echo $SUDO_USER)
    if [ -z "$REAL_USER" ]; then REAL_USER=$(whoami); fi
else
    REAL_USER=$(whoami)
    # Suggest running with sudo if we suspect limits (check a simple sudo command)
    if ! sudo -n true 2>/dev/null; then
         echo "${RED}Warning: Current user does not have passwordless sudo access.${NC}"
         echo "To automatically resolve this, run this script with sudo:"
         echo "  sudo ./setup.sh"
    fi
fi

GATEWAY_CONF="nginx/gateway.conf"
TARGET_CONF="$NGINX_SITES_AVAILABLE/hosting-gateway"
TARGET_LINK="$NGINX_SITES_ENABLED/hosting-gateway"

if [ -f "$GATEWAY_CONF" ]; then
    # We will use a temporary file to substitute variables
    TEMP_CONF=$(mktemp)
    cp "$GATEWAY_CONF" "$TEMP_CONF"
    
    # Replace domain in the temp config
    sed -i "s/yourdomain.com/$NGINX_DOMAIN/" "$TEMP_CONF"
    
    # Replace gateway routes path in includes
    # We look for "include /etc/nginx/gateway-routes" and replace the path part
    sed -i "s|/etc/nginx/gateway-routes|$NGINX_GATEWAY_ROUTES|g" "$TEMP_CONF"
    
    echo "Installing Gateway Config to $TARGET_CONF"
    sudo cp "$TEMP_CONF" "$TARGET_CONF"
    sudo ln -sf "$TARGET_CONF" "$TARGET_LINK"
    rm "$TEMP_CONF"
    
    # Test Nginx
    if sudo nginx -t; then
        echo "Nginx configuration valid."
    else
        printf "${RED}Nginx configuration test failed!${NC}\n"
    fi
    
    printf "${GREEN}Gateway configured for $NGINX_DOMAIN${NC}\n"
else
    printf "${RED}Gateway config template not found at $GATEWAY_CONF${NC}\n"
fi

# Set permissions
echo "Setting permissions..."
sudo chown -R $USER:$USER "$UPLOAD_ROOT" "$BUILD_ROOT" "$(dirname "$AUTH_PORTS_FILE")" 2>/dev/null || true

printf "${GREEN}Setup Complete!${NC}\n"
echo "To start the server:"
echo "  sudo node server.js"
echo ""

# Fix permissions for the real user
if [ -n "$REAL_USER" ] && [ "$REAL_USER" != "root" ]; then
    echo "Fixing permissions for user: $REAL_USER"
    chown -R "$REAL_USER:$REAL_USER" "$BUILD_ROOT" "$UPLOAD_ROOT" "$BACKUP_ROOT"
    chown -R "$REAL_USER:$REAL_USER" "$AUTH_PORTS_FILE" "$AUTH_HISTORY_FILE" "$AUTH_USERS_FILE" 2>/dev/null || true
    chown -R "$REAL_USER:$REAL_USER" "$(dirname "$AUTH_PORTS_FILE")"
fi

echo "Setup complete! Please restart the server."
