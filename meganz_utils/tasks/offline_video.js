/**
 * tasks/offline_video.js
 *
 * Implements a fully decoupled, stateful 3-phase offline video conversion pipeline:
 *
 * 1. Phase 1 (Download All):
 *    Downloads all candidate files from MEGA into <offlineDir>/input/ mirroring
 *    the exact remote folder hierarchy. Resumable (skips existing matching files).
 *
 * 2. Phase 2 (Convert Offline):
 *    Iterates over all files in <offlineDir>/input/ and encodes to <offlineDir>/output/
 *    conserving the exact structure for easy side-by-side comparison.
 *    Tracks every result in <offlineDir>/manifest.csv. Resumable at any point
 *    (skips already-processed files; deleting an entry in CSV allows re-running it).
 *    Runs completely offline with zero active network connection.
 *
 * 3. Phase 3 (Upload All):
 *    Connects to MEGA in a single batch session, generates poster frames,
 *    streams converted AV1 videos back to their parent folders, deletes original
 *    remote files, and marks entries as uploaded in the manifest.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const { logger, formatBytes } = require('../lib/logger');
const { scanFiles, resolveFolderPath } = require('../lib/scanner');
const {
  loadManifest,
  appendManifestEntry,
  updateManifestUploadStatus,
} = require('../lib/manifest');
const {
  downloadVideoWithRetry,
  uploadVideoStreamWithRetry,
  generateVideoPosters,
  deleteOriginalVideo,
  detectVideoConvertScriptPath,
  resolveHomePath,
  appendToLogFile,
} = require('./convert_video_to_av1');

const execPromise = util.promisify(exec);

/**
 * Resolves local directories for offline staging.
 * @param {object} options
 * @param {string} targetFolderName
 * @returns {{ offlineDir: string, inputDir: string, outputDir: string, manifestPath: string }}
 */
function resolveOfflineDirs(options, targetFolderName = 'video') {
  let offlineDir;
  if (options.offlineDir) {
    offlineDir = resolveHomePath(options.offlineDir);
  } else {
    const safeName = targetFolderName ? targetFolderName.replace(/[^a-zA-Z0-9_-]/g, '_') : 'video';
    offlineDir = path.join(os.homedir(), 'ws', `mega_offline_${safeName}`);
  }

  const inputDir = path.join(offlineDir, 'input');
  const outputDir = path.join(offlineDir, 'output');
  const manifestPath = path.join(offlineDir, 'manifest.csv');

  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  return { offlineDir, inputDir, outputDir, manifestPath };
}

/**
 * Phase 1: Downloads all candidate files from MEGA to local input directory.
 * @param {import('megajs').Storage} storage
 * @param {import('megajs').MutableFile} targetFolder
 * @param {object} config
 * @param {object} offlineDirs
 */
async function downloadAllPhase(storage, targetFolder, config, offlineDirs) {
  logger.info('\n=======================================================');
  logger.info('PHASE 1: BATCH DOWNLOAD (MEGA -> Local Disk)');
  logger.info(`Destination directory: "${offlineDirs.inputDir}"`);
  logger.info('=======================================================');

  const extensions = config.ext || ['mp4', 'mov', 'm4v'];
  const allFiles = scanFiles(targetFolder, {
    extensions,
    recursive: config.recursive !== false,
  });

  // Filter out any video that already has the .av1.mp4 suffix on remote
  const candidateFiles = config.force
    ? allFiles
    : allFiles.filter((item) => !item.name.toLowerCase().endsWith('.av1.mp4'));

  logger.info(`Found ${candidateFiles.length} candidate remote video(s) to download.`);

  const toProcess = config.limit && config.limit > 0 ? candidateFiles.slice(0, config.limit) : candidateFiles;
  if (config.limit && config.limit > 0 && candidateFiles.length > config.limit) {
    logger.info(`Limiting download to first ${config.limit} files (--limit ${config.limit}).`);
  }

  if (config.dryRun) {
    logger.info(`\n[DRY RUN] Would download ${toProcess.length} remote video(s):`);
    toProcess.forEach((f, idx) => {
      logger.info(`  ${idx + 1}. "${f.relativePath}" (${formatBytes(f.size)})`);
    });
    return { downloadedCount: 0, resumedCount: 0, totalBytes: 0 };
  }

  let downloadedCount = 0;
  let resumedCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;
    const localInputPath = path.join(offlineDirs.inputDir, item.relativePath);
    fs.mkdirSync(path.dirname(localInputPath), { recursive: true });

    // Check if already downloaded with identical file size
    if (fs.existsSync(localInputPath)) {
      const stat = fs.statSync(localInputPath);
      if (stat.size === item.size && stat.size > 0) {
        logger.info(`${progress} [Resumed] "${item.relativePath}" already downloaded (${formatBytes(item.size)}). Skipping.`);
        resumedCount++;
        totalBytes += stat.size;
        continue;
      }
    }

    const megaFile = item.file || item;
    logger.info(`${progress} Downloading "${item.relativePath}" (${formatBytes(item.size)})...`);
    await downloadVideoWithRetry(megaFile, localInputPath);

    const fileTimestamp = megaFile.timestamp || item.timestamp;
    if (fileTimestamp) {
      try {
        const fileDate = new Date(fileTimestamp * 1000);
        fs.utimesSync(localInputPath, fileDate, fileDate);
      } catch (_) {}
    }

    downloadedCount++;
    totalBytes += item.size;
    logger.success(`${progress} Downloaded "${item.relativePath}" (${formatBytes(item.size)}).`);
  }

  logger.info(`\nPhase 1 Complete: ${downloadedCount} newly downloaded, ${resumedCount} already present (${formatBytes(totalBytes)} total).`);
  return { downloadedCount, resumedCount, totalBytes };
}

/**
 * Scans local directory recursively for video files.
 * @param {string} dir
 * @param {string} [baseDir]
 * @returns {Array<{ relativePath: string, fullPath: string, size: number }>}
 */
function scanLocalVideoFiles(dir, baseDir = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(scanLocalVideoFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase().replace('.', '');
      if (['mp4', 'mov', 'm4v'].includes(ext) && !entry.name.toLowerCase().endsWith('.av1.mp4')) {
        const relativePath = path.relative(baseDir, fullPath);
        const stat = fs.statSync(fullPath);
        results.push({ relativePath, fullPath, size: stat.size });
      }
    }
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Phase 2: Offline Conversion.
 * Converts downloaded files, saves to output dir mirroring structure, and records to CSV manifest.
 * @param {object} config
 * @param {object} offlineDirs
 */
async function convertAllOfflinePhase(config, offlineDirs) {
  logger.info('\n=======================================================');
  logger.info('PHASE 2: OFFLINE LOCAL CONVERSION');
  logger.info(`Input directory:  "${offlineDirs.inputDir}"`);
  logger.info(`Output directory: "${offlineDirs.outputDir}"`);
  logger.info(`Manifest CSV:     "${offlineDirs.manifestPath}"`);
  logger.info('=======================================================');

  const manifest = loadManifest(offlineDirs.manifestPath);
  logger.info(`Loaded manifest with ${manifest.size} existing entry/entries.`);

  const localFiles = scanLocalVideoFiles(offlineDirs.inputDir);
  logger.info(`Found ${localFiles.length} video file(s) in local input directory.`);

  if (config.dryRun) {
    logger.info(`\n[DRY RUN] Would process ${localFiles.length} local video(s):`);
    localFiles.forEach((f, idx) => {
      const existing = manifest.get(f.relativePath);
      const statusNote = existing ? ` [Manifest: ${existing.status}]` : ' [Pending conversion]';
      logger.info(`  ${idx + 1}. "${f.relativePath}" (${formatBytes(f.size)})${statusNote}`);
    });
    return { convertedCount: 0, skippedManifestCount: 0, rejectedSavingsCount: 0, failedCount: 0 };
  }

  let convertedCount = 0;
  let skippedManifestCount = 0;
  let rejectedSavingsCount = 0;
  let failedCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < localFiles.length; i++) {
    const file = localFiles[i];
    const progress = `[${i + 1}/${localFiles.length}]`;
    const relPath = file.relativePath;

    // Check manifest for previous status
    if (manifest.has(relPath)) {
      const existing = manifest.get(relPath);
      if (
        existing.status === 'converted' ||
        existing.status === 'rejected_no_savings' ||
        existing.status.startsWith('skipped')
      ) {
        logger.info(`${progress} [Manifest Resume] Skipping "${relPath}" (Status: ${existing.status.toUpperCase()}).`);
        skippedManifestCount++;
        continue;
      }
    }

    logger.info(`\n--- ${progress} Converting: "${relPath}" (${formatBytes(file.size)}) ---`);

    const relDir = path.dirname(relPath);
    const ext = path.extname(relPath);
    const stem = path.basename(relPath, ext);
    const outDir = path.join(offlineDirs.outputDir, relDir);
    fs.mkdirSync(outDir, { recursive: true });

    const targetAv1Path = path.join(outDir, `${stem}.av1.mp4`);

    // Build convert_video_to_av1 CLI arguments
    const cmd = [
      `"${config.convertScriptPath}"`,
      `"${file.fullPath}"`,
      '-o', `"${targetAv1Path}"`,
      '-crf', String(config.crf),
      '-p', String(config.preset),
      '-t', String(config.threads),
      '--audio-codec', config.audioCodec,
      '--audio-bitrate', config.audioBitrate,
    ];

    if (config.logFilePath) {
      cmd.push('--log-file', `"${config.logFilePath}"`);
    }
    if (config.minSavingsPct != null) {
      cmd.push('--min-savings-pct', String(config.minSavingsPct));
    }
    if (config.adaptiveQuality !== false) {
      cmd.push('--adaptive-quality');
    } else {
      cmd.push('--no-adaptive-quality');
    }
    if (config.skipLowBitrate !== false) {
      cmd.push('--skip-low-bitrate');
    } else {
      cmd.push('--no-skip-low-bitrate');
    }
    if (config.validate === false) {
      cmd.push('--no-verify');
    }
    if (config.force) {
      cmd.push('--force');
    }

    const conversionCmd = cmd.join(' ');
    let stdout = '';
    let stderr = '';
    let isSuccess = false;

    try {
      const res = await execPromise(conversionCmd);
      stdout = res.stdout || '';
      stderr = res.stderr || '';
      isSuccess = true;
    } catch (execErr) {
      stdout = execErr.stdout || '';
      stderr = execErr.stderr || '';

      const combined = stdout + '\n' + stderr;
      if (
        combined.includes('REJECTED') ||
        combined.includes('QA Failed: Insufficient compression') ||
        combined.includes('QA Rejection:')
      ) {
        const detailLine = combined
          .split('\n')
          .find((l) => l.includes('Insufficient compression') || l.includes('QA Failed:') || l.includes('QA Rejection:')) || 'AV1 output did not achieve minimum required savings.';
        const cleanMsg = detailLine.replace(/.*(?:QA Rejection:|QA Failed:|Detail:)\s*/i, '').trim();

        logger.warn(`Retaining original "${relPath}": ${cleanMsg}`);
        appendManifestEntry(offlineDirs.manifestPath, {
          relativePath: relPath,
          status: 'rejected_no_savings',
          originalSize: file.size,
          convertedSize: 0,
          savingsPct: 0.0,
          durationSec: 0.0,
          crf: config.crf,
          preset: config.preset,
          timestamp: new Date().toISOString(),
          uploaded: false,
          errorMessage: cleanMsg,
        });
        manifest.set(relPath, { status: 'rejected_no_savings' });
        rejectedSavingsCount++;
        continue;
      }

      if (combined.includes('SKIPPED')) {
        const skipLine = combined.split('\n').find((l) => l.includes('SKIPPED') || l.includes('already highly compressed')) || combined;
        const cleanSkip = skipLine.replace(/.*(?:SKIPPED.*?:\s*|Detail:\s*)/i, '').trim();
        logger.info(`Skipped "${relPath}": ${cleanSkip}`);
        appendManifestEntry(offlineDirs.manifestPath, {
          relativePath: relPath,
          status: 'skipped_low_bitrate',
          originalSize: file.size,
          convertedSize: file.size,
          savingsPct: 0.0,
          durationSec: 0.0,
          crf: config.crf,
          preset: config.preset,
          timestamp: new Date().toISOString(),
          uploaded: false,
          errorMessage: cleanSkip,
        });
        manifest.set(relPath, { status: 'skipped_low_bitrate' });
        continue;
      }

      const errorMsg = (stderr.trim() || stdout.trim() || execErr.message);
      logger.error(`Conversion failed for "${relPath}": ${errorMsg}`);
      appendManifestEntry(offlineDirs.manifestPath, {
        relativePath: relPath,
        status: 'failed',
        originalSize: file.size,
        convertedSize: 0,
        savingsPct: 0.0,
        durationSec: 0.0,
        crf: config.crf,
        preset: config.preset,
        timestamp: new Date().toISOString(),
        uploaded: false,
        errorMessage: errorMsg,
      });
      manifest.set(relPath, { status: 'failed' });
      failedCount++;
      continue;
    }

    // Success path
    const aqLine = stdout.split('\n').find((l) => l.includes('[Adaptive Quality]'));
    if (aqLine) logger.info(`  ${aqLine.trim()}`);

    if (fs.existsSync(targetAv1Path) && fs.statSync(targetAv1Path).size > 0) {
      const convSize = fs.statSync(targetAv1Path).size;
      const savedBytes = file.size - convSize;
      const ratio = (((savedBytes) / file.size) * 100).toFixed(1);

      logger.success(`Converted "${relPath}": ${formatBytes(file.size)} -> ${formatBytes(convSize)} (${ratio}% reduction).`);

      appendManifestEntry(offlineDirs.manifestPath, {
        relativePath: relPath,
        status: 'converted',
        originalSize: file.size,
        convertedSize: convSize,
        savingsPct: parseFloat(ratio),
        durationSec: 0.0,
        crf: config.crf,
        preset: config.preset,
        timestamp: new Date().toISOString(),
        uploaded: false,
        errorMessage: '',
      });
      manifest.set(relPath, { status: 'converted' });
      convertedCount++;
    } else {
      logger.error(`Expected output file "${targetAv1Path}" was not created.`);
      failedCount++;
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`\nPhase 2 Complete in ${durationSec}s:`);
  logger.info(`- Converted:               ${convertedCount}`);
  logger.info(`- Skipped (via manifest):  ${skippedManifestCount}`);
  logger.info(`- Retained (no savings):   ${rejectedSavingsCount}`);
  logger.info(`- Failed:                  ${failedCount}`);

  return { convertedCount, skippedManifestCount, rejectedSavingsCount, failedCount };
}

/**
 * Phase 3: Uploads all converted videos to MEGA and deletes original remote files.
 * @param {import('megajs').Storage} storage
 * @param {import('megajs').MutableFile} targetFolder
 * @param {object} config
 * @param {object} offlineDirs
 */
async function uploadAllPhase(storage, targetFolder, config, offlineDirs) {
  logger.info('\n=======================================================');
  logger.info('PHASE 3: BATCH UPLOAD TO MEGA & REMOTE CLEANUP');
  logger.info(`Source directory: "${offlineDirs.outputDir}"`);
  logger.info('=======================================================');

  const manifest = loadManifest(offlineDirs.manifestPath);
  const toUpload = Array.from(manifest.values()).filter(
    (e) => e.status === 'converted' && e.uploaded !== true
  );

  logger.info(`Found ${toUpload.length} converted video(s) pending upload in manifest.`);

  if (toUpload.length === 0) {
    logger.info('All converted videos are already uploaded to MEGA. Nothing to upload.');
    return { uploadedCount: 0, skippedCount: 0 };
  }

  if (config.dryRun) {
    logger.info(`\n[DRY RUN] Would upload ${toUpload.length} converted video(s) and delete original files:`);
    toUpload.forEach((e, idx) => {
      logger.info(`  ${idx + 1}. "${e.relativePath}" (${formatBytes(e.convertedSize)})`);
    });
    return { uploadedCount: 0, skippedCount: 0 };
  }

  let uploadedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < toUpload.length; i++) {
    const entry = toUpload[i];
    const progress = `[${i + 1}/${toUpload.length}]`;
    const relDir = path.dirname(entry.relativePath);
    const stem = path.basename(entry.relativePath, path.extname(entry.relativePath));
    const targetAv1Name = `${stem}.av1.mp4`;

    const localAv1Path = path.join(offlineDirs.outputDir, relDir, targetAv1Name);
    if (!fs.existsSync(localAv1Path)) {
      logger.warn(`${progress} Local converted file missing at "${localAv1Path}". Skipping upload.`);
      skippedCount++;
      continue;
    }

    // Resolve remote parent folder
    let parentFolder = targetFolder;
    const normalizedRelDir = (relDir && relDir !== '.') ? relDir.split(path.sep).join('/') : '';
    if (normalizedRelDir) {
      try {
        parentFolder = resolveFolderPath(targetFolder, normalizedRelDir);
      } catch (err) {
        logger.error(`${progress} Failed to resolve remote folder for "${normalizedRelDir}": ${err.message}`);
        skippedCount++;
        continue;
      }
    }

    // Find original file on MEGA
    const originalName = path.basename(entry.relativePath);
    const originalFile = parentFolder.children
      ? parentFolder.children.find((c) => !c.directory && c.name === originalName)
      : null;
    const originalTimestamp = originalFile && originalFile.timestamp ? originalFile.timestamp : null;

    // Check if target AV1 video is already on MEGA
    const existingAv1 = parentFolder.children
      ? parentFolder.children.find((c) => !c.directory && c.name === targetAv1Name)
      : null;

    if (existingAv1) {
      logger.info(`${progress} "${targetAv1Name}" already exists on MEGA. Checking original removal...`);
      if (originalFile) {
        await deleteOriginalVideo(originalFile);
      }
      updateManifestUploadStatus(offlineDirs.manifestPath, entry.relativePath, true);
      uploadedCount++;
      continue;
    }

    logger.info(`\n${progress} Uploading "${targetAv1Name}" (${formatBytes(entry.convertedSize)}) to "${parentFolder.name}"...`);

    // Generate poster frames
    const tempThumb = path.join(os.tmpdir(), `poster_${Date.now()}_320.jpg`);
    const tempPrev = path.join(os.tmpdir(), `poster_${Date.now()}_1600.jpg`);
    const { thumbBuf, prevBuf } = await generateVideoPosters(localAv1Path, tempThumb, tempPrev);

    try {
      if (fs.existsSync(tempThumb)) fs.unlinkSync(tempThumb);
      if (fs.existsSync(tempPrev)) fs.unlinkSync(tempPrev);
    } catch (_) {}

    // Upload stream with retry
    await uploadVideoStreamWithRetry(
      parentFolder,
      targetAv1Name,
      localAv1Path,
      thumbBuf,
      prevBuf,
      originalTimestamp
    );

    logger.success(`${progress} Upload complete for "${targetAv1Name}".`);

    // Delete remote original video
    if (originalFile) {
      logger.info(`Deleting original video "${originalFile.name}" from MEGA...`);
      await deleteOriginalVideo(originalFile);
    }

    // Mark as uploaded in manifest.csv
    updateManifestUploadStatus(offlineDirs.manifestPath, entry.relativePath, true);
    uploadedCount++;
  }

  logger.info(`\nPhase 3 Complete: ${uploadedCount} uploaded & verified, ${skippedCount} skipped.`);
  return { uploadedCount, skippedCount };
}

/**
 * Main orchestrator for offline video conversion.
 * @param {import('megajs').Storage} storage
 * @param {import('megajs').MutableFile} targetFolder
 * @param {object} options
 */
async function runOfflineVideoTask(storage, targetFolder, options = {}) {
  const targetName = targetFolder ? targetFolder.name : (options.targetPath ? path.basename(options.targetPath) : 'video');
  const offlineDirs = resolveOfflineDirs(options, targetName);

  const config = {
    ...options,
    convertScriptPath: options.convertScriptPath
      ? resolveHomePath(options.convertScriptPath)
      : detectVideoConvertScriptPath(),
    logFilePath: resolveHomePath(options.logFile || path.join(offlineDirs.offlineDir, 'video_conversion.log')),
    crf: options.crf || 30,
    preset: options.preset || 8,
    threads: options.threads || 2,
    audioCodec: options.audioCodec || 'auto',
    audioBitrate: options.audioBitrate || '192k',
    minSavingsPct: options.minSavingsPct != null ? parseFloat(options.minSavingsPct) : 5.0,
    adaptiveQuality: options.adaptiveQuality !== false,
    skipLowBitrate: options.skipLowBitrate !== false,
  };

  logger.info(`Offline Workspace initialized at: "${offlineDirs.offlineDir}"`);

  // Handle selective phases
  if (options.downloadOnly) {
    if (!storage || !targetFolder) {
      throw new Error('Download phase requires active MEGA connection. Please provide credentials.');
    }
    return await downloadAllPhase(storage, targetFolder, config, offlineDirs);
  }

  if (options.convertOnly) {
    return await convertAllOfflinePhase(config, offlineDirs);
  }

  if (options.uploadOnly) {
    if (!storage || !targetFolder) {
      throw new Error('Upload phase requires active MEGA connection. Please provide credentials.');
    }
    return await uploadAllPhase(storage, targetFolder, config, offlineDirs);
  }

  // Default: Full 3-phase execution
  if (!storage || !targetFolder) {
    throw new Error('Full offline pipeline requires active MEGA connection for download and upload phases.');
  }

  // Phase 1: Download All
  await downloadAllPhase(storage, targetFolder, config, offlineDirs);

  // Phase 2: Convert Offline
  await convertAllOfflinePhase(config, offlineDirs);

  // Phase 3: Upload All & Delete Originals
  await uploadAllPhase(storage, targetFolder, config, offlineDirs);

  logger.success(`\nAll 3 Offline Phases successfully completed! Workspace: "${offlineDirs.offlineDir}"`);
}

module.exports = {
  resolveOfflineDirs,
  downloadAllPhase,
  convertAllOfflinePhase,
  uploadAllPhase,
  runOfflineVideoTask,
};
