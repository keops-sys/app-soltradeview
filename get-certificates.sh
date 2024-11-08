#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log() { echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"; }
error() { echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1"; }

# Create certificates directory structure
mkdir -p certs/production
mkdir -p certs/development

# Function to generate development certificates
generate_dev_certs() {
    log "Generating development certificates..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout certs/development/localhost.key \
        -out certs/development/localhost.cert \
        -subj "/CN=localhost" \
        && log "Development certificates generated successfully" \
        || error "Failed to generate development certificates"
}

# Function to fetch production certificates
fetch_prod_certs() {
    log "Fetching production certificates..."
    
    # Check if acme.sh is installed
    if ! command -v acme.sh &> /dev/null; then
        error "acme.sh is not installed"
        exit 1
    fi

    # Revoke existing certificate if it exists
    acme.sh --revoke -d soltradeview.com || warn "No certificate to revoke or revocation failed"

    # Generate new certificate
    acme.sh --issue --standalone \
        -d soltradeview.com \
        -d www.soltradeview.com \
        -d app.soltradeview.com \
        || { error "Failed to generate certificates"; exit 1; }

    # Copy certificates to project
    local cert_source="/root/.acme.sh/soltradeview.com_ecc"
    local cert_dest="certs/production"

    cp "${cert_source}/soltradeview.com.key" "${cert_dest}/" \
        && cp "${cert_source}/fullchain.cer" "${cert_dest}/" \
        && cp "${cert_source}/ca.cer" "${cert_dest}/" \
        && log "Production certificates copied successfully" \
        || { error "Failed to copy certificates"; exit 1; }
}

# Main execution
case "$1" in
    "dev")
        generate_dev_certs
        ;;
    "prod")
        if [[ $EUID -ne 0 ]]; then
            error "Production certificate generation must be run as root"
            exit 1
        fi
        fetch_prod_certs
        ;;
    *)
        echo "Usage: $0 [dev|prod]"
        echo "  dev  - Generate development certificates"
        echo "  prod - Fetch production certificates (requires root)"
        exit 1
        ;;
esac

# Create/update .gitignore
cat > certs/.gitignore << EOL
# Ignore all files in this directory
*
# Except this file
!.gitignore
# And the development directory
!development/
EOL

log "Certificate setup completed"