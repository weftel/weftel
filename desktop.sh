#!/usr/bin/env bash
# Run the notes editor as a desktop app: start the local server (if needed) and open it
# in a chromeless Chrome window. Native folder picker works via /pick-folder (osascript).
#
#   ./desktop.sh [vault-folder]      # defaults to ~/notebook
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT="${1:-$HOME/notebook}"
PORT="${PORT:-4321}"

# start the server if it isn't already up on this port
if ! curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
  ( cd "$DIR" && PORT="$PORT" bun run server.ts "$VAULT" >/tmp/note-editor.log 2>&1 & )
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break; sleep 0.25; done
fi

# open a chromeless app window (its own profile so it behaves like a standalone app)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ]; then
  "$CHROME" --app="http://localhost:$PORT/" --user-data-dir="$HOME/.note-editor-app" \
    --no-first-run --no-default-browser-check >/dev/null 2>&1 &
else
  open "http://localhost:$PORT/"
fi
echo "Notes editor running → http://localhost:$PORT/  (vault: $VAULT)"
