#!/bin/bash
# Take a compressed screenshot for LLM analysis
# Usage: ./screenshot.sh [name]
# Output: /tmp/screenshots/<name>.compressed.jpg

NAME="${1:-screenshot}"
DIR="/tmp/screenshots"
mkdir -p "$DIR"

# Take screenshot and save as PNG
agent-browser screenshot --json 2>/dev/null | node -e "
const fs = require('fs');
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const json = JSON.parse(data);
    if (json && json.data && json.data.base64) {
      fs.writeFileSync('$DIR/$NAME.png', Buffer.from(json.data.base64, 'base64'));
    }
  } catch (e) {}
});
"

# Compress for LLM analysis
if [ -f "$DIR/$NAME.png" ]; then
  node /workspace/scripts/compress-image.js "$DIR/$NAME.png" "$DIR/$NAME.compressed.jpg" 2>&1
  echo "$DIR/$NAME.compressed.jpg"
fi
