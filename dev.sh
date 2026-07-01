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

# AI features default ON for DEV (so a restart never silently disables ⌘K/ghost again — the trap
# that bit us 2026-06-17). The committed server.ts default stays OFF, so launch/tests are untouched;
# this is dev-convenience only. Per-flag override still works: `AI_EDIT_ENABLED=0 ./dev.sh …` drops
# ⌘K, `DIFF_GATE=0 ./dev.sh …` keeps ⌘K but drops the approve gate (the gate rides on AI_EDIT_ENABLED).
# Ghost defaults to the local FIM model; if Ollama isn't running it degrades cleanly (no ghost, no crash).
: "${AI_EDIT_ENABLED:=1}"
: "${GHOST_TEXT_ENABLED:=1}"
: "${GHOST_PROVIDER:=ollama}"
: "${GHOST_MODEL:=qwen2.5-coder:1.5b}"
# ⌘K (the rewrite scope) defaults to LOCAL qwen2.5-coder:3b in dev — cloud Haiku was the measured
# "too slow" (cloud-vs-local experiment, issue #74): ~56× slower to first token for ~0.5 quality
# points more, and Ben's bar is latency-first (the quality path is the user's own Claude Code). Ghost
# keeps its own 1.5b (its GHOST_* override wins). Committed server.ts default stays cloud/haiku for
# launch. Override: `PROVIDER=claude MODEL=haiku ./dev.sh …` puts ⌘K back on cloud.
: "${PROVIDER:=ollama}"
: "${MODEL:=qwen2.5-coder:3b}"
export AI_EDIT_ENABLED GHOST_TEXT_ENABLED GHOST_PROVIDER GHOST_MODEL PROVIDER MODEL

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
