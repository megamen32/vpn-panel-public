#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD_DIR="$SCRIPT_DIR/payload"
APP_DIR="$HOME/Library/Application Support/BezVPN"
CLI_DIR="$HOME/.local/bin"
CLI="$CLI_DIR/bez"
PLIST="$HOME/Library/LaunchAgents/com.bezrabotnyi.bez.plist"
LABEL="com.bezrabotnyi.bez"
DOMAIN="gui/$(id -u)"
BEZ_RELEASE_VERSION="v0.1.7"
BACKUP_ROOT="$APP_DIR/backups/$(date +%Y%m%d-%H%M%S)"

[[ "$(uname -s)" == Darwin ]] || { echo "Bez bundle: macOS only" >&2; exit 1; }
[[ -x "$PAYLOAD_DIR/xray" && -f "$PAYLOAD_DIR/codex-release/codex-package.json" && -x "$PAYLOAD_DIR/codex-release/bin/codex" && -f "$PAYLOAD_DIR/bez" && -f "$PAYLOAD_DIR/config-smart.json" && -f "$PAYLOAD_DIR/config-all.json" ]] || {
  echo "Bez bundle: incomplete payload" >&2
  exit 1
}

ARCH="$(uname -m)"
file "$PAYLOAD_DIR/xray" | grep -q "$ARCH" || {
  echo "Bez bundle: Xray architecture does not match $ARCH" >&2
  exit 1
}
file "$PAYLOAD_DIR/codex-release/bin/codex" | grep -q "$ARCH" || {
  echo "Bez bundle: Codex architecture does not match $ARCH" >&2
  exit 1
}

backup_existing() {
  local path backed=0
  for path in \
    "$CLI" \
    "$APP_DIR/bin/xray" \
    "$APP_DIR/config-smart.json" \
    "$APP_DIR/config-all.json" \
    "$APP_DIR/config.json" \
    "$APP_DIR/state" \
    "$APP_DIR/ports" \
    "$PLIST" \
    "$HOME/.codex/packages/standalone/current"; do
    if [[ -e "$path" || -L "$path" ]]; then
      if (( backed == 0 )); then mkdir -p "$BACKUP_ROOT"; fi
      cp -PpR "$path" "$BACKUP_ROOT/"
      backed=1
    fi
  done
  if (( backed )); then
    echo "Bez bundle: previous user installation backed up to $BACKUP_ROOT"
  fi
}

mkdir -p "$CLI_DIR" "$APP_DIR/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
backup_existing
install -m 700 "$PAYLOAD_DIR/bez" "$CLI"
install -m 755 "$PAYLOAD_DIR/xray" "$APP_DIR/bin/xray"
CODEX_RELEASE_NAME="codex-release-${BEZ_RELEASE_VERSION}-${ARCH}"
CODEX_RELEASES="$HOME/.codex/packages/standalone/releases"
mkdir -p "$CODEX_RELEASES"
if [[ -e "$CODEX_RELEASES/$CODEX_RELEASE_NAME" ]]; then
  [[ -x "$CODEX_RELEASES/$CODEX_RELEASE_NAME/bin/codex" ]] || {
    echo "Bez bundle: existing Codex release is incomplete" >&2
    exit 1
  }
else
  cp -R "$PAYLOAD_DIR/codex-release" "$CODEX_RELEASES/$CODEX_RELEASE_NAME"
fi
ln -sfn "$CODEX_RELEASES/$CODEX_RELEASE_NAME" "$HOME/.codex/packages/standalone/current"
ln -sfn "$HOME/.codex/packages/standalone/current/bin/codex" "$CLI_DIR/codex"
install -m 600 "$PAYLOAD_DIR/config-smart.json" "$APP_DIR/config-smart.json"
install -m 600 "$PAYLOAD_DIR/config-all.json" "$APP_DIR/config-all.json"
install -m 600 "$PAYLOAD_DIR/config-smart.json" "$APP_DIR/config.json"
install -m 600 "$PAYLOAD_DIR/state" "$APP_DIR/state"
install -m 600 "$PAYLOAD_DIR/ports" "$APP_DIR/ports"
: > "$APP_DIR/bundle-offline"
chmod 600 "$APP_DIR/bundle-offline"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$APP_DIR/bin/xray</string><string>run</string><string>-config</string><string>$APP_DIR/config.json</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/BezVPN.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/BezVPN.log</string>
</dict></plist>
PLIST
chmod 600 "$PLIST"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
"$CLI" smart --offline --local
echo "Bez bundle installed and smart mode enabled. No administrator password was used."
