#!/usr/bin/env bash
# install-service.sh — Install/update the token-burner systemd service
# Usage: sudo ./install-service.sh [--uninstall]
set -euo pipefail

SERVICE_NAME="token-burner"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node 2>/dev/null || echo "/usr/bin/node")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }

# --- Uninstall ---
if [[ "${1:-}" == "--uninstall" ]]; then
    echo "Uninstalling ${SERVICE_NAME}..."
    systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
    rm -f "${SERVICE_FILE}"
    systemctl daemon-reload
    info "Service removed."
    exit 0
fi

# --- Preflight ---
[[ $EUID -eq 0 ]] || error "Must run as root (sudo ./install-service.sh)"
[[ -f "${SCRIPT_DIR}/bin/burn.js" ]] || error "bin/burn.js not found — run from repo root"
command -v node &>/dev/null || error "node not found in PATH"

# --- Write unit file ---
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Token Burner — Claude Code Subscription Optimizer
After=network.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_BIN} ${SCRIPT_DIR}/bin/burn.js --watch
Restart=on-failure
RestartSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
Environment=PATH=/usr/bin:/usr/local/bin:/root/.local/bin:/root/.nvm/current/bin

# Hardening
NoNewPrivileges=false
ProtectSystem=false

[Install]
WantedBy=multi-user.target
EOF

# --- Enable & start ---
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

sleep 2
if systemctl is-active --quiet "${SERVICE_NAME}"; then
    info "Service '${SERVICE_NAME}' installed and running."
    echo ""
    echo "  Status:  systemctl status ${SERVICE_NAME}"
    echo "  Logs:    journalctl -u ${SERVICE_NAME} -f"
    echo "  Stop:    systemctl stop ${SERVICE_NAME}"
    echo "  Remove:  sudo $0 --uninstall"
else
    warn "Service installed but not running. Check logs:"
    echo "  journalctl -u ${SERVICE_NAME} -n 30"
fi
