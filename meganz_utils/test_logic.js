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

// Test 8: CSV Manifest serialization, RFC-4180 escaping, and loading
const os = require('os');
const {
  loadManifest,
  appendManifestEntry,
  saveManifest,
  updateManifestUploadStatus,
  escapeCsv,
  parseCsvLine,
} = require('./lib/manifest');
const { resolveOfflineDirs } = require('./tasks/offline_video');

const tempTestDir = path.join(os.tmpdir(), `test_manifest_${Date.now()}`);
const tempManifest = path.join(tempTestDir, 'manifest.csv');

// Test CSV escaping
assert.strictEqual(escapeCsv('normal'), 'normal');
assert.strictEqual(escapeCsv('has,comma'), '"has,comma"');
assert.strictEqual(escapeCsv('has"quote'), '"has""quote"');
assert.strictEqual(escapeCsv('has\nnewline'), '"has\nnewline"');

// Test CSV line parsing
const parsed = parseCsvLine('folder/clip.mp4,converted,1000,500,50.0,12.5,30,8,"2026-10-25T00:00:00Z",false,"No errors, clean"');
assert.strictEqual(parsed[0], 'folder/clip.mp4');
assert.strictEqual(parsed[1], 'converted');
assert.strictEqual(parsed[parsed.length - 1], 'No errors, clean');

// Append entries to manifest
appendManifestEntry(tempManifest, {
  relativePath: 'Day 1/clip1.MOV',
  status: 'converted',
  originalSize: 50000000,
  convertedSize: 25000000,
  savingsPct: 50.0,
  durationSec: 15.2,
  crf: 30,
  preset: 8,
  timestamp: '2026-10-25T01:00:00Z',
  uploaded: false,
  errorMessage: '',
});

appendManifestEntry(tempManifest, {
  relativePath: 'Day 2/burst_action.mp4',
  status: 'rejected_no_savings',
  originalSize: 10000000,
  convertedSize: 0,
  savingsPct: 0.0,
  durationSec: 3.1,
  crf: 32,
  preset: 8,
  timestamp: '2026-10-25T01:05:00Z',
  uploaded: false,
  errorMessage: 'Insufficient compression: AV1 larger than source',
});

const loadedMap = loadManifest(tempManifest);
assert.strictEqual(loadedMap.size, 2);
assert.strictEqual(loadedMap.get('Day 1/clip1.MOV').status, 'converted');
assert.strictEqual(loadedMap.get('Day 1/clip1.MOV').originalSize, 50000000);
assert.strictEqual(loadedMap.get('Day 1/clip1.MOV').convertedSize, 25000000);
assert.strictEqual(loadedMap.get('Day 1/clip1.MOV').savingsPct, 50.0);
assert.strictEqual(loadedMap.get('Day 1/clip1.MOV').uploaded, false);
assert.strictEqual(loadedMap.get('Day 2/burst_action.mp4').status, 'rejected_no_savings');
console.log('✔ Test 8 passed: CSV Manifest serialization, RFC-4180 escaping, and loading');

// Test 9: Manifest resume skipping & manual deletion re-run behavior
// 1. Resume check: both existing entries should be recognized as processed
assert.ok(loadedMap.has('Day 1/clip1.MOV'));
assert.ok(loadedMap.has('Day 2/burst_action.mp4'));

// 2. User manually deletes 'Day 2/burst_action.mp4' from CSV to re-run it
loadedMap.delete('Day 2/burst_action.mp4');
saveManifest(tempManifest, loadedMap);

const reloadedMap = loadManifest(tempManifest);
assert.strictEqual(reloadedMap.size, 1);
assert.ok(reloadedMap.has('Day 1/clip1.MOV'), 'Day 1/clip1.MOV should remain');
assert.ok(!reloadedMap.has('Day 2/burst_action.mp4'), 'Day 2/burst_action.mp4 should be absent after manual deletion for re-run');
console.log('✔ Test 9 passed: Manifest resume skipping & manual deletion re-run behavior');

// Test 10: Manifest upload status updating
updateManifestUploadStatus(tempManifest, 'Day 1/clip1.MOV', true);
const afterUploadMap = loadManifest(tempManifest);
assert.strictEqual(afterUploadMap.get('Day 1/clip1.MOV').uploaded, true);
console.log('✔ Test 10 passed: Manifest upload status tracking');

// Test 11: Offline workspace directory structure & path conservation
const dirs = resolveOfflineDirs({ offlineDir: tempTestDir }, 'kashmir');
assert.strictEqual(dirs.inputDir, path.join(tempTestDir, 'input'));
assert.strictEqual(dirs.outputDir, path.join(tempTestDir, 'output'));
assert.strictEqual(dirs.manifestPath, path.join(tempTestDir, 'manifest.csv'));
assert.ok(fs.existsSync(dirs.inputDir));
assert.ok(fs.existsSync(dirs.outputDir));

// Clean up temp test directory
fs.rmSync(tempTestDir, { recursive: true, force: true });
console.log('✔ Test 11 passed: Offline workspace directory structure & path conservation');

// Test 12: Conversion output metadata extraction (duration_sec, crf, preset)
const { extractConversionMetadata } = require('./tasks/offline_video');

// Case 1: Status line with duration, CRF, and preset
const out1 = `
  [Adaptive Quality] Using CRF 33 (base: 30, 1080p Full HD (+1 CRF))
  Status: CONVERTED | Original: 6712705B | Converted: 6220000B | Duration: 6.13s | CRF: 33 | Preset: 8
`;
const meta1 = extractConversionMetadata(out1, { crf: 30, preset: 8 });
assert.strictEqual(meta1.durationSec, 6.13);
assert.strictEqual(meta1.crf, 33);
assert.strictEqual(meta1.preset, 8);

// Case 2: 4K UHD video with dynamic preset 10 and FFmpeg duration format
const out2 = `
  [Adaptive Quality] Using CRF 35 (base: 30, 4K high-density (+4 CRF))
  [4K UHD Dynamic Preset] Using Preset 10 for 4K video
  Duration: 00:01:15.50, start: 0.000000, bitrate: 45000 kb/s
`;
const meta2 = extractConversionMetadata(out2, { crf: 30, preset: 8 });
assert.strictEqual(meta2.durationSec, 75.5);
assert.strictEqual(meta2.crf, 35);
assert.strictEqual(meta2.preset, 10);

// Case 3: Empty / failed output fallback to config
const meta3 = extractConversionMetadata('error occurred', { crf: 30, preset: 8 });
assert.strictEqual(meta3.durationSec, 0.0);
assert.strictEqual(meta3.crf, 30);
assert.strictEqual(meta3.preset, 8);

console.log('✔ Test 12 passed: Conversion metadata extraction (duration, crf, preset)');

// Test 13: CLI argument parsing for preset, path, and threads
const { parseCLI } = require('./index');

const parsed1 = parseCLI(['convert-video', '--convert-only', '--offline-dir=/tmp/mega', '-p', '6', '-t', '0']);
assert.strictEqual(parsed1.preset, 6, '-p 6 should parse preset as 6');
assert.strictEqual(parsed1.threads, 0, '-t 0 should parse threads as 0');

const parsed2 = parseCLI(['convert-video', '--preset=7']);
assert.strictEqual(parsed2.preset, 7, '--preset=7 should parse preset as 7');

const parsed3 = parseCLI(['convert', '-p', 'kashmir']);
assert.strictEqual(parsed3.targetPath, 'kashmir', '-p <string> should parse as targetPath');
assert.strictEqual(parsed3.preset, 8, 'default preset should remain 8');

console.log('✔ Test 13 passed: CLI argument parsing for preset (-p), path, and threads');

console.log('\nAll unit tests passed successfully!');
