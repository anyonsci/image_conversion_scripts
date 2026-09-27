/**
 * tasks/upload_thumbnails.js
 *
 * Generates and uploads full-frame, high-quality thumbnail (Attribute 0) and
 * preview (Attribute 1) to existing files on MEGA.nz without re-uploading file data.
 *
 * For AVIF files, uses avifdec to properly decode Android MIAF Tile Grids without
 * top-left quadrant cropping.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const { logger } = require('../lib/logger');
const { scanFiles } = require('../lib/scanner');

const execPromise = util.promisify(exec);

/**
 * Decodes an image file to high-quality thumbnail (320px) and preview (1600px).
 * Uses avifdec for .avif files to ensure full tile-grid assembly.
 */
async function generateThumbnailAndPreview(inputPath, thumbOutPath, prevOutPath, tempDir) {
  const isAvif = inputPath.toLowerCase().endsWith('.avif');
  let sourceForScaling = inputPath;
  let intermediateJpg = null;

  try {
    if (isAvif) {
      intermediateJpg = path.join(tempDir, `full_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
      // Step 1: Decode complete AVIF tile grid via avifdec (single-threaded to prevent thrashing)
      await execPromise(`avifdec -j 1 -q 95 "${inputPath}" "${intermediateJpg}"`);
      sourceForScaling = intermediateJpg;
    }

    // Step 2: Downscale to high-quality thumbnail (320px) and preview (1600px)
    const cmd = [
      'ffmpeg',
      '-threads', '1',
      '-y',
      '-v', 'error',
      '-i', `"${sourceForScaling}"`,
      '-vf', '"scale=320:320:force_original_aspect_ratio=decrease"',
      '-q:v', '2',
      '-update', '1',
      `"${thumbOutPath}"`,
      '-vf', '"scale=\'min(1600,iw)\':\'min(1600,ih)\':force_original_aspect_ratio=decrease"',
      '-q:v', '2',
      '-update', '1',
      `"${prevOutPath}"`,
    ].join(' ');

    await execPromise(cmd);
  } finally {
    if (intermediateJpg && fs.existsSync(intermediateJpg)) {
      try {
        fs.unlinkSync(intermediateJpg);
      } catch (_) {}
    }
  }
}

/**
 * Generates thumbnail ONLY (320px, full-frame).
 */
async function generateThumbnailOnly(inputPath, thumbOutPath, tempDir) {
  const isAvif = inputPath.toLowerCase().endsWith('.avif');
  let sourceForScaling = inputPath;
  let intermediateJpg = null;

  try {
    if (isAvif) {
      intermediateJpg = path.join(tempDir, `full_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
      await execPromise(`avifdec -j 1 -q 95 "${inputPath}" "${intermediateJpg}"`);
      sourceForScaling = intermediateJpg;
    }

    const cmd = [
      'ffmpeg',
      '-threads', '1',
      '-y',
      '-v', 'error',
      '-i', `"${sourceForScaling}"`,
      '-vf', '"scale=320:320:force_original_aspect_ratio=decrease"',
      '-q:v', '2',
      '-update', '1',
      `"${thumbOutPath}"`,
    ].join(' ');

    await execPromise(cmd);
  } finally {
    if (intermediateJpg && fs.existsSync(intermediateJpg)) {
      try {
        fs.unlinkSync(intermediateJpg);
      } catch (_) {}
    }
  }
}

/**
 * Helper to upload an attribute with exponential backoff retries.
 */
async function uploadAttributeWithRetry(file, type, buffer, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await file.uploadAttribute(type, buffer);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      logger.warn(`Upload "${type}" attribute attempt ${attempt} failed: ${err.message}. Retrying in 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Main task runner for generating and uploading thumbnails.
 *
 * @param {import('megajs').Storage} storage
 * @param {import('megajs').MutableFile} targetFolder
 * @param {object} options
 * @param {Array<object>} rawNodes
 */
async function runThumbnailsTask(storage, targetFolder, options = {}, rawNodes = []) {
  const localDir = options.localDir ? path.resolve(options.localDir) : null;
  const onlyThumb = !!options.onlyThumbnails;
  const extensions = options.ext || ['avif', 'jpg', 'jpeg', 'png', 'webp'];

  logger.info(`Scanning target MEGA folder "${targetFolder.name}" for extensions: [${extensions.join(', ')}]...`);
  const allFiles = scanFiles(targetFolder, {
    extensions,
    recursive: options.recursive !== false,
    rawNodes,
  });

  logger.info(`Found ${allFiles.length} matching files on MEGA.`);

  // Determine which files need processing
  let alreadySatisfied = 0;
  const filesToProcess = [];

  for (const item of allFiles) {
    const isSatisfied = onlyThumb
      ? item.hasThumb
      : (item.hasThumb && item.hasPreview);

    if (!options.force && isSatisfied) {
      alreadySatisfied++;
    } else {
      filesToProcess.push(item);
    }
  }

  logger.info(
    onlyThumb
      ? `[STATUS] Already have thumbnail: ${alreadySatisfied} | Needing thumbnails: ${filesToProcess.length}`
      : `[STATUS] Already have both thumbnail & preview: ${alreadySatisfied} | Needing update: ${filesToProcess.length}`
  );

  if (options.limit > 0 && filesToProcess.length > options.limit) {
    logger.info(`Limiting run to first ${options.limit} files (--limit).`);
    filesToProcess.length = options.limit;
  }

  if (filesToProcess.length === 0) {
    logger.success('All files on MEGA already have the required thumbnails/previews. Nothing to do!');
    return { successCount: 0, skippedCount: 0, errorCount: 0 };
  }

  if (options.dryRun) {
    logger.info('[DRY RUN] Would generate and upload thumbnails for:');
    filesToProcess.slice(0, 15).forEach((f, idx) => {
      console.log(`  ${idx + 1}. ${f.relativePath} (thumb: ${f.hasThumb}, preview: ${f.hasPreview})`);
    });
    if (filesToProcess.length > 15) {
      console.log(`  ... and ${filesToProcess.length - 15} more files.`);
    }
    return { successCount: 0, skippedCount: 0, errorCount: 0 };
  }

  // Scratch directory for temp processing
  const tempDir = path.join(os.tmpdir(), `meganz_thumbs_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const startTime = Date.now();

  logger.info(`=======================================================`);
  logger.info(
    onlyThumb
      ? `Starting full-frame thumbnail generation & upload...`
      : `Starting full-frame thumbnail & preview generation & upload...`
  );
  logger.info(`=======================================================\n`);

  try {
    for (let i = 0; i < filesToProcess.length; i++) {
      const item = filesToProcess[i];
      const progress = `[${i + 1}/${filesToProcess.length}] (${(((i + 1) / filesToProcess.length) * 100).toFixed(1)}%)`;

      // Check local folder first
      let localSourcePath = null;
      let isDownloadedTemp = false;

      if (localDir) {
        // Try direct name match or relative path match
        const candidate1 = path.join(localDir, item.name);
        const candidate2 = path.join(localDir, item.relativePath);
        if (fs.existsSync(candidate1)) {
          localSourcePath = candidate1;
        } else if (fs.existsSync(candidate2)) {
          localSourcePath = candidate2;
        }
      }

      const tempThumb = path.join(tempDir, `thumb_${i}.jpg`);
      const tempPrev = path.join(tempDir, `prev_${i}.jpg`);
      const fileStart = Date.now();

      try {
        // Fallback: If not in local directory, download file buffer into temp scratch
        if (!localSourcePath) {
          if (!options.allowDownload) {
            logger.warn(`${progress} [SKIP] File not found in local directory: "${item.name}"`);
            skippedCount++;
            continue;
          }
          logger.info(`${progress} Downloading "${item.name}" from MEGA...`);
          const dlBuffer = await item.file.downloadBuffer();
          localSourcePath = path.join(tempDir, `dl_${i}_${item.name}`);
          await fs.promises.writeFile(localSourcePath, dlBuffer);
          isDownloadedTemp = true;
        }

        if (onlyThumb) {
          await generateThumbnailOnly(localSourcePath, tempThumb, tempDir);
          const thumbBuf = await fs.promises.readFile(tempThumb);
          await uploadAttributeWithRetry(item.file, 'thumbnail', thumbBuf);
          const elapsed = Date.now() - fileStart;
          logger.success(
            `${progress} ${item.name} | Thumb: ${(thumbBuf.length / 1024).toFixed(1)}KB (${elapsed}ms)`
          );
        } else {
          await generateThumbnailAndPreview(localSourcePath, tempThumb, tempPrev, tempDir);
          const thumbBuf = await fs.promises.readFile(tempThumb);
          const prevBuf = await fs.promises.readFile(tempPrev);

          await Promise.all([
            uploadAttributeWithRetry(item.file, 'thumbnail', thumbBuf),
            uploadAttributeWithRetry(item.file, 'preview', prevBuf),
          ]);
          const elapsed = Date.now() - fileStart;
          logger.success(
            `${progress} ${item.name} | Thumb: ${(thumbBuf.length / 1024).toFixed(1)}KB, Preview: ${(prevBuf.length / 1024).toFixed(1)}KB (${elapsed}ms)`
          );
        }

        successCount++;
      } catch (err) {
        logger.error(`${progress} Failed processing ${item.name}: ${err.message}`);
        errorCount++;
      } finally {
        // Unconditional scratch cleanup
        try {
          if (fs.existsSync(tempThumb)) fs.unlinkSync(tempThumb);
          if (fs.existsSync(tempPrev)) fs.unlinkSync(tempPrev);
          if (isDownloadedTemp && localSourcePath && fs.existsSync(localSourcePath)) {
            fs.unlinkSync(localSourcePath);
          }
        } catch (_) {}
      }
    }
  } finally {
    try {
      fs.rmdirSync(tempDir);
    } catch (_) {}
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`=======================================================`);
  logger.info(`Task completed in ${durationSec}s:`);
  logger.info(`- Updated: ${successCount}`);
  logger.info(`- Skipped: ${skippedCount}`);
  logger.info(`- Errors: ${errorCount}`);
  logger.info(`- Already satisfied: ${alreadySatisfied}`);
  logger.info(`=======================================================\n`);

  return { successCount, skippedCount, errorCount };
}

module.exports = {
  runThumbnailsTask,
  generateThumbnailAndPreview,
  generateThumbnailOnly,
};
