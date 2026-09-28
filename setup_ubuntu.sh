#!/usr/bin/env bash
# ====================================================================
# setup_ubuntu.sh - One-Step Setup Script for Image Conversion & MEGA Sync
# ====================================================================
# Installs all system dependencies, builds libavif apps, installs Node.js,
# configures npm modules, and verifies end-to-end toolchain integrity.
#
# Supported OS: Ubuntu 20.04+, Debian 11+, Linux Mint, Pop!_OS
#
# Usage:
#   ./setup_ubuntu.sh [-y|--yes] [--skip-libavif] [--prefix DIR]
# ====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-/usr/local}"
ASSUME_YES=0
SKIP_LIBAVIF=0

log()  { printf "\033[1;34m==>\033[0m \033[1m%s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✔\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33mWARNING:\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

run_apt() {
  local apt_args=(install)
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    apt_args+=(-y)
  fi
  apt_args+=("$@")
  if [[ "$(id -u)" -eq 0 ]]; then
    DEBIAN_FRONTEND=noninteractive apt-get "${apt_args[@]}"
  else
    need_cmd sudo
    sudo DEBIAN_FRONTEND=noninteractive apt-get "${apt_args[@]}"
  fi
}

detect_os() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    case "${ID_LIKE:-$ID}" in
      *debian*|*ubuntu*) return 0 ;;
    esac
    case "${ID:-}" in
      ubuntu|debian|linuxmint|pop) return 0 ;;
    esac
  fi
  die "This setup script targets Ubuntu/Debian-based systems."
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes) ASSUME_YES=1; shift ;;
      --skip-libavif) SKIP_LIBAVIF=1; shift ;;
      --prefix) PREFIX="$2"; shift 2 ;;
      -h|--help)
        echo "Usage: $0 [options]"
        echo "Options:"
        echo "  -y, --yes          Non-interactive installation (auto-confirm apt)"
        echo "  --skip-libavif     Skip building libavif if already installed"
        echo "  --prefix DIR       Installation prefix (default: /usr/local)"
        echo "  -h, --help         Show this help message"
        exit 0
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

ensure_nodejs() {
  log "Checking Node.js & npm..."
  local install_needed=0
  if ! command -v node >/dev/null 2>&1; then
    install_needed=1
  else
    local node_major
    node_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$node_major" -lt 18 ]]; then
      log "Installed Node.js version $(node -v) is older than v18. Upgrading..."
      install_needed=1
    fi
  fi

  if [[ "$install_needed" -eq 1 ]]; then
    log "Installing Node.js (v20 LTS)..."
    need_cmd curl
    local setup_node_url="https://deb.nodesource.com/setup_20.x"
    if [[ "$(id -u)" -eq 0 ]]; then
      curl -fsSL "$setup_node_url" | bash -
      DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
    else
      need_cmd sudo
      curl -fsSL "$setup_node_url" | sudo -E bash -
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
    fi
  fi

  ok "Node.js $(node -v) & npm $(npm -v)"
}

install_conversion_engine() {
  log "Installing image conversion tools (convert_to_avif)..."
  local install_script="${SCRIPT_DIR}/convert_to_avif/install_ubuntu.sh"
  [[ -f "$install_script" ]] || die "Installer not found at: ${install_script}"
  chmod +x "$install_script"

  local extra_flags=()
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    extra_flags+=(-y)
  fi
  if [[ "$SKIP_LIBAVIF" -eq 1 ]]; then
    extra_flags+=(--skip-libavif)
  fi
  extra_flags+=(--skip-dssim --prefix "$PREFIX")

  "$install_script" "${extra_flags[@]}"
}

setup_meganz_utils() {
  log "Setting up meganz_utils Node.js environment..."
  local meganz_dir="${SCRIPT_DIR}/meganz_utils"
  [[ -d "$meganz_dir" ]] || die "meganz_utils directory not found: ${meganz_dir}"

  (
    cd "$meganz_dir"
    log "Running npm install in meganz_utils..."
    npm install --silent
    ok "Node.js dependencies installed successfully."

    log "Running unit test suite..."
    npm test
  )
}

check_credentials() {
  log "Checking MEGA authentication..."
  local rclone_conf="${HOME}/.config/rclone/rclone.conf"
  local env_file="${SCRIPT_DIR}/meganz_utils/.env"
  local has_creds=0

  if [[ -f "$rclone_conf" ]] && grep -q '\[mega1\]' "$rclone_conf" 2>/dev/null; then
    ok "Found rclone remote [mega1] in ${rclone_conf}"
    has_creds=1
  fi

  if [[ -f "$env_file" ]] && grep -q 'MEGA_EMAIL' "$env_file" 2>/dev/null; then
    ok "Found environment credentials in ${env_file}"
    has_creds=1
  fi

  if [[ -n "${MEGA_EMAIL:-}" && -n "${MEGA_PASSWORD:-}" ]]; then
    ok "Found MEGA_EMAIL and MEGA_PASSWORD in environment."
    has_creds=1
  fi

  if [[ "$has_creds" -eq 0 ]]; then
    warn "No MEGA credentials detected yet."
    cat <<EOF

To configure your MEGA account, you have 3 options:
  Option A (Recommended - .env file):
    cp "${SCRIPT_DIR}/meganz_utils/.env.example" "${SCRIPT_DIR}/meganz_utils/.env"
    nano "${SCRIPT_DIR}/meganz_utils/.env"   # Set MEGA_EMAIL & MEGA_PASSWORD

  Option B (rclone remote):
    rclone config   # Create a remote named 'mega1' of type 'mega'

  Option C (CLI arguments):
    node meganz_utils/index.js convert --email "you@example.com" --password "pass"
EOF
  fi
}

print_summary() {
  cat <<EOF

====================================================================
🎉 Installation & Environment Setup Complete!
====================================================================

Installed Tools:
  ✔ Python 3 + Pillow + NumPy
  ✔ ffmpeg (single-thread SSIM / scaling)
  ✔ exiftool (full EXIF/GPS/ICC metadata preservation)
  ✔ heif-convert + libde265 / x265 (Apple/Android HEIC decode & encode)
  ✔ avifenc / avifdec / avifgainmaputil (AV1 + gain maps)
  ✔ Node.js $(node -v) + meganz_utils suite

How to run conversions:
  1. Dry-run test from root:
     node "${SCRIPT_DIR}/meganz_utils/index.js" convert --path="/" --dry-run

  2. Full conversion (single-thread, strict 100% AVIF, adaptive quality):
     node "${SCRIPT_DIR}/meganz_utils/index.js" convert --path="/" -j 1

  3. Upload/refresh thumbnails and previews:
     node "${SCRIPT_DIR}/meganz_utils/index.js" thumbnails --path="/"

====================================================================
EOF
}

main() {
  parse_args "$@"
  detect_os
  ensure_nodejs
  install_conversion_engine
  setup_meganz_utils
  check_credentials
  print_summary
}

main "$@"
