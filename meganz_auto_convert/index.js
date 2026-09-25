/**
 * MEGA.nz Automated JPEG to AVIF Converter & Sync Utility
 * 
 * Standalone, production-ready utility that recursively traverses a MEGA.nz folder,
 * converts all JPEG images (.jpg / .jpeg) to AVIF format with metadata retention,
 * uploads the converted .avif files back to their parent folders, and removes
 * the original JPEGs from MEGA.nz.
 *
 * Supports both immediate single-run (--once) and scheduled cron (--cron) modes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const dotenv = require('dotenv');
const { Storage } = require('megajs');
const cron = require('node-cron');

const execPromise = util.promisify(exec);

// Load environment variables from .env if present
dotenv.config({ path: path.resolve(__dirname, '.env') });

// ====================================================================
// Logger Utility
// ====================================================================

const logger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] [INFO] ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] [WARN] ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] [SUCCESS] ${msg}`),
  error: (msg, err) => {
    if (err && err.stack) {
      console.error(`[${new Date().toISOString()}] [ERROR] ${msg}\n${err.stack}`);
    } else {
      console.error(`[${new Date().toISOString()}] [ERROR] ${msg}${err ? ` - ${err}` : ''}`);
    }
  },
};

// ====================================================================
// Helper Functions
// ====================================================================

/**
 * Format bytes into human-readable string (e.g. 4.2 MB)
 * @param {number} bytes 
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Resolves a tilde path (~/...) to absolute home path.
 * @param {string} filePath
 * @returns {string}
 */
function resolveHomePath(filePath) {
  if (!filePath) return filePath;
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

/**
 * Finds the default location of the convert_to_avif.sh script.
 * @returns {string}
 */
function detectConvertScriptPath() {
  const candidates = [
    path.resolve(__dirname, '../convert_to_avif/convert_to_avif.sh'),
    path.resolve(__dirname, 'convert_to_avif/convert_to_avif.sh'),
    path.resolve(process.cwd(), 'convert_to_avif/convert_to_avif.sh'),
    path.resolve(process.cwd(), '../convert_to_avif/convert_to_avif.sh'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to relative path from workspace root
  return path.resolve(__dirname, '../convert_to_avif/convert_to_avif.sh');
}

// ====================================================================
// CLI Arguments & Configuration
// ====================================================================

/**
 * Parses CLI arguments.
 * Supported:
 *   --once             Run single conversion pass and exit
 *   --cron             Run on recurring cron schedule
 *   --schedule="<exp>" Custom cron schedule pattern (e.g. "0 * * * *")
 *   --path="<path>"    Override TARGET_PATH (e.g. "/Photos/SubFolder")
 *   --dry-run          Scan and list files without converting/uploading
 *   --force            Re-convert even if AVIF already exists
 *   --run-on-start     Run immediate pass when starting cron mode
 *   --help, -h         Show help screen
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    once: false,
    cron: false,
    dryRun: false,
    force: false,
    runOnStart: false,
    help: false,
    targetPath: null,
    schedule: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--once') {
      options.once = true;
    } else if (arg === '--cron') {
      options.cron = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--run-on-start') {
      options.runOnStart = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--schedule' && args[i + 1]) {
      options.schedule = args[++i];
    } else if (arg.startsWith('--schedule=')) {
      options.schedule = arg.split('=')[1];
    } else if (arg === '--path' && args[i + 1]) {
      options.targetPath = args[++i];
    } else if (arg.startsWith('--path=')) {
      options.targetPath = arg.split('=')[1];
    }
  }

  return options;
}

/**
 * Merges environment variables and CLI options into a runtime configuration.
 */
function buildConfig(cliOptions) {
  const rawLogFile = process.env.LOG_FILE || '~/ws/conversion.log';
  const resolvedLogFile = resolveHomePath(rawLogFile);

  const convertScript = process.env.CONVERT_SCRIPT_PATH
    ? resolveHomePath(process.env.CONVERT_SCRIPT_PATH)
    : detectConvertScriptPath();

  const runMode = cliOptions.cron
    ? 'cron'
    : cliOptions.once
    ? 'once'
    : (process.env.RUN_MODE || 'once').toLowerCase();

  return {
    megaEmail: process.env.MEGA_EMAIL || '',
    megaPassword: process.env.MEGA_PASSWORD || '',
    targetPath: cliOptions.targetPath || process.env.TARGET_PATH || '/',
    runMode,
    cronSchedule: cliOptions.schedule || process.env.CRON_SCHEDULE || '0 * * * *',
    dryRun: cliOptions.dryRun || process.env.DRY_RUN === 'true',
    force: cliOptions.force || process.env.FORCE_CONVERT === 'true',
    runOnStart: cliOptions.runOnStart || process.env.RUN_ON_START === 'true',
    convertScriptPath: convertScript,
    logFilePath: resolvedLogFile,
    tempBaseDir: process.env.TEMP_BASE_DIR || '/tmp/mega',
    codec: process.env.AVIF_CODEC || 'aom',
    speed: process.env.AVIF_SPEED || '8',
    quality: process.env.AVIF_QUALITY || '85',
    jobs: process.env.AVIF_JOBS || '1',
  };
}

/**
 * Prints usage documentation.
 */
function printHelp() {
  console.log(`
MEGA.nz Automated JPEG to AVIF Converter & Sync Tool
=====================================================

Usage:
  node index.js [options]

Options:
  --once                 Execute a single conversion sync run and exit (default mode)
  --cron                 Start as a daemon running on a cron schedule
  --schedule "<pattern>" Specify cron pattern (e.g. "0 * * * *" for hourly, default)
  --path "<targetPath>"  Designate root folder to scan on MEGA (e.g. "/Photos/SubFolder")
  --dry-run              Scan MEGA folder recursively and report files without modifying
  --force                Re-convert and overwrite existing AVIF files
  --run-on-start         Trigger an immediate run upon starting in --cron mode
  --help, -h             Display this help message

Environment Variables (.env):
  MEGA_EMAIL             MEGA.nz account email (required)
  MEGA_PASSWORD          MEGA.nz account password (required)
  TARGET_PATH            Target folder path on MEGA (default: "/")
  RUN_MODE               "once" or "cron" (default: "once")
  CRON_SCHEDULE          Cron expression (default: "0 * * * *")
  RUN_ON_START           Execute sync immediately on startup in cron mode (default: false)
  CONVERT_SCRIPT_PATH    Path to convert_to_avif.sh (auto-detected if omitted)
  LOG_FILE               Log file to append conversion logs (default: "~/ws/conversion.log")
  TEMP_BASE_DIR          Local scratch directory (default: "/tmp/mega")
  AVIF_CODEC             AV1 codec: "aom" (default, lowest RAM), "svt", or "rav1e"
  AVIF_SPEED             Encoder speed 0-10 (default: 8)
  AVIF_QUALITY           AVIF quality 0-100 (default: 85)
  AVIF_JOBS              Parallel jobs for encoder (default: 1)
`);
}

// ====================================================================
// Core MEGA Navigation & File Traversal
// ====================================================================

/**
 * Resolves the designated folder path starting from the MEGA storage root.
 *
 * @param {import('megajs').MutableFile} root - Root Cloud Drive folder
 * @param {string} targetPath - Path to target folder (e.g. "/Photos/SubFolder" or "/")
 * @returns {import('megajs').MutableFile} Resolved target folder object
 */
function resolveFolderPath(root, targetPath) {
  const normalized = (targetPath || '/').trim();
  if (normalized === '/' || normalized === '' || normalized === '.') {
    return root;
  }

  // Split into directory segments, omitting empty components
  const segments = normalized.split('/').filter(Boolean);
  let current = root;

  for (const segment of segments) {
    if (!current.children || !Array.isArray(current.children)) {
      throw new Error(`Target path segment "${segment}" cannot be resolved because "${current.name}" has no children`);
    }

    const nextFolder = current.children.find(
      (item) => item.directory && item.name === segment
    );

    if (!nextFolder) {
      const availableDirs = current.children
        .filter((c) => c.directory)
        .map((c) => `"${c.name}"`)
        .join(', ');
      throw new Error(
        `Directory "${segment}" not found in "${current.name}". Available subfolders: [${availableDirs || 'none'}]`
      );
    }

    current = nextFolder;
  }

  return current;
}

/**
 * Recursively traverses down all child folders starting from the specified folder.
 * Collects all file objects where file.directory is false and the extension matches /\.(jpe?g)$/i.
 *
 * @param {import('megajs').MutableFile} folder - The MEGA folder node to scan
 * @param {string} relativePath - The accumulated relative path from target root
 * @returns {Array<{ file: import('megajs').MutableFile, parentFolder: import('megajs').MutableFile, relativePath: string, fileName: string }>}
 */
function scanJpegFilesRecursively(folder, relativePath = '') {
  const results = [];

  if (!folder || !Array.isArray(folder.children)) {
    return results;
  }

  for (const item of folder.children) {
    const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;

    if (item.directory) {
      // Recurse into child directory
      results.push(...scanJpegFilesRecursively(item, itemRelativePath));
    } else if (item.name && /\.(jpe?g)$/i.test(item.name)) {
      results.push({
        file: item,
        parentFolder: folder,
        relativePath: itemRelativePath,
        fileName: item.name,
      });
    }
  }

  return results;
}

// ====================================================================
// Image Conversion & Processing Pipeline
// ====================================================================

/**
 * Processes a single JPEG file:
 * 1. Checks if AVIF already exists in parent folder (skips duplicate conversion if found).
 * 2. Downloads file directly into an in-memory Buffer using file.downloadBuffer().
 * 3. Writes buffer to temporary disk path (/tmp/mega/<path_to_file>/<filename>.jpg).
 * 4. Executes convert_to_avif.sh with metadata preservation.
 * 5. Reads generated .avif into a Buffer.
 * 6. Uploads the .avif buffer to the original parent folder on MEGA.
 * 7. Deletes the original JPEG file from MEGA using file.delete().
 * 8. Cleans up temporary disk files in a finally block.
 *
 * @param {object} item - File metadata and parent references
 * @param {object} config - Runtime configuration
 * @returns {Promise<object>} Result status and statistics
 */
async function processImage(item, config) {
  const { file, parentFolder, relativePath, fileName } = item;
  const avifFileName = fileName.replace(/\.(jpe?g)$/i, '.avif');

  // Check if an AVIF version already exists in the same MEGA parent folder
  const existingAvif = parentFolder.children
    ? parentFolder.children.find((c) => !c.directory && c.name.toLowerCase() === avifFileName.toLowerCase())
    : null;

  if (existingAvif && existingAvif.size > 0 && !config.force) {
    logger.info(
      `AVIF version "${avifFileName}" already exists in parent folder (${formatBytes(existingAvif.size)}). Cleaning up residual JPEG "${fileName}"...`
    );
    await file.delete();
    logger.success(`Removed residual JPEG "${fileName}" from MEGA.`);
    return {
      status: 'skipped_existing',
      fileName,
      avifFileName,
      originalSize: file.size,
      convertedSize: existingAvif.size,
    };
  }

  // Construct temporary file paths mirroring the folder hierarchy
  const sanitizedRelPath = relativePath.replace(/^\/+/, '');
  const tempJpgPath = path.join(config.tempBaseDir, sanitizedRelPath);
  const tempAvifPath = tempJpgPath.replace(/\.(jpe?g)$/i, '.avif');

  logger.info(`Starting conversion: "${relativePath}" (${formatBytes(file.size)})`);

  try {
    // Ensure the parent directory for temporary files exists
    await fs.promises.mkdir(path.dirname(tempJpgPath), { recursive: true });

    // Step 1: Download JPEG directly as an in-memory Buffer
    logger.info(`Downloading in-memory Buffer for "${fileName}"...`);
    const jpgBuffer = await file.downloadBuffer();

    if (!jpgBuffer || jpgBuffer.length === 0) {
      throw new Error(`Downloaded buffer is empty for "${fileName}"`);
    }

    // Step 2: Write buffer to scratch file for convert_to_avif CLI
    await fs.promises.writeFile(tempJpgPath, jpgBuffer);

    // Step 3: Ensure destination directory for log file exists
    await fs.promises.mkdir(path.dirname(config.logFilePath), { recursive: true });

    // Step 4: Execute convert_to_avif command
    // Using `set -o pipefail` ensures non-zero exit codes from convert_to_avif are not masked by tee
    const conversionCmd = `set -o pipefail; "${config.convertScriptPath}" "${tempJpgPath}" -o "${tempAvifPath}" --codec ${config.codec} -s ${config.speed} -q ${config.quality} -j ${config.jobs} 2>&1 | tee -a "${config.logFilePath}"`;

    logger.info(`Running convert_to_avif for "${fileName}"...`);
    await execPromise(conversionCmd, { shell: '/bin/bash' });

    // Step 5: Verify converted output file exists and is non-empty
    if (!fs.existsSync(tempAvifPath)) {
      throw new Error(`Converted AVIF file was not created at "${tempAvifPath}"`);
    }

    const avifBuffer = await fs.promises.readFile(tempAvifPath);
    if (!avifBuffer || avifBuffer.length === 0) {
      throw new Error(`Converted AVIF file is empty at "${tempAvifPath}"`);
    }

    const savedBytes = jpgBuffer.length - avifBuffer.length;
    const compressionRatio = (((savedBytes) / jpgBuffer.length) * 100).toFixed(1);
    logger.info(
      `Converted "${fileName}": ${formatBytes(jpgBuffer.length)} -> ${formatBytes(avifBuffer.length)} (${compressionRatio}% reduction)`
    );

    // Step 6: Upload AVIF buffer to the exact same parent folder in MEGA
    logger.info(`Uploading "${avifFileName}" to parent folder "${parentFolder.name}"...`);
    await parentFolder.upload(
      {
        name: avifFileName,
        size: avifBuffer.length,
        allowUploadBuffering: true,
      },
      avifBuffer
    ).complete;
    logger.success(`Upload complete for "${avifFileName}".`);

    // Step 7: Delete original JPEG file from MEGA
    logger.info(`Deleting original JPEG "${fileName}" from MEGA...`);
    await file.delete();
    logger.success(`Successfully removed "${fileName}" from MEGA.`);

    return {
      status: 'success',
      fileName,
      avifFileName,
      originalSize: jpgBuffer.length,
      convertedSize: avifBuffer.length,
    };
  } finally {
    // Operational Cleanup: Unconditionally remove scratch files to prevent disk exhaustion
    try {
      await fs.promises.unlink(tempJpgPath).catch(() => {});
      await fs.promises.unlink(tempAvifPath).catch(() => {});
    } catch (_) {}
  }
}

// ====================================================================
// Sync Workflow Runner
// ====================================================================

/**
 * Runs a single full synchronization pass:
 * 1. Authenticates with MEGA.nz.
 * 2. Resolves root target directory.
 * 3. Scans recursively for JPEGs.
 * 4. Processes images sequentially (concurrency control) with individual try/catch error boundaries.
 * 5. Logs comprehensive operational summary.
 * 6. Closes MEGA session.
 *
 * @param {object} config - Configuration object
 */
async function runSync(config) {
  const startTime = Date.now();
  logger.info(`=======================================================`);
  logger.info(`Starting MEGA JPEG -> AVIF Sync Run`);
  logger.info(`Target MEGA Path: "${config.targetPath}"`);
  logger.info(`Encoder Settings: Codec=${config.codec}, Speed=${config.speed}, Quality=${config.quality}, Jobs=${config.jobs}`);
  logger.info(`Log File: "${config.logFilePath}"`);
  logger.info(`=======================================================`);

  let storage = null;

  try {
    logger.info(`Authenticating with MEGA.nz as "${config.megaEmail}"...`);

    storage = await new Promise((resolve, reject) => {
      const s = new Storage({
        email: config.megaEmail,
        password: config.megaPassword,
        userAgent: 'meganz-auto-convert/1.0.0',
        autologin: true,
      });

      s.ready.then(() => resolve(s)).catch(reject);
    });

    logger.success(`Connected to MEGA.nz. Resolving target folder "${config.targetPath}"...`);

    const targetFolder = resolveFolderPath(storage.root, config.targetPath);
    logger.info(`Target folder resolved: "${targetFolder.name}" (ID: ${targetFolder.nodeId})`);

    logger.info(`Scanning recursively for JPEG images (*.jpg, *.jpeg)...`);
    const jpegItems = scanJpegFilesRecursively(targetFolder);
    logger.info(`Found ${jpegItems.length} JPEG file(s) under "${config.targetPath}".`);

    if (jpegItems.length === 0) {
      logger.info(`No JPEG files found. Directory is clean.`);
      return;
    }

    if (config.dryRun) {
      logger.info(`\n--- DRY-RUN MODE: Listing files to be converted ---`);
      for (const item of jpegItems) {
        const targetName = item.fileName.replace(/\.(jpe?g)$/i, '.avif');
        logger.info(`[DRY-RUN] "${item.relativePath}" (${formatBytes(item.file.size)}) -> "${targetName}"`);
      }
      logger.info(`--- DRY-RUN COMPLETE: ${jpegItems.length} candidate file(s) ---\n`);
      return;
    }

    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let totalSavedBytes = 0;
    let totalOriginalBytes = 0;
    let totalConvertedBytes = 0;

    // Concurrency Control: Sequential loop (for...of) to keep VPS memory and CPU usage minimal
    for (let i = 0; i < jpegItems.length; i++) {
      const item = jpegItems[i];
      const progress = `[${i + 1}/${jpegItems.length}]`;
      logger.info(`\n${progress} Processing: "${item.relativePath}"`);

      // Error Boundary: Individual try...catch protects the sync process from crashing
      try {
        const result = await processImage(item, config);

        if (result.status === 'success') {
          successCount++;
          totalOriginalBytes += result.originalSize;
          totalConvertedBytes += result.convertedSize;
          totalSavedBytes += Math.max(0, result.originalSize - result.convertedSize);
        } else if (result.status === 'skipped_existing') {
          skippedCount++;
        }
      } catch (err) {
        failedCount++;
        logger.error(`Failed to process "${item.relativePath}": ${err.message}`);
        logger.warn(`Skipping to next file. Original file remains safe on MEGA.`);
      }
    }

    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`\n=======================================================`);
    logger.info(`Sync Run Completed in ${elapsedSeconds}s`);
    logger.info(`Summary:`);
    logger.info(`  Total Discovered: ${jpegItems.length}`);
    logger.info(`  Converted & Synced: ${successCount}`);
    logger.info(`  Skipped (Existing): ${skippedCount}`);
    logger.info(`  Failed (Safeguarded): ${failedCount}`);
    if (successCount > 0) {
      logger.info(`  Original Volume: ${formatBytes(totalOriginalBytes)}`);
      logger.info(`  Converted Volume: ${formatBytes(totalConvertedBytes)}`);
      logger.info(`  Total Space Saved: ${formatBytes(totalSavedBytes)}`);
    }
    logger.info(`=======================================================\n`);
  } catch (err) {
    logger.error(`Fatal error during sync run: ${err.message}`, err);
    throw err;
  } finally {
    if (storage) {
      try {
        await storage.close();
      } catch (_) {}
    }
  }
}

// ====================================================================
// Entry Point & Scheduling Controller
// ====================================================================

async function main() {
  const cliOptions = parseArgs();

  if (cliOptions.help) {
    printHelp();
    process.exit(0);
  }

  const config = buildConfig(cliOptions);

  // Validate required MEGA credentials
  if (!config.megaEmail || !config.megaPassword) {
    console.error(`\n[FATAL] Missing required MEGA credentials.`);
    console.error(`Please provide MEGA_EMAIL and MEGA_PASSWORD in your .env file or environment.\n`);
    printHelp();
    process.exit(1);
  }

  // Validate convert_to_avif.sh script
  if (!fs.existsSync(config.convertScriptPath)) {
    logger.warn(`convert_to_avif.sh was not found at: "${config.convertScriptPath}"`);
    logger.warn(`Please set CONVERT_SCRIPT_PATH to the correct location of convert_to_avif.sh.`);
  } else {
    try {
      fs.chmodSync(config.convertScriptPath, 0o755);
    } catch (_) {}
  }

  logger.info(`Initialized meganz-auto-convert in [${config.runMode.toUpperCase()}] mode`);

  if (config.runMode === 'cron') {
    if (!cron.validate(config.cronSchedule)) {
      logger.error(`Invalid cron expression: "${config.cronSchedule}". Exiting.`);
      process.exit(1);
    }

    logger.info(`Configured cron schedule: "${config.cronSchedule}"`);
    let isJobRunning = false;

    // Mutex-protected cron handler to prevent overlapping runs on long conversions
    const scheduledJob = async () => {
      if (isJobRunning) {
        logger.warn(`Previous sync job is still actively running. Skipping this schedule trigger.`);
        return;
      }
      isJobRunning = true;
      try {
        await runSync(config);
      } catch (err) {
        logger.error(`Cron sync cycle encountered an error: ${err.message}`);
      } finally {
        isJobRunning = false;
      }
    };

    const task = cron.schedule(config.cronSchedule, scheduledJob);

    // Optional immediate execution on startup
    if (config.runOnStart) {
      logger.info(`RUN_ON_START is true: Initiating immediate startup sync...`);
      scheduledJob();
    }

    // Graceful signal handling
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}. Gracefully stopping cron scheduler...`);
      task.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    logger.info(`Cron daemon is active. Awaiting scheduled triggers (Press Ctrl+C to terminate)...`);
  } else {
    // Single immediate run mode
    try {
      await runSync(config);
      process.exit(0);
    } catch (err) {
      logger.error(`Sync execution failed: ${err.message}`);
      process.exit(1);
    }
  }
}

// Start application
main().catch((err) => {
  logger.error(`Uncaught exception in main(): ${err.message}`, err);
  process.exit(1);
});
