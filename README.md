# note-editor-spike

A local-first, AI-native notes editor. Notes are plain `.md` / `.html` on disk in a
folder ("vault"). Fluid WYSIWYG editing (TipTap), with the mission: **edit as much of the
HTML directly as a human as possible** — prose, inline styles, tables, callouts, and even
bespoke designed HTML all become editable; only genuinely un-modelable content (SVG,
`<style>`-driven imports) stays a preserved, view-only block.

AI runs on **your own Claude subscription** (via `@anthropic-ai/claude-agent-sdk`) — no
API key. Personal-use OAuth, which is exactly the local-first model.

## Run it

**Dev (browser):**
```bash
bun install
bun run server.ts ~/notebook      # any folder is a vault
# open http://localhost:4321/
```

**As a desktop app (macOS):**
```bash
./desktop.sh ~/notebook           # starts the server + opens a chromeless app window
```
…or double-click **`Notes.app`** in this folder. The app auto-starts the server and opens
a native-feeling window. Switching vaults uses a **native macOS folder picker**.

## Using it
- **Open / switch vault** — click the folder name at the top of the sidebar (native
  picker on macOS; path prompt elsewhere).
- **cmd+K** — AI edit/write at the cursor or on a selection (streams live; runs on Haiku).
- **`/`** — slash menu (headings, to-dos, callouts, tables, embeds).
- **Select text** — formatting toolbar (bold, color, highlight, link, ✦ AI edit).
- Chat is intentionally **not** in-app yet — use Claude Code on the vault folder.

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
- **Next (real native window): Tauri** — needs the Rust toolchain (`rustup`), not yet
  installed here. The integration seams are already in place: the server's `/open-folder`
  route swaps the vault, and the client calls `window.__pickFolder()` for folder selection
  — a Tauri build just injects a native picker into that hook and points a webview at the
  local server (run as a sidecar). No app logic changes required.
