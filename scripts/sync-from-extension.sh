#!/bin/sh
# Refresh the copies of the extension's dashboard and sample data used by the desktop app.
# Usage: scripts/sync-from-extension.sh /path/to/farfield-extension
set -e
EXT="${1:?path to the extension folder}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
for f in dashboard.html dashboard.js theme.js analysis.js sample-org.js regression-tests.js office-logic.js office-files.js chat-import.js llm-analyze.js sync.js overview-ripple.js; do cp "$EXT/$f" "$HERE/web/dashboard/$f"; done
for d in fonts logo icons; do rm -rf "$HERE/web/dashboard/$d"; cp -r "$EXT/$d" "$HERE/web/dashboard/$d"; done
for f in analysis.js office-logic.js office-files.js sync.js background.js; do cp "$EXT/$f" "$HERE/vendor/$f"; done
echo "Copied from $EXT"
