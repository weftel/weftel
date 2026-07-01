#!/bin/sh
# start.sh — the ONE command to launch the notes editor from a fresh clone.
#
#   bun start                 # or:  npm start   or:  ./start.sh
#   ./start.sh [vault] [port] # defaults: ~/notebook on 4321
#
# What it does for you (so a new user never has to reason about the run model):
#   1. installs dependencies if they're missing (bun install)
#   2. picks a safe port — if OUR server is already on it (a stale/zombie instance
#      serving old code) it restarts it fresh; if an UNRELATED server owns the port
#      it leaves that alone and moves to the next free port
#   3. starts the server and VERIFIES the process we started owns the port (no zombie
#      hijack) and prints the served bundle version (the ?v= tag proves it's current)
#   4. opens the editor in your browser
#   5. defaults the vault to ~/notebook, creating it on first run if it doesn't exist
#
# Advanced/dev workflows (dev.sh with AI flags, desktop.sh app window) still work as
# before — this is the zero-knowledge happy path, not a replacement for them.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
VAULT="${1:-$HOME/notebook}"
PORT="${2:-${PORT:-4321}}"
cd "$DIR"

# 1. deps — install on first run (fresh clone has no node_modules)
if [ ! -d node_modules ] || [ ! -e node_modules/.bin ]; then
  echo "installing dependencies (first run)…"
  bun install
fi

# vault: default ~/notebook, create it on first run so the user lands in a real (empty)
# vault instead of the bundled sample. macOS: /tmp is a symlink to /private/tmp; the
# server realpaths its root, so normalize to the canonical path for the printed URL.
if [ ! -d "$VAULT" ]; then
  echo "creating vault: $VAULT"
  mkdir -p "$VAULT"
fi
VAULT=$(cd "$VAULT" 2>/dev/null && pwd -P) || { echo "vault not found: $VAULT"; exit 1; }

# is there OUR editor server already on $PORT? (signature: it serves the /editor.js
# module referenced with a per-build ?v= cache-bust tag). Distinguishes our own stale
# instance — safe to restart — from an unrelated server we must NOT kill.
is_our_server() {
  curl -s "http://localhost:$1/" 2>/dev/null | grep -q 'editor\.js?v='
}
listener_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

# 2. pick a safe port
while :; do
  PIDS=$(listener_pids "$PORT")
  if [ -z "$PIDS" ]; then
    break                                   # free — use it
  elif is_our_server "$PORT"; then
    # our own (possibly stale) server holds the port — restart it so the served bundle
    # is guaranteed current (kills ONLY our editor, never an unrelated process).
    echo "restarting the editor already on :$PORT (pid $PIDS) to serve the latest code"
    kill $PIDS 2>/dev/null || true
    sleep 1
    break
  else
    # an unrelated server owns this port — leave it running, move to the next port.
    NEXT=$((PORT + 1))
    echo "port $PORT is used by another program (not the editor) — trying $NEXT instead"
    PORT=$NEXT
  fi
done

# 3. start fresh + verify
( PORT="$PORT" exec bun run server.ts "$VAULT" ) &
NEWPID=$!
for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break; sleep 0.25; done

OWNER=$(listener_pids "$PORT" | head -1)
BUNDLE=$(curl -s "http://localhost:$PORT/?file=x" | grep -oE 'editor\.js\?v=[a-z0-9]+' | head -1)
URL="http://localhost:$PORT/"
echo "--------------------------------------------------"
echo "  Notes editor →  $URL"
echo "  vault           $VAULT"
echo "  pid             $NEWPID (port owner: ${OWNER:-none})"
echo "  bundle          ${BUNDLE:-(?)}   ← current build; a stale server would show an old tag"
echo "--------------------------------------------------"
if [ -n "$OWNER" ] && [ "$OWNER" != "$NEWPID" ]; then
  echo "⚠️  a different process ($OWNER) answered on :$PORT — not the one just started."
  echo "    Re-run: ./start.sh   (or pick a port: ./start.sh \"$VAULT\" 4322)"
  exit 1
fi

# 4. open the editor (best-effort; never fail the launch if no opener is available)
if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true      # macOS
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true  # Linux
fi

echo "editor is running — press Ctrl-C to stop."
wait $NEWPID
