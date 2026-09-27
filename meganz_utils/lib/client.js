/**
 * client.js
 * Authentication and connection management for MEGA.nz.
 * Supports credentials from CLI flags, .env, and ~/.config/rclone/rclone.conf.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Storage } = require('megajs');
const { logger } = require('./logger');

/**
 * Extracts and reveals credentials from rclone.conf for a given remote.
 * @param {string} remoteName
 * @returns {{ email: string, password: string } | null}
 */
function getRcloneCredentials(remoteName = 'mega1') {
  const confPath = path.join(os.homedir(), '.config/rclone/rclone.conf');
  if (!fs.existsSync(confPath)) return null;

  try {
    const lines = fs.readFileSync(confPath, 'utf8').split('\n');
    let inSection = false;
    let user = null;
    let pass = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('[') && line.endsWith(']')) {
        inSection = line === `[${remoteName}]`;
        continue;
      }
      if (!inSection) continue;
      if (line.startsWith('user =')) user = line.split('=')[1].trim();
      if (line.startsWith('pass =')) pass = line.split('=')[1].trim();
    }

    if (!user || !pass) return null;
    const password = execSync(`rclone reveal "${pass}"`, { encoding: 'utf8' }).trim();
    return { email: user, password };
  } catch (err) {
    logger.warn(`Failed to read rclone credentials for [${remoteName}]: ${err.message}`);
    return null;
  }
}

/**
 * Resolves MEGA credentials from options, environment, or rclone.conf.
 * Priority: CLI options > Environment variables > rclone.conf
 *
 * @param {object} options
 * @returns {{ email: string, password: string }}
 */
function resolveCredentials(options = {}) {
  let email = options.email || process.env.MEGA_EMAIL || '';
  let password = options.password || process.env.MEGA_PASSWORD || '';

  if (!email || !password) {
    const rcloneRemote = options.rcloneRemote || process.env.RCLONE_REMOTE || 'mega1';
    const rcloneCreds = getRcloneCredentials(rcloneRemote);
    if (rcloneCreds) {
      email = email || rcloneCreds.email;
      password = password || rcloneCreds.password;
      logger.info(`Loaded MEGA credentials from rclone remote "[${rcloneRemote}]" (${email})`);
    }
  }

  if (!email || !password) {
    throw new Error(
      'MEGA credentials not found. Provide --email and --password, configure .env, or configure rclone.'
    );
  }

  return { email, password };
}

/**
 * Connects to MEGA and returns the authenticated Storage instance.
 * @param {object} credentials - { email, password }
 * @returns {Promise<import('megajs').Storage>}
 */
async function connectMega(credentials) {
  logger.info(`Connecting to MEGA as ${credentials.email}...`);
  const storage = await new Storage({
    email: credentials.email,
    password: credentials.password,
    autologin: true,
    autoload: true,
  }).ready;

  logger.success(`Connected to MEGA successfully! Account: ${storage.name || credentials.email}`);
  return storage;
}

/**
 * Fetches raw API node list containing low-level metadata and encrypted file attributes (fa).
 * @param {import('megajs').Storage} storage
 * @returns {Promise<Array<object>>}
 */
function fetchRawNodes(storage) {
  return new Promise((resolve, reject) => {
    storage.api.request({ a: 'f', c: 1, r: 1 }, (err, resp) => {
      if (err) return reject(err);
      resolve(resp.f || []);
    });
  });
}

/**
 * Safely closes the MEGA storage connection.
 * @param {import('megajs').Storage} storage
 */
function closeMega(storage) {
  if (storage && typeof storage.close === 'function') {
    try {
      storage.close();
    } catch (_) {}
  }
}

module.exports = {
  getRcloneCredentials,
  resolveCredentials,
  connectMega,
  fetchRawNodes,
  closeMega,
};
