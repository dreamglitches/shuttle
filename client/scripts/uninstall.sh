#!/usr/bin/env bash
# Shuttle Client Uninstall Script
# Idempotent: safe to run multiple times.
# Removes: binary, systemd unit, any leftover ephemeral extraction dirs or tmux sessions.
set -euo pipefail

SERVICE_NAME="shuttled"

echo "Uninstalling Shuttle client..."

# ─── Stop and disable systemd service ────────────────────────────────────────
stop_service() {
  local scope="$1"  # "" (system) or "--user"
  if systemctl $scope is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Stopping service ($scope)..."
    systemctl $scope stop "$SERVICE_NAME" || true
  fi
  if systemctl $scope is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Disabling service ($scope)..."
    systemctl $scope disable "$SERVICE_NAME" || true
  fi
}

if [[ "$EUID" -eq 0 ]]; then
  stop_service ""
  # Also try user in case it was installed both ways
  stop_service "--user" 2>/dev/null || true
else
  stop_service "--user" 2>/dev/null || true
fi

# ─── Remove unit files ────────────────────────────────────────────────────────
SYSTEM_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
USER_UNIT="$HOME/.config/systemd/user/${SERVICE_NAME}.service"

if [[ -f "$SYSTEM_UNIT" ]]; then
  echo "Removing $SYSTEM_UNIT"
  rm -f "$SYSTEM_UNIT"
  systemctl daemon-reload 2>/dev/null || true
fi

if [[ -f "$USER_UNIT" ]]; then
  echo "Removing $USER_UNIT"
  rm -f "$USER_UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
fi

# ─── Remove binary ────────────────────────────────────────────────────────────
for BIN_PATH in "/usr/local/bin/shuttled" "$HOME/.local/bin/shuttled"; do
  if [[ -f "$BIN_PATH" ]]; then
    echo "Removing $BIN_PATH"
    rm -f "$BIN_PATH"
  fi
  if [[ -f "${BIN_PATH}.prev" ]]; then
    echo "Removing ${BIN_PATH}.prev (update backup)"
    rm -f "${BIN_PATH}.prev"
  fi
done

# ─── Kill any orphaned tmux sessions ─────────────────────────────────────────
echo "Cleaning up orphaned tmux sessions..."
if command -v tmux &>/dev/null; then
  # Kill any sessions with our naming prefix (s-* interactive, c-* command exec)
  tmux ls -F "#{session_name}" 2>/dev/null | grep -E '^[sc]-[0-9a-f]{8}' | while read -r name; do
    echo "  Killing tmux session: $name"
    tmux kill-session -t "$name" 2>/dev/null || true
  done
fi

# ─── Remove ephemeral extraction dirs ────────────────────────────────────────
echo "Cleaning up ephemeral temp dirs..."
# Pattern: /tmp/.<8-hex-chars>  (mode 700, created by shuttled)
find /tmp -maxdepth 1 -name '.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' \
     -type d 2>/dev/null | while read -r dir; do
  echo "  Removing $dir"
  rm -rf "$dir"
done

# ─── Remove fallback ID file ──────────────────────────────────────────────────
FALLBACK_ID="$HOME/.shuttled_id"
if [[ -f "$FALLBACK_ID" ]]; then
  echo "Removing fallback server ID file: $FALLBACK_ID"
  rm -f "$FALLBACK_ID"
fi

echo ""
echo "✓ Shuttle client uninstalled. No artifacts remain."
