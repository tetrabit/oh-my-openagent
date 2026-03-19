#!/usr/bin/env bash

set -euo pipefail

NVM_VERSION="v0.40.3"      # https://github.com/nvm-sh/nvm/releases
NODE_VERSION="lts/*"       # "lts/*" | "22" | specific version

OMO_CONFIG_DST="$HOME/.config/opencode/oh-my-opencode.json"

: "${OMO_REPO_URL:=https://github.com/tetrabit/oh-my-openagent.git}"
: "${OMO_REPO_REF:=main}"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
SKIP_SYSTEM_DEPS=0
SKIP_BUN=0
SKIP_NODE=0
SKIP_PATCHED_INSTALL=0
SKIP_CONFIG=0
SKIP_BUILD=0
NO_BACKUP=0

usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [options]

Fresh-machine setup: Bun + nvm/Node + patched OpenCode + oh-my-opencode + config.

Options:
  --skip-system-deps
                   Skip installing/updating OS package prerequisites
  --skip-bun        Skip Bun installation
  --skip-node       Skip nvm + Node.js installation
  --skip-patched-install
                   Skip running this repo's install.sh
  --skip-config     Skip deploying oh-my-opencode.json config
  --skip-build      Pass --skip-build to install.sh
  --no-backup       Pass --no-backup to install.sh
  --help            Show this help

Notes:
  - Supports Debian/Ubuntu and Arch-like Linux distributions.
  - Re-runs system package installation to install or upgrade prerequisites.
  - Safe to re-run on an existing machine (idempotent).
  - Uses the patched/local OpenCode build from this repo (not opencode.ai installer).
  - Auth is NOT configured — run 'opencode auth login' after setup.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-system-deps) SKIP_SYSTEM_DEPS=1 ;;
    --skip-bun)      SKIP_BUN=1 ;;
    --skip-node)     SKIP_NODE=1 ;;
    --skip-patched-install) SKIP_PATCHED_INSTALL=1 ;;
    --skip-config)   SKIP_CONFIG=1 ;;
    --skip-build)    SKIP_BUILD=1 ;;
    --no-backup)     NO_BACKUP=1 ;;
    --help|-h)       usage; exit 0 ;;
    *) printf '[bootstrap] Unknown option: %s\n' "$1" >&2; usage; exit 1 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

log()     { printf "${CYAN}[bootstrap]${RESET} %s\n" "$1"; }
ok()      { printf "${GREEN}[bootstrap]${RESET} ${BOLD}OK${RESET}  %s\n" "$1"; }
warn()    { printf "${YELLOW}[bootstrap]${RESET} ${BOLD}WARN${RESET} %s\n" "$1"; }
fail()    { printf "${RED}[bootstrap]${RESET} ${BOLD}FAIL${RESET} %s\n" "$1" >&2; exit 1; }
step()    { printf "\n${BOLD}${CYAN}━━━ %s ━━━${RESET}\n" "$1"; }
skipped() { printf "${DIM}[bootstrap] SKIP %s${RESET}\n" "$1"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1. Install it and retry."
}

require_linux() {
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  [[ "$os" == "linux" ]] || fail "This bootstrap currently supports Linux only."
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  if command -v doas >/dev/null 2>&1; then
    doas "$@"
    return
  fi

  fail "Root privileges are required to install system prerequisites. Install sudo/doas or re-run as root."
}

DISTRO_FAMILY=""

detect_linux_family() {
  local distro_id=""
  local distro_like=""

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    distro_id="${ID:-}"
    distro_like="${ID_LIKE:-}"
  fi

  case " ${distro_id} ${distro_like} " in
    *" debian "*|*" ubuntu "*|*" linuxmint "*|*" neon "*|*" pop "*|*" raspbian "*)
      DISTRO_FAMILY="debian"
      ;;
    *" arch "*|*" cachyos "*|*" endeavouros "*|*" manjaro "*)
      DISTRO_FAMILY="arch"
      ;;
    *)
      if command -v apt-get >/dev/null 2>&1; then
        DISTRO_FAMILY="debian"
      elif command -v pacman >/dev/null 2>&1; then
        DISTRO_FAMILY="arch"
      else
        fail "Unsupported Linux distribution. Supported families: Debian/Ubuntu and Arch-like."
      fi
      ;;
  esac
}

verify_system_prereqs() {
  require_cmd git
  require_cmd curl
  require_cmd unzip
  require_cmd python3
  require_cmd make

  if ! command -v gcc >/dev/null 2>&1 && ! command -v cc >/dev/null 2>&1; then
    fail "Required compiler not found: gcc/cc"
  fi

  if ! command -v pkg-config >/dev/null 2>&1; then
    fail "Required command not found: pkg-config"
  fi
}

ensure_system_prereqs() {
  detect_linux_family

  case "$DISTRO_FAMILY" in
    debian)
      local packages=(
        ca-certificates
        curl
        git
        unzip
        xz-utils
        python3
        build-essential
        pkg-config
      )
      log "Updating apt package index..."
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update
      log "Installing/upgrading bootstrap prerequisites via apt..."
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
      ;;
    arch)
      local packages=(
        ca-certificates
        curl
        git
        unzip
        xz
        python
        make
        gcc
        pkgconf
      )
      log "Installing/upgrading bootstrap prerequisites via pacman..."
      log "Arch-like systems use a full sync upgrade here to avoid partial-upgrade breakage."
      run_privileged pacman -Syu --noconfirm --needed "${packages[@]}"
      ;;
    *)
      fail "Unsupported distro family: $DISTRO_FAMILY"
      ;;
  esac

  verify_system_prereqs
  ok "System prerequisites ready for $DISTRO_FAMILY-based Linux"
}

# Reload shell environment so newly installed tools are on PATH
reload_path() {
  # Bun
  [[ -d "$HOME/.bun/bin" ]] && export PATH="$HOME/.bun/bin:$PATH"
  # nvm
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
  # npm global bins
  [[ -d "$HOME/.npm-global/bin" ]] && export PATH="$HOME/.npm-global/bin:$PATH"
  # Standard local bins
  [[ -d "$HOME/.local/bin" ]] && export PATH="$HOME/.local/bin:$PATH"
}

# ---------------------------------------------------------------------------
# Detect whether we were piped from curl
# ---------------------------------------------------------------------------
RUNNING_REMOTE=0
if [[ "${BASH_SOURCE[0]}" == "" || "${BASH_SOURCE[0]}" == "bash" ]]; then
  RUNNING_REMOTE=1
fi

REPO_DIR=""
TEMP_CLONE_DIR=""

cleanup() {
  if [[ -n "$TEMP_CLONE_DIR" && -d "$TEMP_CLONE_DIR" ]]; then
    rm -rf "$TEMP_CLONE_DIR"
  fi
}

trap cleanup EXIT

resolve_repo_dir() {
  local candidate_dir=""

  if [[ "$RUNNING_REMOTE" -eq 0 ]]; then
    candidate_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ -f "$candidate_dir/install.sh" && -d "$candidate_dir/opencode-platform/packages/opencode" && -d "$candidate_dir/oh-my-opencode" ]]; then
      REPO_DIR="$candidate_dir"
      return
    fi

    warn "Bootstrap is not running from a complete repo checkout. Falling back to remote clone."
  fi

  require_cmd git
  TEMP_CLONE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/omo-bootstrap.XXXXXX")"
  log "Cloning $OMO_REPO_URL ($OMO_REPO_REF) ..."
  git clone --depth 1 --branch "$OMO_REPO_REF" "$OMO_REPO_URL" "$TEMP_CLONE_DIR"
  REPO_DIR="$TEMP_CLONE_DIR"
}

validate_repo_layout() {
  [[ -f "$REPO_DIR/install.sh" ]] || fail "Missing $REPO_DIR/install.sh"
  [[ -d "$REPO_DIR/opencode-platform/packages/opencode" ]] || fail "Missing $REPO_DIR/opencode-platform/packages/opencode (patched OpenCode source)"
  [[ -d "$REPO_DIR/oh-my-opencode" ]] || fail "Missing $REPO_DIR/oh-my-opencode (plugin source)"
}

# ---------------------------------------------------------------------------
# Step 1: System prerequisites
# ---------------------------------------------------------------------------
require_linux

step "Step 1/6 — System prerequisites"

if [[ "$SKIP_SYSTEM_DEPS" -eq 1 ]]; then
  skipped "System prerequisites (--skip-system-deps)"
else
  ensure_system_prereqs
fi

# ---------------------------------------------------------------------------
# Step 2: Bun
# ---------------------------------------------------------------------------
step "Step 2/6 — Bun"

if [[ "$SKIP_BUN" -eq 1 ]]; then
  skipped "Bun (--skip-bun)"
else
  reload_path
  if command -v bun >/dev/null 2>&1; then
    BUN_VERSION_BEFORE="$(bun --version)"
    log "Updating Bun (current: $BUN_VERSION_BEFORE)..."
    if bun upgrade; then
      reload_path
      ok "Bun ready ($(bun --version))"
    else
      warn "bun upgrade failed. Reinstalling Bun via the official installer."
      require_cmd curl
      curl -fsSL https://bun.sh/install | bash
      reload_path
      command -v bun >/dev/null 2>&1 || fail "Bun installation failed. Check https://bun.sh/docs/installation"
      ok "Bun ready ($(bun --version))"
    fi
  else
    log "Installing Bun..."
    require_cmd curl
    curl -fsSL https://bun.sh/install | bash
    reload_path
    if command -v bun >/dev/null 2>&1; then
      ok "Bun installed ($(bun --version))"
    else
      fail "Bun installation failed. Check https://bun.sh/docs/installation"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: nvm + Node.js
# ---------------------------------------------------------------------------
step "Step 3/6 — nvm + Node.js"

if [[ "$SKIP_NODE" -eq 1 ]]; then
  skipped "nvm + Node.js (--skip-node)"
else
  reload_path
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh"
    CURRENT_NVM_VERSION="$(nvm --version 2>/dev/null || true)"
    TARGET_NVM_VERSION="${NVM_VERSION#v}"

    if [[ "$CURRENT_NVM_VERSION" != "$TARGET_NVM_VERSION" ]]; then
      log "Updating nvm from ${CURRENT_NVM_VERSION:-unknown} to $NVM_VERSION..."
      if [[ -d "$NVM_DIR/.git" ]]; then
        require_cmd git
        git -C "$NVM_DIR" fetch --tags origin
        git -C "$NVM_DIR" checkout "$NVM_VERSION"
      else
        OLD_PROFILE="${PROFILE-__OMO_UNSET__}"
        require_cmd curl
        export PROFILE="${PROFILE:-$HOME/.bashrc}"
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
        if [[ "$OLD_PROFILE" == "__OMO_UNSET__" ]]; then
          unset PROFILE
        else
          export PROFILE="$OLD_PROFILE"
        fi
      fi
      reload_path
    fi

    ok "nvm ready ($(nvm --version))"
  else
    log "Installing nvm $NVM_VERSION..."
    require_cmd curl
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
    reload_path
    if [[ -s "$NVM_DIR/nvm.sh" ]]; then
      ok "nvm installed"
    else
      fail "nvm installation failed. Check https://github.com/nvm-sh/nvm"
    fi
  fi

  # Source nvm for the rest of this script
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"

  log "Installing/updating Node.js ($NODE_VERSION)..."
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"
  ok "Node.js ready ($(node --version)) — npm $(npm --version)"
fi

step "Step 4/6 — Repository source"
resolve_repo_dir
validate_repo_layout
ok "Using repository source at: $REPO_DIR"

step "Step 5/6 — Patched install (this repo)"

if [[ "$SKIP_PATCHED_INSTALL" -eq 1 ]]; then
  skipped "Patched install (--skip-patched-install)"
else
  reload_path
  require_cmd bun
  require_cmd npm

  INSTALL_CMD=(bash "$REPO_DIR/install.sh")
  if [[ "$SKIP_BUILD" -eq 1 ]]; then
    INSTALL_CMD+=(--skip-build)
  fi
  if [[ "$NO_BACKUP" -eq 1 ]]; then
    INSTALL_CMD+=(--no-backup)
  fi
  if [[ "$SKIP_CONFIG" -eq 0 ]]; then
    INSTALL_CMD+=(--with-config)
  fi

  log "Running patched installer: ${INSTALL_CMD[*]}"
  "${INSTALL_CMD[@]}"
  ok "Patched OpenCode + oh-my-opencode installed from local sources"
fi

step "Step 6/6 — Verify installation"

if command -v opencode >/dev/null 2>&1; then
  ok "opencode available: $(opencode --version 2>/dev/null || echo unknown)"
else
  fail "opencode not found on PATH after installation"
fi

if [[ -d "$HOME/.opencode/node_modules/oh-my-opencode/dist" ]]; then
  ok "Plugin dist present at ~/.opencode/node_modules/oh-my-opencode/dist"
else
  warn "Plugin dist directory not found in ~/.opencode/node_modules/oh-my-opencode/dist"
fi

if [[ "$SKIP_CONFIG" -eq 0 ]]; then
  if [[ -f "$OMO_CONFIG_DST" ]]; then
    ok "Personal config deployed: $OMO_CONFIG_DST"
  else
    fail "Expected config missing: $OMO_CONFIG_DST"
  fi
else
  skipped "Config verification (--skip-config)"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
printf "\n${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  oMoMoMoMo... Bootstrap complete!${RESET}\n"
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

printf "Next steps:\n"
printf "  1. Restart your shell (or: ${CYAN}source ~/.bashrc${RESET} / ${CYAN}source ~/.zshrc${RESET})\n"
printf "  2. Authenticate your providers:\n"
printf "       ${CYAN}opencode auth login${RESET}   # select Anthropic, Google, GitHub\n"
printf "  3. Start coding:\n"
printf "       ${CYAN}opencode${RESET}\n\n"

printf "${DIM}Auth was intentionally skipped — run 'opencode auth login' to set up your providers.${RESET}\n\n"
