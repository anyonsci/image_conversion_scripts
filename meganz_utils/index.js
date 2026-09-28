#!/usr/bin/env node

/**
 * meganz_utils
 *
 * Configurable, multi-function utility suite for modifying and maintaining files on MEGA.nz.
 *
 * Available Functions:
 *   1. thumbnails (thumb) : Generate and upload full-frame thumbnails & previews (using local files or download)
 *   2. convert (avif)     : Convert remote JPEGs to AVIF with metadata retention and sync back to MEGA
 *
 * Usage:
 *   node index.js <command> [options]
 */

'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env if present
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { logger } = require('./lib/logger');
const { resolveCredentials, connectMega, fetchRawNodes, closeMega } = require('./lib/client');
const { resolveFolderPath, parseExtensionFilter } = require('./lib/scanner');
const { runThumbnailsTask } = require('./tasks/upload_thumbnails');
const { runConvertTask } = require('./tasks/convert_to_avif');

// ====================================================================
// CLI Parser
// ====================================================================

function printGlobalHelp() {
  console.log(`
MEGA.nz Utility Suite (meganz_utils)
====================================
Extensible, production-grade CLI tools for managing, converting, and enhancing files on MEGA.nz.

Usage:
  node index.js <command> [options]

Commands:
  thumbnails, thumb    Generate and upload sharp, full-frame thumbnails (320px) and previews (1600px)
                       using avifdec + ffmpeg. Reads from local directory to prevent re-downloads.
  convert, avif        Recursively convert remote JPEGs to AVIF, attaching thumbnails, and removing originals.
  help                 Display this help message

Global Options:
  -p, --path <target>       Target folder path on MEGA (default: env TARGET_PATH or "/")
  -e, --ext <extensions>    Comma-separated extensions to filter (e.g. "jpg,jpeg,heic,heif" or "avif")
  --rclone-remote <remote>  Rclone remote name to load credentials from (default: "mega1")
  --email <email>           Override MEGA account email
  --password <password>     Override MEGA account password
  --limit <number>          Process at most N files (useful for testing)
  -f, --force               Force processing even if already converted or attributes exist
  --dry-run                 Simulate scan and report actions without making changes
  -h, --help                Show command-specific help

Thumbnails Options:
  -l, --local-dir <path>    Local directory containing the files (avoids re-downloading)
  --only-thumbnails         Generate and upload ONLY 320px thumbnails (skips previews)
  --allow-download          Download file from MEGA if not found in local directory

Convert Options:
  --cron                    Run as a background cron daemon
  --schedule <pattern>      Cron schedule pattern (default: "0 * * * *" for hourly)
  --run-on-start            Trigger immediate run upon starting daemon
  -q, --quality <num>       AVIF quality (default: 85)
  --adaptive-quality        Adaptively scale AVIF quality based on source JPEG quality/entropy (default: true)
  --no-adaptive-quality     Disable adaptive quality and use fixed -q for all files
  -s, --speed <num>         AVIF encoder speed 0-10 (default: 8)
  --codec <codec>           Encoder codec: aom (default, lowest RAM), svt, or rav1e
  --min-ssim <num>          Minimum SSIM perceptual similarity score 0-1 (default: 0.85)
  --skip-ultrahdr           Skip Ultra HDR photos with gain maps to preserve native dynamic range (default: true)
  --no-skip-ultrahdr        Attempt to convert Ultra HDR photos anyway
  --no-verify               Skip similarity validation before deleting source JPEG

Examples:
  # Upload thumbnails for local AVIF files in remote folder "mummy_parna_26":
  node index.js thumbnails --path="mummy_parna_26" --local-dir="/home/ubuntu/ws/parna_avif"

  # Convert remote JPEGs / HEIC files across entire drive starting from root:
  node index.js convert --path="/"

  # Convert remote JPEGs with quick validation (default) and limit 5 files:
  node index.js convert --path="/" --limit=5

  # Convert remote JPEGs on hourly schedule:
  node index.js convert --path="/" --cron
`);
}

function parseCLI() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    return { command: 'help' };
  }

  const command = args[0].toLowerCase();
  const options = {
    command,
    targetPath: process.env.TARGET_PATH || '/',
    ext: null,
    rcloneRemote: process.env.RCLONE_REMOTE || 'mega1',
    email: process.env.MEGA_EMAIL || '',
    password: process.env.MEGA_PASSWORD || '',
    localDir: process.env.LOCAL_DIR || null,
    onlyThumbnails: false,
    allowDownload: false,
    cron: false,
    schedule: process.env.CRON_SCHEDULE || null,
    runOnStart: false,
    quality: process.env.AVIF_QUALITY || '85',
    adaptiveQuality: true,
    jobs: process.env.AVIF_JOBS || '1',
    speed: process.env.AVIF_SPEED || '8',
    codec: process.env.AVIF_CODEC || 'aom',
    validate: true,
    minSSIM: process.env.MIN_SSIM ? parseFloat(process.env.MIN_SSIM) : 0.85,
    skipUltraHdr: true,
    force: false,
    dryRun: false,
    limit: 0,
    help: false,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '-p' || arg === '--path') {
      options.targetPath = args[++i];
    } else if (arg.startsWith('--path=')) {
      options.targetPath = arg.split('=')[1];
    } else if (arg === '-e' || arg === '--ext') {
      options.ext = parseExtensionFilter(args[++i]);
    } else if (arg.startsWith('--ext=')) {
      options.ext = parseExtensionFilter(arg.split('=')[1]);
    } else if (arg === '-l' || arg === '--local-dir') {
      options.localDir = args[++i];
    } else if (arg.startsWith('--local-dir=')) {
      options.localDir = arg.split('=')[1];
    } else if (arg === '--only-thumbnails' || arg === '--only-thumbnail' || arg === '--thumbnail-only') {
      options.onlyThumbnails = true;
    } else if (arg === '--allow-download') {
      options.allowDownload = true;
    } else if (arg === '--rclone-remote') {
      options.rcloneRemote = args[++i];
    } else if (arg.startsWith('--rclone-remote=')) {
      options.rcloneRemote = arg.split('=')[1];
    } else if (arg === '--email') {
      options.email = args[++i];
    } else if (arg.startsWith('--email=')) {
      options.email = arg.split('=')[1];
    } else if (arg === '--password') {
      options.password = args[++i];
    } else if (arg.startsWith('--password=')) {
      options.password = arg.split('=')[1];
    } else if (arg === '--limit') {
      options.limit = parseInt(args[++i], 10) || 0;
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1], 10) || 0;
    } else if (arg === '-f' || arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--cron') {
      options.cron = true;
    } else if (arg === '--schedule') {
      options.schedule = args[++i];
    } else if (arg.startsWith('--schedule=')) {
      options.schedule = arg.split('=')[1];
    } else if (arg === '--run-on-start') {
      options.runOnStart = true;
    } else if (arg === '-q' || arg === '--quality') {
      options.quality = args[++i];
    } else if (arg.startsWith('--quality=')) {
      options.quality = arg.split('=')[1];
    } else if (arg === '-s' || arg === '--speed') {
      options.speed = args[++i];
    } else if (arg.startsWith('--speed=')) {
      options.speed = arg.split('=')[1];
    } else if (arg === '-j' || arg === '--jobs') {
      options.jobs = args[++i];
    } else if (arg.startsWith('--jobs=')) {
      options.jobs = arg.split('=')[1];
    } else if (arg === '--codec') {
      options.codec = args[++i];
    } else if (arg.startsWith('--codec=')) {
      options.codec = arg.split('=')[1];
    } else if (arg === '--min-ssim') {
      options.minSSIM = parseFloat(args[++i]);
    } else if (arg.startsWith('--min-ssim=')) {
      options.minSSIM = parseFloat(arg.split('=')[1]);
    } else if (arg === '--no-verify' || arg === '--skip-validation') {
      options.validate = false;
    } else if (arg === '--adaptive-quality') {
      options.adaptiveQuality = true;
    } else if (arg === '--no-adaptive-quality') {
      options.adaptiveQuality = false;
    } else if (arg === '--no-skip-ultrahdr' || arg === '--no-skip-hdr') {
      options.skipUltraHdr = false;
    } else if (arg === '--skip-ultrahdr' || arg === '--skip-hdr') {
      options.skipUltraHdr = true;
    }
  }

  return options;
}

// ====================================================================
// Main Controller
// ====================================================================

async function main() {
  const cli = parseCLI();

  if (cli.command === 'help' || cli.help) {
    printGlobalHelp();
    return;
  }

  const validCommands = ['thumbnails', 'thumb', 'convert', 'avif'];
  if (!validCommands.includes(cli.command)) {
    console.error(`Error: Unknown command "${cli.command}". Run "node index.js help" for usage.`);
    process.exit(1);
  }

  // Set default extension filters per command if not explicitly overridden
  if (!cli.ext) {
    if (cli.command === 'thumbnails' || cli.command === 'thumb') {
      cli.ext = ['avif', 'jpg', 'jpeg', 'png', 'webp'];
    } else if (cli.command === 'convert' || cli.command === 'avif') {
      cli.ext = ['jpg', 'jpeg'];
    }
  }

  // 1. Resolve authentication credentials
  const credentials = resolveCredentials(cli);

  // 2. Connect to MEGA
  const storage = await connectMega(credentials);

  try {
    // 3. Resolve target folder node
    logger.info(`Resolving remote folder path: "${cli.targetPath}"...`);
    const targetFolder = resolveFolderPath(storage.root, cli.targetPath);
    logger.success(`Resolved folder: "${targetFolder.name}" (Node: ${targetFolder.nodeId})`);

    // 4. Fetch raw nodes if running thumbnails task (for fa inspection)
    let rawNodes = [];
    if (cli.command === 'thumbnails' || cli.command === 'thumb') {
      logger.info('Fetching node attribute metadata (fa)...');
      rawNodes = await fetchRawNodes(storage);
    }

    // 5. Dispatch to selected task
    if (cli.command === 'thumbnails' || cli.command === 'thumb') {
      await runThumbnailsTask(storage, targetFolder, cli, rawNodes);
    } else if (cli.command === 'convert' || cli.command === 'avif') {
      await runConvertTask(storage, targetFolder, cli);
    }
  } finally {
    closeMega(storage);
  }
}

main().catch((err) => {
  logger.error('Fatal execution error:', err);
  process.exit(1);
});
