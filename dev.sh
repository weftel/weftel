#!/bin/sh
# dev.sh — start (or restart) the editor server SAFELY.
#
# Exists because of a recurring trap: an old `bun run server.ts` keeps listening on the
# port, a newly-started one silently fails to bind, and you end up testing STALE CODE
# (or the wrong vault) while believing you restarted. This script kills whatever is on
# the port, starts fresh, then VERIFIES the vault root + bundle version actually served.
#
# Usage:
#   ./dev.sh [vault-dir] [port]     # defaults: ~/notebook on 4321
#   ./dev.sh /private/tmp/corpus-browse 4322
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
VAULT="${1:-$HOME/notebook}"
PORT="${2:-4321}"

# macOS: /tmp is a symlink to /private/tmp; the server realpaths its root, so a /tmp/…
# ?file= URL fails confinement. Normalize here so printed URLs are the canonical form.
VAULT=$(cd "$VAULT" 2>/dev/null && pwd -P) || { echo "vault not found: $1"; exit 1; }

# 1. kill ANYTHING on the port (zombie servers from old sessions are the recurring bug)
PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$PIDS" ]; then echo "killing stale listener(s) on :$PORT → $PIDS"; kill $PIDS 2>/dev/null || true; sleep 1; fi

# 2. start fresh
( cd "$DIR" && PORT="$PORT" exec bun run server.ts "$VAULT" ) &
NEWPID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break; sleep 0.25; done

# 3. VERIFY: the process we just started owns the port, and the served vault matches
OWNER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
SERVED=$(curl -s "http://localhost:$PORT/" | grep -oE '"file":"[^"]*"' | head -1)
BUNDLE=$(curl -s "http://localhost:$PORT/?file=x" | grep -oE 'editor\.js\?v=[a-z0-9]+' | head -1)
echo "--------------------------------------------------"
echo "  url     http://localhost:$PORT/"
echo "  vault   $VAULT"
echo "  pid     $NEWPID (port owner: ${OWNER:-none})"
echo "  serving ${SERVED:-(welcome screen)}"
echo "  bundle  ${BUNDLE:-(?)}   ← changes on every code change; if it didn't, you're stale"
echo "--------------------------------------------------"
if [ -n "$OWNER" ] && [ "$OWNER" != "$NEWPID" ]; then
  echo "⚠️  PORT HIJACKED: pid $OWNER (an old server) answered, not the one just started."
  echo "    Run: kill $OWNER   then re-run ./dev.sh"
  exit 1
fi
case "$SERVED" in *"$VAULT"*) : ;; *) echo "⚠️  served file is not under $VAULT — wrong vault is live."; esac
wait $NEWPID
