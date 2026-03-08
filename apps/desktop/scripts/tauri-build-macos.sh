#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_TARGET_DIR="$APP_ROOT/src-tauri/target/release"
BUNDLE_MACOS_DIR="$TAURI_TARGET_DIR/bundle/macos"
APP_BUNDLE_PATH="$BUNDLE_MACOS_DIR/NyraQ.app"
DMG_DIR="$TAURI_TARGET_DIR/bundle/dmg"
DMG_PATH="$DMG_DIR/NyraQ_0.1.0_aarch64.dmg"

cleanup_stale_tauri_mounts() {
  local mounted_volume

  while IFS= read -r mounted_volume; do
    if [[ -n "$mounted_volume" && -d "$mounted_volume" ]]; then
      /usr/bin/hdiutil detach "$mounted_volume" -force >/dev/null 2>&1 || true
    fi
  done < <(/bin/ls -1d /Volumes/dmg.* 2>/dev/null || true)

  /bin/rm -f "$BUNDLE_MACOS_DIR"/rw.*.dmg
}

cleanup_stale_bundle_outputs() {
  /bin/rm -rf "$BUNDLE_MACOS_DIR"/*.app
  /bin/rm -f "$DMG_DIR"/*.dmg
}

mkdir -p "$DMG_DIR"
cleanup_stale_tauri_mounts
cleanup_stale_bundle_outputs

cd "$APP_ROOT"
npx tauri build --bundles app "$@"

if [[ ! -d "$APP_BUNDLE_PATH" ]]; then
  echo "Expected app bundle was not created: $APP_BUNDLE_PATH" >&2
  exit 1
fi

cleanup_stale_tauri_mounts
/bin/rm -f "$DMG_PATH"

/usr/bin/hdiutil create \
  -volname "NyraQ" \
  -srcfolder "$BUNDLE_MACOS_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "Created DMG: $DMG_PATH"