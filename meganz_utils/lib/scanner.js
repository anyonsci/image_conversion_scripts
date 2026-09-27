/**
 * scanner.js
 * Common folder resolution and file filtering utilities for MEGA.nz.
 * Traverses target remote directories and matches files by configurable extensions.
 */

'use strict';

const path = require('path');

/**
 * Resolves the designated folder path starting from the MEGA storage root.
 *
 * @param {import('megajs').MutableFile} root - Root Cloud Drive folder
 * @param {string} targetPath - Path to target folder (e.g. "/Photos/SubFolder" or "mummy_parna_26" or "/")
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
      throw new Error(`Path segment "${segment}" cannot be resolved because "${current.name}" has no children`);
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
 * Parses extension filter input into a normalized array of lowercase extensions (without leading dot).
 * Examples:
 *   "jpg,jpeg" -> ["jpg", "jpeg"]
 *   [".avif", "png"] -> ["avif", "png"]
 *   "*" -> ["*"]
 *
 * @param {string|Array<string>} input
 * @returns {Array<string>}
 */
function parseExtensionFilter(input) {
  if (!input) return [];
  let parts = [];
  if (Array.isArray(input)) {
    parts = input;
  } else if (typeof input === 'string') {
    parts = input.split(',').map((s) => s.trim());
  }

  return parts
    .map((ext) => ext.replace(/^\.+/, '').toLowerCase())
    .filter(Boolean);
}

/**
 * Recursively or flatly scans a MEGA folder and filters files based on extension.
 *
 * @param {import('megajs').MutableFile} folder - The target folder node to scan
 * @param {object} options
 * @param {string|Array<string>} [options.extensions] - e.g. ['avif'] or ['jpg', 'jpeg'] or '*'
 * @param {boolean} [options.recursive=true] - Whether to recurse into subdirectories
 * @param {Array<object>} [options.rawNodes] - Optional raw nodes list from fetchRawNodes()
 * @param {string} [options.relativePath=''] - Accumulated relative path
 * @returns {Array<object>}
 */
function scanFiles(folder, options = {}) {
  const {
    extensions = [],
    recursive = true,
    rawNodes = null,
    relativePath = '',
  } = options;

  const filterExts = parseExtensionFilter(extensions);
  const matchAll = filterExts.length === 0 || filterExts.includes('*');

  // Build raw node lookup map by node handle (h) for fast metadata inspection
  const rawMap = new Map();
  if (Array.isArray(rawNodes)) {
    for (const raw of rawNodes) {
      if (raw && raw.h) {
        rawMap.set(raw.h, raw);
      }
    }
  }

  const results = [];

  function traverse(currentFolder, currentRelPath) {
    if (!currentFolder || !Array.isArray(currentFolder.children)) {
      return;
    }

    for (const item of currentFolder.children) {
      const itemRelPath = currentRelPath ? `${currentRelPath}/${item.name}` : item.name;

      if (item.directory) {
        if (recursive) {
          traverse(item, itemRelPath);
        }
      } else {
        const fileName = item.name || '';
        const ext = path.extname(fileName).replace(/^\.+/, '').toLowerCase();

        if (matchAll || filterExts.includes(ext)) {
          const raw = rawMap.get(item.nodeId);
          const fa = raw && typeof raw.fa === 'string' ? raw.fa : '';

          results.push({
            file: item,
            parentFolder: currentFolder,
            name: fileName,
            relativePath: itemRelPath,
            size: item.size || 0,
            ext,
            nodeId: item.nodeId,
            rawNode: raw || null,
            hasThumb: fa.includes(':0*'),
            hasPreview: fa.includes(':1*'),
          });
        }
      }
    }
  }

  traverse(folder, relativePath);
  return results;
}

module.exports = {
  resolveFolderPath,
  parseExtensionFilter,
  scanFiles,
};
