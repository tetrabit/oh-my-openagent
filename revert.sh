#!/usr/bin/env bash
set -euo pipefail

OPENCODE_REPO_URL="https://github.com/anomalyco/opencode.git"
PLUGIN_REPO_URL="https://github.com/code-yeongyu/oh-my-opencode.git"
OPENCODE_REF="dev"
PLUGIN_REF="dev"

NO_BACKUP=0
KEEP_WORKDIR=0
WORKDIR=""

OPENCODE_BIN_DST="$HOME/.opencode/bin/opencode"
CACHE_PLUGIN_DST="$HOME/.cache/opencode/node_modules/oh-my-opencode"
LOCAL_PLUGIN_DST="$HOME/.opencode/node_modules/oh-my-opencode"

usage() {
  cat <<'EOF'
Usage: ./revert.sh [options]

Reinstall upstream (clean/original) OpenCode + oh-my-opencode into the current user's home directory.

Options:
  --opencode-ref <ref>     Git ref for OpenCode repo (default: dev)
  --plugin-ref <ref>       Git ref for oh-my-opencode repo (default: dev)
  --opencode-repo <url>    Override OpenCode repo URL
  --plugin-repo <url>      Override oh-my-opencode repo URL
  --workdir <path>         Use existing work directory (default: mktemp)
  --keep-workdir           Do not delete work directory after completion
  --no-backup              Overwrite without creating timestamped backups
  --help                   Show this help message

Notes:
  - This script does NOT modify files under ~/.config/opencode.
  - It overwrites ~/.opencode/bin/opencode and plugin dist directories.
  - It builds from upstream source refs you choose.
EOF
}

log() {
  printf '[revert] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[revert] Missing required command: %s\n' "$1" >&2
    exit 1
  fi
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

  printf '[revert] Unsupported platform: %s/%s\n' "$os" "$arch" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --opencode-ref)
      OPENCODE_REF="${2:-}"
      shift
      ;;
    --plugin-ref)
      PLUGIN_REF="${2:-}"
      shift
      ;;
    --opencode-repo)
      OPENCODE_REPO_URL="${2:-}"
      shift
      ;;
    --plugin-repo)
      PLUGIN_REPO_URL="${2:-}"
      shift
      ;;
    --workdir)
      WORKDIR="${2:-}"
      shift
      ;;
    --keep-workdir)
      KEEP_WORKDIR=1
      ;;
    --no-backup)
      NO_BACKUP=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '[revert] Unknown option: %s\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

require_cmd bun
require_cmd git

if [[ -z "$WORKDIR" ]]; then
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ohmyopencode-revert.XXXXXX")"
else
  mkdir -p "$WORKDIR"
fi

if [[ "$KEEP_WORKDIR" -eq 0 ]]; then
  trap 'rm -rf "$WORKDIR"' EXIT
fi

OPENCODE_SRC_DIR="$WORKDIR/opencode"
PLUGIN_SRC_DIR="$WORKDIR/oh-my-opencode"

log "Using work directory: $WORKDIR"

log "Cloning OpenCode upstream ($OPENCODE_REF)"
git clone --depth 1 --branch "$OPENCODE_REF" "$OPENCODE_REPO_URL" "$OPENCODE_SRC_DIR"

log "Cloning oh-my-opencode upstream ($PLUGIN_REF)"
git clone --depth 1 --branch "$PLUGIN_REF" "$PLUGIN_REPO_URL" "$PLUGIN_SRC_DIR"

log "Installing/building OpenCode"
(cd "$OPENCODE_SRC_DIR" && bun install)
(cd "$OPENCODE_SRC_DIR/packages/opencode" && bun run script/build.ts --single --skip-install)

log "Installing/building oh-my-opencode"
(cd "$PLUGIN_SRC_DIR" && bun install)
(cd "$PLUGIN_SRC_DIR" && bun run build)

PLATFORM_TRIPLET="$(detect_platform_triplet)"
OPENCODE_BIN_SRC="$OPENCODE_SRC_DIR/packages/opencode/dist/opencode-$PLATFORM_TRIPLET/bin/opencode"
PLUGIN_DIST_SRC="$PLUGIN_SRC_DIR/dist"

if [[ ! -x "$OPENCODE_BIN_SRC" ]]; then
  printf '[revert] Missing built binary: %s\n' "$OPENCODE_BIN_SRC" >&2
  exit 1
fi

if [[ ! -d "$PLUGIN_DIST_SRC" ]]; then
  printf '[revert] Missing plugin dist directory: %s\n' "$PLUGIN_DIST_SRC" >&2
  exit 1
fi

PLUGIN_TARGETS=("$CACHE_PLUGIN_DST")
if [[ -d "$LOCAL_PLUGIN_DST" ]]; then
  PLUGIN_TARGETS+=("$LOCAL_PLUGIN_DST")
fi

if [[ "$NO_BACKUP" -eq 0 ]]; then
  BACKUP_DIR="$HOME/.opencode/backups/ohmyopencode-extension-revert/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  log "Backing up existing install to $BACKUP_DIR"
  backup_path "$OPENCODE_BIN_DST" "$BACKUP_DIR"
  for target in "${PLUGIN_TARGETS[@]}"; do
    backup_path "$target/dist" "$BACKUP_DIR"
    backup_path "$target/package.json" "$BACKUP_DIR"
    backup_path "$target/postinstall.mjs" "$BACKUP_DIR"
  done
fi

log "Installing upstream OpenCode binary to $OPENCODE_BIN_DST"
mkdir -p "$(dirname "$OPENCODE_BIN_DST")"
install -m 0755 "$OPENCODE_BIN_SRC" "$OPENCODE_BIN_DST"

for target in "${PLUGIN_TARGETS[@]}"; do
  log "Installing upstream plugin dist to $target"
  mkdir -p "$target"
  rm -rf "$target/dist"
  cp -a "$PLUGIN_DIST_SRC" "$target/dist"

  if [[ -f "$PLUGIN_SRC_DIR/package.json" ]]; then
    install -m 0644 "$PLUGIN_SRC_DIR/package.json" "$target/package.json"
  fi

  if [[ -f "$PLUGIN_SRC_DIR/postinstall.mjs" ]]; then
    install -m 0644 "$PLUGIN_SRC_DIR/postinstall.mjs" "$target/postinstall.mjs"
  fi
done

log "Revert complete"
log "Config files were left untouched under ~/.config/opencode"
"$OPENCODE_BIN_DST" --version
