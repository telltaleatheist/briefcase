#!/bin/bash
SEARCH_DIR="/Users/telltale/Documents/software/Briefcase/dist-electron/mac-arm64/Briefcase.app"
TARGET_FILE="/Users/telltale/Documents/software/Briefcase/docs/completed_app_structure.md"

echo "Refreshing tree in: $TARGET_FILE"

echo '```' > "$TARGET_FILE"
tree "$SEARCH_DIR" -I 'zone.js|node_modules|eslint*|nest-cli*|angular-devkit' >> "$TARGET_FILE"
echo '\n\n\n' >> $TARGET_FILE
yes | npx asar list "$SEARCH_DIR/Contents/Resources/app.asar" >> $TARGET_FILE
echo '```' >> "$TARGET_FILE"
