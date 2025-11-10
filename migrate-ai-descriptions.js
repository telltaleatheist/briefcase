#!/usr/bin/env node

/**
 * Migration script to populate ai_description field for existing videos
 * Extracts the VIDEO OVERVIEW section from existing analyses
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Path to clippy database
const appDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'clippy');
const librariesPath = path.join(appDataPath, 'libraries');

// Find all library databases
const libraryDirs = fs.readdirSync(librariesPath).filter(dir => dir.startsWith('lib_'));

console.log(`Found ${libraryDirs.length} libraries to process`);

let totalUpdated = 0;

for (const libDir of libraryDirs) {
  const dbPath = path.join(librariesPath, libDir, 'library.db');

  if (!fs.existsSync(dbPath)) {
    console.log(`Skipping ${libDir} - no library.db found`);
    continue;
  }

  console.log(`\nProcessing ${libDir}...`);

  const db = new Database(dbPath);

  try {
    // Get all analyses that have content but video doesn't have ai_description
    const analyses = db.prepare(`
      SELECT
        a.video_id,
        a.ai_analysis,
        v.filename
      FROM analyses a
      JOIN videos v ON a.video_id = v.id
      WHERE a.ai_analysis IS NOT NULL
        AND (v.ai_description IS NULL OR v.ai_description = '')
    `).all();

    console.log(`  Found ${analyses.length} analyses to migrate`);

    let updated = 0;

    for (const analysis of analyses) {
      try {
        // Extract summary from analysis text
        // Format: **VIDEO OVERVIEW**\n\nSummary text\n\n----
        const match = analysis.ai_analysis.match(/\*\*VIDEO OVERVIEW\*\*\s*\n+([\s\S]*?)\n+-{3,}/);

        if (match && match[1]) {
          const summary = match[1].trim();

          // Update video's ai_description
          db.prepare('UPDATE videos SET ai_description = ? WHERE id = ?')
            .run(summary, analysis.video_id);

          // Also update the analyses table's summary field if it's empty
          db.prepare('UPDATE analyses SET summary = ? WHERE video_id = ? AND (summary IS NULL OR summary = "")')
            .run(summary, analysis.video_id);

          console.log(`  ✓ Updated: ${analysis.filename.substring(0, 60)}...`);
          updated++;
        } else {
          console.log(`  ✗ No summary found: ${analysis.filename.substring(0, 60)}...`);
        }
      } catch (error) {
        console.error(`  ✗ Error processing ${analysis.filename}: ${error.message}`);
      }
    }

    console.log(`  Migrated ${updated} videos in ${libDir}`);
    totalUpdated += updated;

  } catch (error) {
    console.error(`Error processing ${libDir}: ${error.message}`);
  } finally {
    db.close();
  }
}

console.log(`\n✓ Migration complete! Updated ${totalUpdated} videos total.`);
