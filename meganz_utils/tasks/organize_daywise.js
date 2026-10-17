/**
 * tasks/organize_daywise.js
 *
 * Organizes remote photos and videos into day-wise folders (e.g. "Day 1", "Day 2", ... "Day 7")
 * based on true capture/recording timestamps (EXIF DateTimeOriginal, QuickTime mvhd, or filename),
 * completely bypassing filesystem modification/creation times.
 *
 * All moves are executed server-side via MEGA API (moveTo) without downloading full files or re-uploading.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const pLimit = require('p-limit');
const { logger } = require('../lib/logger');

// Day configuration: 10th Oct 2026 -> Day 1, ... 16th Oct 2026 -> Day 7
const DAY_MAP = {
  '20261010': 'Day 1',
  '20261011': 'Day 2',
  '20261012': 'Day 3',
  '20261013': 'Day 4',
  '20261014': 'Day 5',
  '20261015': 'Day 6',
  '20261016': 'Day 7',
};

/**
 * Extracts date (YYYYMMDD) from filename if present.
 * Matches:
 *  - PXL_20261010_...
 *  - 20261010_...
 *  - 2026-10-10...
 */
function extractDateFromFilename(fileName) {
  // PXL_YYYYMMDD_
  const pxlMatch = fileName.match(/PXL_(\d{4})(\d{2})(\d{2})_/i);
  if (pxlMatch) {
    return `${pxlMatch[1]}${pxlMatch[2]}${pxlMatch[3]}`;
  }

  // YYYYMMDD
  const isoMatch = fileName.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (y >= 2000 && y <= 2030 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${isoMatch[1]}${isoMatch[2]}${isoMatch[3]}`;
    }
  }

  return null;
}

/**
 * Parses QuickTime mvhd atom from a buffer (works for .MOV and .MP4).
 * Returns YYYYMMDD in IST (+05:30) or null.
 */
function parseQuickTimeMvhd(buf) {
  if (!buf || buf.length < 16) return null;
  const idx = buf.indexOf(Buffer.from('mvhd'));
  if (idx === -1 || idx + 16 > buf.length) return null;

  const version = buf.readUInt8(idx + 4);
  let createTimeSeconds = 0;
  if (version === 0 && idx + 12 <= buf.length) {
    createTimeSeconds = buf.readUInt32BE(idx + 8);
  } else if (version === 1 && idx + 16 <= buf.length) {
    const hi = buf.readUInt32BE(idx + 8);
    const lo = buf.readUInt32BE(idx + 12);
    createTimeSeconds = hi * 4294967296 + lo;
  }

  if (!createTimeSeconds) return null;

  // Mac epoch starts 1904-01-01 UTC. Difference from Unix epoch is 2,082,844,800 seconds.
  const unixSeconds = createTimeSeconds - 2082844800;
  // Convert to IST (+5.5 hours = 19,800 seconds)
  const istSeconds = unixSeconds + 19800;
  const d = new Date(istSeconds * 1000);
  if (isNaN(d.getTime())) return null;

  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Extracts capture date (YYYYMMDD) from remote image header buffer using exiftool.
 */
function parseExifDateFromBuffer(buf, ext) {
  if (!buf || buf.length === 0) return null;
  const tmpPath = path.join(os.tmpdir(), `exif_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, buf);
    const out = execSync(`exiftool -s3 -DateTimeOriginal -CreateDate "${tmpPath}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!out) return null;
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(\d{4}):(\d{2}):(\d{2})/);
      if (match) {
        return `${match[1]}${match[2]}${match[3]}`;
      }
    }
  } catch {
    // ExifTool parse failure or corrupted header chunk
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }
  return null;
}

/**
 * Inspects a remote file to determine its capture date.
 */
async function resolveFileDate(file) {
  const fileName = file.name;
  const ext = path.extname(fileName).replace(/^\.+/, '').toLowerCase();

  // 1. Check filename
  const nameDate = extractDateFromFilename(fileName);
  if (nameDate) {
    return { date: nameDate, source: 'filename' };
  }

  // 2. QuickTime video (.mov, .mp4)
  if (['mov', 'mp4', 'm4v'].includes(ext)) {
    try {
      // First check last 64KB (where iPhone writes mvhd)
      const tailSize = Math.min(65536, file.size);
      const tailBuf = await file.downloadBuffer({
        start: Math.max(0, file.size - tailSize),
        end: file.size - 1,
      });
      let mvhdDate = parseQuickTimeMvhd(tailBuf);
      if (mvhdDate) {
        return { date: mvhdDate, source: 'video_mvhd_tail' };
      }

      // Check first 64KB (fast-start / web-optimized)
      const headSize = Math.min(65536, file.size);
      const headBuf = await file.downloadBuffer({ start: 0, end: headSize - 1 });
      mvhdDate = parseQuickTimeMvhd(headBuf);
      if (mvhdDate) {
        return { date: mvhdDate, source: 'video_mvhd_head' };
      }
    } catch (e) {
      logger.warn(`Failed reading video metadata for "${fileName}": ${e.message}`);
    }
  }

  // 3. Images (.heic, .heif, .avif, .jpg, .jpeg, .png)
  if (['heic', 'heif', 'avif', 'jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    try {
      // Download first 128KB header
      const chunkSize = Math.min(131072, file.size);
      const chunkBuf = await file.downloadBuffer({ start: 0, end: chunkSize - 1 });
      const exifDate = parseExifDateFromBuffer(chunkBuf, ext);
      if (exifDate) {
        return { date: exifDate, source: 'exif_header' };
      }
    } catch (e) {
      logger.warn(`Failed reading EXIF header for "${fileName}": ${e.message}`);
    }
  }

  return { date: null, source: 'unknown' };
}

/**
 * Main Daywise Organization Task.
 */
async function runOrganizeTask(storage, options = {}) {
  const {
    targetPath = 'kashmir oct 26',
    dryRun = false,
    folderFormat = 'Day X', // 'Day X' or 'Day X (DD Mon)'
  } = options;

  logger.info(`Starting day-wise photo organization...`);
  logger.info(`Target folder: "${targetPath}" | Mode: ${dryRun ? 'DRY-RUN (Simulated)' : 'LIVE'}`);

  const { resolveFolderPath } = require('../lib/scanner');
  const targetFolder = resolveFolderPath(storage.root, targetPath);

  // Filter children that are files (not directories) and not already inside a Day folder
  const existingFiles = (targetFolder.children || []).filter((c) => !c.directory);

  if (existingFiles.length === 0) {
    logger.info(`No files to organize in "${targetPath}". Everything may already be sorted into subfolders!`);
    return;
  }

  logger.info(`Found ${existingFiles.length} files in "${targetPath}". Resolving dates...`);

  // Step 1: Detect dates for all files in parallel (concurrency 8)
  const limit = pLimit(8);
  let nameCount = 0;
  let metadataCount = 0;
  let completedCount = 0;

  const probeTasks = existingFiles.map((file) =>
    limit(async () => {
      const { date, source } = await resolveFileDate(file);
      if (source === 'filename') nameCount++;
      else if (source !== 'unknown') metadataCount++;

      const numMatch = file.name.match(/IMG_(\d+)/i);
      const imgSeq = numMatch ? parseInt(numMatch[1], 10) : null;

      completedCount++;
      if (completedCount % 50 === 0 || completedCount === existingFiles.length) {
        logger.info(`Processed dates: [${completedCount}/${existingFiles.length}] (Filename: ${nameCount}, Metadata: ${metadataCount})`);
      }

      return {
        file,
        name: file.name,
        size: file.size,
        date,
        source,
        imgSeq,
        dayFolder: null,
      };
    })
  );

  const fileItems = await Promise.all(probeTasks);

  // Step 2: Sequence Interpolation for untagged IMG_ files (e.g. screenshots without EXIF)
  const imgSorted = fileItems
    .filter((item) => item.imgSeq !== null)
    .sort((a, b) => a.imgSeq - b.imgSeq);

  for (let i = 0; i < imgSorted.length; i++) {
    const curr = imgSorted[i];
    if (curr.date) continue;

    // Find preceding known date
    let prevDate = null;
    for (let j = i - 1; j >= 0; j--) {
      if (imgSorted[j].date) {
        prevDate = imgSorted[j].date;
        break;
      }
    }

    // Find succeeding known date
    let nextDate = null;
    for (let j = i + 1; j < imgSorted.length; j++) {
      if (imgSorted[j].date) {
        nextDate = imgSorted[j].date;
        break;
      }
    }

    if (prevDate && prevDate === nextDate) {
      curr.date = prevDate;
      curr.source = 'sequence_interpolation';
    } else if (prevDate) {
      curr.date = prevDate;
      curr.source = 'sequence_interpolation_prev';
    } else if (nextDate) {
      curr.date = nextDate;
      curr.source = 'sequence_interpolation_next';
    }
  }

  // Step 3: Map dates to destination Day folders
  const summary = {};
  for (const item of fileItems) {
    if (item.date && DAY_MAP[item.date]) {
      item.dayFolder = DAY_MAP[item.date];
    } else if (item.date) {
      item.dayFolder = `Other_${item.date}`;
    } else {
      item.dayFolder = 'Unsorted';
    }
    summary[item.dayFolder] = (summary[item.dayFolder] || 0) + 1;
  }

  logger.info(`\n=== Proposed Day-wise Distribution ===`);
  console.table(summary);

  if (dryRun) {
    logger.info(`[DRY-RUN] No files were moved. To execute live moves, re-run without --dry-run.`);
    return summary;
  }

  // Step 4: Live Execution - Create Day directories on MEGA and move files
  logger.info(`Creating day folders and moving files server-side on MEGA...`);

  // Cache folder objects
  const folderCache = {};
  for (const c of targetFolder.children || []) {
    if (c.directory) {
      folderCache[c.name] = c;
    }
  }

  let movedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < fileItems.length; i++) {
    const item = fileItems[i];
    const targetDirName = item.dayFolder;

    try {
      // Ensure folder exists
      if (!folderCache[targetDirName]) {
        logger.info(`Creating folder "${targetDirName}" in "${targetPath}"...`);
        const newDir = await targetFolder.mkdir(targetDirName);
        folderCache[targetDirName] = newDir;
      }

      const destFolder = folderCache[targetDirName];
      await item.file.moveTo(destFolder);
      movedCount++;

      if (movedCount % 25 === 0 || i + 1 === fileItems.length) {
        logger.info(`[${i + 1}/${fileItems.length}] Moved "${item.name}" -> "${targetDirName}"`);
      }
    } catch (err) {
      errorCount++;
      logger.error(`Failed to move "${item.name}" to "${targetDirName}": ${err.message}`);
    }
  }

  logger.success(`\n[COMPLETE] Successfully organized ${movedCount} files into day folders (${errorCount} errors).`);
  return summary;
}

module.exports = {
  runOrganizeTask,
  extractDateFromFilename,
  parseQuickTimeMvhd,
  parseExifDateFromBuffer,
  resolveFileDate,
  DAY_MAP,
};
