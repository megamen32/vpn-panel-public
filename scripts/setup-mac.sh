#!/usr/bin/env bash
set -euo pipefail

VPN_DIR="$HOME/apps/vpn"
SCRIPT_URL="https://raw.githubusercontent.com/roomhacker/vpn-panel/main/scripts/test-routing.sh"

echo "=== Setup Mac for VPN routing tests ==="
mkdir -p "$VPN_DIR"
cd "$VPN_DIR"

if ! command -v docker &>/dev/null; then
  echo "Installing Docker via Homebrew..."
  if ! command -v brew &>/dev/null; then
    echo "Install Homebrew first: https://brew.sh"
    exit 1
  fi
  brew install --cask docker
  echo "Open Docker.app and start it, then re-run this script."
  exit 0
fi

echo "Docker: $(docker --version)"

echo "Pulling Xray image..."
docker pull ghcr.io/xtls/xray-core:v26.6.1

echo "Downloading test script..."
curl -fL "$SCRIPT_URL" -o "$VPN_DIR/test-routing.sh"
chmod +x "$VPN_DIR/test-routing.sh"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Get a subscription token from the admin panel:"
echo "   https://vpn.bezrabotnyi.com/admin"
echo ""
echo "2. Run the test:"
echo "   cd ~/apps/vpn && VPN_TOKEN=<your-token> ./test-routing.sh"
echo ""
echo "   Or with a specific endpoint:"
echo "   VPN_TOKEN=<token> VPN_ENDPOINT=smart-de-relay ./test-routing.sh"
echo "   VPN_TOKEN=<token> VPN_ENDPOINT=full-de-relay ./test-routing.sh"
echo "   VPN_TOKEN=<token> VPN_ENDPOINT=smart-us-relay ./test-routing.sh"
echo "   VPN_TOKEN=<token> VPN_ENDPOINT=full-us-relay ./test-routing.sh"
