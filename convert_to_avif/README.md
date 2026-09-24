# convert_to_avif

Portable utility: convert JPEG/PNG/WebP → AVIF while preserving what the source
carried (ICC / EXIF / XMP, and Ultra HDR or Apple **gain maps** when the encoder
supports them). Optionally runs layered QA so critical batches only keep encodes
that decode cleanly and look close to the original.

It does **not** round-trip through JPG for QA. It decodes the AVIF to a lossless
raster and compares against the decoded source.

## Install (Ubuntu / Debian)

One-shot installer (apt packages + libavif built with the faster SVT-AV1 encoder
and gain-map support):

```bash
# Recommended: non-interactive
sudo ./install_ubuntu.sh -y

# Custom prefix
sudo ./install_ubuntu.sh -y --prefix /opt/convert-to-avif

# Faster / offline-ish: skip Rust dssim (ffmpeg ssim still works for --verify)
sudo ./install_ubuntu.sh -y --skip-dssim
```

After install, ensure `${PREFIX}/bin` is on `PATH` (and `${PREFIX}/lib` on `LD_LIBRARY_PATH` if needed), then run `./convert_to_avif.sh …`.

### Manual install

#### 1. Python
Python **3.10+**. Core conversion uses the standard library only.

Optional for `--verify` if `dssim` / `ffmpeg` are unavailable:

```bash
pip install pillow numpy
# or: sudo apt install python3-pil python3-numpy
```

#### 2. exiftool (recommended)
Metadata presence checks.

```bash
# Debian/Ubuntu
sudo apt install libimage-exiftool-perl

# macOS
brew install exiftool
```

#### 3. libavif apps (required)
You need **`avifenc`**, and for QA **`avifdec`**. For Ultra HDR verification also
**`avifgainmaputil`**.

**Critical:** `avifenc` must be linked against the **SVT-AV1 encoder**. This tool
selects it explicitly with `--codec svt`; a libavif build without
`AVIF_CODEC_SVT` will fail its startup capability check.

Many distro packages also ship libavif **without** gain-map JPEG support.
Confirm:

```bash
avifenc --version          # should list svt
avifenc --codec svt --yuv 420 -q 60 input.jpg output.avif  # SVT-AV1 is 4:2:0 only
avifenc -h 2>&1 | grep -i qgain
```

If either check fails, build libavif ≥ **1.2** (ideally **1.3+**) yourself and
install the binaries onto `PATH`. Upstream: https://github.com/AOMediaCodec/libavif

Typical build shape (adjust flags to the release you use):

```bash
# deps example (Debian/Ubuntu):
#   cmake ninja-build libsvtav1enc-dev libdav1d-dev
#   libjpeg-dev libpng-dev libxml2-dev pkg-config
cmake -S . -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DAVIF_BUILD_APPS=ON \
  -DAVIF_CODEC_SVT=SYSTEM \
  -DAVIF_CODEC_DAV1D=SYSTEM \
  -DAVIF_JPEG=SYSTEM \
  -DAVIF_ZLIBPNG=SYSTEM \
  -DAVIF_LIBXML2=SYSTEM
cmake --build build
# install avifenc avifdec avifgainmaputil onto PATH
```

SVT-AV1 handles encoding; dav1d provides AVIF decoding for QA.

#### 4. Perceptual verify tools (recommended for `--verify`)
Prefer one of:

```bash
# DSSIM (best simple still-image metric)
cargo install dssim
# or: brew install dssim

# or use ffmpeg's ssim filter (often already installed)
ffmpeg -version
```

### Env overrides
If tools are not on `PATH`:

| Variable | Tool |
|----------|------|
| `AVIFENC` | avifenc |
| `AVIFDEC` | avifdec |
| `AVIFGAINMAPUTIL` | avifgainmaputil |
| `EXIFTOOL` | exiftool |
| `DSSIM` | dssim |
| `FFMPEG` | ffmpeg |

## Layout

```
convert_to_avif/
  install_ubuntu.sh  # Ubuntu/Debian dependency installer
  convert_to_avif.sh # CLI wrapper
  cli.py             # argparse + main
  pipeline.py        # Converter, BatchRunner
  probing.py         # ImageProber, MetadataReader
  encoding.py        # AvifEncoder
  qa.py              # Structural / Perceptual / HDR gates
  media.py           # ImageDecoder (shared ffmpeg/avifdec path)
  metrics.py         # SimilarityMeasurer
  toolchain.py       # Tool discovery + capability checks
  models.py          # Domain types + settings
  constants.py
```

## Usage

```bash
# Directory → <dir>_avif/  (mirrors tree)
./convert_to_avif.sh /path/to/photos

# Single file
./convert_to_avif.sh shot.jpg

# Critical workload: hard gates + perceptual compare
./convert_to_avif.sh /path/to/photos --verify

# Also run HDR tonemap informational checks on gain-map sources
./convert_to_avif.sh /path/to/photos --verify --verify-hdr

# Probe only
./convert_to_avif.sh /path/to/photos --dry-run

# Quarantine rejected encodes instead of deleting them
./convert_to_avif.sh /path/to/photos --verify --quarantine /tmp/avif_failed
```

Or as a module (parent of this package on `PYTHONPATH`):

```bash
PYTHONPATH=.. python3 -m convert_to_avif /path/to/photos -q 85 -s 4 --verify
```

### Defaults
| Setting | Default |
|---------|---------|
| Codec (`--codec`) | aom (recommended for low RAM) |
| Color quality (`-q`) | 85 |
| Gain-map quality | 85 |
| Speed (`-s`) | 8 |
| Jobs | 50% of CPUs |
| Max DSSIM (`--verify`) | 0.002 |
| Min SSIM (`--verify`) | 0.98 |
| Max size ratio | 1.2 × source |
| Min size ratio | 0.01 × source |

Calibrate DSSIM/SSIM thresholds on a golden set before production.

## QA gates

**Tier A (always)**  
Encode OK, non-empty output, decodes, dimensions match (when known), gain map
present if source had one, size sanity, metadata warnings via exiftool.

**Tier B (`--verify`)**  
Decode AVIF → PNG, decode source → PNG, compare with `dssim` or `ffmpeg ssim`
(or Pillow+numpy). Failures are deleted or moved to `--quarantine`.

**Tier C (`--verify-hdr`)**  
Gain-map tonemap informational checks via `avifgainmaputil tonemap` when available.

### Exit codes
| Code | Meaning |
|------|---------|
| 0 | All processed files converted or intentionally skipped |
| 1 | One or more encodes failed or were rejected by QA |
| 2 | Usage / missing required tools / bad input path |

## Profiles
| Probe | Encode path |
|-------|-------------|
| `jpeg+gainmap` | `avifenc --codec svt --yuv 420 -q … --qgain-map …` |
| `jpeg` | `avifenc --codec svt --yuv 420 -q …` |
| `png` | `avifenc --codec svt --yuv 420 -q … --qalpha …` |
| `webp` | ffmpeg → PNG, then `avifenc --codec svt --yuv 420` |

> SVT-AV1 only supports 4:2:0 chroma, so all encodes force `--yuv 420`.
> 4:4:4/4:2:2 sources are downsampled to 4:2:0 during encoding.

## Limits
- Lossy AVIF cannot be bit-identical to JPEG; QA is threshold-based.
- Viewers that ignore gain maps show the SDR base (by design).
- Animated WebP/GIF are not handled.
- Originals are never deleted.
