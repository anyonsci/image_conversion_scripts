/**
 * Unit test suite to verify directory resolution, recursive scanning, and file mapping logic.
 */

const assert = require('assert');
const path = require('path');

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
    } else if (item.name && /\.(jpe?g)$/i.test(item.name)) {
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
            { name: 'logo.png', directory: false, size: 512 },
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
assert.strictEqual(foundFromPhotos.length, 4);

const fileNames = foundFromPhotos.map((f) => f.fileName);
assert.ok(fileNames.includes('cover.jpg'));
assert.ok(fileNames.includes('vacation.JPEG'));
assert.ok(fileNames.includes('beach.JPG'));
assert.ok(fileNames.includes('mountain.jpeg'));
assert.ok(!fileNames.includes('notes.txt'));
assert.ok(!fileNames.includes('logo.png'));
console.log('✔ Test 4 passed: Recursive JPEG discovery (case-insensitive)');

// Test 5: Relative paths and parent links
const mountain = foundFromPhotos.find((f) => f.fileName === 'mountain.jpeg');
assert.strictEqual(foundFromPhotos.find(f => f.fileName === 'mountain.jpeg').relativePath, '2026/Trip/mountain.jpeg');
assert.strictEqual(foundFromPhotos.find(f => f.fileName === 'mountain.jpeg').parentFolder.name, 'Trip');
console.log('✔ Test 5 passed: Relative paths and parent folder linking');

console.log('\nAll unit tests passed successfully!');
