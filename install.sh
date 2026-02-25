#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_DIR="$ROOT_DIR/opencode-platform/packages/opencode"
PLUGIN_DIR="$ROOT_DIR/oh-my-opencode"

OPENCODE_BIN_SRC=""
PLUGIN_DIST_SRC="$PLUGIN_DIR/dist"

OPENCODE_BIN_DST="$HOME/.opencode/bin/opencode"
CACHE_PLUGIN_DST="$HOME/.cache/opencode/node_modules/oh-my-opencode"
LOCAL_PLUGIN_DST="$HOME/.opencode/node_modules/oh-my-opencode"
PATCH_DISPLAY_VERSION="1.2.11-nullpatch"

SKIP_BUILD=0
NO_BACKUP=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Build and install patched OpenCode + oh-my-opencode into the current user's home directory.

Options:
  --skip-build   Skip build steps and install existing artifacts.
  --no-backup    Overwrite without creating timestamped backups.
  --help         Show this help message.

Notes:
  - This script does NOT modify files under ~/.config/opencode.
  - It overwrites ~/.opencode/bin/opencode and plugin dist directories.
EOF
}

log() {
  printf '[install] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[install] Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

detect_platform_triplet() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  if [[ "$os" == "linux" && "$arch" == "x86_64" ]]; then
    printf 'linux-x64'
    return
  fi

  if [[ "$os" == "linux" && "$arch" == "aarch64" ]]; then
    printf 'linux-arm64'
    return
  fi

  if [[ "$os" == "darwin" && "$arch" == "x86_64" ]]; then
    printf 'darwin-x64'
    return
  fi

  if [[ "$os" == "darwin" && "$arch" == "arm64" ]]; then
    printf 'darwin-arm64'
    return
  fi

  printf '[install] Unsupported platform: %s/%s\n' "$os" "$arch" >&2
  exit 1
}

backup_path() {
  local source_path="$1"
  local backup_root="$2"
  if [[ ! -e "$source_path" ]]; then
    return
  fi

  local safe_name
  safe_name="${source_path#/}"
  safe_name="${safe_name//\//__}"
  cp -a "$source_path" "$backup_root/$safe_name"
}

write_opencode_wrapper() {
  local wrapper_path="$1"
  local real_path="$2"
  local tmp_path
  tmp_path="${wrapper_path}.tmp.$$"
  cat >"$tmp_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export OPENCODE_DISABLE_AUTOUPDATE=1
if [[ "\$#" -ge 1 && "\$1" == "--version" ]]; then
  real_version="\$("$real_path" --version)"
  case "\$real_version" in
    *-nullpatch) printf '%s\n' "\$real_version" ;;
    *) printf '%s\n' "\${real_version}-nullpatch" ;;
  esac
  exit 0
fi
exec "$real_path" "\$@"
EOF
  chmod 0755 "$tmp_path"
  mv -f "$tmp_path" "$wrapper_path"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    --no-backup)
      NO_BACKUP=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '[install] Unknown option: %s\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

require_cmd bun

if [[ ! -d "$OPENCODE_DIR" || ! -d "$PLUGIN_DIR" ]]; then
  printf '[install] Script must be run from repository root (or symlinked there).\n' >&2
  exit 1
fi

PLATFORM_TRIPLET="$(detect_platform_triplet)"
OPENCODE_BIN_SRC="$OPENCODE_DIR/dist/opencode-$PLATFORM_TRIPLET/bin/opencode"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "Building opencode binary"
  (cd "$OPENCODE_DIR" && bun run script/build.ts --single --skip-install)

  log "Building oh-my-opencode dist and binaries"
  (cd "$PLUGIN_DIR" && bun run build:all)
fi

if [[ ! -x "$OPENCODE_BIN_SRC" ]]; then
  printf '[install] Missing built binary: %s\n' "$OPENCODE_BIN_SRC" >&2
  exit 1
fi

if [[ ! -d "$PLUGIN_DIST_SRC" ]]; then
  printf '[install] Missing plugin dist directory: %s\n' "$PLUGIN_DIST_SRC" >&2
  exit 1
fi

PLUGIN_TARGETS=("$CACHE_PLUGIN_DST" "$LOCAL_PLUGIN_DST")

BIN_TARGETS=("$OPENCODE_BIN_DST")
ACTIVE_OPENCODE_PATH="$(command -v opencode 2>/dev/null || true)"
if [[ -n "$ACTIVE_OPENCODE_PATH" && "$ACTIVE_OPENCODE_PATH" != "$OPENCODE_BIN_DST" ]]; then
  case "$ACTIVE_OPENCODE_PATH" in
    "$HOME"/*)
      BIN_TARGETS+=("$ACTIVE_OPENCODE_PATH")
      log "Detected active opencode at $ACTIVE_OPENCODE_PATH (will update it too)"
      ;;
    *)
      log "Detected active opencode at $ACTIVE_OPENCODE_PATH (outside home; leaving unchanged)"
      ;;
  esac
fi

BACKUP_DIR=""
if [[ "$NO_BACKUP" -eq 0 ]]; then
  BACKUP_DIR="$HOME/.opencode/backups/ohmyopencode-extension/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  log "Backing up existing install to $BACKUP_DIR"
  for bin_target in "${BIN_TARGETS[@]}"; do
    backup_path "$bin_target" "$BACKUP_DIR"
    backup_path "$bin_target.real" "$BACKUP_DIR"
  done
  for target in "${PLUGIN_TARGETS[@]}"; do
    backup_path "$target/dist" "$BACKUP_DIR"
    backup_path "$target/bin" "$BACKUP_DIR"
    backup_path "$target/packages" "$BACKUP_DIR"
    backup_path "$target/package.json" "$BACKUP_DIR"
    backup_path "$target/postinstall.mjs" "$BACKUP_DIR"
  done
fi

for bin_target in "${BIN_TARGETS[@]}"; do
  log "Installing opencode binary to $bin_target.real"
  mkdir -p "$(dirname "$bin_target")"
  install -m 0755 "$OPENCODE_BIN_SRC" "$bin_target.real"
  write_opencode_wrapper "$bin_target" "$bin_target.real"
done

for target in "${PLUGIN_TARGETS[@]}"; do
  log "Installing plugin dist to $target"
  mkdir -p "$target"
  rm -rf "$target/dist" "$target/bin" "$target/packages"
  cp -a "$PLUGIN_DIST_SRC" "$target/dist"
  
  if [[ -d "$PLUGIN_DIR/bin" ]]; then
    cp -a "$PLUGIN_DIR/bin" "$target/bin"
  fi
  
  if [[ -d "$PLUGIN_DIR/packages" ]]; then
    cp -a "$PLUGIN_DIR/packages" "$target/packages"
  fi

  if [[ -f "$PLUGIN_DIR/package.json" ]]; then
    install -m 0644 "$PLUGIN_DIR/package.json" "$target/package.json"
  fi

  if [[ -f "$PLUGIN_DIR/postinstall.mjs" ]]; then
    install -m 0644 "$PLUGIN_DIR/postinstall.mjs" "$target/postinstall.mjs"
  fi
done

RUNTIME_STATE_DIR="$HOME/.opencode"
RUNTIME_PACKAGE_JSON="$RUNTIME_STATE_DIR/package.json"
CACHE_STATE_DIR="$HOME/.cache/opencode"
CACHE_PACKAGE_JSON="$CACHE_STATE_DIR/package.json"
RUNTIME_PLUGIN_PACKAGE_JSON="$HOME/.opencode/node_modules/@opencode-ai/plugin/package.json"

RUNTIME_PLUGIN_VERSION=""
if [[ -f "$RUNTIME_PLUGIN_PACKAGE_JSON" ]]; then
  RUNTIME_PLUGIN_VERSION="$(grep -m1 '"version"' "$RUNTIME_PLUGIN_PACKAGE_JSON" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
fi

if [[ -z "$RUNTIME_PLUGIN_VERSION" ]]; then
  RUNTIME_PLUGIN_VERSION="1.2.11"
fi

mkdir -p "$RUNTIME_STATE_DIR"
cat >"$RUNTIME_PACKAGE_JSON" <<EOF
{
  "dependencies": {
    "@opencode-ai/plugin": "$RUNTIME_PLUGIN_VERSION"
  }
}
EOF

mkdir -p "$CACHE_STATE_DIR"
cat >"$CACHE_PACKAGE_JSON" <<EOF
{
  "dependencies": {
    "@opencode-ai/plugin": "$RUNTIME_PLUGIN_VERSION"
  }
}
EOF
log "Updated runtime package metadata with @opencode-ai/plugin@$RUNTIME_PLUGIN_VERSION"

log "Install complete"
log "Config files were left untouched under ~/.config/opencode"

EXPECTED_VERSION="$($OPENCODE_BIN_SRC --version)"
for bin_target in "${BIN_TARGETS[@]}"; do
  INSTALLED_VERSION="$($bin_target.real --version)"
  if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
    printf '[install] Version mismatch at %s (expected %s, got %s)\n' "$bin_target" "$EXPECTED_VERSION" "$INSTALLED_VERSION" >&2
    exit 1
  fi
done

log "Installed binary version: $EXPECTED_VERSION"
log "Displayed CLI version: $PATCH_DISPLAY_VERSION"
if [[ -n "$ACTIVE_OPENCODE_PATH" ]]; then
  log "Active opencode path: $ACTIVE_OPENCODE_PATH"
fi
