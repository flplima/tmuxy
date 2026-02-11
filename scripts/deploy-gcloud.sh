#!/bin/bash

# =============================================================================
# GCloud VM Deployment Script
# =============================================================================
# Builds Rust binary + Vite UI and deploys to GCloud VM via Cloud Storage
# Uses the same releases directory approach as other projects
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Change to project root
cd "$(dirname "$0")/.."

# Load .env
if [[ ! -f .env ]]; then
    echo -e "${RED}Error: .env file not found. Copy .env.example to .env and fill in values.${NC}"
    exit 1
fi
source .env

# Validate required env vars
for var in GCS_BUCKET GCLOUD_PROJECT GCLOUD_ZONE GCLOUD_INSTANCE; do
    if [[ -z "${!var}" ]]; then
        echo -e "${RED}Error: $var is not set in .env${NC}"
        exit 1
    fi
done

# Configuration
PROJECT="tmuxy"
PM2_NAME="tmuxy"
RELEASE_DATETIME=$(date +"%Y-%m-%d.%H-%M-%S")
RELEASE_FILE="${RELEASE_DATETIME}.${PROJECT}.tar.gz"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Deploying tmuxy to GCloud VM${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}Deployment Info:${NC}"
echo -e "   GCloud Project: ${GCLOUD_PROJECT}"
echo -e "   Instance: ${GCLOUD_INSTANCE}"
echo -e "   Zone: ${GCLOUD_ZONE}"
echo -e "   Release: ${RELEASE_DATETIME}"
echo ""

# Step 1: Build Vite UI
echo -e "${YELLOW}[1/5] Building Vite UI...${NC}"
npm run build

if [[ ! -d "packages/tmuxy-ui/dist" ]]; then
    echo -e "${RED}Error: Vite build output not found at packages/tmuxy-ui/dist${NC}"
    exit 1
fi
echo -e "${GREEN}UI build complete${NC}"
echo ""

# Step 2: Build Rust binary (release)
echo -e "${YELLOW}[2/5] Building Rust binary (release)...${NC}"
cargo build -p web-server --release

BINARY="target/release/tmuxy-web"
if [[ ! -f "$BINARY" ]]; then
    echo -e "${RED}Error: Binary not found at $BINARY${NC}"
    exit 1
fi
echo -e "${GREEN}Rust build complete${NC}"
echo ""

# Step 3: Create deployment bundle
echo -e "${YELLOW}[3/5] Creating deployment bundle...${NC}"

BUNDLE_DIR=$(mktemp -d)
trap "rm -rf ${BUNDLE_DIR}" EXIT

# Copy binary
cp "$BINARY" "${BUNDLE_DIR}/tmuxy-web"

# Copy Vite build output
cp -r packages/tmuxy-ui/dist "${BUNDLE_DIR}/dist"

# Create tarball
TARBALL_PATH="${BUNDLE_DIR}/${RELEASE_FILE}"
cd "${BUNDLE_DIR}"
tar -czf "${TARBALL_PATH}" tmuxy-web dist
cd - > /dev/null

TARBALL_SIZE=$(du -h "${TARBALL_PATH}" | cut -f1)
echo -e "${GREEN}Bundle created (${TARBALL_SIZE})${NC}"
echo ""

# Step 4: Upload to Cloud Storage
echo -e "${YELLOW}[4/5] Uploading to Cloud Storage...${NC}"
gsutil cp "${TARBALL_PATH}" "${GCS_BUCKET}/${RELEASE_FILE}"
echo -e "${GREEN}Upload complete${NC}"
echo ""

# Step 5: Deploy on VM
echo -e "${YELLOW}[5/5] Deploying on GCloud VM...${NC}"
gcloud compute ssh "${GCLOUD_INSTANCE}" \
    --project="${GCLOUD_PROJECT}" \
    --zone="${GCLOUD_ZONE}" \
    -- "~/deploy.sh ${PROJECT} ${RELEASE_DATETIME}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Deployment complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}App URL: https://tmuxy.felipelima.xyz${NC}"
echo -e "${BLUE}Completed at: $(date '+%Y-%m-%d %H:%M:%S %z')${NC}"
echo ""
echo -e "${YELLOW}Useful commands:${NC}"
echo -e "   View logs: gc-run 'pm2 logs ${PM2_NAME}'"
echo -e "   Restart:   gc-run 'pm2 restart ${PM2_NAME}'"
echo -e "   Status:    gc-run 'pm2 status'"
echo -e "   Releases:  gc-run 'ls -la ~/${PROJECT}.felipelima.xyz/releases/'"
echo ""
