#!/bin/bash

# =============================================================================
# Tauri Build Script
# =============================================================================
# Builds the Tmuxy Tauri desktop application with native IPC communication
# (direct Tauri invoke/events for lower latency)
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

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Building Tmuxy Tauri Desktop App${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Parse arguments
BUILD_TYPE="release"
TARGET=""
VERBOSE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --debug)
            BUILD_TYPE="debug"
            shift
            ;;
        --target)
            TARGET="$2"
            shift 2
            ;;
        --verbose|-v)
            VERBOSE="--verbose"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --debug       Build in debug mode (default: release)"
            echo "  --target      Target triple (e.g., x86_64-unknown-linux-gnu)"
            echo "  --verbose,-v  Verbose output"
            echo "  --help,-h     Show this help"
            echo ""
            echo "Examples:"
            echo "  $0                    # Release build for current platform"
            echo "  $0 --debug            # Debug build"
            echo "  $0 --target x86_64-apple-darwin  # Build for macOS x64"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo -e "${YELLOW}Build Configuration:${NC}"
echo -e "   Mode: ${BUILD_TYPE}"
if [[ -n "$TARGET" ]]; then
    echo -e "   Target: ${TARGET}"
fi
echo ""

# Step 1: Install frontend dependencies if needed
if [[ ! -d "node_modules" ]]; then
    echo -e "${YELLOW}[1/4] Installing npm dependencies...${NC}"
    npm install
else
    echo -e "${YELLOW}[1/4] npm dependencies already installed${NC}"
fi
echo ""

# Step 2: Build Vite UI
echo -e "${YELLOW}[2/4] Building Vite UI...${NC}"
npm run build -w tmuxy-ui

if [[ ! -d "packages/tmuxy-ui/dist" ]]; then
    echo -e "${RED}Error: Vite build output not found at packages/tmuxy-ui/dist${NC}"
    exit 1
fi
echo -e "${GREEN}UI build complete${NC}"
echo ""

# Step 3: Build Tauri app
echo -e "${YELLOW}[3/4] Building Tauri desktop app...${NC}"

TAURI_ARGS=""
if [[ "$BUILD_TYPE" == "debug" ]]; then
    TAURI_ARGS="--debug"
fi
if [[ -n "$TARGET" ]]; then
    TAURI_ARGS="$TAURI_ARGS --target $TARGET"
fi
if [[ -n "$VERBOSE" ]]; then
    TAURI_ARGS="$TAURI_ARGS $VERBOSE"
fi

# Use npm run tauri build
cd packages/tauri-app
npx tauri build $TAURI_ARGS
cd ../..

echo -e "${GREEN}Tauri build complete${NC}"
echo ""

# Step 4: Report output location
echo -e "${YELLOW}[4/4] Build artifacts:${NC}"

if [[ "$BUILD_TYPE" == "debug" ]]; then
    BUNDLE_DIR="target/debug/bundle"
else
    BUNDLE_DIR="target/release/bundle"
fi

# Find and list built binaries
if [[ -d "$BUNDLE_DIR" ]]; then
    echo -e "${GREEN}Bundles created:${NC}"
    find "$BUNDLE_DIR" -type f \( -name "*.deb" -o -name "*.AppImage" -o -name "*.dmg" -o -name "*.app" -o -name "*.msi" -o -name "*.exe" \) 2>/dev/null | while read -r file; do
        size=$(du -h "$file" | cut -f1)
        echo -e "   ${file} (${size})"
    done
else
    # Check for binary directly
    if [[ "$BUILD_TYPE" == "debug" ]]; then
        BINARY="target/debug/tauri-app"
    else
        BINARY="target/release/tauri-app"
    fi
    if [[ -f "$BINARY" ]]; then
        size=$(du -h "$BINARY" | cut -f1)
        echo -e "   ${BINARY} (${size})"
    fi
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Tauri build complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}Notes:${NC}"
echo -e "   - This build uses Tauri IPC for communication"
echo -e "   - Lower latency than the web version due to direct IPC"
echo -e "   - Set TMUXY_SESSION env var to use a custom session name"
echo ""
