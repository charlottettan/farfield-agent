#!/bin/bash
# Double-click this file to start Farfield. It opens in Terminal and keeps watching until you close that window.
# Chat reading must already be turned on once with:  node src/cli.js screen on --agree
cd "$(dirname "$0")" || exit 1
echo "Starting Farfield. Leave this window open. Close it (or press Ctrl+C) to stop."
exec node src/cli.js app
