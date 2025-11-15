const sqlite3 = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HASH_SAMPLE_SIZE = 1024 * 1024; // 1MB

function quickHashFile(filePath, fileSize) {
  const hash = crypto.createHash('sha256');

  // Add file size to hash
  hash.update(fileSize.toString());

  // Sample from beginning, middle, and end of file
  const sampleSize = Math.min(HASH_SAMPLE_SIZE, Math.floor(fileSize / 3));

  if (fileSize <= HASH_SAMPLE_SIZE * 3) {
    const buffer = fs.readFileSync(filePath);
    hash.update(buffer);
  } else {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(sampleSize);

      // Beginning
      fs.readSync(fd, buffer, 0, sampleSize, 0);
      hash.update(buffer);

      // Middle
      fs.readSync(fd, buffer, 0, sampleSize, Math.floor(fileSize / 2) - Math.floor(sampleSize / 2));
      hash.update(buffer);

      // End
      fs.readSync(fd, buffer, 0, sampleSize, fileSize - sampleSize);
      hash.update(buffer);
    } finally {
      fs.closeSync(fd);
    }
  }

  return hash.digest('hex');
}

// Find the active library database
const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'clippy', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const activeLib = config.libraries.find(lib => lib.id === config.activeLibraryId);

if (!activeLib) {
  console.error('No active library found');
  process.exit(1);
}

console.log('Active library:', activeLib.name);
console.log('Database path:', activeLib.dbPath);
console.log('');

// Open database
const db = sqlite3(activeLib.dbPath);

// Test filename from the error list
const testFilename = '2024-12-16 joshua haymes says founding fathers are rolling over in their graves - satan is being worshiped in government and mosques are being built - christian nationalism.mov';

// Find this file in the database
const video = db.prepare('SELECT * FROM videos WHERE filename = ?').get(testFilename);

if (!video) {
  console.log('File not found in database:', testFilename);
  process.exit(1);
}

console.log('=== Database Entry ===');
console.log('ID:', video.id);
console.log('Filename:', video.filename);
console.log('File path:', video.file_path);
console.log('File hash in DB:', video.file_hash);
console.log('Parent ID:', video.parent_id);
console.log('');

// Check if file exists in Downloads
const downloadsPath = path.join(os.homedir(), 'Downloads', 'clips');
const downloadsFullPath = path.join(downloadsPath, '2025-10-19', testFilename);

if (fs.existsSync(downloadsFullPath)) {
  const stats = fs.statSync(downloadsFullPath);
  const hash = quickHashFile(downloadsFullPath, stats.size);
  console.log('=== Downloads File ===');
  console.log('Path:', downloadsFullPath);
  console.log('Size:', stats.size);
  console.log('Computed hash:', hash);
  console.log('Matches DB hash:', hash === video.file_hash);
  console.log('');
} else {
  console.log('File NOT found in Downloads:', downloadsFullPath);
  console.log('');
}

// Check if file exists in Callisto
const callistoPath = '/Volumes/Callisto/clips';
const callistoFullPath = path.join(callistoPath, '2025-10-19', testFilename);

if (fs.existsSync(callistoFullPath)) {
  const stats = fs.statSync(callistoFullPath);
  const hash = quickHashFile(callistoFullPath, stats.size);
  console.log('=== Callisto File ===');
  console.log('Path:', callistoFullPath);
  console.log('Size:', stats.size);
  console.log('Computed hash:', hash);
  console.log('Matches DB hash:', hash === video.file_hash);
  console.log('');
} else {
  console.log('File NOT found in Callisto:', callistoFullPath);
  console.log('');
}

db.close();
