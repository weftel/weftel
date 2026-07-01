// note-editor-spike — local-first, AI-native notes editor.
//
// One "vault" folder. Notes are .md / .html on disk. Fluid TipTap editing with
// three block types (Prose / Rich / Dynamic). cmd+K = AI edit via the user's own
// Claude. This server: bundles the client, serves the editor, and owns all file
// I/O behind safety guards (vault confinement, atomic writes, no-clobber create,
// trash-on-delete, same-origin POST checks).
//
//   bun run server.ts [file-or-folder]
//   open http://localhost:4321/
//
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, mkdirSync, realpathSync, rmSync, copyFileSync } from "node:fs";
import { resolve, extname, basename, dirname, sep, join } from "node:path";
import { createHash } from "node:crypto";
// [AI:model-layer] The raw model call now lives behind a provider seam (server/providers.ts).
// streamAI() below delegates to the selected provider (CloudProvider by default, which wraps
// the Agent SDK exactly as before) instead of calling query() directly here.
import { getProvider, modelInfo } from "./server/providers";

// [AI:cmdk] In-app AI edit (⌘K) — DEFAULT ON in committed code (launch #88: the headline feature
// must be visible on a fresh clone, no dev.sh). Env override still works: `AI_EDIT_ENABLED=0` drops
// ⌘K (any other value, incl. unset, is ON). SINGLE SOURCE OF TRUTH: gates the /rewrite route AND is
// injected into the client via shell(). When no provider is reachable the route degrades cleanly
// (CloudProvider catches, /rewrite streams {error}, client shows it) — it never hangs. Connect/
// first-run UX is #89. (model-layer + cmdk agreed on the single-source pattern.)
const AI_EDIT_ENABLED = process.env.AI_EDIT_ENABLED !== "0";

// [AI:ghost] Tab ghost-text ("Cursor-Tab for notes", v1) — inline faded completion accepted with
// Tab. Default ON (launch #88); disable with GHOST_TEXT_ENABLED=0. Gates the /ghost route AND is
// injected into the client (shell()), so front and back never drift — same pattern as AI_EDIT_ENABLED.
const GHOST_TEXT_ENABLED = process.env.GHOST_TEXT_ENABLED !== "0";

// [AI:integration] Diff-approve gate, wired INTO ⌘K (decision #4). The gate is part of the ⌘K flow,
// so it's ON whenever ⌘K is on, with `DIFF_GATE=0` as an escape hatch. Committed default (AI off) ⇒
// gate off ⇒ base behavior byte-identical. Injected into the client (shell()) as __DIFF_GATE_ENABLED.
const DIFF_GATE_ENABLED = AI_EDIT_ENABLED && process.env.DIFF_GATE !== "0";

// [AI:cmdk+model-layer] ⌘K model config is UNIFIED through the provider layer (modelInfo() at the
// /rewrite call-site), the same path /ghost uses — PROVIDER/MODEL env drives both. (Replaced the
// old per-feature CMDK_MODEL const.)

// [AI:cmdk] Output-format contract — passed as the SDK systemPrompt so every ⌘K edit obeys it
// regardless of the per-target instruction. Reworked for the rebuild to HARD-SEPARATE the two
// output formats (HTML block vs prose) and to FRAME ACTION (produce the artifact, never narrate),
// the two failure modes that made the old ⌘K net-negative.
const SYSTEM = `You are an inline editor for ONE note. The user selected a target and gave one instruction. Apply it and output ONLY THE RESULT — the artifact itself, nothing wrapped around it.

ALWAYS
- No preamble, no explanation, no apology, no "Here is", no closing remark, no code fences. If you cannot do exactly what was asked, output your single best attempt at the artifact anyway — NEVER a message about it.
- Edit ONLY the stated target. The rest of the note is context for tone and facts, not something to regenerate or echo back. Keep the target's length and scope unless told otherwise.
- Produce EXACTLY the structure asked for. Table dimensions are ROWS × COLUMNS (rows first): "a 3x4 table" = 3 rows and 4 columns (NOT 4 rows and 3 columns); no empty spacer cells. "3 bullets" = 3 list items.
- Respect the note's theme: never hardcode text or background colors unless explicitly asked; let colors inherit.

OUTPUT FORMAT — the instruction names the target; obey its rule exactly:
- HTML block target -> output PURE HTML only, inline styles only. NEVER markdown: no **bold**, no _italic_, no \`code\`, no |---| pipe tables, no backslash-newline. Prefer the simplest native element (a plain <table>, <ul>, <p>) over heavy wrappers unless asked for something visual; use inline SVG only for a genuine diagram or chart. Every <svg> MUST carry a viewBox AND width="100%" (so it sizes to the note, not a clipped 300x150 default), and any gradient/clip MUST be defined inside its proper wrapper (<linearGradient>/<radialGradient>/<clipPath>) — never bare <stop>s.
- Text (prose) target -> output PLAIN TEXT only: the rewritten words, no markup of any kind (the app owns bold / italic / color / headings). Do not wrap the result in quotes.`;

// AI record/replay cache — for deterministic e2e tests. AI_CACHE=<dir>: hash model+system+
// prompt, replay the cached response if present, else call the model once and save it.
// AI_OFFLINE=1: error on a cache miss instead of calling out (CI with a committed cache).
const AI_CACHE = process.env.AI_CACHE || "";
const AI_OFFLINE = process.env.AI_OFFLINE === "1";
function aiKey(model: string, prompt: string) { return createHash("sha256").update(model + "\n" + SYSTEM + "\n" + prompt).digest("hex").slice(0, 40); }
function aiCacheGet(key: string): string | null { if (!AI_CACHE) return null; try { return readFileSync(join(AI_CACHE, key + ".txt"), "utf8"); } catch { return null; } }
function aiCacheSet(key: string, val: string) { if (!AI_CACHE) return; try { mkdirSync(AI_CACHE, { recursive: true }); writeFileSync(join(AI_CACHE, key + ".txt"), val); } catch {} }
// Stream a one-shot completion through the SELECTED provider (CloudProvider by default —
// subscription auth, no tools). onChunk receives each raw text delta; returns the full
// trimmed text. Honors the AI_CACHE (record/replay) and AI_OFFLINE exactly as before.
// [AI:model-layer] The cache wrapper (key/get/AI_OFFLINE/set/trim) is unchanged — only the
// raw model call is delegated to getProvider().stream(). The provider streams RAW deltas and
// returns UNTRIMMED text; we trim here for the cache + return value, preserving byte-identical
// legacy behavior. With PROVIDER unset the provider is CloudProvider and the key is identical.
async function streamAI(prompt: string, model: string, onChunk: (s: string) => void, provider: ReturnType<typeof getProvider> = getProvider()): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const key = aiKey(model, prompt);
  const cached = aiCacheGet(key);
  if (cached != null) { onChunk(cached); return { ok: true, out: cached }; }
  if (AI_OFFLINE) return { ok: false, error: "ai cache miss (AI_OFFLINE)" };
  const r = await provider.stream(prompt, { system: SYSTEM, model }, onChunk); // [AI:integration] caller picks the provider (per-feature: ⌘K vs ghost)
  if (!r.ok) return r;
  const out = r.out.trim();
  aiCacheSet(key, out);
  return { ok: true, out };
}
import { hasInteractiveScript, buildGhostPrompt, cleanGhostCompletion, stripCodeFence, cleanProseResult } from "./client/lib"; // [AI:ghost+cmdk] ghost prompt/clean + output-format hygiene
import { safeRichHtml } from "./safe-html"; // [AI:cmdk] sanitize that preserves camelCase SVG (extracted; replaces the inline sanitize-html use)

const PORT = Number(process.env.PORT) || 4321;
const ARG = resolve(process.argv[2] ?? "./sample.md");
let ROOT: string;
let LAUNCH_FILE: string | null;
if (existsSync(ARG) && statSync(ARG).isDirectory()) { ROOT = ARG; LAUNCH_FILE = null; }
else { ROOT = dirname(ARG); LAUNCH_FILE = ARG; }
try { ROOT = realpathSync(ROOT); } catch {}
// Every vault opened this session stays live (ROOT is just the latest, for bare "/").
// One global root broke multi-tab use: tab B's "Open folder" repointed the vault and
// tab A's saves started failing 403. Confinement is the union of opened roots.
const ROOTS: string[] = [ROOT];

const NOTE_RE = /\.(md|markdown|html?|htm)$/i;
function escHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)); }

// ---- safety ----
// realpath the deepest EXISTING ancestor so symlinks can't escape the vault
// (handles create/rename targets that don't exist yet).
function realParent(p: string): string {
  let cur = resolve(p);
  while (cur !== dirname(cur)) { try { return realpathSync(cur); } catch { cur = dirname(cur); } }
  return cur;
}
function vaultOf(p: string): string | null { const real = realParent(p); return ROOTS.find((r) => real === r || real.startsWith(r + sep)) ?? null; }
function inVault(p: string): boolean { return vaultOf(p) !== null; }
function okNotePath(p: string): boolean { return inVault(p) && NOTE_RE.test(resolve(p)); }
// Image assets (pasted images live as sidecar files next to the note — local-first).
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const IMG_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };
function okAssetPath(p: string): boolean { return inVault(p) && IMG_RE.test(resolve(p)); }
// Sanitize a user-supplied name into a SINGLE safe path segment: strip path separators and
// control chars, drop leading dots (no hidden/dot-dirs, no `..` traversal). Used by
// /folder-create. (The /create path takes a full pre-built path and relies on inVault confinement
// — there is no segment-sanitizer there to reuse, so this is the project's first one.)
function sanitizeSeg(name: string): string {
  return String(name).replace(/[\\/]/g, "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim();
}
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches may omit Origin entirely
  try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
}
function atomicWrite(p: string, content: string) {
  const tmp = `${p}.tmp${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p); // atomic on same fs — never leaves a half-written note
}
// Turn a raw fs error into an actionable, user-facing message (instead of leaking a stack
// string into a toast). Falls back to the error's message for anything unmapped.
function fsErrMsg(e: any): string {
  switch (e && e.code) {
    case "EACCES": case "EPERM": return "permission denied — check folder permissions";
    case "ENOSPC": return "the disk is full";
    case "ENOTDIR": return "a file already exists where a folder is needed";
    case "EISDIR": return "that name is a folder";
    case "ENAMETOOLONG": return "the name is too long";
    case "EROFS": return "the folder is read-only";
    // Don't leak the absolute vault path (which String(e.message) embeds) — just the code.
    default: return "couldn't complete that operation (" + ((e && e.code) || "error") + ")";
  }
}
function toTrash(p: string) {
  const trash = join(vaultOf(p) ?? ROOT, ".trash"); // trash lives in the note's own vault
  if (!existsSync(trash)) mkdirSync(trash, { recursive: true });
  let dest = join(trash, `${basename(p)}.${Date.now()}`);
  let i = 0; while (existsSync(dest)) dest = join(trash, `${basename(p)}.${Date.now()}.${++i}`);
  renameSync(p, dest); // never clobber an existing trash entry
}
// [AI:cmdk] safeRichHtml + SVG_ATTRS moved to ./safe-html.ts (unit-testable; preserves camelCase SVG).

// ---- client bundle ----
async function bundleClient(): Promise<string> {
  const b = await Bun.build({ entrypoints: ["./client/editor.ts"], target: "browser", minify: true });
  if (!b.success) { console.error("=== CLIENT BUILD FAILED ==="); for (const l of b.logs) console.error(String(l)); return "document.body.innerHTML='<pre style=\"padding:24px;color:#db2777\">client build failed — see server logs</pre>';"; }
  console.log("client bundled ok");
  return await b.outputs[0].text();
}
let EDITOR_JS = await bundleClient();
// Cache-bust the bundle per build so a restart always serves fresh code — the desktop app
// window (its own Chrome profile) and browsers otherwise reuse a stale /editor.js.
let BUILD_ID = Bun.hash(EDITOR_JS).toString(36);

function fmtOf(p: string): string {
  const e = extname(p).toLowerCase();
  if (e === ".md" || e === ".markdown") return "md";
  if (e === ".html" || e === ".htm") return "html";
  return "txt";
}
type NoteFile = { name: string; path: string; rel: string; fmt: string; mtime: number };
// One walk yields both the note FILES (with mtime, epoch ms) and EVERY directory under the tree
// (rel paths, incl. empty ones) so the client can show empty folders. Dot-dirs (.trash/.git/
// .obsidian/…) and node_modules are skipped — never descended, never listed. Same depth(4)/
// file-cap(800) guards as before.
function listTree(dir: string): { files: NoteFile[]; dirs: string[] } {
  const root = resolve(dir);
  const files: NoteFile[] = [];
  const dirs: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || files.length > 800) return;
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const full = `${d}/${e}`;
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { dirs.push(full.slice(root.length + 1)); walk(full, depth + 1); }
      else if (NOTE_RE.test(e)) files.push({ name: e, path: full, rel: full.slice(root.length + 1), fmt: fmtOf(e), mtime: Math.round(st.mtimeMs) });
    }
  };
  walk(root, 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  dirs.sort((a, b) => a.localeCompare(b));
  return { files, dirs };
}
function listNotes(dir: string): NoteFile[] { return listTree(dir).files; }
function firstNote(): string | null { const f = listNotes(ROOT); return f.length ? f[0].path : null; }

function styles(): string {
  return `
  :root{--bg:#fbfbfa;--surface:#fff;--text:#1c1c1e;--muted:#76767e;--subtle:#a3a3ad;--border:#ececec;--border-strong:#deded3;
    --accent:#6d5cf0;--accent-ink:#5a49d6;--accent-tint:rgba(109,92,240,.10);--accent-line:rgba(109,92,240,.55);
    --win:#1a9d63;--warn:#c2790a;--risk:#d6336c;--code-bg:#f3f3f1;--code-ink:#5a49d6}
  @media(prefers-color-scheme:dark){:root{--bg:#0e0e11;--surface:#16161a;--text:#ececef;--muted:#9a9aa6;--subtle:#6b6b78;--border:#26262c;--border-strong:#34343c;
    --accent:#a99bff;--accent-ink:#bcb1ff;--accent-tint:rgba(169,155,255,.14);--accent-line:rgba(169,155,255,.6);
    --win:#34c98a;--warn:#e0a64a;--risk:#ff6b9d;--code-bg:#1d1d23;--code-ink:#bcb1ff}}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
  .bar{position:sticky;top:0;display:flex;align-items:center;gap:12px;padding:9px 18px;background:var(--surface);border-bottom:1px solid var(--border);z-index:6;font-size:13px}
  .bar .title{font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46ch}
  .bar .badge{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:1px 6px}
  .bar .spacer{flex:1}
  .bar .status{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px}
  .bar .status .dot{width:7px;height:7px;border-radius:50%;background:var(--subtle)}
  .bar .status.saved .dot{background:var(--win)}.bar .status.saving .dot{background:var(--warn)}.bar .status.dirty .dot{background:var(--subtle)}.bar .status.error{color:var(--risk)}.bar .status.error .dot{background:var(--risk)}
  .bar .chip{font-size:12px;color:var(--muted);border:1px solid var(--border);background:transparent;border-radius:6px;padding:4px 10px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
  .bar .chip:hover{border-color:var(--border-strong);color:var(--text)}
  .bar .chip kbd{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--accent-ink);background:var(--accent-tint);border-radius:3px;padding:0 4px}
  .bar .seg{display:inline-flex;border:1px solid var(--border);border-radius:7px;overflow:hidden}
  .bar .seg button{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:none;padding:4px 11px;cursor:pointer;line-height:1.5}
  .bar .seg button:hover{color:var(--text)}
  .bar .seg button.on{background:var(--accent);color:#fff}
  .bar .chip[hidden]{display:none}
  /* INTERACT mode: the doc's own code runs in a sandboxed iframe filling the note pane.
     Height is derived from the bar's REAL measured height (--bar-h, set by the client) — not a
     magic 40px — so the sticky bar never overlaps the iframe (F34). The iframe surface uses the
     app background (F30) so an unstyled doc reads as a themed pane, not a bare white slab. */
  .interact-view{height:calc(100vh - var(--bar-h, 40px))}
  .interact-view iframe{width:100%;height:100%;border:0;display:block;background:var(--bg)}
  .interact-note{position:fixed;bottom:14px;right:16px;z-index:8;font-size:11px;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:5px 10px;display:flex;align-items:center;gap:7px;box-shadow:0 4px 14px rgba(0,0,0,.1)}
  .interact-note .dot{width:7px;height:7px;border-radius:50%;background:var(--win);flex:none}
  .layout{display:flex;align-items:flex-start}
  .sidebar{width:256px;flex:none;border-right:1px solid var(--border);height:calc(100vh - var(--bar-h, 40px));overflow:auto;padding:10px 8px;position:sticky;top:var(--bar-h, 40px)}
  .sidebar .vault{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;font:inherit;font-size:12px;font-weight:600;color:var(--muted);background:transparent;border:none;padding:5px 8px;border-radius:7px;cursor:pointer;text-align:left}
  .sidebar .vault:hover{background:var(--accent-tint);color:var(--text)}
  .sidebar .vault .vcaret{opacity:.5;font-size:11px;flex:none}
  .sidebar .vault .vname{overflow:hidden;text-overflow:ellipsis}
  .sidebar .filter{width:100%;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;padding:6px 9px;font:inherit;font-size:12.5px;margin:6px 0 8px;outline:none}
  .sidebar .filter:focus{border-color:var(--accent-line)}
  .sidebar .new{display:flex;align-items:center;gap:7px;width:100%;text-align:left;font:inherit;font-size:13px;color:var(--muted);background:transparent;border:1px dashed var(--border-strong);border-radius:7px;padding:7px 10px;margin-bottom:8px;cursor:pointer}
  .sidebar .new:hover{color:var(--accent-ink);border-color:var(--accent-line)}
  .sidebar .new-row{display:flex;gap:6px}
  .sidebar .new-row .new{justify-content:center;margin-bottom:8px}
  .note-link{position:relative;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);text-decoration:none;padding:6px 10px;border-radius:7px;white-space:nowrap;overflow:hidden;cursor:pointer}
  .note-link .nm{overflow:hidden;text-overflow:ellipsis}
  .note-link .gl{font-size:11px;color:var(--subtle);flex:none}
  .note-link:hover{background:var(--accent-tint)}
  .note-link.active{background:var(--accent-tint);color:var(--text);font-weight:500}
  .note-link.active::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:3px;background:var(--accent)}
  .note-link .row-act{margin-left:auto;display:none;gap:2px}
  .note-link:hover .row-act{display:inline-flex}
  .note-link .row-act button{font:inherit;font-size:11px;color:var(--subtle);background:transparent;border:none;cursor:pointer;padding:1px 4px;border-radius:4px}
  .note-link .row-act button:hover{color:var(--text);background:var(--surface)}
  .folder-row{position:relative;display:flex;align-items:center;gap:5px;font-size:12.5px;color:var(--muted);padding:5px 10px;border-radius:7px;white-space:nowrap;overflow:hidden;cursor:pointer;user-select:none}
  .folder-row:hover{background:var(--accent-tint);color:var(--text)}
  .folder-row .fcaret{font-size:9px;color:var(--subtle);flex:none;width:9px;text-align:center;transition:transform .12s}
  .folder-row .ficon{font-size:11px;flex:none}
  .folder-row .fname{overflow:hidden;text-overflow:ellipsis;font-weight:500}
  .folder-row .fcount{margin-left:6px;font-size:10.5px;color:var(--subtle);flex:none}
  .folder-row .row-act{margin-left:auto;display:none;gap:2px}
  .folder-row:hover .row-act{display:inline-flex}
  .folder-row .row-act button{font:inherit;font-size:11px;color:var(--subtle);background:transparent;border:none;cursor:pointer;padding:1px 4px;border-radius:4px}
  .folder-row .row-act button:hover{color:var(--text);background:var(--surface)}
  .note-empty{font-size:12px;color:var(--subtle);padding:8px 10px;font-style:italic}
  /* F24: the note pane fills at least the viewport below the bar, so a short/dark
     note's own background (set on .main by F6) covers the whole pane — no app-gray strip.
     Bar height comes from the measured --bar-h var (F34) so it stays exact at any bar size. */
  .main{flex:1;min-width:0;min-height:calc(100vh - var(--bar-h, 40px))}
  .doc{max-width:760px;margin:0 auto;padding:40px 32px 22vh}
  .doc.own-frame{max-width:none;padding:0 0 22vh} /* self-framing doc: its own CSS rules the page frame */
  /* F39: the page frame lived on the stripped <main>/<article> container (e.g. <main class="wrap"> max-width+margin:auto), so the
     editable content has no wrapper of its own — re-cap+center the column at the container's width so it centers like the browser.
     Beats both .doc{max-width:760} and a scoped body{margin:0} (which would otherwise pin it hard-left) via the two-class selector. */
  .doc.own-frame-cap{max-width:var(--frame-cap,900px);margin-left:auto;margin-right:auto}
  .stale-bar{position:fixed;top:0;left:0;right:0;z-index:9999;background:#d97706;color:#fff;font-size:13.5px;font-weight:600;text-align:center;padding:8px 12px}
  .stale-bar button{font:inherit;margin-left:10px;border:none;border-radius:6px;background:#fff;color:#92400e;padding:3px 12px;cursor:pointer}
  .ProseMirror{outline:none;min-height:60vh}
  .ProseMirror .is-empty::before{content:attr(data-placeholder);color:var(--subtle);float:left;height:0;pointer-events:none}
  /* to-dos */
  .ProseMirror ul[data-type="taskList"]{list-style:none;margin:0 0 14px;padding:0}
  .ProseMirror ul[data-type="taskList"] li{display:flex;align-items:flex-start;gap:9px;margin-bottom:5px}
  .ProseMirror ul[data-type="taskList"] li>label{flex:none;margin-top:3px;user-select:none}
  .ProseMirror ul[data-type="taskList"] li>div{flex:1 1 auto;min-width:0}
  .ProseMirror ul[data-type="taskList"] li>div>p{margin:0}
  .ProseMirror ul[data-type="taskList"] input[type=checkbox]{appearance:none;-webkit-appearance:none;width:16px;height:16px;border:1.5px solid var(--border-strong);border-radius:4px;cursor:pointer;position:relative;background:var(--surface);transition:background .12s,border-color .12s}
  .ProseMirror ul[data-type="taskList"] input[type=checkbox]:checked{background:var(--accent);border-color:var(--accent)}
  .ProseMirror ul[data-type="taskList"] input[type=checkbox]:checked::after{content:"✓";position:absolute;inset:0;color:#fff;font-size:11px;line-height:13px;text-align:center;font-weight:700}
  .ProseMirror ul[data-type="taskList"] li[data-checked="true"]>div{color:var(--muted);text-decoration:line-through}
  /* callouts */
  .ProseMirror .callout{display:flex;gap:11px;margin:16px 0;padding:13px 15px;border-radius:9px;border:1px solid var(--border);background:var(--surface)}
  .ProseMirror .callout-icon{flex:none;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;background:var(--accent)}
  .ProseMirror .callout-body{flex:1 1 auto;min-width:0}.ProseMirror .callout-body>*{margin-bottom:6px}.ProseMirror .callout-body>*:last-child{margin-bottom:0}
  .ProseMirror .callout-info{border-color:var(--accent-line);background:var(--accent-tint)}.ProseMirror .callout-info .callout-icon{background:var(--accent)}
  .ProseMirror .callout-tip{border-color:rgba(26,157,99,.4);background:rgba(26,157,99,.08)}.ProseMirror .callout-tip .callout-icon{background:var(--win)}
  .ProseMirror .callout-warn{border-color:rgba(194,121,10,.4);background:rgba(194,121,10,.08)}.ProseMirror .callout-warn .callout-icon{background:var(--warn)}
  /* tables */
  .ProseMirror table{border-collapse:collapse;margin:14px 0;width:100%;table-layout:fixed;overflow:hidden}
  .ProseMirror table td,.ProseMirror table th{border:1px solid var(--border-strong);padding:7px 10px;vertical-align:top;position:relative;min-width:60px}
  .ProseMirror table th{background:var(--code-bg);font-weight:600;text-align:left}
  .ProseMirror table td>p,.ProseMirror table th>p{margin:0}
  .ProseMirror table .selectedCell::after{content:"";position:absolute;inset:0;background:var(--accent-tint);pointer-events:none}
  .ProseMirror table .column-resize-handle{position:absolute;right:-2px;top:0;bottom:0;width:4px;background:var(--accent);cursor:col-resize}
  .ProseMirror .tableWrapper{overflow-x:auto}
  .ProseMirror h1{font-size:30px;letter-spacing:-.021em;margin:0 0 16px}.ProseMirror h2{font-size:21px;letter-spacing:-.012em;margin:28px 0 10px}.ProseMirror h3{font-size:17px;margin:22px 0 8px}
  .ProseMirror p{margin:0 0 14px}.ProseMirror ul,.ProseMirror ol{margin:0 0 14px 22px}.ProseMirror li{margin-bottom:4px}.ProseMirror li>p{margin:0}
  .ProseMirror a{color:var(--accent-ink);text-underline-offset:2px}
  .ProseMirror code{font-family:ui-monospace,Menlo,monospace;font-size:.88em;background:var(--code-bg);color:var(--code-ink);padding:1px 5px;border-radius:4px}
  .ProseMirror pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:14px;overflow:auto}.ProseMirror pre code{background:none;color:inherit;padding:0}
  /* Fidelity: a styled html note's own design wins — the app's code/pre theme (purple ink etc.)
     is for md/unstyled notes and must not paint over a doc that styles these itself. The
     note-scoped sheet is appended after this one, so the doc's own rules re-cover these. */
  .note-scope code{font-family:monospace;font-size:inherit;background:none;color:inherit;padding:0;border-radius:0}
  .note-scope pre{background:none;border:none;border-radius:0;padding:0}
  .ProseMirror blockquote{border-left:3px solid var(--border-strong);margin:0 0 14px;padding-left:14px;color:var(--muted)}
  .ProseMirror>*:first-child{margin-top:0}
  /* editable styled boxes ((b)): keep ProseMirror's paragraph margins from blowing out tight designs */
  .ProseMirror [data-sbox] p{margin:0}
  .ProseMirror [data-sbox]{position:relative}
  /* native image node (paste support) */
  .ProseMirror img.note-img{display:block;max-width:100%;height:auto;border-radius:8px;margin:14px 0}
  .ProseMirror img.note-img.ProseMirror-selectednode,.ProseMirror .ProseMirror-selectednode img.note-img{outline:2px solid var(--accent);outline-offset:3px}
  .ProseMirror .note-img-wrap{position:relative;display:inline-block;max-width:100%}
  .ProseMirror .note-img-handle{position:absolute;right:-7px;bottom:7px;width:15px;height:15px;border-radius:4px;background:var(--accent);border:2px solid var(--surface);cursor:nwse-resize;opacity:0;transition:opacity .12s}
  .ProseMirror .note-img-wrap:hover .note-img-handle,.ProseMirror .note-img-wrap.ProseMirror-selectednode .note-img-handle,.ProseMirror .note-img-wrap.resizing .note-img-handle{opacity:1}
  .ProseMirror .rich-block{margin:16px 0;border-radius:8px;position:relative}
  .ProseMirror .rich-block.ProseMirror-selectednode{outline:2px solid var(--accent);outline-offset:4px}
  .ProseMirror .rich-block::after{content:"rich block · ⌘K to edit";position:absolute;top:-9px;right:8px;font-family:ui-monospace,Menlo,monospace;font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:var(--bg);padding:1px 6px;border-radius:3px;opacity:0;transition:opacity .12s}
  .ProseMirror .rich-block[data-leaf-editable]::after{content:"frozen block · double-click text to edit · ⌘K"}
  .ProseMirror .rich-block[data-svg-editable]::after{content:"svg · double-click text to edit · ⌘K"}
  .ProseMirror .rich-block[data-svg-editable][data-leaf-editable]::after{content:"frozen block · double-click any text to edit · ⌘K"}
  .ProseMirror .rich-block:hover::after{opacity:1}
  .ProseMirror .app-block{margin:18px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--surface)}
  .ProseMirror .app-block.ProseMirror-selectednode{outline:2px solid var(--accent);outline-offset:3px}
  .app-head{display:flex;align-items:center;justify-content:space-between;padding:9px 13px;font-size:12px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border)}
  .app-head .lhs{display:flex;align-items:center;gap:8px}
  .app-head .live{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--win)}
  .app-head .live .dot{width:6px;height:6px;border-radius:50%;background:var(--win)}
  .app-btn{font:inherit;font-size:11px;color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:6px;padding:3px 9px;cursor:pointer}.app-btn:hover{color:var(--text);border-color:var(--border-strong)}
  .app-block iframe{display:block}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;transition:opacity .15s,transform .15s;color:#fff;font-size:12.5px;padding:8px 15px;border-radius:8px;pointer-events:none;z-index:40;box-shadow:0 6px 20px rgba(0,0,0,.16)}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .cmdk{position:absolute;display:none;width:380px;background:var(--surface);border:1px solid var(--accent-line);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.22);padding:9px;z-index:50}
  .cmdk.show{display:block}
  .cmdk input{width:100%;border:none;outline:none;background:transparent;color:var(--text);font-size:14px;padding:6px}
  .cmdk-hint{font-size:11.5px;color:var(--muted);padding:3px 6px 1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .slash{position:absolute;width:256px;max-height:320px;overflow:auto;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.22);padding:6px;z-index:52}
  .slash-group{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle);padding:7px 9px 3px}
  .slash-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:13.5px}
  .slash-item .t{flex:1}
  .slash-item .k{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--accent-ink);background:var(--accent-tint);border-radius:3px;padding:0 5px}
  .slash-item.sel{background:var(--accent-tint)}
  .slash-empty{padding:10px 12px;font-size:12.5px;color:var(--muted)}
  .bubble{position:absolute;display:none;align-items:center;gap:2px;background:var(--text);border-radius:9px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.28);z-index:54}
  .bubble.show{display:flex}
  .bubble button{font:inherit;font-size:13px;color:#fff;background:transparent;border:none;border-radius:6px;padding:5px 9px;cursor:pointer;line-height:1;display:flex;align-items:center}
  @media(prefers-color-scheme:dark){.bubble{background:#26262c;border:1px solid var(--border-strong)}}
  .bubble button:hover{background:rgba(255,255,255,.14)}
  .bubble button.on{background:rgba(255,255,255,.22)}
  .bubble button.accent{color:var(--accent);font-weight:600}
  .bubble .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
  .bubble .bsep{width:1px;align-self:stretch;background:rgba(255,255,255,.22);margin:2px 3px}
  .bubble .cswatch{display:inline-flex;align-items:center;justify-content:center;padding:5px 7px;cursor:pointer;border-radius:6px}
  .bubble .cswatch:hover{background:rgba(255,255,255,.14)}
  .bubble .cswatch input[type=color]{width:15px;height:15px;border:none;border-radius:4px;background:none;padding:0;cursor:pointer}
  .bubble .cswatch input[type=color]::-webkit-color-swatch-wrapper{padding:0}
  .bubble .cswatch input[type=color]::-webkit-color-swatch{border:1px solid rgba(255,255,255,.4);border-radius:4px}
  .bubble [data-a="hilite"] .hl{background:#fde047;color:#1c1c1e;font-weight:700;border-radius:3px;padding:0 4px;font-size:11px}
  .switcher{position:fixed;inset:0;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.28);z-index:60}
  .switcher.show{display:flex}
  .switcher .box{margin-top:12vh;width:min(560px,92vw);background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden}
  .switcher input{width:100%;border:none;outline:none;background:transparent;color:var(--text);font-size:16px;padding:15px 18px;border-bottom:1px solid var(--border)}
  .switcher .results{max-height:50vh;overflow:auto;padding:6px}
  .switcher .res{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:14px}
  .switcher .res .gl{font-size:12px;color:var(--subtle)}
  .switcher .res .pth{margin-left:auto;font-size:11px;color:var(--subtle)}
  .switcher .res.sel,.switcher .res:hover{background:var(--accent-tint)}
  .onboard{max-width:520px;margin:14vh auto;text-align:center;padding:0 24px}
  .onboard h1{font-size:26px;letter-spacing:-.02em;margin-bottom:10px}
  .onboard p{color:var(--muted);margin-bottom:20px}
  .onboard .notice{text-align:left;font-size:13.5px;background:color-mix(in srgb,#dc2626 9%,var(--surface));border:1px solid color-mix(in srgb,#dc2626 35%,transparent);border-radius:8px;padding:10px 14px;margin-bottom:26px;word-break:break-all}
  .onboard .actions{display:flex;gap:10px;justify-content:center}
  .onboard button{font:inherit;font-size:14px;border-radius:8px;padding:9px 16px;cursor:pointer;border:1px solid var(--border-strong);background:var(--surface);color:var(--text)}
  .onboard button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  /* [AI:firstrun] "connect your Claude / point at Ollama" banner — a dismissible strip under the
     toolbar, shown only when an AI feature is enabled but its provider isn't reachable. Amber (a
     to-do, not an error) so it reads as setup guidance, not a failure. */
  .ai-connect{display:flex;align-items:flex-start;gap:10px;padding:10px 16px;font-size:13px;line-height:1.5;background:color-mix(in srgb,#f59e0b 12%,var(--surface));border-bottom:1px solid color-mix(in srgb,#f59e0b 40%,transparent);color:var(--text)}
  .ai-connect .ic{flex:none;font-size:15px;line-height:1.4}
  .ai-connect .msg{flex:1;min-width:0}
  .ai-connect .msg b{font-weight:600}
  .ai-connect code{font-family:ui-monospace,Menlo,monospace;font-size:.86em;background:color-mix(in srgb,#f59e0b 20%,var(--surface));border-radius:4px;padding:1px 5px}
  .ai-connect .x{flex:none;font:inherit;font-size:16px;line-height:1;color:var(--muted);background:transparent;border:none;cursor:pointer;padding:2px 4px;border-radius:5px}
  .ai-connect .x:hover{color:var(--text);background:color-mix(in srgb,#f59e0b 18%,transparent)}`;
}

function shell(note: { file: string; format: string; content: string } | null, openError: string | null = null): string {
  const title = escHtml(note ? basename(note.file).replace(NOTE_RE, "") : "note-editor");
  // F31: the Interact toggle is only meaningful when the doc actually has executable JS to run
  // — a styled-but-static doc (no <script>) has nothing to interact with. Gate on the raw bytes
  // here (single source of truth) and pass the flag to the client via __NOTE__.interactive so
  // ⌘E and the toggle markup never drift.
  const interactive = !!(note && note.format === "html" && hasInteractiveScript(note.content));
  // a tab's vault is the one CONTAINING its note, not the latest-opened global
  const json = note ? JSON.stringify({ ...note, interactive, root: vaultOf(note.file) ?? ROOT }).replace(/</g, "\\u003c") : `{"root":${JSON.stringify(ROOT).replace(/</g, "\\u003c")}}`;
  // INTERACT toggle: EDIT = the JS-free ProseMirror editor; INTERACT runs the doc's OWN code in
  // a sandboxed iframe. Shown only for docs that contain interactive JS (F31). When absent we
  // HIDE it (simplest, default). Seam for the alternative — disable + tooltip "nothing to
  // interact with" — kept here intentionally (taste call, see report): to switch, render the
  // <div class="seg"> always and add `disabled title="Nothing to interact with"` on the Interact
  // <button> + a `.seg button:disabled` style, instead of returning "".
  const modeSeg = interactive
    ? `<div class="seg" id="modeseg" role="group" aria-label="View mode"><button data-mode="edit" class="on" title="Edit — fluid editor (⌘E)">Edit</button><button data-mode="interact" title="Interact — run this doc’s own code, sandboxed (⌘E)">Interact</button></div>`
    : "";
  const body = note
    ? `<div class="bar"><span class="title" id="title">${title}</span><span class="badge">${note.format}</span>${modeSeg}<span class="spacer"></span><span class="status dirty" id="savestatus"><span class="dot"></span><span class="lbl">—</span></span>${AI_EDIT_ENABLED ? '<button class="chip" id="askchip"><kbd>⌘K</kbd> AI edit</button>' : ""}<button class="chip" id="insertchip">+ Insert</button></div>
  <div class="layout"><aside class="sidebar" id="sidebar"></aside><main class="main"><div id="editor" class="doc"></div></main></div>`
    : `<div class="onboard">${openError ? `<div class="notice">⚠️ ${escHtml(openError)}</div>` : ""}<h1>Your notes, in HTML, with AI.</h1><p>Open a folder of markdown or HTML notes, or create your first one. Everything stays local, in your own files.</p><div class="actions"><button class="primary" id="ob-open">Open folder…</button><button id="ob-new">New note</button></div></div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${styles()}</style></head>
<body>
  ${body}
  <script>window.__NOTE__=${json};window.__AI_EDIT_ENABLED=${AI_EDIT_ENABLED};window.__GHOST_TEXT_ENABLED=${GHOST_TEXT_ENABLED};window.__DIFF_GATE_ENABLED=${DIFF_GATE_ENABLED};
  // This app uses no service worker. If a stale one (e.g. from a prior project on this port)
  // is registered on this origin it will intercept /editor.js and serve old code, immune to
  // refresh. Unregister any SW + drop its caches so the next load is always the fresh bundle.
  if(navigator.serviceWorker)navigator.serviceWorker.getRegistrations().then(rs=>{if(rs.length){Promise.all(rs.map(r=>r.unregister())).then(()=>{if(window.caches)caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>location.reload());else location.reload();});}});</script>
  <script type="module" src="/editor.js?v=${BUILD_ID}"></script>
</body></html>`;
}

function json(data: unknown, status = 200) { return Response.json(data as any, { status }); }

// [AI:firstrun] First-run connection state. Cheaply probes (no inference / token spend) whether the
// provider EACH ENABLED AI feature routes to is actually reachable — a logged-in Claude subscription
// session (Agent SDK OAuth, no API key) or a running local Ollama daemon. The client polls this on
// load to decide whether to show the "connect your Claude / point at Ollama" banner. When AI is
// disabled entirely (the committed default) there is nothing to connect, so `anyEnabled` is false and
// the client shows nothing. When a provider IS connected the banner stays invisible. Probes are only
// run for ENABLED features and are de-duped by provider so we never probe the same daemon twice.
async function aiStatus() {
  const rewrite = modelInfo("rewrite");
  const ghost = modelInfo("ghost");
  const cache = new Map<string, Promise<{ connected: boolean; detail: string; hint?: string }>>();
  const probe = (name: string) => {
    if (!cache.has(name)) cache.set(name, Promise.resolve(getProvider(name).probe?.() ?? { connected: true, detail: name + ": no probe (assumed ok)" }));
    return cache.get(name)!;
  };
  const rwProbe = AI_EDIT_ENABLED ? await probe(rewrite.provider) : null;
  const ghProbe = GHOST_TEXT_ENABLED ? await probe(ghost.provider) : null;
  const relevant = [rwProbe, ghProbe].filter(Boolean) as { connected: boolean; hint?: string }[];
  const notConnected = relevant.filter((p) => !p.connected);
  return {
    anyEnabled: AI_EDIT_ENABLED || GHOST_TEXT_ENABLED,
    aiEditEnabled: AI_EDIT_ENABLED,
    ghostEnabled: GHOST_TEXT_ENABLED,
    // connected = every ENABLED feature's provider is reachable (vacuously true when none enabled)
    connected: relevant.every((p) => p.connected),
    rewrite: { ...rewrite, ...(rwProbe ?? {}) },
    ghost: { ...ghost, ...(ghProbe ?? {}) },
    // one actionable next step (first not-connected provider's hint) for the banner
    hint: notConnected[0]?.hint ?? null,
  };
}

Bun.serve({
  port: PORT,
  // [AI:cmdk] Bun's default idleTimeout is 10s — it KILLED streaming /rewrite responses on a cold
  // model start (first token > 10s with no bytes yet), surfacing to the user as a bare "failed:
  // empty". Raise it to Bun's max (255s) so slow/cold model streams (and /ghost later) survive; once
  // tokens flow, each chunk resets the idle clock, so steady streaming never trips it. Fast routes
  // (save/list) are unaffected. (0 would fully disable it; a finite cap still reaps dead sockets.)
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/editor.js") return new Response(EDITOR_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });

    // Serve a vault image (the editor displays a note's relative <img src> through here —
    // saved files keep their portable relative paths). Images only, vault-confined.
    if (url.pathname === "/raw") {
      const p = resolve(url.searchParams.get("file") || "");
      if (!okAssetPath(p) || !existsSync(p) || !statSync(p).isFile()) return new Response("not found", { status: 404 });
      const mime = IMG_MIME[extname(p).slice(1).toLowerCase()] || "application/octet-stream";
      return new Response(Bun.file(p), { headers: { "content-type": mime } });
    }

    if (req.method === "POST") {
      if (!sameOrigin(req)) return json({ ok: false, error: "bad origin" }, 403);
      const body: any = await req.json().catch(() => ({}));
      if (url.pathname === "/save") {
        const p = resolve(String(body.file || ""));
        if (!okNotePath(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(p)) return json({ ok: false, error: "no such note (use create)" }, 404);
        try { atomicWrite(p, String(body.content ?? "")); return json({ ok: true }); } catch (e) { return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      if (url.pathname === "/create") {
        const p = resolve(String(body.file || ""));
        if (!okNotePath(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (existsSync(p)) return json({ ok: false, error: "a note with that name already exists" });
        // mkdir the parent so a note can be created in a brand-new (sub)folder. The parent must
        // ITSELF be in-vault — realParent() realpaths the deepest existing ancestor, so a
        // recursive mkdir can only ever materialize dirs UNDER an in-vault ancestor (no escape).
        const parent = dirname(p);
        if (!inVault(parent)) return json({ ok: false, error: "path not allowed" }, 403);
        // mkdirSync(recursive) returns the FIRST dir it created (or undefined). If the write then
        // fails, roll those new dirs back so a failed/abusive create can't accumulate empty dirs.
        let made: string | undefined;
        try { made = mkdirSync(parent, { recursive: true }); atomicWrite(p, String(body.content ?? "")); return json({ ok: true, path: p }); }
        catch (e) { if (made) try { rmSync(made, { recursive: true, force: true }); } catch {} return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      if (url.pathname === "/rename") {
        const a = resolve(String(body.from || "")), b = resolve(String(body.to || ""));
        if (!okNotePath(a) || !okNotePath(b)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(a)) return json({ ok: false, error: "the note no longer exists" });
        if (existsSync(b)) return json({ ok: false, error: "a note with that name already exists" });
        // Allow rename to MOVE into a (possibly new) folder — mkdir the destination parent, same
        // in-vault guarantee as /create above.
        const parent = dirname(b);
        if (!inVault(parent)) return json({ ok: false, error: "path not allowed" }, 403);
        let made: string | undefined;
        try { made = mkdirSync(parent, { recursive: true }); renameSync(a, b); return json({ ok: true, path: b }); }
        catch (e) { if (made) try { rmSync(made, { recursive: true, force: true }); } catch {} return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      if (url.pathname === "/delete") {
        const p = resolve(String(body.file || ""));
        if (!okNotePath(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(p)) return json({ ok: false, error: "the note no longer exists" });
        try { toTrash(p); return json({ ok: true }); } catch (e) { return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      // Move a FILE or a FOLDER to a new location (backs drag-drop + rename). Dir-aware: a moved
      // file must stay a note (NOTE_RE), a moved folder can be anything. No-clobber; mkdir the
      // destination parent (same in-vault guarantee as /create — realParent confines the mkdir).
      if (url.pathname === "/move") {
        const a = resolve(String(body.from || "")), b = resolve(String(body.to || ""));
        if (!inVault(a) || !inVault(b)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(a)) return json({ ok: false, error: "the item no longer exists" });
        if (existsSync(b)) return json({ ok: false, error: "a file or folder with that name already exists" });
        let st; try { st = statSync(a); } catch { return json({ ok: false, error: "the item no longer exists" }); }
        if (!st.isDirectory() && !NOTE_RE.test(b)) return json({ ok: false, error: "path not allowed" }, 403);
        const parent = dirname(b);
        if (!inVault(parent)) return json({ ok: false, error: "path not allowed" }, 403);
        let made: string | undefined;
        try { made = mkdirSync(parent, { recursive: true }); renameSync(a, b); return json({ ok: true, path: b }); }
        catch (e) { if (made) try { rmSync(made, { recursive: true, force: true }); } catch {} return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      // Create an empty directory dir/name. Sanitize name to a single safe segment; no-clobber.
      if (url.pathname === "/folder-create") {
        const parent = resolve(String(body.dir || ""));
        if (!inVault(parent)) return json({ ok: false, error: "path not allowed" }, 403);
        const name = sanitizeSeg(String(body.name || ""));
        if (!name) return json({ ok: false, error: "enter a folder name" });
        const p = join(parent, name);
        if (!inVault(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (existsSync(p)) return json({ ok: false, error: "a folder with that name already exists" });
        try { mkdirSync(p, { recursive: true }); return json({ ok: true, path: p }); }
        catch (e) { return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      // Move a WHOLE folder (recursively, as-is) into the vault's .trash, timestamped — same
      // semantics as toTrash() for a note. renameSync is an atomic move of the dir. Guards: must
      // be an in-vault directory, never the vault root itself, never .trash.
      if (url.pathname === "/folder-delete") {
        const p = resolve(String(body.folder || ""));
        if (!inVault(p)) return json({ ok: false, error: "path not allowed" }, 403);
        let st; try { st = statSync(p); } catch { return json({ ok: false, error: "the folder no longer exists" }); }
        if (!st.isDirectory()) return json({ ok: false, error: "not a folder" });
        const vault = vaultOf(p) ?? ROOT;
        if (realParent(p) === vault) return json({ ok: false, error: "can't delete the vault root" }, 403);
        if (basename(p) === ".trash") return json({ ok: false, error: "path not allowed" }, 403);
        try { toTrash(p); return json({ ok: true }); } catch (e) { return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      // Duplicate a note → <base>-copy.<ext>, incrementing -copy-2, -copy-3 on collision. Byte-for-
      // byte copy (copyFileSync), so content is preserved exactly.
      if (url.pathname === "/duplicate") {
        const p = resolve(String(body.file || ""));
        if (!okNotePath(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(p) || !statSync(p).isFile()) return json({ ok: false, error: "the note no longer exists" });
        const ext = extname(p);                     // includes the dot (".md")
        const base = p.slice(0, p.length - ext.length);
        let dest = `${base}-copy${ext}`, i = 1;
        while (existsSync(dest)) dest = `${base}-copy-${++i}${ext}`;
        try { copyFileSync(p, dest); return json({ ok: true, path: dest }); }
        catch (e) { return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      // Restore a .trash entry to the vault ROOT under its origName (strip the .<ts>). No-clobber:
      // if the name is taken, restore alongside as <base>-restored.<ext> (then -restored-2). path
      // MUST be a direct child of this vault's .trash (path-safety) before we move it.
      if (url.pathname === "/restore") {
        const p = resolve(String(body.path || ""));
        if (!inVault(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(p)) return json({ ok: false, error: "that item is no longer in the trash" });
        const vault = vaultOf(p) ?? ROOT;
        let parentReal: string, trashReal: string;
        try { parentReal = realpathSync(dirname(p)); } catch { return json({ ok: false, error: "path not allowed" }, 403); }
        try { trashReal = realpathSync(join(vault, ".trash")); } catch { return json({ ok: false, error: "path not allowed" }, 403); }
        if (parentReal !== trashReal) return json({ ok: false, error: "not a trash item" }, 403);
        const m = basename(p).match(/^(.+)\.(\d{10,})(?:\.\d+)?$/);
        const origName = m ? m[1] : basename(p);
        let dest = join(vault, origName);
        if (existsSync(dest)) {                       // origin name is taken — restore alongside
          const ext = extname(origName), base = origName.slice(0, origName.length - ext.length);
          dest = join(vault, `${base}-restored${ext}`);
          let i = 1; while (existsSync(dest)) dest = join(vault, `${base}-restored-${++i}${ext}`);
        }
        try { renameSync(p, dest); return json({ ok: true, path: dest }); }
        catch (e) { return json({ ok: false, error: fsErrMsg(e) }, 500); }
      }
      if (url.pathname === "/asset") {
        // Save a pasted image as a sidecar file: <note-dir>/assets/img-<stamp>.<ext>.
        // Server generates the filename (no user input in the path) and returns the
        // note-relative src so the saved note stays portable.
        const note = resolve(String(body.note || ""));
        if (!okNotePath(note) || !existsSync(note)) return json({ ok: false, error: "bad note" }, 403);
        const ext = String(body.ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!IMG_MIME[ext]) return json({ ok: false, error: "unsupported image type" }, 400);
        const b64 = String(body.data || "");
        if (b64.length > 28_000_000) return json({ ok: false, error: "image too large (>20MB)" }, 413); // ~20MB binary
        let buf: Buffer; try { buf = Buffer.from(b64, "base64"); } catch { return json({ ok: false, error: "bad data" }, 400); }
        if (!buf.length) return json({ ok: false, error: "empty image" }, 400);
        const dir = join(dirname(note), "assets");
        const name = "img-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 7) + "." + ext;
        const abs = join(dir, name);
        if (!okAssetPath(abs)) return json({ ok: false, error: "path not allowed" }, 403);
        try { mkdirSync(dir, { recursive: true }); writeFileSync(abs + ".tmp", buf); renameSync(abs + ".tmp", abs); } catch (e) { return json({ ok: false, error: String(e) }, 500); }
        return json({ ok: true, src: "assets/" + name, abs });
      }
      if (url.pathname === "/pick-folder") {
        // native macOS folder picker (used by the desktop app / browser). Cancel → cancelled.
        try {
          const proc = Bun.spawn(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose your vault folder")'], { stdout: "pipe", stderr: "pipe" });
          const out = (await new Response(proc.stdout).text()).trim();
          const code = await proc.exited;
          if (code !== 0) return json({ ok: false, cancelled: true });
          return out ? json({ ok: true, path: out.replace(/\/$/, "") }) : json({ ok: false });
        } catch { return json({ ok: false }); }
      }
      if (url.pathname === "/open-folder") {
        let d: string; try { d = realpathSync(resolve(String(body.dir || ""))); } catch { return json({ ok: false, error: "not a folder" }); }
        if (!statSync(d).isDirectory()) return json({ ok: false, error: "not a folder" });
        // bound vault switches to inside the user's home so a stray POST can't repoint to / or system dirs
        const home = (() => { try { return realpathSync(process.env.HOME || "/"); } catch { return "/"; } })();
        if (d !== home && !d.startsWith(home + sep)) return json({ ok: false, error: "folder must be inside your home directory" });
        if (!ROOTS.includes(d)) ROOTS.push(d); // previously-opened vaults stay live for their tabs
        ROOT = d; LAUNCH_FILE = null;
        return json({ ok: true, first: firstNote() });
      }
      if (url.pathname === "/rewrite") {
        // [AI:cmdk] AI generation for the three GENERATIVE ⌘K targets only (rich / author / prose).
        // Native-block attr/structure edits + prose FORMATTING never reach here — the client routes
        // those to deterministic editor commands, so the model can't duplicate a block or emit a
        // literal markdown mark. streamAI() is the single AI call-site (model-layer swap-point).
        if (!AI_EDIT_ENABLED) return json({ ok: false, error: "ai edit disabled" }, 404);
        const mode = String(body.mode || "");
        const prompt = String(body.prompt || "");
        const { provider: rwProvider, model } = modelInfo("rewrite"); // [AI:integration] ⌘K uses the REWRITE scope (PROVIDER/MODEL; claude/haiku by default → cache key unchanged)
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (o: any) => { try { controller.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n")); } catch {} };
            const r = await streamAI(prompt, model, (chunk) => send({ chunk }), getProvider(rwProvider));
            if (!r.ok) { send({ error: r.error }); controller.close(); return; }
            // Enforce the output-format contract on the RESULT (belt-and-suspenders to the SYSTEM
            // prompt): a rich block is always pure sanitized HTML; prose is de-narrated plain text;
            // author content becomes HTML only if it actually carries tags.
            let text: string, html: boolean;
            if (mode === "rich") { text = safeRichHtml(stripCodeFence(r.out)); html = true; }
            else if (mode === "author") {
              const body2 = stripCodeFence(r.out);
              html = /<[a-z][\s\S]*>/i.test(body2);
              text = html ? safeRichHtml(body2) : cleanProseResult(body2);
            } else { text = cleanProseResult(r.out); html = false; } // prose
            send({ done: { ok: !!text, text, html } });
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
      }
      // [AI:ghost] Tab ghost-text: return a SHORT plain-text continuation of the block at the
      // cursor. Gated on GHOST_TEXT_ENABLED (404 when off, like /rewrite). The prompt is built by
      // the shared buildGhostPrompt (single source with the client's gate) and routed through the
      // one streamAI() call-site — no streaming back to the client (a ghost is one short string),
      // so the model can later be swapped to a fast/local one here without touching the client.
      if (url.pathname === "/ghost") {
        if (!GHOST_TEXT_ENABLED) return json({ ok: false, error: "ghost text disabled" }, 404);
        const blockType = String(body.blockType || "paragraph");
        const context = String(body.context || "").slice(0, 4000); // block text before cursor (chat path + spacing)
        // [AI:ghost] FIM context: prefix = document text before the cursor, suffix = text after it.
        // Falls back to `context` when the client doesn't send them (older client / chat path).
        const prefix = String(body.prefix ?? context).slice(-4000);
        const suffix = String(body.suffix ?? "").slice(0, 2000);
        if (!context.trim() && !prefix.trim()) return json({ ok: false, error: "no context" }, 400);
        const { provider: ghProvider, model } = modelInfo("ghost"); // [AI:integration] ghost uses the GHOST scope (GHOST_PROVIDER/GHOST_MODEL || PROVIDER/MODEL) — independent of ⌘K
        const provider = getProvider(ghProvider);                   // e.g. GHOST_PROVIDER=ollama GHOST_MODEL=qwen2.5-coder:1.5b → local FIM, while ⌘K stays cloud
        let r: { ok: true; out: string } | { ok: false; error: string };
        if (provider.complete) {
          // [AI:ghost] COMPLETION/FIM path (local completion models): raw prefix+suffix, NO chat
          // wrapper and NO note-generation SYSTEM prompt — that framing made completion models emit
          // junk like "html". maxTokens bounds latency; stop at a paragraph break.
          r = await provider.complete(prefix, suffix, { model, maxTokens: 32, stop: ["\n\n"] }); // a ghost shows ≤~120 chars (~30 tok); 32 keeps the long-tail latency down
        } else {
          // chat fallback (Cloud / Claude, no FIM): the legacy "continue this <blockType>" prompt
          // through streamAI on the GHOST provider (cache key identical for the default claude/haiku).
          r = await streamAI(buildGhostPrompt(blockType, context), model, () => {}, provider);
        }
        if (!r.ok) return json({ ok: false, error: r.error }, 502);
        return json({ ok: true, text: cleanGhostCompletion(r.out) });
      }
      return json({ ok: false, error: "unknown" }, 404);
    }

    // Stale-tab guard: a tab opened before a server restart keeps RUNNING (and saving
    // with) old code, silently. The client compares this on focus and asks for a reload.
    if (url.pathname === "/version") return json({ v: BUILD_ID });

    // [AI:integration] which provider + model EACH AI feature uses right now — makes the per-feature
    // split visible (⌘K can be cloud while ghost is local). `rewrite` kept top-level for any caller
    // that read the old flat {provider,model} shape.
    if (url.pathname === "/api/model") return json({ ...modelInfo("rewrite"), rewrite: modelInfo("rewrite"), ghost: modelInfo("ghost") });

    // [AI:firstrun] Connection state for the "connect your Claude / point at Ollama" first-run banner —
    // whether each ENABLED AI feature's provider is actually reachable (no inference, cheap probe).
    if (url.pathname === "/api/ai-status") return json(await aiStatus());

    // Preflight for in-doc note links: lets the client explain a dead link in place
    // instead of navigating to a welcome screen.
    if (url.pathname === "/exists") {
      const p = resolve(url.searchParams.get("file") || "");
      const exists = existsSync(p) && statSync(p).isFile();
      return json({ exists, inVault: inVault(p), isNote: NOTE_RE.test(p) });
    }
    if (url.pathname === "/list") {
      const dir = url.searchParams.get("dir");
      const d = dir ? resolve(dir) : ROOT;
      if (!inVault(d)) return json({ files: [], dirs: [], root: ROOT });
      const { files, dirs } = listTree(d);
      return json({ files, dirs, root: ROOT });
    }
    // Enumerate the vault's .trash. Each entry is `<origbasename>.<unixms>` (toTrash format; a
    // rare collision adds a `.<n>` dedupe suffix). Parse origName + trashedAt back out so the
    // client can render a restore list. Missing .trash → empty. Vault-confined (GET, read-only).
    if (url.pathname === "/trash") {
      const dir = url.searchParams.get("dir");
      const d = dir ? resolve(dir) : ROOT;
      if (!inVault(d)) return json({ items: [] });
      const trash = join(vaultOf(d) ?? ROOT, ".trash");
      if (!existsSync(trash)) return json({ items: [] });
      let entries: string[] = [];
      try { entries = readdirSync(trash); } catch { return json({ items: [] }); }
      const items: { path: string; name: string; origName: string; origRel: string; trashedAt: number }[] = [];
      for (const e of entries) {
        const full = join(trash, e);
        let st; try { st = statSync(full); } catch { continue; }
        const m = e.match(/^(.+)\.(\d{10,})(?:\.\d+)?$/); // <origbasename>.<unixms>[.<dedupe>]
        const origName = m ? m[1] : e;
        const trashedAt = m ? Number(m[2]) : Math.round(st.mtimeMs);
        items.push({ path: full, name: e, origName, origRel: origName, trashedAt });
      }
      items.sort((a, b) => b.trashedAt - a.trashedAt); // newest-trashed first
      return json({ items });
    }
    if (url.pathname !== "/") return new Response("not found", { status: 404 });

    const fileParam = url.searchParams.get("file");
    let path: string | null = fileParam ? resolve(fileParam) : (LAUNCH_FILE || firstNote());
    // An explicitly requested file that can't be served gets an explanation on the
    // welcome screen — silently landing there read as "hyperlinks are broken".
    let openError: string | null = null;
    if (path && !(existsSync(path) && statSync(path).isFile())) { if (fileParam) openError = `No such note: ${path}`; path = null; }
    else if (path && !inVault(path)) { if (fileParam) openError = `That file is outside your open folder${ROOTS.length > 1 ? "s" : ""}. Use “Open folder…” to open ${dirname(path)} first.`; path = null; }
    else if (path && !NOTE_RE.test(path)) { if (fileParam) openError = `Not a note file (.md / .html): ${path}`; path = null; }
    if (!path) return new Response(shell(null, openError), { headers: { "content-type": "text/html; charset=utf-8" } });
    let content: string; try { content = readFileSync(path, "utf8"); } catch { return new Response(shell(null, `Couldn't read ${path}`), { headers: { "content-type": "text/html; charset=utf-8" } }); }
    return new Response(shell({ file: path, format: fmtOf(path), content }), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`note-editor-spike → http://localhost:${PORT}/   vault: ${ROOT}`);
