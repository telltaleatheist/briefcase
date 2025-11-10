#!/bin/bash

# Migration script to populate ai_description field for existing videos
# Extracts the VIDEO OVERVIEW section from existing analyses

APP_DATA_PATH="$HOME/Library/Application Support/clippy"
LIBRARIES_PATH="$APP_DATA_PATH/libraries"

echo "Migration: Populating ai_description from existing analyses"
echo "============================================================"

total_updated=0

# Find all library databases
for lib_dir in "$LIBRARIES_PATH"/lib_*; do
  if [ ! -d "$lib_dir" ]; then
    continue
  fi

  db_path="$lib_dir/library.db"

  if [ ! -f "$db_path" ]; then
    echo "Skipping $(basename "$lib_dir") - no library.db found"
    continue
  fi

  echo ""
  echo "Processing $(basename "$lib_dir")..."

  # Use a temporary Python script to do the regex extraction and update
  python3 - "$db_path" <<'PYTHON_SCRIPT'
import sys
import sqlite3
import re

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get all analyses that have content but video doesn't have ai_description
cursor.execute("""
  SELECT
    a.video_id,
    a.ai_analysis,
    v.filename
  FROM analyses a
  JOIN videos v ON a.video_id = v.id
  WHERE a.ai_analysis IS NOT NULL
    AND (v.ai_description IS NULL OR v.ai_description = '')
""")

analyses = cursor.fetchall()
print(f"  Found {len(analyses)} analyses to migrate")

updated = 0

for video_id, ai_analysis, filename in analyses:
    # Extract summary from analysis text
    # Format: **VIDEO OVERVIEW**\n\nSummary text\n\n----
    match = re.search(r'\*\*VIDEO OVERVIEW\*\*\s*\n+([\s\S]*?)\n+-{3,}', ai_analysis)

    if match:
        summary = match.group(1).strip()

        # Update video's ai_description
        cursor.execute('UPDATE videos SET ai_description = ? WHERE id = ?',
                      (summary, video_id))

        # Also update the analyses table's summary field if it's empty
        cursor.execute('UPDATE analyses SET summary = ? WHERE video_id = ? AND (summary IS NULL OR summary = "")',
                      (summary, video_id))

        # Truncate filename for display
        display_name = filename[:60] + '...' if len(filename) > 60 else filename
        print(f"  ✓ Updated: {display_name}")
        updated += 1
    else:
        display_name = filename[:60] + '...' if len(filename) > 60 else filename
        print(f"  ✗ No summary found: {display_name}")

conn.commit()
conn.close()

print(f"  Migrated {updated} videos in this library")
sys.exit(updated)  # Return count as exit code
PYTHON_SCRIPT

  updated_count=$?
  total_updated=$((total_updated + updated_count))

done

echo ""
echo "✓ Migration complete! Updated ${total_updated} videos total."
