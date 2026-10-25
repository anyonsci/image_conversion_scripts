# AGENTS.md — Developer & AI Agent Guidelines

This document provides architectural context, operational constraints, and workflow instructions for AI agents and human developers maintaining or extending this codebase.

---

## 1. Project Purpose & Architecture

The repository provides a dual-layer toolchain for high-fidelity photo conversion and cloud synchronization:

```text
image_conversion_scripts/
├── convert_to_avif/            # Layer 1: Python AVIF image encoding & QA verification engine
│   ├── encoding.py             # libavif / avifenc CLI wrapper, adaptive quality scaling
│   ├── gain_maps.py            # Ultra HDR / Apple HDR gain map extraction & injection
│   ├── probing.py             # Format detection, entropy analysis, and dimension probing
│   ├── qa.py                   # SSIM perceptual similarity scoring & validation
│   └── main.py                 # Standalone CLI entrypoint
│
├── convert_video_to_av1/       # Layer 1.5: Python AV1 video encoding & QA verification engine
│   ├── encoding.py             # ffmpeg + libsvtav1 wrapper, HDR 10-bit preservation, faststart
│   ├── probing.py             # ffprobe video/audio codec, resolution, rotation & color tags
│   ├── qa.py                   # Lossless null-sink decode test, duration parity & resolution check
│   ├── pipeline.py             # Single-file & batch recursive conversion orchestration
│   └── cli.py                  # Standalone CLI entrypoint
│
├── meganz_utils/               # Layer 2: Node.js automation suite for MEGA.nz
│   ├── lib/
│   │   ├── client.js           # MEGA client auth (rclone config / .env) + custom HTTP parser
│   │   ├── scanner.js          # Remote folder resolution & extension filtering
│   │   └── logger.js           # Timestamped logging formatting
│   ├── tasks/
│   │   ├── convert_to_avif.js  # Task 1: Remote JPEG/HEIC -> AVIF sync pipeline
│   │   ├── convert_video_to_av1.js # Task 1b: Remote MP4/MOV -> AV1 streaming pipeline
│   │   ├── upload_thumbnails.js# Task 2: High-resolution thumbnail/preview generator
│   │   └── organize_daywise.js # Task 3: Day-wise trip organizer (Day 1 - Day 7)
│   └── index.js                # Unified CLI entrypoint & dispatcher
```

---

## 2. Core Operating Principles for AI Agents

1. **RAM-Conscious Concurrency (Single-Threaded `-j 1`)**:
   - Deployment instances may operate with low memory (e.g. 1–2 GB RAM).
   - High-resolution AVIF encoding (e.g. 12–50 MP photos) can consume significant RAM.
   - Always default to `-j 1` (single worker) for encoding and cleanup scratch buffers immediately to prevent Linux OOM killer invocation or swap thrashing.
2. **Never Delete Without Verified Validation**:
   - In `convert_to_avif.js`, original JPEGs/HEICs must **only** be deleted after:
     1. Converted AVIF passes SSIM verification (`SSIM >= minSSIM`, default 0.85).
     2. Resolution dimensions strictly match the original.
     3. AVIF file is successfully uploaded to MEGA.
   - In `convert_video_to_av1.js`, original MP4/MOVs must **only** be deleted after:
     1. Converted AV1 passes full-stream decode test (`ffmpeg -v error -i <file> -f null -`).
     2. Duration matches source within tolerance and resolution matches.
     3. AV1 video is successfully uploaded to MEGA.
3. **RAM-Safe Video Streaming**:
   - Videos (100MB – 2GB+) must never be downloaded into in-memory buffers (`downloadBuffer()`).
   - Always stream to/from local disk (`file.download().pipe(...)` and `fs.createReadStream().pipe(folder.upload())`) to protect instances from OOM crashes.
4. **Zero-Bandwidth Operations First**:
   - **Video AV1 Detection**: All converted videos strictly use the `<stem>.av1.mp4` suffix. The scanner immediately excludes `*.av1.mp4` by filename regex (0 bytes) and verifies whether `<stem>.av1.mp4` already exists on MEGA before downloading any source video.
   - **Day-wise Organizing**: Never download full photos to move them. Extract dates via filename regex (0 bytes) or header range reads (~128 KB for EXIF, ~1 KB for QuickTime atoms). Move files using MEGA's server-side `moveTo()` API.
   - **Thumbnails**: Point to local directories (`--local-dir`) whenever files exist locally to prevent redundant downloads.

---

## 3. Critical Technical Gotchas & Workarounds

### A. Node.js Strict HTTP Parser (`HPE_CR_EXPECTED`)
- **Symptom**: Downloads hang indefinitely or fail with `HTTPParserError: HPE_CR_EXPECTED` on Node 18+.
- **Root Cause**: MEGA storage servers (`userstorage.mega.co.nz`) occasionally omit `\r` (CR) before `\n` in custom headers.
- **Solution**: [`lib/client.js`](meganz_utils/lib/client.js) implements `customFetch` with `insecureHTTPParser: true`. Never replace this with native Node fetch or undici without retaining the insecure parser flag.

### B. MEGA "MAC verification failed"
- **Symptom**: Ranged or full downloads occasionally fail with `Error: MAC verification failed`.
- **Solution**: Handled automatically in [`tasks/convert_to_avif.js`](meganz_utils/tasks/convert_to_avif.js) via fallback ranged stream `{ start: 0, end: size - 1 }` with verification disabled.

### C. HEIC 512x512 Embedded Thumbnail Bug
- **Symptom**: `Error: Dimension mismatch: Source image is 512x512 but AVIF decoded to 3024x4032`.
- **Root Cause**: Apple HEIC files embed a 512x512 preview stream. Libavif or generic decoders can inadvertently read the thumbnail stream instead of the full sensor plane.
- **Solution**: Always probe HEIC dimensions using `exiftool` (`ImageWidth` / `ImageHeight`) first before libavif probing.

### D. Android MIAF Tile Grids
- **Symptom**: Converted AVIF thumbnails appear cropped to the top-left quadrant.
- **Solution**: [`tasks/upload_thumbnails.js`](meganz_utils/tasks/upload_thumbnails.js) decodes AVIF files using `avifdec` (official AOMedia reference decoder) to stitch tile grids before scaling with `ffmpeg`.

### E. Active Conversion Awareness
- **Rule**: Never run `organize` on a folder that is actively undergoing conversion by `convert_to_avif`. If files are moved into subdirectories while conversion is running, newly uploaded AVIFs will land in the root folder instead of the day folder.

### F. MEGA Attribute 1MB Limit (`Error: MEGA returned a 400 status code`)
- **Symptom**: Upload fails with `Error: MEGA returned a 400 status code` during file upload or attribute upload.
- **Root Cause**: MEGA storage servers strictly enforce a 1 MB (1,048,576 bytes) ceiling on file attributes (Attribute 0: thumbnail, Attribute 1: preview). Generating 1600px previews at high quality (`-q:v 2`) on complex, high-entropy scenes (trees, mountains, water) can generate previews exceeding 1 MB, triggering an HTTP 400 Bad Request.
- **Solution**: Previews must be encoded with `-q:v 4` and dynamically capped below 800 KB. `uploadFileWithRetry` in [`tasks/convert_to_avif.js`](meganz_utils/tasks/convert_to_avif.js) catches stream errors, intercepts 400 responses, and automatically retries by stripping oversized preview attributes so the underlying AVIF file is never blocked.

---

## 4. Key Workflows & CLI Commands

### Running in `tmux` with Live Logs
When executing long-running conversions on remote servers, always run inside a `tmux` session and tee output to both stdout and a log file:
```bash
tmux new -s conversion
node meganz_utils/index.js convert --path="kashmir" --no-skip-ultrahdr 2>&1 | tee -a /home/ubuntu/ws/conversion_kashmir.log
```

### Video Conversion to AV1
Recursively converts remote `.mp4` and `.mov` videos to AV1 using SVT-AV1 with QA validation:
```bash
# Preview candidate videos:
node meganz_utils/index.js convert-video --path="kashmir" --dry-run

# Run streaming conversion (CRF 30, Preset 8, 2 threads):
node meganz_utils/index.js convert-video --path="kashmir" -crf 30 --preset 8

# Run 3-phase Offline Mode (batch download -> local convert -> batch upload):
node meganz_utils/index.js convert-video --path="kashmir" --offline

# Selective phases:
node meganz_utils/index.js convert-video --path="kashmir" --download-only
node meganz_utils/index.js convert-video --convert-only --offline-dir="~/ws/mega_offline_kashmir"
node meganz_utils/index.js convert-video --path="kashmir" --upload-only
```

### Day-wise Photo Organizing
Organizes photos and videos into `Day 1` (Oct 10) through `Day 7` (Oct 16) based on true capture timestamps:
```bash
# Preview plan with dry run:
node meganz_utils/index.js organize --path="kashmir oct 26" --dry-run

# Execute server-side moves:
node meganz_utils/index.js organize --path="kashmir oct 26"
```

### Unit Tests & Verification
Run the regression test suite before committing changes:
```bash
cd meganz_utils
npm test
```
