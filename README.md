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
3. Ensures Node.js (>= 18) and runs `npm install` for `meganz_utils`.
4. Runs unit tests and self-checks.

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
If you already use `rclone` with a remote named `mega1`:
```bash
# meganz_utils automatically reads ~/.config/rclone/rclone.conf
rclone config
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

---

## 📂 Repository Structure

- [`setup_ubuntu.sh`](setup_ubuntu.sh): Top-level automated Ubuntu installer.
- [`convert_to_avif/`](convert_to_avif/): Standalone Python AVIF encoding and QA engine with gain-map support.
  - [`install_ubuntu.sh`](convert_to_avif/install_ubuntu.sh): Low-level C/C++ dependency and libavif build script.
- [`meganz_utils/`](meganz_utils/): Node.js automation suite for MEGA.nz cloud drive operations.
  - [`index.js`](meganz_utils/index.js): CLI entrypoint.
  - [`tasks/convert_to_avif.js`](meganz_utils/tasks/convert_to_avif.js): Remote download $\rightarrow$ convert $\rightarrow$ validate $\rightarrow$ upload $\rightarrow$ delete workflow.
  - [`tasks/upload_thumbnails.js`](meganz_utils/tasks/upload_thumbnails.js): Sharp thumbnail/preview generator.
  - [`test_logic.js`](meganz_utils/test_logic.js): Unit test suite.
