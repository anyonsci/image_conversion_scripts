#!/usr/bin/env bash
# ====================================================================
# setup_mac_arm.sh - Zero-Admin Setup for Apple Silicon (macOS ARM64)
# ====================================================================
# Installs a 100% self-contained, isolated local conversion environment
# for Apple Silicon (ARM64) Macs without requiring root/sudo privileges
# or installing any global system packages.
#
# Supported: macOS on Apple Silicon (ARM64)
#
# Usage:
#   ./setup_mac_arm.sh [options]
#
# Options:
#   --use-brew         Use existing Homebrew to install packages (if preferred)
#   --prefix <dir>     Custom local directory for tools (default: ./.mac_tools)
#   -y, --yes          Non-interactive mode (auto-accept defaults)
#   -h, --help         Show this help message
# ====================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="${SCRIPT_DIR}/.mac_tools"
USE_BREW=0
ASSUME_YES=0

log()  { printf "\033[1;34m==>\033[0m \033[1m%s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✔\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33mWARNING:\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --use-brew) USE_BREW=1; shift ;;
      --prefix) TOOLS_DIR="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -h|--help)
        sed -ne '/^#/!q;s/^# //;2,$p' "$0"
        exit 0
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

detect_hardware() {
  log "Inspecting macOS Hardware Architecture..."

  local os_type arch
  os_type="$(uname -s)"
  arch="$(uname -m)"

  if [[ "$os_type" != "Darwin" ]]; then
    die "This script is tailored for macOS. Detected: ${os_type}."
  fi

  if [[ "$arch" != "arm64" ]]; then
    die "This script requires Apple Silicon (arm64). Detected: ${arch}."
  fi

  TOTAL_CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo 8)"
  PERF_CORES="$(sysctl -n hw.perflevel0.logicalcpu 2>/dev/null || echo "$TOTAL_CORES")"
  EFF_CORES="$(sysctl -n hw.perflevel1.logicalcpu 2>/dev/null || echo 0)"
  CHIP_MODEL="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")"
  RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  RAM_GB=$(( RAM_BYTES / 1024 / 1024 / 1024 ))

  ok "Host: ${CHIP_MODEL} (${TOTAL_CORES} cores: ${PERF_CORES} Performance + ${EFF_CORES} Efficiency), ${RAM_GB} GB Unified RAM"
}

check_existing_tools() {
  log "Checking for existing tools on PATH..."

  HAS_FFMPEG=0
  HAS_SVTAV1=0
  HAS_NODE=0
  HAS_PYTHON=0
  HAS_EXIFTOOL=0
  HAS_AVIFENC=0

  if command -v ffmpeg >/dev/null 2>&1; then
    HAS_FFMPEG=1
    if ffmpeg -encoders 2>&1 | grep -q libsvtav1; then
      HAS_SVTAV1=1
      ok "Found ffmpeg with libsvtav1: $(which ffmpeg)"
    else
      warn "Found ffmpeg at $(which ffmpeg), but it lacks libsvtav1 support."
    fi
  fi

  if command -v node >/dev/null 2>&1; then
    local node_ver
    node_ver="$(node -v | sed 's/v//')"
    local major="${node_ver%%.*}"
    if [[ "$major" -ge 18 ]]; then
      HAS_NODE=1
      ok "Found Node.js v${node_ver}: $(which node)"
    fi
  fi

  if command -v python3 >/dev/null 2>&1; then
    if python3 -c "import PIL, numpy" >/dev/null 2>&1; then
      HAS_PYTHON=1
      ok "Found Python 3 with Pillow & NumPy: $(which python3)"
    fi
  fi

  if command -v exiftool >/dev/null 2>&1; then
    HAS_EXIFTOOL=1
    ok "Found exiftool: $(which exiftool)"
  fi

  if command -v avifenc >/dev/null 2>&1; then
    HAS_AVIFENC=1
    ok "Found avifenc: $(which avifenc)"
  fi
}

install_via_brew() {
  log "Installing required tools via Homebrew..."
  if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew is not installed. Please install Homebrew or run without --use-brew for self-contained installation."
  fi

  brew install ffmpeg libavif exiftool node python@3.11
  python3 -m pip install --user --upgrade pillow numpy || true
}

install_self_contained() {
  log "Setting up isolated, non-root toolchain in: ${TOOLS_DIR}..."
  mkdir -p "${TOOLS_DIR}/bin"

  local MAMBA_BIN="${TOOLS_DIR}/bin/micromamba"
  if [[ ! -x "$MAMBA_BIN" ]]; then
    log "Downloading standalone Micromamba static binary (macOS ARM64)..."
    curl -Ls https://micro.mamba.pm/api/micromamba/osx-arm64/latest | tar -xj -C "${TOOLS_DIR}" bin/micromamba
    chmod +x "$MAMBA_BIN"
    ok "Micromamba ready: ${MAMBA_BIN}"
  fi

  log "Installing native Apple Silicon packages (ffmpeg + libsvtav1, libavif, exiftool, nodejs, python)..."
  "$MAMBA_BIN" create -p "${TOOLS_DIR}" -c conda-forge \
    ffmpeg \
    svt-av1 \
    libavif \
    exiftool \
    nodejs=20 \
    python=3.11 \
    pillow \
    numpy \
    -y --no-rc

  ok "Isolated toolchain installed successfully in ${TOOLS_DIR}."
}

setup_npm_modules() {
  log "Installing project npm dependencies..."
  export PATH="${TOOLS_DIR}/bin:$PATH"

  if [[ -f "${SCRIPT_DIR}/meganz_utils/package.json" ]]; then
    (
      cd "${SCRIPT_DIR}/meganz_utils"
      npm install --no-fund --no-audit
    )
    ok "Node.js dependencies installed in meganz_utils/node_modules/."
  fi
}

generate_helper_scripts() {
  log "Generating activation and runner scripts for Apple Silicon..."

  # 1. Environment activation script
  local ENV_SCRIPT="${SCRIPT_DIR}/env_mac.sh"
  cat > "${ENV_SCRIPT}" <<EOF
#!/usr/bin/env bash
# Source this file to activate the optimized environment:
#   source env_mac.sh

export SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export TOOLS_DIR="\${SCRIPT_DIR}/.mac_tools"

if [[ -d "\${TOOLS_DIR}/bin" ]]; then
  export PATH="\${TOOLS_DIR}/bin:\$PATH"
fi

# Apple Silicon Concurrency Configuration
export VIDEO_THREADS=0 # Informs SVT-AV1 to utilize all performance and efficiency cores (lp=0)
export AVIF_JOBS=\$(sysctl -n hw.perflevel0.logicalcpu 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 8)
export PYTHONUNBUFFERED=1

echo "✔ Apple Silicon environment active: \$(which ffmpeg 2>/dev/null || echo 'ffmpeg')"
echo "  Hardware: ${CHIP_MODEL} | Cores: ${TOTAL_CORES} (${PERF_CORES} Performance) | AV1 Threads: Auto (All Cores)"
EOF
  chmod +x "${ENV_SCRIPT}"
  ok "Generated environment script: ${ENV_SCRIPT}"

  # 2. Dedicated Offline Video Converter Runner for Mac
  local RUNNER_SCRIPT="${SCRIPT_DIR}/run_mac_offline.sh"
  cat > "${RUNNER_SCRIPT}" <<'EOF'
#!/usr/bin/env bash
# ====================================================================
# run_mac_offline.sh - Fast Offline Video Conversion on Apple Silicon
# ====================================================================
# Automatically runs Phase 2 (Offline Conversion) using all available CPU cores.
#
# Usage:
#   ./run_mac_offline.sh <path_to_offline_dir> [options]
#
# Examples:
#   ./run_mac_offline.sh ~/Downloads/mega_offline_kashmir
#   ./run_mac_offline.sh ~/Downloads/mega_offline_kashmir -crf 32 --preset 8
# ====================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Activate environment if present
if [[ -f "${SCRIPT_DIR}/env_mac.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/env_mac.sh" >/dev/null 2>&1
fi

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  echo "Usage: $0 <path_to_offline_dir> [additional options]"
  echo "Example: $0 ~/Downloads/mega_offline_kashmir -crf 30"
  exit 1
fi

OFFLINE_DIR="$1"
shift

# Normalize path
if [[ "$OFFLINE_DIR" == ~* ]]; then
  OFFLINE_DIR="${HOME}${OFFLINE_DIR:1}"
fi

if [[ ! -d "$OFFLINE_DIR/input" ]]; then
  echo "Error: Directory '$OFFLINE_DIR/input' does not exist."
  echo "Ensure you have copied the downloaded 'input/' folder from the cloud server."
  exit 1
fi

echo "=========================================================="
echo "Starting High-Speed Offline Conversion"
echo "Workspace: $OFFLINE_DIR"
echo "Cores: $(sysctl -n hw.ncpu 2>/dev/null || echo 'all') | Video Threads: Auto (lp=0)"
echo "=========================================================="

node "${SCRIPT_DIR}/meganz_utils/index.js" convert-video \
  --convert-only \
  --offline-dir="${OFFLINE_DIR}" \
  -t 0 \
  "$@"
EOF
  chmod +x "${RUNNER_SCRIPT}"
  ok "Generated offline runner script: ${RUNNER_SCRIPT}"
}

verify_installation() {
  log "Verifying end-to-end toolchain integrity..."
  export PATH="${TOOLS_DIR}/bin:$PATH"

  # Verify ffmpeg + svtav1
  if ! ffmpeg -encoders 2>&1 | grep -q libsvtav1; then
    die "ffmpeg with libsvtav1 verification failed."
  fi
  ok "ffmpeg with SVT-AV1 verified."

  # Verify Node.js unit tests
  log "Running Node.js unit tests..."
  (
    cd "${SCRIPT_DIR}/meganz_utils"
    node test_logic.js >/dev/null 2>&1
  )
  ok "Node.js unit tests passed."

  # Verify Python AV1 unit tests
  log "Running Python AV1 unit tests..."
  python3 -m unittest discover -s "${SCRIPT_DIR}/convert_video_to_av1/tests" >/dev/null 2>&1
  ok "Python AV1 unit tests passed."
}

print_summary() {
  cat <<EOF

======================================================================
🎉 Mac ARM Setup Complete! (${CHIP_MODEL})
======================================================================

No global packages or root permissions were used.
All tools are isolated in: ${TOOLS_DIR}

How to run offline conversion on your Mac:
------------------------------------------------------
1. Copy the offline folder (e.g. mega_offline_kashmir) from the cloud server
   to your Mac (e.g. ~/Downloads/mega_offline_kashmir).

2. Run the high-speed converter:
   ./run_mac_offline.sh ~/Downloads/mega_offline_kashmir

   Or with custom CRF / Preset:
   ./run_mac_offline.sh ~/Downloads/mega_offline_kashmir -crf 32 --preset 8

3. When complete, copy the 'output/' and 'manifest.csv' back to the
   cloud server and run the batch upload:
   node meganz_utils/index.js convert-video --path="kashmir" --upload-only

To completely remove the local tools:
--------------------------------------------------------------
   rm -rf "${TOOLS_DIR}" "${SCRIPT_DIR}/env_mac.sh" "${SCRIPT_DIR}/run_mac_offline.sh"

======================================================================
EOF
}

main() {
  parse_args "$@"
  detect_hardware

  check_existing_tools

  if [[ "$HAS_SVTAV1" -eq 1 && "$HAS_NODE" -eq 1 && "$HAS_PYTHON" -eq 1 && "$HAS_EXIFTOOL" -eq 1 ]]; then
    ok "All required tools are already present on your Mac! Skipping toolchain installation."
  elif [[ "$USE_BREW" -eq 1 ]]; then
    install_via_brew
  else
    install_self_contained
  fi

  setup_npm_modules
  generate_helper_scripts
  verify_installation
  print_summary
}

main "$@"
