#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to log messages
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1"
}

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    error "Node.js is not installed"
    exit 1
fi

# Pull latest changes
log "Pulling latest changes from git..."
if ! git pull; then
    error "Git pull failed"
    exit 1
fi

# Check if any changes were pulled
if [ -n "$(git status --porcelain)" ]; then
    warn "There are uncommitted changes in the repository"
fi

# Install/update dependencies if package.json was changed
if git diff --name-only HEAD@{1} HEAD | grep -q "package.json"; then
    log "Package.json changed. Installing dependencies..."
    npm install
fi

# Determine environment
if [[ "$(hostname)" == "soletradeview-mvp" ]]; then
    export NODE_ENV=production
    log "Starting in production mode..."
else
    export NODE_ENV=development
    log "Starting in development mode..."
fi

# Start the application with error handling
if node index.js; then
    log "Application started successfully"
else
    error "Application failed to start"
    exit 1
fi
