#!/usr/bin/env bash
# Shuttle Client Install Script
# Usage:
#   install.sh --binary <path>         Install from a local pre-built binary
#   install.sh --url <url>             Download binary from URL
#   install.sh --binary <path> --system    Force system install (requires root)
#   install.sh --binary <path> --user      Force user install
#
# The binary MUST be pre-built with the PSK embedded at compile time.
# This script never compiles from source.
set -euo pipefail

BINARY_SRC=""
BINARY_URL=""
FORCE_MODE=""  # "system" | "user" | ""
SERVICE_NAME="shuttled"

# ─── Parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary) BINARY_SRC="$2"; shift 2 ;;
    --url)    BINARY_URL="$2"; shift 2 ;;
    --system) FORCE_MODE="system"; shift ;;
    --user)   FORCE_MODE="user"; shift ;;
    --help|-h)
      echo "Usage: install.sh [--binary <path>|--url <url>] [--system|--user]"
      exit 0
      ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$BINARY_SRC" && -z "$BINARY_URL" ]]; then
  echo "Error: must supply --binary <path> or --url <url>"
  echo "       The binary must be pre-built with your PSK embedded."
  exit 1
fi

# ─── Detect arch ──────────────────────────────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH_TAG="amd64" ;;
  aarch64|arm64) ARCH_TAG="arm64" ;;
  i686|i386) ARCH_TAG="386" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
echo "Detected arch: $ARCH_TAG"

# ─── Download if --url given ───────────────────────────────────────────────────
if [[ -n "$BINARY_URL" ]]; then
  TMP_BIN="$(mktemp)"
  echo "Downloading binary from $BINARY_URL ..."
  curl -fsSL --output "$TMP_BIN" "$BINARY_URL"
  chmod +x "$TMP_BIN"
  BINARY_SRC="$TMP_BIN"
fi

# Verify the binary is executable
if [[ ! -f "$BINARY_SRC" ]]; then
  echo "Error: binary not found: $BINARY_SRC"
  exit 1
fi
chmod +x "$BINARY_SRC"

# ─── Determine install mode ───────────────────────────────────────────────────
if [[ -z "$FORCE_MODE" ]]; then
  if [[ "$EUID" -eq 0 ]]; then
    FORCE_MODE="system"
  else
    FORCE_MODE="user"
    echo "Not running as root — installing user-level service."
    echo "  Use --system with sudo for a system-level install."
  fi
fi

# ─── System install ───────────────────────────────────────────────────────────
if [[ "$FORCE_MODE" == "system" ]]; then
  if [[ "$EUID" -ne 0 ]]; then
    echo "Error: --system requires root (run with sudo)"
    exit 1
  fi

  INSTALL_PATH="/usr/local/bin/shuttled"
  UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

  echo "Installing binary to $INSTALL_PATH ..."
  install -m 755 "$BINARY_SRC" "$INSTALL_PATH"

  echo "Writing systemd unit to $UNIT_PATH ..."
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Shuttle Fleet Client
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=${INSTALL_PATH}
ExecStopPost=${INSTALL_PATH} --rollback-check
Restart=always
RestartSec=5
KillMode=process
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  echo ""
  echo "✓ Shuttle client installed as system service: $SERVICE_NAME"
  echo "  Status: systemctl status $SERVICE_NAME"
  echo "  Logs:   journalctl -u $SERVICE_NAME -f"

# ─── User install ─────────────────────────────────────────────────────────────
else
  INSTALL_DIR="$HOME/.local/bin"
  INSTALL_PATH="$INSTALL_DIR/shuttled"
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_PATH="$UNIT_DIR/${SERVICE_NAME}.service"

  mkdir -p "$INSTALL_DIR" "$UNIT_DIR"

  echo "Installing binary to $INSTALL_PATH ..."
  install -m 755 "$BINARY_SRC" "$INSTALL_PATH"

  echo "Writing systemd user unit to $UNIT_PATH ..."
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Shuttle Fleet Client
After=network.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=${INSTALL_PATH}
ExecStopPost=${INSTALL_PATH} --rollback-check
Restart=always
RestartSec=5
KillMode=process
TimeoutStopSec=15

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
  echo ""
  echo "✓ Shuttle client installed as user service: $SERVICE_NAME"
  echo "  Status: systemctl --user status $SERVICE_NAME"
  echo "  Logs:   journalctl --user -u $SERVICE_NAME -f"
fi

# ─── Cleanup temp download ────────────────────────────────────────────────────
if [[ -n "$BINARY_URL" && -n "$TMP_BIN" ]]; then
  rm -f "$TMP_BIN"
fi

echo ""
echo "Install complete. The client will beacon to the manager on its next poll interval."
