# MEGA.nz Auto JPEG -> AVIF Converter & Sync Utility

Standalone, production-grade Node.js service that recursively monitors a designated folder in a MEGA.nz account, downloads JPEG images into an in-memory buffer, converts them to high-efficiency AVIF images using the project's native `convert_to_avif` toolchain (retaining EXIF and gain map metadata), uploads the converted `.avif` files back to their original parent subfolders, and removes the original `.jpg` / `.jpeg` files.

---

## Features

- **Direct MEGA API Integration:** Authenticates via `megajs` directly with account credentials.
- **Recursive Subfolder Traversal:** Navigates arbitrary folder depths on MEGA, maintaining exact parent-child directory structures.
- **In-Memory Streaming & Safe Scratch Processing:** Downloads files directly to in-memory `Buffer` objects, writes to temporary scratch files in `/tmp/mega/`, encodes to AVIF, and unconditionally cleans up scratch disk space in `finally` blocks.
- **Production Error Boundaries:** Each file is isolated in its own `try...catch` boundary. A corrupt image or upload issue will not crash the batch; original files are preserved on MEGA upon any conversion failure.
- **Concurrency & Memory Control:** Operates sequentially (`for...of`) to prevent memory/CPU saturation on small VPS instances (e.g., 1 GB RAM).
- **Flexible Execution Modes:** Supports immediate one-off execution (`--once`) or recurring background cron scheduling (`--cron`).
- **Dry-Run Mode:** Inspect candidates and preview planned actions without mutating any files on MEGA (`--dry-run`).

---

## Directory Structure

```text
image_conversion_scripts/
├── convert_to_avif/            # AVIF encoder pipeline wrapper
│   ├── convert_to_avif.sh
│   └── ...
└── meganz_auto_convert/        # This utility
    ├── .env.example            # Environment configuration template
    ├── index.js                # Main production script
    ├── package.json            # Node.js project manifest & dependencies
    ├── test_logic.js           # Unit test suite
    └── README.md               # Setup and operational documentation
```

---

## Linux VPS Setup Instructions

### 1. Prerequisites

Ensure Node.js (v18+) and system toolchain dependencies (`avifenc`, `exiftool`, `ffmpeg`) are installed on your Linux VPS:

```bash
# Ubuntu / Debian Node.js installation (if not already installed)
sudo apt update
sudo apt install -y nodejs npm

# Verify toolchain installed by convert_to_avif
# If needed, run the installer in the parent directory:
cd ../convert_to_avif && sudo ./install_ubuntu.sh -y
```

### 2. Install Project Dependencies

From within the `meganz_auto_convert` directory:

```bash
cd meganz_auto_convert
npm install
```

### 3. Configure Credentials & Environment

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
nano .env
```

Configure your credentials and target path:

```env
# Required credentials
MEGA_EMAIL=your_account@example.com
MEGA_PASSWORD=your_secure_password

# Target folder path on MEGA (e.g. /Photos/Vacation or /)
TARGET_PATH=/Photos/Vacation

# Execution mode: once or cron
RUN_MODE=once

# Cron schedule (default: hourly at minute 0)
CRON_SCHEDULE="0 * * * *"

# AVIF Encoder parameters
AVIF_CODEC=aom
AVIF_SPEED=8
AVIF_QUALITY=85
AVIF_JOBS=1

# Local scratch directory & logs
TEMP_BASE_DIR=/tmp/mega
LOG_FILE=~/ws/conversion.log
```

---

## Running the Utility

### Dry Run (Recommended First Step)
Simulate discovery and print planned actions without modifying MEGA:
```bash
npm run dry-run
# or:
node index.js --dry-run
```

### Single Execution (Run Once)
Process all JPEGs immediately and exit upon completion:
```bash
npm run start:once
# or:
node index.js --once --path="/Photos/SubFolder"
```

### Scheduled Daemon (Cron Mode)
Run as a background process checking MEGA on a recurring schedule:
```bash
npm run start:cron
# or with custom schedule (every 30 minutes) and immediate startup sync:
node index.js --cron --schedule="*/30 * * * *" --run-on-start
```

---

## Deploying as a System Service (Systemd)

For continuous 24/7 background operation on a Linux VPS, configure a `systemd` service:

1. Create a service file `/etc/systemd/system/mega-avif-sync.service`:

```ini
[Unit]
Description=MEGA.nz Automated JPEG to AVIF Converter Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/anyonsci/image_conversion_scripts/meganz_auto_convert
ExecStart=/usr/bin/node index.js --cron
Restart=on-failure
RestartSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

2. Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable mega-avif-sync.service
sudo systemctl start mega-avif-sync.service

# Check service status and logs
sudo systemctl status mega-avif-sync.service
journalctl -u mega-avif-sync.service -f
```

---

## Running Unit Tests

Run the built-in validation test suite:

```bash
npm test
```
