#!/usr/bin/env bash
# Install convert_to_avif dependencies on Ubuntu / Debian-based systems.
#
# Installs:
#   - Python 3, ffmpeg, exiftool, Pillow/numpy (verify fallback)
#   - Build toolchain + SVT-AV1 / dav1d / libjpeg / libpng / libxml2
#   - libavif apps (avifenc, avifdec, avifgainmaputil) built from source
#     with SVT-AV1 encoder + JPEG gain-map support
#   - dssim via cargo (optional; ffmpeg ssim also works for --verify)
#
# Usage:
#   ./install_ubuntu.sh
#   sudo ./install_ubuntu.sh --prefix /usr/local
#   ./install_ubuntu.sh --skip-dssim
#
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
LIBAVIF_VERSION="${LIBAVIF_VERSION:-v1.3.0}"
BUILD_ROOT="${BUILD_ROOT:-/tmp/convert_to_avif-build}"
SKIP_DSSIM=0
SKIP_LIBAVIF=0
ASSUME_YES=0
JOBS="$(nproc 2>/dev/null || echo 2)"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --prefix DIR          Install prefix (default: ${PREFIX})
  --libavif-version V   libavif git tag/branch (default: ${LIBAVIF_VERSION})
  --build-root DIR      Scratch directory for source builds (default: ${BUILD_ROOT})
  --jobs N              Parallel build jobs (default: ${JOBS})
  --skip-dssim          Do not install Rust/dssim (ffmpeg ssim still usable)
  --skip-libavif        Do not build libavif (use existing PATH tools)
  -y, --yes             Non-interactive apt (-y)
  -h, --help            Show this help
EOF
}

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
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

install_prefix_writeable() {
  if [[ -w "$PREFIX" ]] || [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  need_cmd sudo
}

with_install() {
  if [[ -w "$PREFIX" ]] || [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
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
  die "This installer targets Ubuntu/Debian-based systems."
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix) PREFIX="$2"; shift 2 ;;
      --libavif-version) LIBAVIF_VERSION="$2"; shift 2 ;;
      --build-root) BUILD_ROOT="$2"; shift 2 ;;
      --jobs) JOBS="$2"; shift 2 ;;
      --skip-dssim) SKIP_DSSIM=1; shift ;;
      --skip-libavif) SKIP_LIBAVIF=1; shift ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
}

apt_update() {
  log "Updating apt package lists"
  if [[ "$(id -u)" -eq 0 ]]; then
    if [[ "$ASSUME_YES" -eq 1 ]]; then
      apt-get update -y
    else
      apt-get update
    fi
  else
    need_cmd sudo
    if [[ "$ASSUME_YES" -eq 1 ]]; then
      sudo apt-get update -y
    else
      sudo apt-get update
    fi
  fi
}

install_apt_packages() {
  log "Installing apt packages"
  if ! apt-cache show libsvtav1enc-dev >/dev/null 2>&1; then
    die "libsvtav1enc-dev is unavailable for this distribution/architecture; SVT-AV1 is required"
  fi
  local pkgs=(
    python3
    python3-pil
    python3-numpy
    ffmpeg
    libimage-exiftool-perl
    git
    curl
    ca-certificates
    build-essential
    cmake
    ninja-build
    pkg-config
    libsvtav1enc-dev
    libdav1d-dev
    libjpeg-dev
    libpng-dev
    zlib1g-dev
    libxml2-dev
  )
  run_apt "${pkgs[@]}"
}

avifenc_has_svt() {
  local enc="${1:-avifenc}"
  command -v "$enc" >/dev/null 2>&1 || return 1
  local tmp
  tmp="$(mktemp -d)"
  # 64x64 PNG: older SVT-AV1 versions reject smaller dimensions.
  python3 - "$tmp/t.png" <<'PY'
import base64, pathlib, sys
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PMQ0AAAwDoEqv9ErY"
    "vQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLAB"
    "8+AWnmfUycAAAAAElFTkSuQmCC"
))
PY
  # SVT-AV1 only supports 4:2:0, so force --yuv 420 (avifenc defaults to 444 for PNG).
  if "$enc" --codec svt --yuv 420 -q 60 -s 10 -j 1 "${tmp}/t.png" "${tmp}/t.avif" >/dev/null 2>&1 \
    && [[ -s "${tmp}/t.avif" ]]; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

avifenc_has_qgain() {
  local enc="${1:-avifenc}"
  command -v "$enc" >/dev/null 2>&1 || return 1
  "$enc" -h 2>&1 | grep -qi 'qgain-map'
}

system_avif_ok() {
  avifenc_has_svt avifenc && avifenc_has_qgain avifenc \
    && command -v avifdec >/dev/null 2>&1 \
    && command -v avifgainmaputil >/dev/null 2>&1
}

build_libavif() {
  log "Building libavif ${LIBAVIF_VERSION} into ${PREFIX}"
  need_cmd git
  need_cmd cmake
  need_cmd ninja
  need_cmd pkg-config

  mkdir -p "$BUILD_ROOT"
  local src="${BUILD_ROOT}/libavif"
  if [[ -d "${src}/.git" ]]; then
    git -C "$src" fetch --tags --force
    git -C "$src" checkout -f "$LIBAVIF_VERSION"
  else
    rm -rf "$src"
    git clone --depth 1 --branch "$LIBAVIF_VERSION" \
      https://github.com/AOMediaCodec/libavif.git "$src"
  fi

  local build="${src}/build-convert-to-avif"
  rm -rf "$build"
  mkdir -p "$build"

  local cmake_args=(
    -S "$src"
    -B "$build"
    -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_PREFIX="$PREFIX"
    -DAVIF_BUILD_APPS=ON
    -DAVIF_CODEC_SVT=SYSTEM
    -DAVIF_CODEC_DAV1D=SYSTEM
    -DAVIF_JPEG=SYSTEM
    -DAVIF_ZLIBPNG=SYSTEM
    -DAVIF_LIBXML2=SYSTEM
  )

  cmake "${cmake_args[@]}"
  cmake --build "$build" --parallel "$JOBS"
  with_install cmake --install "$build"

  # Ensure runtime linker finds libs when PREFIX is not a default path
  if [[ "$PREFIX" != /usr && "$PREFIX" != /usr/local ]]; then
    warn "Non-standard prefix ${PREFIX}: add ${PREFIX}/bin to PATH and ${PREFIX}/lib to LD_LIBRARY_PATH (or ldconfig)."
  fi
  if [[ -d "${PREFIX}/lib" ]] && [[ "$(id -u)" -eq 0 || -w /etc/ld.so.conf.d ]]; then
    if [[ "$PREFIX" == /usr/local ]]; then
      with_install ldconfig || true
    fi
  fi
}

install_dssim() {
  if command -v dssim >/dev/null 2>&1; then
    log "dssim already present: $(command -v dssim)"
    return 0
  fi
  log "Installing dssim (Rust / cargo)"
  if ! command -v cargo >/dev/null 2>&1; then
    need_cmd curl
    local rustup_init="${BUILD_ROOT}/rustup-init.sh"
    mkdir -p "$BUILD_ROOT"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$rustup_init"
    # Install rustup for the invoking user (avoid root cargo home surprises when sudo)
    if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != root ]]; then
      sudo -u "$SUDO_USER" bash "$rustup_init" -y --profile minimal
      # shellcheck disable=SC1090
      source "$(eval echo "~${SUDO_USER}")/.cargo/env"
    else
      bash "$rustup_init" -y --profile minimal
      # shellcheck disable=SC1091
      source "${HOME}/.cargo/env"
    fi
  fi
  need_cmd cargo
  cargo install dssim --locked
  local cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin/dssim"
  if [[ -x "$cargo_bin" && ! -e "${PREFIX}/bin/dssim" ]]; then
    with_install install -m 0755 "$cargo_bin" "${PREFIX}/bin/dssim" || true
  fi
}

verify_install() {
  log "Verifying tools"
  local path_prefix="${PREFIX}/bin"
  export PATH="${path_prefix}:${PATH}"
  if [[ -d "${PREFIX}/lib" ]]; then
    export LD_LIBRARY_PATH="${PREFIX}/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi

  local missing=0
  for cmd in python3 ffmpeg exiftool avifenc avifdec; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf '  OK  %s -> %s\n' "$cmd" "$(command -v "$cmd")"
    else
      printf '  MISSING  %s\n' "$cmd"
      missing=1
    fi
  done

  if command -v avifgainmaputil >/dev/null 2>&1; then
    printf '  OK  avifgainmaputil -> %s\n' "$(command -v avifgainmaputil)"
  else
    printf '  MISSING  avifgainmaputil (needed for Ultra HDR verify)\n'
    missing=1
  fi

  if avifenc_has_svt avifenc; then
    printf '  OK  avifenc can encode with SVT-AV1\n'
  else
    printf '  FAIL avifenc cannot encode with SVT-AV1\n'
    missing=1
  fi

  if avifenc_has_qgain avifenc; then
    printf '  OK  avifenc --qgain-map present (gain-map JPEG support)\n'
  else
    printf '  FAIL avifenc missing --qgain-map\n'
    missing=1
  fi

  if command -v dssim >/dev/null 2>&1; then
    printf '  OK  dssim -> %s\n' "$(command -v dssim)"
  else
    printf '  WARN dssim not installed (ffmpeg ssim / Pillow still usable for --verify)\n'
  fi

  if [[ "$missing" -ne 0 ]]; then
    die "Installation incomplete. See messages above."
  fi

  cat <<EOF

Install complete.

Ensure these are on your PATH (and library path if needed):
  export PATH="${PREFIX}/bin:\$PATH"
  export LD_LIBRARY_PATH="${PREFIX}/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"

Then run:
  $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/convert_to_avif.sh --help
EOF
}

main() {
  parse_args "$@"
  detect_os
  install_prefix_writeable
  apt_update
  install_apt_packages

  if [[ "$SKIP_LIBAVIF" -eq 1 ]]; then
    log "Skipping libavif build (--skip-libavif)"
  elif system_avif_ok; then
    log "System avifenc/avifdec/avifgainmaputil already usable; skipping source build"
  else
    build_libavif
  fi

  if [[ "$SKIP_DSSIM" -eq 1 ]]; then
    log "Skipping dssim (--skip-dssim)"
  else
    install_dssim || warn "dssim install failed; continuing (ffmpeg ssim remains available)"
  fi

  verify_install
}

main "$@"
