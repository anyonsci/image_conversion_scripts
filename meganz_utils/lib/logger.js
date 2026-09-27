/**
 * logger.js
 * Standardized logging and formatting utilities for meganz_utils.
 */

'use strict';

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

module.exports = {
  logger,
  formatBytes,
};
