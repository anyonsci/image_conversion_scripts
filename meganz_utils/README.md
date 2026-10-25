# MEGA.nz Utility Suite (`meganz_utils`)

A modular, extensible, production-ready Node.js utility suite for automating operations, conversions, and metadata enhancements on **MEGA.nz**.

---

## Architecture & Directory Structure

```text
meganz_utils/
├── lib/                        # Core reusable utilities
│   ├── client.js               # MEGA client auth & persistent session resumption
│   ├── manifest.js             # CSV manifest management & RFC-4180 parsing for offline resumption
│   ├── scanner.js              # Folder resolution & extension filtering
│   └── logger.js               # Timestamped logging & formatting
├── tasks/                      # Modular task runners
│   ├── upload_thumbnails.js    # Task 1: Full-frame thumbnail & preview generator
│   ├── convert_to_avif.js      # Task 2: Automated JPEG -> AVIF converter & sync
│   ├── convert_video_to_av1.js # Task 3: Streaming MP4/MOV -> AV1 video converter & sync
│   ├── offline_video.js        # Task 4: 3-phase offline video pipeline (batch dl -> local convert -> batch ul)
│   └── organize_daywise.js     # Task 5: Fast day-wise folder organizer
├── index.js                    # Unified CLI entrypoint & task dispatcher
├── package.json                # Project manifest & npm scripts
├── .env.example                # Environment variables template
└── README.md                   # This documentation
```

---

## Key Features

1. **Auto-Authentication with `rclone`**: Automatically detects and decrypts credentials from your existing `~/.config/rclone/rclone.conf` (remote `[mega1]`) or `.env`.
2. **Shared Folder & Extension Filtering**: Common scanning logic (`lib/scanner.js`) handles recursive folder traversal and case-insensitive extension matching.
3. **Full-Frame AVIF Tile-Grid Decoding**: Uses `avifdec` (official AOMedia reference decoder) to properly stitch multi-tile Android MIAF grids, preventing top-left cropping.
4. **Zero-Bandwidth Local Matching**: When generating thumbnails/previews, points directly to a local directory (`--local-dir`) to avoid downloading large files from MEGA again.
5. **Memory Safe**: Strictly limits scratch disk and memory usage with immediate file cleanup, making it safe for low-RAM cloud instances (e.g. 1 GB RAM).

---

## Command 1: `thumbnails` (Thumbnail & Preview Generator)

Attaches sharp, full-frame thumbnails (Attribute `0`, 320px) and previews (Attribute `1`, 1600px) directly to existing files on MEGA without re-uploading file content.

### Why Both Are Uploaded
- **Thumbnail (320px JPEG, ~16 KB)**: Used in MEGA folder grid view, album tiles, and search results.
- **Preview (1600px JPEG, ~220 KB)**: Used in MEGA lightbox viewer when viewing full-screen or sliding through photos.

### Usage
```bash
# Process matching local files in folder "mummy_parna_26":
node index.js thumbnails --path="mummy_parna_26" --local-dir="/home/ubuntu/ws/parna_avif"

# Dry run (inspect what would be processed without modifying MEGA):
node index.js thumbnails --path="mummy_parna_26" --local-dir="/home/ubuntu/ws/parna_avif" --dry-run

# Test run with first 5 files:
node index.js thumbnails --path="mummy_parna_26" --local-dir="/home/ubuntu/ws/parna_avif" --limit 5

# Force re-generation of already existing thumbnails:
node index.js thumbnails --path="mummy_parna_26" --local-dir="/home/ubuntu/ws/parna_avif" --force

# Upload ONLY thumbnails (skip 1600px previews):
node index.js thumbnails --path="mummy_parna_26" --local-dir="/home/ubuntu/ws/parna_avif" --only-thumbnails

# Run in background with logging (Recommended for large batches):
nohup node index.js thumbnails --path="mummy_parna_26" --local-dir="/home/ubuntu/ws/parna_avif" > upload_thumbs.log 2>&1 &
```

### Options for `thumbnails`
| Flag | Description | Default |
| :--- | :--- | :--- |
| `-p, --path <path>` | Target folder on MEGA | `"/"` |
| `-l, --local-dir <path>` | Local folder containing original files (prevents re-downloading) | `null` |
| `-e, --ext <list>` | File extensions to process | `avif,jpg,jpeg,png,webp` |
| `--only-thumbnails` | Generate and upload ONLY 320px thumbnails | `false` |
| `--allow-download` | Download file from MEGA if not found locally | `false` |
| `--limit <N>` | Process at most N files | `0` (all) |
| `-f, --force` | Re-generate even if attributes already exist | `false` |
| `--dry-run` | Show plan without uploading | `false` |

---

## Command 2: `convert` (JPEG to AVIF Converter & Sync)

Recursively monitors a folder on MEGA, downloads JPEGs, encodes them to AVIF using `convert_to_avif` with metadata retention, attaches thumbnails/previews, uploads AVIF back to MEGA, and removes the original JPEGs.

### Usage
```bash
# Run a single conversion pass:
node index.js convert --path="/Photos/Vacation"

# Dry run to list candidate JPEGs:
node index.js convert --path="/Photos/Vacation" --dry-run

# Run as background daemon with hourly cron:
node index.js convert --path="/Photos/Vacation" --cron

# Custom schedule (every 30 minutes) with immediate run on startup:
node index.js convert --path="/Photos/Vacation" --cron --schedule="*/30 * * * *" --run-on-start
```

### Options for `convert`
| Flag | Description | Default |
| :--- | :--- | :--- |
| `-p, --path <path>` | Target folder on MEGA | `"/"` |
| `--cron` | Run continuously on a schedule | `false` |
| `--schedule <expr>` | Cron expression | `"0 * * * *"` |
| `--run-on-start` | Run immediately when daemon starts | `false` |
| `-q, --quality <num>`| Base AVIF quality (0-100) | `85` |
| `--adaptive-quality` | Dynamically scale quality (68-85) based on source JPEG quality/entropy | `true` |
| `--no-adaptive-quality` | Force fixed `-q` quality without adaptive scaling | `false` |
| `-s, --speed <num>`  | AVIF encoder speed (0-10) | `8` |
| `--codec <codec>`    | Encoder codec (`aom`, `svt`, `rav1e`) | `aom` |
| `--min-ssim <num>`   | Minimum SSIM threshold before JPEG deletion | `0.85` |
| `--no-verify`        | Skip similarity verification | `false` |

> [!IMPORTANT]
> **100% AVIF Standardization (No Fallback)**: All target JPEG images are converted to AVIF to ensure complete format consistency across the cloud library. With `--adaptive-quality`, heavily compressed or high-noise photos have their target quality intelligently lowered so they achieve compression savings without artifact amplification, while clean camera shots retain maximum visual fidelity. Original JPEGs are deleted only after verified upload.

---

## Command 3: `organize` (Day-wise Photo & Video Organizer)

Sorts trip photos and videos into day-wise folders (`Day 1` = Oct 10 through `Day 7` = Oct 16) based on true capture/recording timestamps.

### Why File Modification Times Cannot Be Used
When converting images to AVIF or moving files on cloud drives, the filesystem modified/created dates reflect the conversion/upload day (e.g. today). `organize` bypasses filesystem timestamps and identifies the real capture date using a smart multi-tier strategy:

1. **Filename Regex (0-bandwidth, instantaneous)**: Matches `PXL_YYYYMMDD_...` (Pixel photos and videos) or ISO date patterns.
2. **Remote EXIF Header Probing (~128 KB range read)**: For Apple iPhone photos (`IMG_xxxx.HEIC`, `IMG_xxxx.avif`, `IMG_xxxx.JPG`), reads only the first 128 KB chunk to extract `DateTimeOriginal` / `CreateDate` via `exiftool`. The full image is never downloaded.
3. **QuickTime Atom Probing (~1 KB read)**: For videos (`.MOV`, `.MP4`), inspects the `moov` / `mvhd` atom creation date.
4. **Sequence Interpolation**: For untagged photos/screenshots without EXIF (e.g. `IMG_2856`), interpolates the capture date from adjacent numbered frames (`IMG_2855` and `IMG_2857`).
5. **Instant Server-Side Moves**: Files are moved using MEGA's native `file.moveTo(targetFolder)` API, which updates directory pointers in milliseconds with zero download/upload bandwidth.

### Usage
```bash
# Preview day-wise distribution without moving files:
node index.js organize --path="kashmir oct 26" --dry-run

# Execute live organization:
node index.js organize --path="kashmir oct 26"

# Organize another folder:
node index.js organize --path="kashmir"
```

### Options for `organize`
| Flag | Description | Default |
| :--- | :--- | :--- |
| `-p, --path <path>` | Target folder on MEGA to organize | `"/"` |
| `--dry-run` | Simulate date resolution & preview file counts per day | `false` |
| `--rclone-remote <remote>` | Rclone remote name to load credentials from | `"mega1"` |

---

## Command 4: `convert-video` (Streaming Remote Video to AV1)

Recursively streams `.mp4` and `.mov` videos from MEGA to disk, converts video streams to AV1 using SVT-AV1 with audio preservation, performs full-stream decode QA verification, generates poster thumbnails/previews, uploads back to MEGA as `<stem>.av1.mp4`, and deletes original remote files.

### Features
- **Adaptive CRF Tuning**: Dynamically scales CRF in the range `[30, 36]` based on resolution (4K UHD +4 CRF, 1080p +1 CRF), framerate (60fps +1 CRF), source codec (HEVC +1 CRF), and bitrate efficiency.
- **Capped CRF Ceiling (`mbr`)**: Restricts SVT-AV1 maximum bitrate to `0.90 * source_bitrate` to prevent file bloat on noisy or complex scenes (e.g. blizzards, water bursts).
- **Preset 10 Acceleration for 4K**: Employs SVT-AV1 Preset 10 on 4K content for 5x–8x throughput acceleration while maintaining high perceptual fidelity.
- **Strict QA Protection**: Original video files are only deleted if the converted AV1 achieves positive compression savings and passes a lossless null-sink decode test (`ffmpeg -v error -i <file> -f null -`). If no savings are achieved, the original file is safely retained.

### Usage
```bash
# Preview candidate videos:
node index.js convert-video --path="kashmir" --dry-run

# Run streaming conversion (CRF 30 dynamic, Preset 8, 2 threads):
node index.js convert-video --path="kashmir" -crf 30 --preset 8

# Force re-conversion of already converted videos:
node index.js convert-video --path="kashmir" --force
```

### Options for `convert-video`
| Flag | Description | Default |
| :--- | :--- | :--- |
| `-p, --path <path>` | Target folder on MEGA | `"/"` |
| `-crf, --crf <num>` | Base AV1 Constant Rate Factor (30-36) | `30` |
| `--preset <num>` | SVT-AV1 encoder preset (0-13) | `8` |
| `-t, --threads <num>` | Worker threads for SVT-AV1 | `2` |
| `--audio-codec <codec>` | Audio codec: `auto`, `copy`, `aac`, `opus` | `auto` |
| `--audio-bitrate <rate>`| Audio bitrate when re-encoding | `192k` |
| `--adaptive-quality` | Dynamically tune CRF based on resolution and bitrate | `true` |
| `--no-adaptive-quality` | Force fixed CRF for all videos | `false` |
| `--skip-low-bitrate` | Skip videos already compressed below 1.2 Mbps | `true` |
| `--dry-run` | List candidate videos without converting | `false` |

---

## Command 5: `offline` / Video Offline Mode

A decoupled, 3-phase batch video conversion pipeline designed for large cloud libraries and unreliable or metered connections. Separates network I/O from compute-heavy CPU encoding and uses a persistent CSV manifest for resilient resumption.

```text
~/ws/mega_offline_<folder_name>/
├── input/                  # Phase 1: Exact MEGA folder structure with downloaded originals
│   └── Day 1/
│       └── clip1.MOV
├── output/                 # Phase 2: Mirrored folder structure with converted AV1 videos
│   └── Day 1/
│       └── clip1.av1.mp4
└── manifest.csv            # Persistent state tracking: enables resumption & manual re-runs
```

### 3-Phase Architecture
1. **Phase 1: Batch Download (`--download-only`)**:
   Downloads all candidate videos (`.mp4`, `.mov`, `.m4v`, excluding `.av1.mp4`) in one go into `<offline_dir>/input/`, reproducing the exact remote folder hierarchy. Automatically skips already-downloaded files on resume.
2. **Phase 2: Local Offline Conversion (`--convert-only`)**:
   Encodes each file from `<offline_dir>/input/` into `<offline_dir>/output/`, mirroring the folder structure for direct comparison. Runs **100% offline** with zero network activity and no credentials required. Tracks all results in `manifest.csv`.
3. **Phase 3: Batch Upload & Remote Cleanup (`--upload-only`)**:
   Connects to MEGA in a single batch session, generates poster frames, streams converted AV1 videos to their parent folders, deletes original remote videos, and marks entries as `uploaded = true` in `manifest.csv`.

### CSV Manifest (`manifest.csv`) Format
Every file processed in Phase 2 is immediately recorded to disk:
```csv
relative_path,status,original_size,converted_size,savings_pct,duration_sec,crf,preset,timestamp,uploaded,error_message
Day 1/IMG_0001.MOV,converted,45123984,18049593,60.0,0.0,32,8,2026-10-25T01:00:00Z,false,
Day 1/IMG_0002.MOV,rejected_no_savings,12000000,0,0.0,0.0,30,8,2026-10-25T01:05:00Z,false,AV1 output did not achieve minimum required savings
```

- **Resumption**: Re-running Phase 2 or Phase 3 automatically skips files marked `converted`, `rejected_no_savings`, or `skipped_low_bitrate`.
- **Manual Re-run Control**: To re-encode a file with different settings, simply delete that row from `manifest.csv`. The next run will pick up and re-process that file.

### Usage
```bash
# Run full 3-phase offline pipeline end-to-end:
node index.js convert-video --path="kashmir" --offline

# Phase 1: Batch download candidate videos:
node index.js convert-video --path="kashmir" --download-only

# Phase 2: Convert offline (can run anywhere, even air-gapped without MEGA credentials):
node index.js convert-video --convert-only --offline-dir="~/ws/mega_offline_kashmir"

# Phase 3: Batch upload converted videos and delete originals:
node index.js convert-video --path="kashmir" --upload-only
```

### Options for Offline Mode
| Flag | Description | Default |
| :--- | :--- | :--- |
| `--offline` | Enable 3-phase offline video pipeline | `false` |
| `--offline-dir <path>` | Custom directory for offline workspace | `~/ws/mega_offline_<folder>` |
| `--download-only` | Run Phase 1 only (download candidates to local disk) | `false` |
| `--convert-only` | Run Phase 2 only (local conversion, no MEGA connection) | `false` |
| `--upload-only` | Run Phase 3 only (batch upload converted videos & cleanup) | `false` |

---

## How to Add New Functions in the Future

The utility uses a clean task-based pattern:

1. **Create a new task module** in `tasks/<my_task>.js`:
   ```javascript
   const { logger } = require('../lib/logger');
   const { scanFiles } = require('../lib/scanner');

   async function runMyTask(storage, targetFolder, options, rawNodes) {
     const files = scanFiles(targetFolder, { extensions: options.ext });
     for (const file of files) {
       // Perform operation on file (e.g. rename, reorganize, verify)
     }
   }

   module.exports = { runMyTask };
   ```

2. **Register the command** in `index.js`:
   - Import `runMyTask` from `./tasks/<my_task>`.
   - Add the command name to `validCommands` in `main()`.
   - Dispatch to `await runMyTask(storage, targetFolder, cli, rawNodes)`.

3. **Add an npm script** in `package.json`:
   ```json
   "scripts": {
     "my-task": "node index.js my-task"
   }
   ```
