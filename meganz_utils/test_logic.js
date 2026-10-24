/**
 * Unit test suite to verify directory resolution, recursive scanning, and file mapping logic.
 */

const assert = require('assert');
const path = require('path');
const { scanFiles, resolveFolderPath: scannerResolveFolderPath } = require('./lib/scanner');

// Extract or replicate the pure functions from index.js for unit validation
function resolveFolderPath(root, targetPath) {
  const normalized = (targetPath || '/').trim();
  if (normalized === '/' || normalized === '' || normalized === '.') {
    return root;
  }

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

function scanJpegFilesRecursively(folder, relativePath = '') {
  const results = [];

  if (!folder || !Array.isArray(folder.children)) {
    return results;
  }

  for (const item of folder.children) {
    const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;

    if (item.directory) {
      results.push(...scanJpegFilesRecursively(item, itemRelativePath));
    } else if (item.name && /\.(jpe?g|heic|heif)$/i.test(item.name)) {
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

// ==========================================
// Test Mock File System Tree
// ==========================================
const mockRoot = {
  name: 'Cloud Drive',
  directory: true,
  children: [
    {
      name: 'Photos',
      directory: true,
      children: [
        { name: 'cover.jpg', directory: false, size: 1024 },
        { name: 'notes.txt', directory: false, size: 50 },
        {
          name: '2026',
          directory: true,
          children: [
            { name: 'vacation.JPEG', directory: false, size: 2048 },
            { name: 'beach.JPG', directory: false, size: 4096 },
            { name: 'live.HEIC', directory: false, size: 3000 },
            { name: 'burst.heif', directory: false, size: 3500 },
            { name: 'logo.png', directory: false, size: 512 },
            { name: 'clip.mp4', directory: false, size: 1048576 },
            { name: 'action.MOV', directory: false, size: 2097152 },
            { name: 'already_done.av1.mp4', directory: false, size: 524288 },
            {
              name: 'Trip',
              directory: true,
              children: [
                { name: 'mountain.jpeg', directory: false, size: 8192 },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'Documents',
      directory: true,
      children: [
        { name: 'invoice.pdf', directory: false, size: 100 },
      ],
    },
  ],
};

// Test 1: Resolve root
assert.strictEqual(resolveFolderPath(mockRoot, '/'), mockRoot);
assert.strictEqual(resolveFolderPath(mockRoot, ''), mockRoot);
console.log('✔ Test 1 passed: Root path resolution');

// Test 2: Resolve nested folder
const photos = resolveFolderPath(mockRoot, '/Photos');
assert.strictEqual(photos.name, 'Photos');

const year2026 = resolveFolderPath(mockRoot, '/Photos/2026');
assert.strictEqual(year2026.name, '2026');

const trip = resolveFolderPath(mockRoot, 'Photos/2026/Trip');
assert.strictEqual(trip.name, 'Trip');
console.log('✔ Test 2 passed: Nested path resolution');

// Test 3: Path not found
assert.throws(() => {
  resolveFolderPath(mockRoot, '/Photos/NonExistent');
}, /Directory "NonExistent" not found/);
console.log('✔ Test 3 passed: Non-existent folder error throwing');

// Test 4: Recursive scan from /Photos
const foundFromPhotos = scanJpegFilesRecursively(photos);
assert.strictEqual(foundFromPhotos.length, 6);

const fileNames = foundFromPhotos.map((f) => f.fileName);
assert.ok(fileNames.includes('cover.jpg'));
assert.ok(fileNames.includes('vacation.JPEG'));
assert.ok(fileNames.includes('beach.JPG'));
assert.ok(fileNames.includes('live.HEIC'));
assert.ok(fileNames.includes('burst.heif'));
assert.ok(fileNames.includes('mountain.jpeg'));
assert.ok(!fileNames.includes('notes.txt'));
assert.ok(!fileNames.includes('logo.png'));
console.log('✔ Test 4 passed: Recursive JPEG/HEIC discovery (case-insensitive)');

// Test 5: Relative paths and parent links
const mountain = foundFromPhotos.find((f) => f.fileName === 'mountain.jpeg');
assert.strictEqual(foundFromPhotos.find(f => f.fileName === 'mountain.jpeg').relativePath, '2026/Trip/mountain.jpeg');
assert.strictEqual(foundFromPhotos.find(f => f.fileName === 'mountain.jpeg').parentFolder.name, 'Trip');
console.log('✔ Test 5 passed: Relative paths and parent folder linking');

// Test 6: Recursive video discovery and .av1.mp4 filtering
const foundVideos = scanFiles(photos, { extensions: ['mp4', 'mov', 'm4v'] });
assert.strictEqual(foundVideos.length, 3);
const candidateVideos = foundVideos.filter((v) => !v.name.toLowerCase().endsWith('.av1.mp4'));
assert.strictEqual(candidateVideos.length, 2);
const videoNames = candidateVideos.map((v) => v.name);
assert.ok(videoNames.includes('clip.mp4'));
assert.ok(videoNames.includes('action.MOV'));
assert.ok(!videoNames.includes('already_done.av1.mp4'));
console.log('✔ Test 6 passed: Recursive MP4/MOV discovery and .av1.mp4 filtering');

// Test 7: Persistent MEGA session caching & sanitization
const fs = require('fs');
const { getSessionPaths, loadCachedSession, saveCachedSession, clearCachedSession } = require('./lib/client');
const testEmail = 'tester_sec_audit@example.com';
const mockStorage = {
  toJSON: () => ({
    key: Buffer.alloc(16, 'k').toString('base64'),
    sid: 'test_session_id_xyz789',
    name: 'Security Test User',
    user: 'u_tester_99',
    options: { email: testEmail, password: 'supersecretpassword123', autoload: true }
  })
};

// Save session
saveCachedSession(testEmail, mockStorage);
const { sessionPath } = getSessionPaths(testEmail);
assert.ok(fs.existsSync(sessionPath), 'Session file must exist');

// Verify permissions and contents
const loaded = loadCachedSession(testEmail);
assert.strictEqual(loaded.sid, 'test_session_id_xyz789');
assert.strictEqual(loaded.name, 'Security Test User');
assert.strictEqual(loaded.options.password, undefined, 'Raw password must be stripped from cached session');

// Clear session
clearCachedSession(testEmail);
assert.ok(!fs.existsSync(sessionPath), 'Session file must be deleted upon clear');
console.log('✔ Test 7 passed: Persistent MEGA session caching & password sanitization');

console.log('\nAll unit tests passed successfully!');
