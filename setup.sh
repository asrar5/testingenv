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
