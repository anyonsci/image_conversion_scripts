/**
 * lib/manifest.js
 *
 * CSV manifest management for offline conversion workflows.
 * Enables persistent tracking of file conversion states, idempotent resumption,
 * and manual re-run control by editing or deleting entries in the CSV file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSV_HEADER = [
  'relative_path',
  'status',
  'original_size',
  'converted_size',
  'savings_pct',
  'duration_sec',
  'crf',
  'preset',
  'timestamp',
  'uploaded',
  'error_message',
].join(',');

/**
 * Escapes a value for CSV format (wraps in quotes if it contains commas, quotes, or newlines).
 * @param {*} val
 * @returns {string}
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Parses a single CSV line into an array of string values.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        current += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        result.push(current);
        current = '';
      } else {
        current += c;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Loads and parses an existing manifest.csv into a Map keyed by relative_path.
 * @param {string} manifestPath
 * @returns {Map<string, object>}
 */
function loadManifest(manifestPath) {
  const map = new Map();
  if (!fs.existsSync(manifestPath)) {
    return map;
  }

  const content = fs.readFileSync(manifestPath, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) {
    return map; // Only header or empty
  }

  // First line is header
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 2) continue;

    const [
      relativePath,
      status,
      originalSize,
      convertedSize,
      savingsPct,
      durationSec,
      crf,
      preset,
      timestamp,
      uploaded,
      errorMessage,
    ] = cols;

    map.set(relativePath, {
      relativePath,
      status,
      originalSize: parseInt(originalSize, 10) || 0,
      convertedSize: parseInt(convertedSize, 10) || 0,
      savingsPct: parseFloat(savingsPct) || 0.0,
      durationSec: parseFloat(durationSec) || 0.0,
      crf: parseInt(crf, 10) || 0,
      preset: parseInt(preset, 10) || 0,
      timestamp: timestamp || '',
      uploaded: uploaded === 'true',
      errorMessage: errorMessage || '',
    });
  }

  return map;
}

/**
 * Formats a manifest entry object as a CSV string row.
 * @param {object} entry
 * @returns {string}
 */
function formatManifestRow(entry) {
  return [
    escapeCsv(entry.relativePath),
    escapeCsv(entry.status),
    escapeCsv(entry.originalSize || 0),
    escapeCsv(entry.convertedSize || 0),
    escapeCsv(entry.savingsPct || 0.0),
    escapeCsv(entry.durationSec || 0.0),
    escapeCsv(entry.crf || 0),
    escapeCsv(entry.preset || 0),
    escapeCsv(entry.timestamp || new Date().toISOString()),
    escapeCsv(entry.uploaded ? 'true' : 'false'),
    escapeCsv(entry.errorMessage || ''),
  ].join(',');
}

/**
 * Appends a single entry to manifest.csv immediately and flushes to disk.
 * Initializes the header if the file does not exist.
 * @param {string} manifestPath
 * @param {object} entry
 */
function appendManifestEntry(manifestPath, entry) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const row = formatManifestRow(entry) + '\n';

  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, CSV_HEADER + '\n' + row, 'utf8');
  } else {
    fs.appendFileSync(manifestPath, row, 'utf8');
  }
}

/**
 * Atomically rewrites the manifest.csv file with all entries from a Map.
 * Used when updating existing records (e.g. upload status).
 * @param {string} manifestPath
 * @param {Map<string, object>} manifestMap
 */
function saveManifest(manifestPath, manifestMap) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const lines = [CSV_HEADER];
  for (const entry of manifestMap.values()) {
    lines.push(formatManifestRow(entry));
  }
  const tmpPath = manifestPath + '.tmp';
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmpPath, manifestPath);
}

/**
 * Updates the uploaded status for a specific relative_path in manifest.csv.
 * @param {string} manifestPath
 * @param {string} relativePath
 * @param {boolean} uploaded
 */
function updateManifestUploadStatus(manifestPath, relativePath, uploaded = true) {
  const map = loadManifest(manifestPath);
  if (map.has(relativePath)) {
    const entry = map.get(relativePath);
    entry.uploaded = uploaded;
    saveManifest(manifestPath, map);
  }
}

module.exports = {
  CSV_HEADER,
  escapeCsv,
  parseCsvLine,
  loadManifest,
  formatManifestRow,
  appendManifestEntry,
  saveManifest,
  updateManifestUploadStatus,
};
