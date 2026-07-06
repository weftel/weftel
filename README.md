# weftel

*The AI lays the warp. You pass the weft.*



https://github.com/user-attachments/assets/0ed7bcfd-770c-4c0d-8cbc-4311bf58e348



A local-first, AI-native notes editor. Notes are plain `.md` / `.html` on disk in a
folder ("vault"). Fluid WYSIWYG editing (TipTap), with the mission: **edit as much of the
HTML directly as a human as possible**. Prose, inline styles, tables, callouts, and even
bespoke designed HTML all become editable; only genuinely un-modelable content (SVG,
`<style>`-driven imports) stays a preserved, view-only block.

AI runs on **your own Claude subscription** (via `@anthropic-ai/claude-agent-sdk`), no
API key. Personal-use OAuth, which is exactly the local-first model.

## Run it

**One command (fresh clone):**
```bash
bun start                         # installs deps, picks a safe port, opens the editor
```
That's it. `bun start` (or `npm start`, or `./start.sh`) installs dependencies on first
run, defaults the vault to `~/notebook` (creating it if needed), starts the server, opens
your browser, and handles the stale-server trap for you: if a previous editor is already
on the port it restarts it fresh; if an unrelated program owns the port it moves to the
next one. Point it elsewhere with `bun start <vault> <port>`.

**Advanced / dev workflows** are unchanged:
```bash
./dev.sh ~/notebook               # dev restart with AI flags default-ON; kills+verifies the port
bun run server.ts ~/notebook      # raw server, no port hygiene (use dev.sh after code changes)
```
`dev.sh` is for hacking on the app (see "Stale server" below); `start.sh` is the
zero-knowledge launch path for just running it.

**As a desktop app (macOS):**
```bash
./desktop.sh ~/notebook           # starts the server + opens a chromeless app window
```
…or double-click **`Notes.app`** in this folder. The app auto-starts the server and opens
a native-feeling window. Switching vaults uses a **native macOS folder picker**.

## Stale server (the recurring "my fix isn't live" trap)

Symptom: you changed code (or restarted), but the app behaves like the old build: a doc
that should be editable is still one frozen rich block, or the welcome screen appears for
a valid `?file=`. Cause, every time so far: **an old `bun run server.ts` is still listening
on the port**; the "new" server silently fails to bind and the zombie keeps serving the old
bundle / the wrong vault. Two amplifiers: the browser/desktop-app caches `/editor.js`
(mitigated by per-build `?v=` cache-busting), and on macOS `/tmp` is a symlink to
`/private/tmp`, so `?file=/tmp/...` fails vault confinement; use `/private/tmp/...`.

Fix: `./dev.sh <vault> [port]`. It kills whatever owns the port, starts fresh, and
**verifies** the served vault + bundle version, loudly failing if a zombie hijacked the
port. When in doubt: `pkill -f server.ts` then `./dev.sh`.

## Using it
- **Open / switch vault**: click the folder name at the top of the sidebar (native
  picker on macOS; path prompt elsewhere).
- **cmd+K**: AI edit/write at the cursor or on a selection (streams live; runs on Haiku).
- **`/`**: slash menu (headings, to-dos, callouts, tables, embeds).
- **Select text**: formatting toolbar (bold, color, highlight, link, ✦ AI edit).
- Chat is intentionally **not** in-app yet; use Claude Code on the vault folder.

## Tests
```bash
bun test tests/unit         # fast unit tests (integrity-critical logic)
npx playwright test         # behavioral e2e (real editor in Chromium; AI replays from cache)
```
AI e2e calls replay from a committed cache (`tests/e2e/.ai-cache`); `AI_OFFLINE=1` forces
replay (no network). First run online re-populates the cache.

## Native app: where it's at / next
- **Now:** Chrome app-window (`desktop.sh` / `Notes.app`) + a native folder picker via
  `/pick-folder` (osascript). Good enough to live in.
- **Next (real native window): Tauri**, which needs the Rust toolchain (`rustup`), not yet
  installed here. The integration seams are already in place: the server's `/open-folder`
  route swaps the vault, and the client calls `window.__pickFolder()` for folder selection.
  A Tauri build just injects a native picker into that hook and points a webview at the
  local server (run as a sidecar). No app logic changes required.
