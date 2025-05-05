#!/bin/bash

# Resolve the path to the target file (relative to the script's location)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_FILE="$SCRIPT_DIR/../docs/clippy_structure.md"

echo "Refreshing tree in: $TARGET_FILE"

# Overwrite the file with the opening code block
echo '```' > "$TARGET_FILE"

# Append the tree output
tree "$SCRIPT_DIR/.." -I '.*dist.*|dist-electron|dist|zone.js|node_modules|eslint*|nest-cli*|angular-devkit' >> "$TARGET_FILE"

# Append the closing code block
echo '```' >> "$TARGET_FILE"