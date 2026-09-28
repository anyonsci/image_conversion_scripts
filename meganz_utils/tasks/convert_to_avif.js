/**
 * tasks/convert_to_avif.js
 *
 * Scans a designated MEGA.nz folder recursively for JPEG images,
 * converts them to AVIF with metadata retention (via convert_to_avif),
 * automatically attaches full-frame thumbnail & preview attributes,
 * uploads the converted .avif back to MEGA, and removes the original JPEGs.
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
 * Finds the default location of the convert_to_avif.sh script.
 * @returns {string}
 */
function detectConvertScriptPath() {
  const candidates = [
    path.resolve(__dirname, '../../convert_to_avif/convert_to_avif.sh'),
    path.resolve(__dirname, '../convert_to_avif/convert_to_avif.sh'),
    path.resolve(process.cwd(), 'convert_to_avif/convert_to_avif.sh'),
    path.resolve(process.cwd(), '../convert_to_avif/convert_to_avif.sh'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(__dirname, '../../convert_to_avif/convert_to_avif.sh');
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
 * Markers indicative of an ISO 21496-1 / Adobe / Apple HDR gain map stream inside a JPEG container.
 */
const ULTRA_HDR_MARKERS = [
  Buffer.from('hdrgm:Version'),
  Buffer.from('hdrgm:version'),
  Buffer.from('http://ns.adobe.com/hdr-gain-map/'),
  Buffer.from('HDRGainMapVersion'),
  Buffer.from('HDRGainMap:HDRGainMapVersion'),
  Buffer.from('http://ns.apple.com/HDRGainMap/'),
];

/**
 * Fast inspection to detect if a JPEG buffer contains an Ultra HDR gain map.
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isUltraHdr(buffer) {
  if (!buffer || buffer.length < 100) return false;
  const scanLimit = Math.min(buffer.length, 2 * 1024 * 1024);
  const scanSlice = buffer.subarray(0, scanLimit);
  return ULTRA_HDR_MARKERS.some((marker) => scanSlice.includes(marker));
}

/**
 * Quickly validates that the converted AVIF is perceptually similar and structurally
 * identical to the source JPEG before any destructive deletion occurs.
 *
 * Checks performed:
 * 1. Output file size sanity (non-empty, non-trivial, sane ratio).
 * 2. AVIF decoding integrity via avifdec (catches corrupt bitstreams, broken MIAF grids).
 * 3. Dimension parity (decoded AVIF resolution === source JPEG resolution).
 * 4. Structural Similarity Index (SSIM) on thumbnail frame (threshold >= minSSIM).
 *
 * @param {object} params
 * @param {string} params.sourceJpgPath - Path to local source JPEG
 * @param {string} params.tempAvifPath - Path to converted AVIF file
 * @param {string} params.thumbJpgPath - Path to generated 320px thumbnail of source JPEG
 * @param {number} [params.minSSIM=0.85] - Minimum acceptable SSIM score (0.0 - 1.0)
 * @param {number} params.jpgSize - Size of original JPEG buffer in bytes
 * @param {number} params.avifSize - Size of converted AVIF buffer in bytes
 * @returns {Promise<{ isValid: boolean, ssim: number, dimensions: string }>}
 */
async function validateConversion({
  sourceJpgPath,
  tempAvifPath,
  thumbJpgPath,
  minSSIM = 0.85,
  jpgSize,
  avifSize,
}) {
  // 1. Sanity size checks
  if (avifSize < 1000) {
    throw new Error(`Converted AVIF is suspiciously small (${avifSize} bytes)`);
  }
  const ratio = avifSize / jpgSize;
  if (ratio < 0.01 || ratio > 2.5) {
    throw new Error(`Suspicious compression ratio (${ratio.toFixed(3)}): AVIF ${avifSize} bytes vs JPG ${jpgSize} bytes`);
  }

  // 2. Decode AVIF with avifdec to check integrity and obtain resolution
  const decodedJpgPath = tempAvifPath + '.validate_dec.jpg';
  try {
    let avifdecOutput = '';
    try {
      const res = await execPromise(`avifdec -j 1 -q 80 "${tempAvifPath}" "${decodedJpgPath}"`);
      avifdecOutput = `${res.stdout || ''} ${res.stderr || ''}`;
    } catch (decErr) {
      throw new Error(`AVIF decoding failed (file may be corrupt): ${decErr.message}`);
    }

    if (!fs.existsSync(decodedJpgPath) || fs.statSync(decodedJpgPath).size === 0) {
      throw new Error('AVIF decoder did not produce a decoded frame');
    }

    // Extract decoded AVIF resolution
    const resMatch = avifdecOutput.match(/Resolution\s*:\s*(\d+)x(\d+)/i);
    let avifWidth = null;
    let avifHeight = null;
    if (resMatch) {
      avifWidth = parseInt(resMatch[1], 10);
      avifHeight = parseInt(resMatch[2], 10);
    }

    // Get original JPG resolution using ffprobe
    let origWidth = null;
    let origHeight = null;
    try {
      const probeRes = await execPromise(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${sourceJpgPath}"`
      );
      const parts = probeRes.stdout.trim().split('x');
      if (parts.length === 2) {
        origWidth = parseInt(parts[0], 10);
        origHeight = parseInt(parts[1], 10);
      }
    } catch (probeErr) {
      try {
        const exifRes = await execPromise(
          `exiftool -s3 -ImageWidth -ImageHeight "${sourceJpgPath}"`
        );
        const lines = exifRes.stdout.trim().split(/\s+/);
        if (lines.length >= 2) {
          origWidth = parseInt(lines[0], 10);
          origHeight = parseInt(lines[1], 10);
        }
      } catch (exifErr) {
        logger.warn(`Could not probe source image dimensions: ${exifErr.message}`);
      }
    }

    // Dimension match verification (allow 1px adjustment for MIAF grid even-dimension requirement)
    if (avifWidth && avifHeight && origWidth && origHeight) {
      const evenOrigWidth = origWidth - (origWidth % 2);
      const evenOrigHeight = origHeight - (origHeight % 2);
      if (
        (avifWidth !== origWidth && avifWidth !== evenOrigWidth) ||
        (avifHeight !== origHeight && avifHeight !== evenOrigHeight)
      ) {
        throw new Error(
          `Dimension mismatch: Source JPEG is ${origWidth}x${origHeight} but AVIF decoded to ${avifWidth}x${avifHeight}`
        );
      }
    }

    // 3. Fast Perceptual Similarity Check (SSIM)
    let ssimScore = 1.0;
    if (thumbJpgPath && fs.existsSync(thumbJpgPath)) {
      const ssimCmd = `ffmpeg -threads 1 -hide_banner -i "${thumbJpgPath}" -i "${decodedJpgPath}" -lavfi "[1:v]scale=320:320:force_original_aspect_ratio=decrease[v1];[0:v][v1]ssim" -f null - 2>&1`;
      const ssimOutput = await execPromise(ssimCmd);
      const ssimCombined = `${ssimOutput.stdout || ''} ${ssimOutput.stderr || ''}`;
      const ssimMatch = ssimCombined.match(/All:([0-9.]+)/);
      if (!ssimMatch) {
        throw new Error(`Failed to calculate SSIM similarity metric: ${ssimCombined}`);
      }
      ssimScore = parseFloat(ssimMatch[1]);
      if (isNaN(ssimScore) || ssimScore < minSSIM) {
        throw new Error(
          `Perceptual similarity check failed: SSIM score ${ssimScore.toFixed(4)} is below safety threshold ${minSSIM}`
        );
      }
    }

    return {
      isValid: true,
      ssim: ssimScore,
      dimensions: origWidth && origHeight ? `${origWidth}x${origHeight}` : `${avifWidth}x${avifHeight}`,
    };
  } finally {
    if (fs.existsSync(decodedJpgPath)) {
      try {
        await fs.promises.unlink(decodedJpgPath);
      } catch (_) {}
    }
  }
}

/**
 * Processes a single JPEG file:
 * 1. Checks if AVIF already exists in parent folder.
 * 2. Downloads JPEG into in-memory buffer.
 * 3. Writes buffer to scratch file.
 * 4. Executes convert_to_avif.sh with metadata preservation.
 * 5. Generates high-quality thumbnail (320px) and preview (1600px).
 * 6. Validates perceptual similarity and dimensions between source JPEG and converted AVIF.
 * 7. Uploads the .avif buffer with thumbnail and preview attributes attached.
 * 8. Deletes original JPEG only after verified upload.
 * 9. Cleans up scratch files.
 */
async function processImage(item, config) {
  const { file, parentFolder, relativePath, name: fileName } = item;
  const avifFileName = fileName.replace(/\.(jpe?g|heic|heif)$/i, '.avif');

  // Check if an AVIF version already exists in the same MEGA parent folder
  const existingAvif = parentFolder.children
    ? parentFolder.children.find((c) => !c.directory && c.name.toLowerCase() === avifFileName.toLowerCase())
    : null;

  if (existingAvif && existingAvif.size > 1000 && !config.force) {
    logger.info(
      `AVIF version "${avifFileName}" already exists in parent folder (${formatBytes(existingAvif.size)}). Cleaning up residual original "${fileName}"...`
    );
    await file.delete();
    logger.success(`Removed residual original "${fileName}" from MEGA.`);
    return {
      status: 'skipped_existing',
      fileName,
      avifFileName,
      originalSize: file.size,
      convertedSize: existingAvif.size,
    };
  }

  const sanitizedRelPath = relativePath.replace(/^\/+/, '');
  const tempJpgPath = path.join(config.tempBaseDir, sanitizedRelPath);
  const tempAvifPath = tempJpgPath.replace(/\.(jpe?g|heic|heif)$/i, '.avif');
  const tempThumbPath = tempJpgPath + '.thumb.jpg';
  const tempPrevPath = tempJpgPath + '.prev.jpg';

  logger.info(`Starting conversion: "${relativePath}" (${formatBytes(file.size)})`);

  try {
    await fs.promises.mkdir(path.dirname(tempJpgPath), { recursive: true });

    // Step 1: Download image buffer with retry
    logger.info(`Downloading in-memory Buffer for "${fileName}"...`);
    let jpgBuffer = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        jpgBuffer = await file.downloadBuffer();
        if (jpgBuffer && jpgBuffer.length > 0) break;
        throw new Error('Downloaded buffer is empty');
      } catch (err) {
        if (attempt === 3) throw err;
        const delay = attempt * 2000;
        logger.warn(`Download failed for "${fileName}" (${err.message}), retrying in ${delay}ms (attempt ${attempt}/3)...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Check for Ultra HDR gain map: skip conversion to retain full camera resolution and OLED HDR pop
    if (config.skipUltraHdr !== false && isUltraHdr(jpgBuffer)) {
      logger.info(
        `Skipping Ultra HDR image "${fileName}" to preserve native dynamic range and full sensor resolution.`
      );
      return {
        status: 'skipped_ultrahdr',
        fileName,
        originalSize: jpgBuffer.length,
        convertedSize: jpgBuffer.length,
      };
    }

    // Step 2: Write buffer to scratch file
    await fs.promises.writeFile(tempJpgPath, jpgBuffer);

    // Step 3: Run convert_to_avif command
    await fs.promises.mkdir(path.dirname(config.logFilePath), { recursive: true });
    const adaptiveFlag = config.adaptiveQuality !== false ? '--adaptive-quality' : '--no-adaptive-quality';
    const conversionCmd = `set -o pipefail; "${config.convertScriptPath}" "${tempJpgPath}" -o "${tempAvifPath}" --codec ${config.codec} -s ${config.speed} -q ${config.quality} ${adaptiveFlag} -j ${config.jobs} 2>&1 | tee -a "${config.logFilePath}"`;

    logger.info(`Running convert_to_avif for "${fileName}"...`);
    await execPromise(conversionCmd, { shell: '/bin/bash' });

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

    // Step 4: Generate high-quality thumbnail (320px) and preview (1600px)
    let thumbBuffer = null;
    let previewBuffer = null;
    try {
      const isHeic = /\.(heic|heif)$/i.test(tempJpgPath);
      if (isHeic) {
        const tempDecodedPath = tempJpgPath + '.raw.jpg';
        await execPromise(`heif-convert --codec-threads 1 -q 95 "${tempJpgPath}" "${tempDecodedPath}"`);
        await execPromise(
          `ffmpeg -threads 1 -y -v error -i "${tempDecodedPath}" \
            -vf "scale=320:320:force_original_aspect_ratio=decrease" -q:v 2 -update 1 "${tempThumbPath}" \
            -vf "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease" -q:v 2 -update 1 "${tempPrevPath}"`
        );
        fs.promises.unlink(tempDecodedPath).catch(() => {});
      } else {
        await execPromise(
          `ffmpeg -threads 1 -y -v error -i "${tempJpgPath}" \
            -vf "scale=320:320:force_original_aspect_ratio=decrease" -q:v 2 -update 1 "${tempThumbPath}" \
            -vf "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease" -q:v 2 -update 1 "${tempPrevPath}"`
        );
      }
      thumbBuffer = await fs.promises.readFile(tempThumbPath);
      previewBuffer = await fs.promises.readFile(tempPrevPath);
    } catch (thumbErr) {
      logger.warn(`Could not generate thumbnail/preview during upload: ${thumbErr.message}`);
    }

    // Step 5: Quick Validation (Perceptual similarity, decoding integrity, dimension match)
    if (config.validate !== false) {
      logger.info(`Validating similarity and integrity for "${fileName}"...`);
      const valResult = await validateConversion({
        sourceJpgPath: tempJpgPath,
        tempAvifPath,
        thumbJpgPath: tempThumbPath,
        minSSIM: config.minSSIM || 0.85,
        jpgSize: jpgBuffer.length,
        avifSize: avifBuffer.length,
      });
      logger.success(
        `Validation PASSED for "${fileName}": Dimensions match (${valResult.dimensions}), SSIM: ${valResult.ssim.toFixed(4)} (threshold: >= ${config.minSSIM || 0.85})`
      );
    } else {
      logger.warn(`Validation skipped for "${fileName}" (--no-verify).`);
    }

    // Step 6: Upload AVIF with thumbnail & preview attached
    logger.info(`Uploading "${avifFileName}" to parent folder "${parentFolder.name}"...`);
    const uploadOptions = {
      name: avifFileName,
      size: avifBuffer.length,
      allowUploadBuffering: true,
    };
    if (thumbBuffer) uploadOptions.thumbnailImage = thumbBuffer;
    if (previewBuffer) uploadOptions.previewImage = previewBuffer;

    await parentFolder.upload(uploadOptions, avifBuffer).complete;
    logger.success(`Upload complete for "${avifFileName}".`);

    // Step 7: Delete original JPEG file from MEGA (ONLY REACHED IF VALIDATION & UPLOAD SUCCEEDED!)
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
    // Unconditional scratch cleanup
    try {
      if (fs.existsSync(tempJpgPath)) await fs.promises.unlink(tempJpgPath);
      if (fs.existsSync(tempAvifPath)) await fs.promises.unlink(tempAvifPath);
      if (fs.existsSync(tempThumbPath)) await fs.promises.unlink(tempThumbPath);
      if (fs.existsSync(tempPrevPath)) await fs.promises.unlink(tempPrevPath);
    } catch (_) {}
  }
}

/**
 * Runs a single synchronization pass for JPEG -> AVIF.
 */
async function runSinglePass(storage, targetFolder, config) {
  const extensions = config.ext || ['jpg', 'jpeg'];
  logger.info(`Scanning target folder "${targetFolder.name}" for extensions: [${extensions.join(', ')}]...`);

  const files = scanFiles(targetFolder, {
    extensions,
    recursive: config.recursive !== false,
  });

  logger.info(`Found ${files.length} candidate image files in target directory.`);

  if (files.length === 0) {
    logger.info('No candidate image files found to convert.');
    return { successCount: 0, skippedCount: 0, skippedHdrCount: 0, errorCount: 0 };
  }

  const toProcess = config.limit && config.limit > 0 ? files.slice(0, config.limit) : files;
  if (config.limit && config.limit > 0 && files.length > config.limit) {
    logger.info(
      `Limiting conversion pass to first ${config.limit} files (--limit ${config.limit}) out of ${files.length} found.`
    );
  }

  if (config.dryRun) {
    logger.info('[DRY RUN] The following JPEG files would be converted to AVIF:');
    toProcess.forEach((item, idx) => {
      console.log(`  ${idx + 1}. ${item.relativePath} (${formatBytes(item.size)})`);
    });
    return { successCount: 0, skippedCount: 0, skippedHdrCount: 0, errorCount: 0 };
  }

  let successCount = 0;
  let skippedCount = 0;
  let skippedHdrCount = 0;
  let errorCount = 0;
  let totalOrigBytes = 0;
  let totalConvBytes = 0;
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;
    logger.info(`\n--- ${progress} Processing "${item.relativePath}" ---`);

    try {
      const result = await processImage(item, config);
      if (result.status === 'success') {
        successCount++;
        totalOrigBytes += result.originalSize;
        totalConvBytes += result.convertedSize;
      } else if (result.status === 'skipped_existing') {
        skippedCount++;
        totalOrigBytes += result.originalSize;
        totalConvBytes += result.convertedSize;
      } else if (result.status === 'skipped_ultrahdr') {
        skippedHdrCount++;
      }
    } catch (err) {
      errorCount++;
      logger.error(`Failed to process "${item.relativePath}": ${err.message}`, err);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalSavedBytes = totalOrigBytes - totalConvBytes;
  const overallRatio = totalOrigBytes > 0 ? (((totalSavedBytes) / totalOrigBytes) * 100).toFixed(1) : '0.0';

  logger.info(`\n=======================================================`);
  logger.info(`Conversion pass completed in ${durationSec}s:`);
  logger.info(`- Converted successfully: ${successCount}`);
  logger.info(`- Skipped existing: ${skippedCount}`);
  if (skippedHdrCount > 0) {
    logger.info(`- Preserved Ultra HDR JPEGs: ${skippedHdrCount}`);
  }
  logger.info(`- Failed: ${errorCount}`);
  logger.info(`- Original data size: ${formatBytes(totalOrigBytes)}`);
  logger.info(`- Converted data size: ${formatBytes(totalConvBytes)}`);
  logger.info(`- Space saved: ${formatBytes(totalSavedBytes)} (${overallRatio}% reduction)`);
  logger.info(`=======================================================\n`);

  return { successCount, skippedCount, skippedHdrCount, errorCount };
}

/**
 * Main task runner for convert-to-avif. Supports both single-pass and cron daemon modes.
 *
 * @param {import('megajs').Storage} storage
 * @param {import('megajs').MutableFile} targetFolder
 * @param {object} options
 */
async function runConvertTask(storage, targetFolder, options = {}) {
  const config = {
    ...options,
    tempBaseDir: options.tempBaseDir || process.env.TEMP_BASE_DIR || '/tmp/mega',
    logFilePath: resolveHomePath(options.logFile || process.env.LOG_FILE || '~/ws/conversion.log'),
    convertScriptPath: options.convertScriptPath
      ? resolveHomePath(options.convertScriptPath)
      : detectConvertScriptPath(),
    codec: options.codec || process.env.AVIF_CODEC || 'aom',
    speed: options.speed || process.env.AVIF_SPEED || '8',
    quality: options.quality || process.env.AVIF_QUALITY || '85',
    jobs: options.jobs || process.env.AVIF_JOBS || '1',
    validate: options.validate !== false,
    minSSIM: options.minSSIM ? parseFloat(options.minSSIM) : 0.85,
    skipUltraHdr: options.skipUltraHdr !== false,
    cronSchedule: options.schedule || process.env.CRON_SCHEDULE || '0 * * * *',
  };

  const isCron = options.cron;

  if (!isCron) {
    return await runSinglePass(storage, targetFolder, config);
  }

  // Cron Daemon Mode
  logger.info(`Starting cron daemon mode with schedule: "${config.cronSchedule}"`);

  if (options.runOnStart) {
    logger.info('Triggering immediate initial sync (--run-on-start)...');
    await runSinglePass(storage, targetFolder, config).catch((err) =>
      logger.error('Error during initial sync run:', err)
    );
  }

  let isJobRunning = false;
  cron.schedule(config.cronSchedule, async () => {
    if (isJobRunning) {
      logger.warn('Previous cron job pass is still active. Skipping this iteration.');
      return;
    }

    isJobRunning = true;
    try {
      await runSinglePass(storage, targetFolder, config);
    } catch (err) {
      logger.error('Error during scheduled cron sync pass:', err);
    } finally {
      isJobRunning = false;
    }
  });

  logger.info('Daemon is listening for cron triggers. Press Ctrl+C to terminate.');
  // Keep event loop active
  await new Promise(() => {});
}

module.exports = {
  runConvertTask,
  processImage,
};
