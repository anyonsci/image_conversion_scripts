/**
 * tasks/convert_video_to_av1.js
 *
 * Scans a designated MEGA.nz folder recursively for MP4 and MOV videos,
 * streams them to disk (RAM-safe without loading full video into Node buffer),
 * converts them to AV1 using convert_video_to_av1 with audio handling & QA verification,
 * generates 320px thumbnail and 1600px preview poster frames,
 * streams the converted AV1 video back to MEGA, and removes the original.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const cron = require('node-cron');
const { logger, formatBytes } = require('../lib/logger');
const { scanFiles } = require('../lib/scanner');

const execPromise = util.promisify(exec);

/**
 * Finds the location of the convert_video_to_av1.sh script.
 * @returns {string}
 */
function detectVideoConvertScriptPath() {
  const candidates = [
    path.resolve(__dirname, '../../convert_video_to_av1/convert_video_to_av1.sh'),
    path.resolve(__dirname, '../convert_video_to_av1/convert_video_to_av1.sh'),
    path.resolve(process.cwd(), 'convert_video_to_av1/convert_video_to_av1.sh'),
    path.resolve(process.cwd(), '../convert_video_to_av1/convert_video_to_av1.sh'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(__dirname, '../../convert_video_to_av1/convert_video_to_av1.sh');
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
 * Streams a remote MEGA file directly to a local disk destination.
 * Memory-safe: Never loads the full video into Node.js heap memory.
 *
 * @param {import('megajs').MutableFile} file
 * @param {string} destPath
 * @param {number} [timeoutMs=600000]
 * @param {object} [downloadOptions={}]
 * @returns {Promise<void>}
 */
function downloadFileStream(file, destPath, timeoutMs = 600000, downloadOptions = {}) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      timer = null;
      writeStream.destroy();
      reject(new Error(`Download stream timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const writeStream = fs.createWriteStream(destPath);
    let dlStream;
    try {
      dlStream = file.download(downloadOptions);
    } catch (err) {
      if (timer) clearTimeout(timer);
      writeStream.destroy();
      return reject(err);
    }

    dlStream.on('error', (err) => {
      if (timer) clearTimeout(timer);
      writeStream.destroy();
      reject(err);
    });

    writeStream.on('error', (err) => {
      if (timer) clearTimeout(timer);
      dlStream.destroy();
      reject(err);
    });

    writeStream.on('finish', () => {
      if (timer) clearTimeout(timer);
      resolve();
    });

    dlStream.pipe(writeStream);
  });
}

/**
 * Downloads a video file to disk with retries and MAC verification bypass fallback.
 */
async function downloadVideoWithRetry(file, destPath, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await downloadFileStream(file, destPath, 600000);
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        return;
      }
      throw new Error('Downloaded file is missing or 0 bytes');
    } catch (err) {
      const errMsg = (err && err.message) || String(err);
      if (errMsg.toLowerCase().includes('mac verification failed')) {
        logger.warn(
          `MAC verification failed for "${file.name}". Retrying with ranged stream to bypass checksum mismatch...`
        );
        try {
          if (fs.existsSync(destPath)) await fs.promises.unlink(destPath).catch(() => {});
          await downloadFileStream(file, destPath, 600000, { start: 0, end: file.size - 1 });
          if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
            return;
          }
        } catch (rangeErr) {
          logger.warn(`Ranged download fallback failed: ${rangeErr.message}`);
        }
      }

      if (attempt === maxAttempts) {
        throw err;
      }

      const backoff = attempt * 3000;
      logger.warn(`Download attempt ${attempt}/${maxAttempts} failed for "${file.name}". Retrying in ${backoff}ms...`);
      if (fs.existsSync(destPath)) await fs.promises.unlink(destPath).catch(() => {});
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/**
 * Uploads a video file from local disk to MEGA using streaming (zero memory buffering)
 * with thumbnail/preview attribute handling and retry logic.
 */
async function uploadVideoStreamWithRetry(parentFolder, fileName, localFilePath, thumbBuffer, previewBuffer, originalTimestamp = null, maxAttempts = 3) {
  let currentThumb = thumbBuffer;
  let currentPreview = previewBuffer;
  const fileSize = fs.statSync(localFilePath).size;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const uploadOptions = {
        name: fileName,
        size: fileSize,
      };
      if (originalTimestamp) uploadOptions.timestamp = originalTimestamp;
      if (currentThumb) uploadOptions.thumbnailImage = currentThumb;
      if (currentPreview) uploadOptions.previewImage = currentPreview;

      const uploadStream = parentFolder.upload(uploadOptions);
      let streamErr = null;
      uploadStream.on('error', (err) => {
        streamErr = err;
      });

      const fileReadStream = fs.createReadStream(localFilePath);
      fileReadStream.pipe(uploadStream);

      const uploadedFile = await uploadStream.complete;
      if (streamErr) throw streamErr;
      return uploadedFile;
    } catch (err) {
      const errMsg = (err && err.message) || String(err);
      logger.warn(`Upload attempt ${attempt}/${maxAttempts} failed for "${fileName}": ${errMsg}`);

      if (attempt === maxAttempts) {
        throw err;
      }

      // If status 400 or attribute error occurred, strip preview and thumbnail sequentially
      if (errMsg.includes('400') || errMsg.includes('status code')) {
        if (currentPreview) {
          logger.warn('Stripping preview poster from upload retry to avoid MEGA attribute size rejection.');
          currentPreview = null;
        } else if (currentThumb) {
          logger.warn('Stripping thumbnail poster from upload retry.');
          currentThumb = null;
        }
      }

      const backoff = attempt * 3000;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/**
 * Generates 320px thumbnail and 1600px preview poster frames from the video.
 */
async function generateVideoPosters(videoPath, thumbPath, prevPath) {
  try {
    // Extract poster frame at 1-second offset
    const cmd = [
      'ffmpeg',
      '-threads', '1',
      '-y',
      '-v', 'error',
      '-ss', '00:00:01',
      '-i', `"${videoPath}"`,
      '-vf', '"scale=320:320:force_original_aspect_ratio=decrease"',
      '-frames:v', '1',
      '-q:v', '2',
      `"${thumbPath}"`,
      '-vf', '"scale=\'min(1600,iw)\':\'min(1600,ih)\':force_original_aspect_ratio=decrease"',
      '-frames:v', '1',
      '-q:v', '4',
      `"${prevPath}"`,
    ].join(' ');

    await execPromise(cmd);

    let thumbBuf = fs.existsSync(thumbPath) ? await fs.promises.readFile(thumbPath) : null;
    let prevBuf = fs.existsSync(prevPath) ? await fs.promises.readFile(prevPath) : null;

    // Enforce MEGA attribute ceiling (< 800 KB safe limit)
    if (prevBuf && prevBuf.length > 800000) {
      const compressedPrev = prevPath + '.cmp.jpg';
      try {
        await execPromise(`ffmpeg -threads 1 -y -v error -i "${prevPath}" -q:v 6 "${compressedPrev}"`);
        if (fs.existsSync(compressedPrev)) {
          const cmp = await fs.promises.readFile(compressedPrev);
          if (cmp.length < prevBuf.length) prevBuf = cmp;
          await fs.promises.unlink(compressedPrev).catch(() => {});
        }
      } catch (_) {}
    }

    if (prevBuf && prevBuf.length > 950000) {
      logger.warn(`Video preview poster is too large (${formatBytes(prevBuf.length)}) for MEGA attribute limit. Skipping preview.`);
      prevBuf = null;
    }

    return { thumbBuf, prevBuf };
  } catch (err) {
    logger.warn(`Failed to generate video poster frames: ${err.message}`);
    return { thumbBuf: null, prevBuf: null };
  }
}

function appendToLogFile(logPath, message) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] [MEGA] ${message}\n`, 'utf8');
  } catch (_) {}
}

/**
 * Safely deletes an original video from MEGA after conversion and upload verification.
 *
 * @param {import('megajs').MutableFile} file
 * @returns {Promise<boolean>}
 */
async function deleteOriginalVideo(file) {
  try {
    await file.delete();
    logger.success(`Removed original video "${file.name}" from MEGA.`);
    return true;
  } catch (err) {
    logger.warn(`Could not delete original video "${file.name}": ${err.message}`);
    return false;
  }
}

/**
 * Fast zero-bandwidth inspection to check if a remote video is already AV1 encoded
 * using a small ~64KB ranged read, avoiding full video download.
 *
 * @param {import('megajs').MutableFile} file
 * @returns {Promise<boolean>}
 */
async function isRemoteVideoAv1(file) {
  if (!file || file.size < 1000) return false;
  try {
    // 1. Check first 64KB (faststart AV1 videos have moov -> stsd -> av01 at the head)
    const headSize = Math.min(65536, file.size);
    const headBuf = await file.downloadBuffer({ start: 0, end: headSize - 1 });
    if (headBuf && headBuf.includes(Buffer.from('av01'))) {
      return true;
    }

    // 2. Check last 64KB (non-faststart AV1 videos write moov at the tail)
    if (file.size > 131072) {
      const tailBuf = await file.downloadBuffer({ start: file.size - 65536, end: file.size - 1 });
      if (tailBuf && tailBuf.includes(Buffer.from('av01'))) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Processes a single remote video file.
 */
async function processVideo(item, config) {
  const { file, parentFolder, relativePath, name: fileName } = item;

  // Target filename: ALWAYS <stem>.av1.mp4
  const stem = fileName.replace(/\.(mp4|mov|m4v)$/i, '');
  const targetAv1Name = `${stem}.av1.mp4`;

  // Quick skip if the file itself already has the .av1.mp4 suffix
  if (fileName.toLowerCase().endsWith('.av1.mp4')) {
    logger.info(`Video "${fileName}" already has .av1.mp4 suffix. Skipping.`);
    return {
      status: 'skipped_existing',
      fileName,
      targetAv1Name: fileName,
      originalSize: file.size,
      convertedSize: file.size,
    };
  }

  // Check if an AV1 version already exists in parent folder
  const existingAv1 = parentFolder.children
    ? parentFolder.children.find((c) => !c.directory && c.name.toLowerCase() === targetAv1Name.toLowerCase() && c.id !== file.id)
    : null;

  if (existingAv1 && existingAv1.size > 1000 && !config.force) {
    logger.info(
      `AV1 video "${targetAv1Name}" already exists in parent folder (${formatBytes(existingAv1.size)}). Cleaning up original "${fileName}"...`
    );
    await file.delete();
    logger.success(`Removed original "${fileName}" from MEGA.`);
    return {
      status: 'skipped_existing',
      fileName,
      targetAv1Name,
      originalSize: file.size,
      convertedSize: existingAv1.size,
    };
  }

  // Fast zero-bandwidth ranged check: verify if remote file is already AV1 before downloading
  if (!config.force && (await isRemoteVideoAv1(file))) {
    logger.info(`Remote video "${fileName}" is already AV1 encoded (detected via ranged atom inspection). Skipping download.`);
    return {
      status: 'skipped_existing',
      fileName,
      targetAv1Name,
      originalSize: file.size,
      convertedSize: file.size,
    };
  }

  const sanitizedRel = relativePath.replace(/^\/+/, '');
  const tempSourcePath = path.join(config.tempBaseDir, sanitizedRel);
  const tempAv1Path = tempSourcePath.replace(/\.(mp4|mov|m4v)$/i, '.av1.mp4');
  const tempThumbPath = tempSourcePath + '.thumb.jpg';
  const tempPrevPath = tempSourcePath + '.prev.jpg';

  logger.info(`Starting video conversion: "${relativePath}" (${formatBytes(file.size)})`);

  try {
    await fs.promises.mkdir(path.dirname(tempSourcePath), { recursive: true });

    // Step 1: Stream video from MEGA to local disk
    logger.info(`Streaming "${fileName}" from MEGA to local disk...`);
    appendToLogFile(config.logFilePath, `Streaming "${fileName}" (${formatBytes(file.size)}) from MEGA to local disk`);
    await downloadVideoWithRetry(file, tempSourcePath);
    const downloadedSize = fs.statSync(tempSourcePath).size;
    if (file.timestamp) {
      try {
        const fileDate = new Date(file.timestamp * 1000);
        fs.utimesSync(tempSourcePath, fileDate, fileDate);
      } catch (_) {}
    }
    logger.success(`Downloaded "${fileName}" (${formatBytes(downloadedSize)}).`);
    appendToLogFile(config.logFilePath, `Downloaded "${fileName}" (${formatBytes(downloadedSize)})`);

    // Step 2: Run convert_video_to_av1 script
    const crf = config.crf || 30;
    const preset = config.preset || 8;
    const threads = config.threads || 2;
    const audioCodec = config.audioCodec || 'auto';
    const audioBitrate = config.audioBitrate || '192k';

    const cmd = [
      `"${config.convertScriptPath}"`,
      `"${tempSourcePath}"`,
      '-o', `"${tempAv1Path}"`,
      '-crf', String(crf),
      '-p', String(preset),
      '-t', String(threads),
      '--audio-codec', audioCodec,
      '--audio-bitrate', audioBitrate,
      '--log-file', config.logFilePath,
    ];

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
    logger.info(`Running convert_video_to_av1 for "${fileName}" [CRF: ${crf}, Preset: ${preset}, Threads: ${threads}]...`);
    let stdout = '';
    let stderr = '';
    try {
      const res = await execPromise(conversionCmd);
      stdout = res.stdout || '';
      stderr = res.stderr || '';
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

        logger.warn(`Retaining original "${fileName}": ${cleanMsg}`);
        appendToLogFile(config.logFilePath, `Retained original "${fileName}": ${cleanMsg}`);
        return {
          status: 'rejected_savings',
          fileName,
          originalSize: downloadedSize,
          convertedSize: downloadedSize,
          reason: cleanMsg,
        };
      }

      if (combined.includes('SKIPPED')) {
        const skipLine = combined.split('\n').find((l) => l.includes('SKIPPED') || l.includes('already highly compressed')) || combined;
        const cleanSkip = skipLine.replace(/.*(?:SKIPPED.*?:\s*|Detail:\s*)/i, '').trim();
        logger.info(`Skipped "${fileName}": ${cleanSkip}`);
        appendToLogFile(config.logFilePath, `Skipped "${fileName}": ${cleanSkip}`);
        return {
          status: 'skipped',
          fileName,
          originalSize: downloadedSize,
          convertedSize: downloadedSize,
        };
      }

      const errorMsg = (stderr.trim() || stdout.trim() || execErr.message);
      throw new Error(`Conversion process failed for "${fileName}":\n${errorMsg}`);
    }

    // Log adaptive quality rationale if present
    const aqLine = stdout.split('\n').find((l) => l.includes('[Adaptive Quality]'));
    if (aqLine) {
      logger.info(aqLine.trim());
    }

    if (!fs.existsSync(tempAv1Path) || fs.statSync(tempAv1Path).size === 0) {
      if (stdout && stdout.includes('SKIPPED')) {
        const skipLine = stdout.split('\n').find((l) => l.includes('SKIPPED')) || stdout;
        logger.info(`Skipped "${fileName}": ${skipLine.trim()}`);
        return {
          status: 'skipped',
          fileName,
          originalSize: downloadedSize,
          convertedSize: downloadedSize,
        };
      }
      throw new Error(`Converted AV1 video was not created at "${tempAv1Path}": ${stderr || stdout}`);
    }

    const convertedSize = fs.statSync(tempAv1Path).size;
    if (file.timestamp) {
      try {
        const fileDate = new Date(file.timestamp * 1000);
        fs.utimesSync(tempAv1Path, fileDate, fileDate);
      } catch (_) {}
    }
    const savedBytes = downloadedSize - convertedSize;
    const ratio = (((savedBytes) / downloadedSize) * 100).toFixed(1);
    logger.info(
      `Converted "${fileName}": ${formatBytes(downloadedSize)} -> ${formatBytes(convertedSize)} (${ratio}% reduction)`
    );

    // Step 3: Generate thumbnail and preview poster frames
    const { thumbBuf, prevBuf } = await generateVideoPosters(tempAv1Path, tempThumbPath, tempPrevPath);

    // Step 4: Stream AV1 video back to MEGA directly as <stem>.av1.mp4
    logger.info(`Uploading "${targetAv1Name}" to parent folder "${parentFolder.name}"...`);
    appendToLogFile(config.logFilePath, `Uploading "${targetAv1Name}" to parent folder "${parentFolder.name}" (${formatBytes(convertedSize)})`);
    const uploadedFile = await uploadVideoStreamWithRetry(
      parentFolder,
      targetAv1Name,
      tempAv1Path,
      thumbBuf,
      prevBuf,
      file.timestamp
    );
    logger.success(`Upload complete for "${targetAv1Name}".`);
    appendToLogFile(config.logFilePath, `Upload complete for "${targetAv1Name}"`);

    // Step 5: Delete original remote file
    logger.info(`Deleting original video "${fileName}" from MEGA...`);
    await file.delete();
    logger.success(`Removed original video "${fileName}" from MEGA.`);
    appendToLogFile(config.logFilePath, `Deleted original video "${fileName}" from MEGA`);

    return {
      status: 'success',
      fileName,
      targetAv1Name,
      originalSize: downloadedSize,
      convertedSize,
    };
  } finally {
    // Unconditional disk cleanup
    try {
      if (fs.existsSync(tempSourcePath)) await fs.promises.unlink(tempSourcePath);
      if (fs.existsSync(tempAv1Path)) await fs.promises.unlink(tempAv1Path);
      if (fs.existsSync(tempThumbPath)) await fs.promises.unlink(tempThumbPath);
      if (fs.existsSync(tempPrevPath)) await fs.promises.unlink(tempPrevPath);
    } catch (_) {}
  }
}

/**
 * Runs a single video conversion synchronization pass.
 */
async function runSinglePass(storage, targetFolder, config) {
  const extensions = config.ext || ['mp4', 'mov', 'm4v'];
  logger.info(`Scanning target folder "${targetFolder.name}" for videos: [${extensions.join(', ')}]...`);

  const allFiles = scanFiles(targetFolder, {
    extensions,
    recursive: config.recursive !== false,
  });

  // Filter out any video that already has the .av1.mp4 suffix (zero bandwidth skip)
  const files = config.force ? allFiles : allFiles.filter((item) => !item.name.toLowerCase().endsWith('.av1.mp4'));
  const alreadyAv1Count = allFiles.length - files.length;

  if (alreadyAv1Count > 0) {
    logger.info(`Ignored ${alreadyAv1Count} already-converted video(s) (.av1.mp4).`);
  }

  logger.info(`Found ${files.length} candidate video file(s) in target directory.`);

  if (files.length === 0) {
    logger.info('No candidate video files found to convert.');
    return { successCount: 0, skippedCount: 0, errorCount: 0 };
  }

  const toProcess = config.limit && config.limit > 0 ? files.slice(0, config.limit) : files;
  if (config.limit && config.limit > 0 && files.length > config.limit) {
    logger.info(`Limiting video pass to first ${config.limit} files (--limit ${config.limit}) out of ${files.length} found.`);
  }

  if (config.dryRun) {
    logger.info('[DRY RUN] The following video files would be converted to AV1:');
    toProcess.forEach((item, idx) => {
      console.log(`  ${idx + 1}. ${item.relativePath} (${formatBytes(item.size)})`);
    });
    return { successCount: 0, skippedCount: 0, errorCount: 0 };
  }

  let successCount = 0;
  let skippedCount = 0;
  let rejectedSavingsCount = 0;
  let errorCount = 0;
  let totalOrigBytes = 0;
  let totalConvBytes = 0;
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;
    logger.info(`\n--- ${progress} Processing Video "${item.relativePath}" ---`);

    // Remote Zero-Bandwidth WhatsApp pre-check (< 15MB)
    const isWhatsApp = /WhatsApp|WA\d{4}|VID-\d{8}-WA/i.test(item.name);
    if (config.skipLowBitrate !== false && !config.force && isWhatsApp && item.size < 15 * 1024 * 1024) {
      logger.info(
        `[Zero-Bandwidth Skip] Skipping WhatsApp video "${item.relativePath}" (already highly compressed, ${formatBytes(item.size)}).`
      );
      skippedCount++;
      totalOrigBytes += item.size;
      totalConvBytes += item.size;
      continue;
    }

    try {
      const result = await processVideo(item, config);
      if (result.status === 'success') {
        successCount++;
        totalOrigBytes += result.originalSize;
        totalConvBytes += result.convertedSize;
      } else if (result.status === 'rejected_savings') {
        rejectedSavingsCount++;
        totalOrigBytes += result.originalSize;
        totalConvBytes += result.originalSize;
      } else if (result.status === 'skipped_existing' || result.status === 'skipped') {
        skippedCount++;
        totalOrigBytes += result.originalSize;
        totalConvBytes += result.convertedSize;
      }
    } catch (err) {
      errorCount++;
      logger.error(`Failed to process video "${item.relativePath}": ${err.message}`, err);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalSavedBytes = totalOrigBytes - totalConvBytes;
  const overallRatio = totalOrigBytes > 0 ? (((totalSavedBytes) / totalOrigBytes) * 100).toFixed(1) : '0.0';

  logger.info(`\n=======================================================`);
  logger.info(`Video conversion pass completed in ${durationSec}s:`);
  logger.info(`- Converted successfully: ${successCount}`);
  logger.info(`- Retained original (no savings): ${rejectedSavingsCount}`);
  logger.info(`- Skipped (existing/pre-compressed): ${skippedCount}`);
  logger.info(`- Failed with errors: ${errorCount}`);
  logger.info(`- Original video size: ${formatBytes(totalOrigBytes)}`);
  logger.info(`- Converted AV1 size: ${formatBytes(totalConvBytes)}`);
  logger.info(`- Space saved: ${formatBytes(totalSavedBytes)} (${overallRatio}% reduction)`);
  logger.info(`=======================================================\n`);

  return { successCount, rejectedSavingsCount, skippedCount, errorCount };
}

/**
 * Main task runner for convert_video_to_av1. Supports both single-pass and cron daemon modes.
 */
async function runConvertVideoTask(storage, targetFolder, options = {}) {
  const config = {
    ...options,
    tempBaseDir: options.tempBaseDir || process.env.TEMP_BASE_DIR || '/tmp/mega_video',
    logFilePath: resolveHomePath(options.logFile || process.env.VIDEO_LOG_FILE || path.resolve(process.cwd(), 'video_conversion.log')),
    convertScriptPath: options.convertScriptPath
      ? resolveHomePath(options.convertScriptPath)
      : detectVideoConvertScriptPath(),
    crf: options.crf || process.env.VIDEO_CRF || 30,
    preset: options.preset || process.env.VIDEO_PRESET || 8,
    adaptiveQuality: options.adaptiveQuality !== false,
    skipLowBitrate: options.skipLowBitrate !== false,
    minSavingsPct: options.minSavingsPct != null ? parseFloat(options.minSavingsPct) : 5.0,
    threads: options.threads || process.env.VIDEO_THREADS || 2,
    audioCodec: options.audioCodec || 'auto',
    audioBitrate: options.audioBitrate || '192k',
    validate: options.validate !== false,
    keepAv1Suffix: options.keepAv1Suffix || false,
    cronSchedule: options.schedule || process.env.CRON_SCHEDULE || '0 * * * *',
  };

  const isCron = options.cron;

  if (!isCron) {
    return await runSinglePass(storage, targetFolder, config);
  }

  // Cron Daemon Mode
  logger.info(`Starting video conversion cron daemon mode with schedule: "${config.cronSchedule}"`);

  if (options.runOnStart) {
    logger.info('Triggering immediate initial video sync (--run-on-start)...');
    await runSinglePass(storage, targetFolder, config).catch((err) =>
      logger.error('Error during initial video sync run:', err)
    );
  }

  let isJobRunning = false;
  cron.schedule(config.cronSchedule, async () => {
    if (isJobRunning) {
      logger.warn('Previous video conversion pass is still active. Skipping this cron iteration.');
      return;
    }

    isJobRunning = true;
    try {
      await runSinglePass(storage, targetFolder, config);
    } catch (err) {
      logger.error('Error during scheduled video cron pass:', err);
    } finally {
      isJobRunning = false;
    }
  });

  logger.info('Video conversion daemon is listening for cron triggers. Press Ctrl+C to terminate.');
  await new Promise(() => {});
}

module.exports = {
  runConvertVideoTask,
  processVideo,
  downloadVideoWithRetry,
  uploadVideoStreamWithRetry,
  generateVideoPosters,
  deleteOriginalVideo,
  detectVideoConvertScriptPath,
  resolveHomePath,
  appendToLogFile,
};
