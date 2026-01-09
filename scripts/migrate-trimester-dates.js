#!/usr/bin/env node
/**
 * Migration Script: Convert T1/T2/T3 Dates to Proper Dates
 *
 * Converts filenames like "2025-09-T2 Video Title.mp4" to "2025-09-10 Video Title.mp4"
 * and updates the database accordingly.
 *
 * T1 (1st-9th)   → 01
 * T2 (10th-19th) → 10
 * T3 (20th-end)  → 20
 *
 * Usage:
 *   node scripts/migrate-trimester-dates.js --dry-run    # Preview changes
 *   node scripts/migrate-trimester-dates.js              # Execute migration
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const CLIPS_ROOT = '/Volumes/Callisto/clips';
const DB_PATH = path.join(CLIPS_ROOT, '.library.db');

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// Trimester to day mapping
const TRIMESTER_TO_DAY = {
  '1': '01',
  '2': '10',
  '3': '20'
};

// Statistics
const stats = {
  total: 0,
  renamed: 0,
  skipped: 0,
  conflicts: 0,
  missing: 0,
  errors: 0
};

/**
 * Execute a SQLite query and return results as array of objects
 */
function sqlQuery(query) {
  try {
    // Use -json mode for easy parsing
    const result = execSync(`sqlite3 -json "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer for large results
    });
    return result.trim() ? JSON.parse(result) : [];
  } catch (err) {
    console.error('SQL Error:', err.message);
    return [];
  }
}

/**
 * Execute a SQLite update statement
 */
function sqlUpdate(statement) {
  try {
    execSync(`sqlite3 "${DB_PATH}" "${statement.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8'
    });
    return true;
  } catch (err) {
    console.error('SQL Update Error:', err.message);
    return false;
  }
}

/**
 * Create a timestamped backup of the database
 */
function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${DB_PATH}.pre-migration-${timestamp}`;

  console.log(`\nCreating database backup...`);
  fs.copyFileSync(DB_PATH, backupPath);
  console.log(`Backup created: ${backupPath}\n`);

  return backupPath;
}

/**
 * Parse T1/T2/T3 pattern from filename
 * Returns { yearMonth, trimester, properDate } or null if no match
 */
function parseTrimesterDate(filename) {
  const match = filename.match(/^(\d{4}-\d{2})-T([123])\s/);
  if (!match) return null;

  const [, yearMonth, trimester] = match;
  const day = TRIMESTER_TO_DAY[trimester];
  const properDate = `${yearMonth}-${day}`;

  return { yearMonth, trimester, properDate };
}

/**
 * Generate new filename by replacing T# with proper date
 */
function generateNewFilename(filename, properDate) {
  return filename.replace(/^(\d{4}-\d{2})-T[123]\s/, `${properDate} `);
}

/**
 * Escape single quotes for SQL
 */
function escapeSql(str) {
  return str.replace(/'/g, "''");
}

/**
 * Process a single video
 */
function processVideo(video) {
  const parsed = parseTrimesterDate(video.filename);
  if (!parsed) {
    console.log(`  SKIP (no pattern): ${video.filename}`);
    stats.skipped++;
    return;
  }

  const { properDate } = parsed;
  const newFilename = generateNewFilename(video.filename, properDate);

  // Build paths
  const folder = path.dirname(video.current_path);
  const newPath = folder === '.' ? newFilename : path.join(folder, newFilename);
  const oldFullPath = path.join(CLIPS_ROOT, video.current_path);
  const newFullPath = path.join(CLIPS_ROOT, newPath);

  // Check if source file exists
  if (!fs.existsSync(oldFullPath)) {
    console.log(`  MISSING: ${video.current_path}`);
    stats.missing++;
    return;
  }

  // Check for conflicts
  if (fs.existsSync(newFullPath) && oldFullPath !== newFullPath) {
    console.log(`  CONFLICT: ${newFilename} already exists`);
    stats.conflicts++;
    return;
  }

  if (DRY_RUN) {
    console.log(`  WOULD RENAME: ${video.filename}`);
    console.log(`            TO: ${newFilename}`);
    console.log(`     upload_date: ${video.upload_date || 'NULL'} -> ${properDate}`);
    stats.renamed++;
    return;
  }

  // Execute rename
  try {
    fs.renameSync(oldFullPath, newFullPath);

    // Update database
    const updateSql = `UPDATE videos SET filename = '${escapeSql(newFilename)}', current_path = '${escapeSql(newPath)}', upload_date = '${properDate}' WHERE id = '${video.id}'`;

    if (sqlUpdate(updateSql)) {
      console.log(`  RENAMED: ${video.filename}`);
      console.log(`       TO: ${newFilename}`);
      stats.renamed++;
    } else {
      // Rollback file rename if DB update failed
      fs.renameSync(newFullPath, oldFullPath);
      console.error(`  ERROR: DB update failed, rolled back file rename`);
      stats.errors++;
    }
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    stats.errors++;
  }
}

/**
 * Main migration function
 */
function main() {
  console.log('='.repeat(70));
  console.log('T1/T2/T3 Date Migration Script');
  console.log('='.repeat(70));

  if (DRY_RUN) {
    console.log('\n*** DRY RUN MODE - No changes will be made ***\n');
  }

  // Check database exists
  if (!fs.existsSync(DB_PATH)) {
    console.error(`ERROR: Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  // Create backup (only in execute mode)
  let backupPath = null;
  if (!DRY_RUN) {
    backupPath = createBackup();
  }

  // Find all T1/T2/T3 videos
  console.log('Finding videos with T1/T2/T3 patterns...\n');

  const videos = sqlQuery(`
    SELECT id, filename, current_path, upload_date
    FROM videos
    WHERE filename LIKE '%-T1 %'
       OR filename LIKE '%-T2 %'
       OR filename LIKE '%-T3 %'
    ORDER BY filename
  `);

  stats.total = videos.length;
  console.log(`Found ${videos.length} videos to process.\n`);

  if (videos.length === 0) {
    console.log('No videos to migrate.');
    return;
  }

  // Process each video
  console.log('Processing videos:');
  console.log('-'.repeat(70));

  for (const video of videos) {
    processVideo(video);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total videos found:    ${stats.total}`);
  console.log(`Successfully renamed:  ${stats.renamed}`);
  console.log(`Skipped (no pattern):  ${stats.skipped}`);
  console.log(`Conflicts (file exists): ${stats.conflicts}`);
  console.log(`Missing files:         ${stats.missing}`);
  console.log(`Errors:                ${stats.errors}`);

  if (DRY_RUN) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to execute the migration.');
  } else if (backupPath) {
    console.log(`\nDatabase backup: ${backupPath}`);
  }

  console.log('='.repeat(70));
}

// Run the migration
main();
