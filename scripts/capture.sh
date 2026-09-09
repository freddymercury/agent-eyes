#!/usr/bin/env bash
# Snapshot the current surface.json under a name, so scans from several real
# pages can be compared later. Run right after each Cmd+Shift+U.
#
#   ./scripts/capture.sh github
#   ./scripts/capture.sh github-reload    # same page again, for stability
set -euo pipefail
NAME="${1:?usage: capture.sh <name>}"
SRC="${AGENT_EYES_DIR:-$HOME/.agenteyes}/surface.json"
DEST="$(cd "$(dirname "$0")/.." && pwd)/scans"
mkdir -p "$DEST"
[ -f "$SRC" ] || { echo "no scan at $SRC — is the server running, and did the scan succeed?"; exit 1; }
cp "$SRC" "$DEST/$NAME.json"
bun -e "
const s = await Bun.file('$DEST/$NAME.json').json();
const age = (Date.now() - Date.parse(s.capturedAt)) / 1000;
console.log(\`  saved $NAME.json — \${s.actions.length} actions, \${s.stats?.durationMs}ms, \${age.toFixed(0)}s old\`);
if (age > 120) console.log('  WARNING: that scan is over 2 minutes old — did the new one land?');
"
