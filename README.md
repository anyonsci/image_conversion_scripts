# Image Conversion & MEGA Sync Suite

A production-grade, resource-efficient toolchain for converting photo archives (JPEG, HEIC, HEIF, PNG, WebP) into high-fidelity AVIF with gain-map awareness, perceptual QA verification, and seamless synchronization with [MEGA.nz](https://mega.nz).

---

## 🚀 Quick Start on a Fresh Ubuntu System

Clone the repository and run the automated setup script:

```bash
git clone <repo-url> image_conversion_scripts
cd image_conversion_scripts

# Run one-step setup (installs tools, builds libavif if needed, configures Node.js)
./setup_ubuntu.sh -y
```

The script automatically:
1. Installs Python 3 (`Pillow`, `NumPy`), `ffmpeg`, `exiftool`, and `libheif` (`heif-convert` with `libde265` & `x265`).
2. Builds / verifies `avifenc`, `avifdec`, and `avifgainmaputil` (with SVT-AV1 & gain-map support).
3. Installs the official rclone release and verifies that its MEGA backend is available.
4. Ensures Node.js (>= 18), installs `meganz_utils` dependencies, and runs unit tests.

---

## 🔑 MEGA Authentication Setup

You can authenticate using any of these 3 methods:

### Option A: `.env` file (Recommended)
Copy the example environment file and add your credentials:
```bash
cp meganz_utils/.env.example meganz_utils/.env
nano meganz_utils/.env
```
Fill in:
```ini
MEGA_EMAIL=your_email@example.com
MEGA_PASSWORD=your_password
```

### Option B: `rclone` config
To create the remote expected by `meganz_utils` (named `mega1`):
```bash
rclone config
# Choose "n" for a new remote, name it "mega1", then select the "mega" storage type.
# Enter your MEGA credentials and save the remote.
```

### Option C: CLI Arguments
Pass credentials directly on the command line:
```bash
node meganz_utils/index.js convert --email "user@example.com" --password "secret"
```

---

## 📸 Usage

All commands can be run from the repository root or inside `meganz_utils/`:

### 1. Dry Run (Verify Scan & File Discovery)
```bash
node meganz_utils/index.js convert --path="/" --dry-run
```

### 2. Full Conversion (Safe, Single-Threaded, No Swap Thrashing)
```bash
node meganz_utils/index.js convert --path="/" -j 1
```

### 3. Relaxed Quality / Overcompression for High-ISO Noise Photos
```bash
node meganz_utils/index.js convert --path="/" -j 1 -q 70 --min-ssim 0.70
```

### 4. Upload/Refresh Gallery Thumbnails & Previews
Generates sharp 320px thumbnails and 1600px previews for all AVIF files:
```bash
node meganz_utils/index.js thumbnails --path="/"
```

### 5. Convert Remote Videos (MP4 / MOV) to AV1

#### A. Direct Streaming Mode
Streams remote MP4/MOV videos to disk one by one, encodes to AV1 via SVT-AV1 with audio preservation, runs full-stream decode QA, attaches poster thumbnails/previews, uploads back to MEGA, and removes originals:
```bash
# Preview candidates:
node meganz_utils/index.js convert-video --path="trips" --dry-run

# Run streaming conversion (CRF 30 [dynamically scaled 30-36], Preset 8, 2 threads):
node meganz_utils/index.js convert-video --path="trips" -crf 30 --preset 8
```

#### B. 3-Phase Offline Mode (Batch Download $\rightarrow$ Local Convert $\rightarrow$ Batch Upload)
Performs all conversion work locally and completely decoupled from MEGA network connectivity, using a persistent `manifest.csv` for state tracking and idempotent resumption:
```bash
# Run full 3-phase offline workflow in one command:
node meganz_utils/index.js convert-video --path="kashmir" --offline

# Or execute selective phases independently:
# Phase 1: Batch download candidate videos from MEGA to local input directory:
node meganz_utils/index.js convert-video --path="kashmir" --download-only

# Phase 2: Convert locally (runs 100% offline, requires NO MEGA connection or credentials):
node meganz_utils/index.js convert-video --convert-only --offline-dir="~/ws/mega_offline_kashmir"

# Phase 3: Batch upload converted videos to MEGA, attach poster frames, and delete originals:
node meganz_utils/index.js convert-video --path="kashmir" --upload-only
```

> [!NOTE]
> **Offline Workspace Layout**:
> - `<offline_dir>/input/`: Mirrored MEGA directory hierarchy containing downloaded originals.
> - `<offline_dir>/output/`: Mirrored directory hierarchy containing converted `.av1.mp4` files for side-by-side comparison.
> - `<offline_dir>/manifest.csv`: Tracks status (`converted`, `rejected_no_savings`, `skipped_low_bitrate`, `failed`), savings percentage, and upload status. Deleting any row allows re-running that specific file upon resume.

### 6. Local Standalone Video Conversion (CLI)
Convert local video files or directories directly without MEGA:
```bash
# Convert a single video:
./convert_video_to_av1/convert_video_to_av1.sh input.mov -o output.mp4 -crf 30 -p 8

# Batch convert a folder recursively:
./convert_video_to_av1/convert_video_to_av1.sh /path/to/videos -crf 30 -p 8
```

### 7. Organize Photos & Videos Day-Wise (Day 1 - Day 7)
Sorts trip photos and videos into day-wise folders (`Day 1` = Oct 10 to `Day 7` = Oct 16) using true capture dates (EXIF, QuickTime atoms, filename regex, sequence interpolation) without downloading full files. Moves are executed server-side via MEGA's API:
```bash
# Preview distribution (dry-run):
node meganz_utils/index.js organize --path="kashmir oct 26" --dry-run

# Execute live organization:
node meganz_utils/index.js organize --path="kashmir oct 26"
```

---

## 📂 Repository Structure

- [`setup_ubuntu.sh`](setup_ubuntu.sh): Top-level automated Ubuntu installer.
- [`convert_to_avif/`](convert_to_avif/): Standalone Python AVIF encoding and QA engine with gain-map support.
  - [`install_ubuntu.sh`](convert_to_avif/install_ubuntu.sh): Low-level C/C++ dependency and libavif build script.
- [`convert_video_to_av1/`](convert_video_to_av1/): Standalone Python AV1 video encoding and QA engine (SVT-AV1, HDR 10-bit preservation, Capped CRF, faststart).
  - [`convert_video_to_av1.sh`](convert_video_to_av1/convert_video_to_av1.sh): Executable CLI runner.
  - [`encoding.py`](convert_video_to_av1/encoding.py): SVT-AV1 wrapper with dynamic CRF (30-36), 4K Preset 10 acceleration, and bitrate ceiling (`mbr`).
  - [`qa.py`](convert_video_to_av1/qa.py): Lossless null-sink decode test, duration parity, and compression savings validation.
- [`meganz_utils/`](meganz_utils/): Node.js automation suite for MEGA.nz cloud drive operations.
  - [`index.js`](meganz_utils/index.js): CLI entrypoint and task dispatcher.
  - [`lib/client.js`](meganz_utils/lib/client.js): Authentication, custom HTTP parser, and persistent session resumption.
  - [`lib/manifest.js`](meganz_utils/lib/manifest.js): CSV manifest management for offline conversion and idempotent resumption.
  - [`tasks/convert_to_avif.js`](meganz_utils/tasks/convert_to_avif.js): Remote image download $\rightarrow$ convert $\rightarrow$ validate $\rightarrow$ upload $\rightarrow$ delete workflow.
  - [`tasks/convert_video_to_av1.js`](meganz_utils/tasks/convert_video_to_av1.js): Remote video streaming $\rightarrow$ AV1 encode $\rightarrow$ decode QA $\rightarrow$ upload $\rightarrow$ delete workflow.
  - [`tasks/offline_video.js`](meganz_utils/tasks/offline_video.js): 3-phase offline batch video conversion workflow.
  - [`tasks/upload_thumbnails.js`](meganz_utils/tasks/upload_thumbnails.js): Sharp thumbnail/preview generator.
  - [`tasks/organize_daywise.js`](meganz_utils/tasks/organize_daywise.js): Fast day-wise folder organizer with server-side instant moves.
  - [`test_logic.js`](meganz_utils/test_logic.js): Unit test suite (11 test suites covering scanning, session caching, and CSV manifest logic).
