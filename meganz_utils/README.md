# MEGA.nz Utility Suite (`meganz_utils`)

A modular, extensible, production-ready Node.js utility suite for automating operations, conversions, and metadata enhancements on **MEGA.nz**.

---

## Architecture & Directory Structure

```text
meganz_utils/
├── lib/                        # Core reusable utilities
│   ├── client.js               # MEGA client authentication (CLI, .env, or rclone.conf)
│   ├── scanner.js              # Folder resolution & extension filtering
│   └── logger.js               # Timestamped logging & formatting
├── tasks/                      # Modular task runners
│   ├── upload_thumbnails.js    # Task 1: Full-frame thumbnail & preview generator
│   └── convert_to_avif.js      # Task 2: Automated JPEG -> AVIF converter & sync
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
| `-q, --quality <num>`| AVIF quality (0-100) | `85` |
| `-s, --speed <num>`  | AVIF encoder speed (0-10) | `8` |
| `--codec <codec>`    | Encoder codec (`aom`, `svt`, `rav1e`) | `aom` |

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
