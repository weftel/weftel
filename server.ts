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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, extname, basename, dirname, sep, join } from "node:path";
import { createHash } from "node:crypto";

// AI record/replay cache — for deterministic e2e tests. AI_CACHE=<dir>: hash the prompt,
// replay the cached response if present, else call claude once and save it. AI_OFFLINE=1:
// error on a cache miss instead of calling out (CI with a committed cache).
const AI_CACHE = process.env.AI_CACHE || "";
const AI_OFFLINE = process.env.AI_OFFLINE === "1";
async function runClaude(prompt: string, timeoutMs = 90000): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  let cacheFile = "";
  if (AI_CACHE) {
    const h = createHash("sha256").update(prompt).digest("hex").slice(0, 40);
    cacheFile = join(AI_CACHE, h + ".txt");
    try { return { ok: true, out: readFileSync(cacheFile, "utf8") }; } catch {}
    if (AI_OFFLINE) return { ok: false, error: "ai cache miss (AI_OFFLINE)" };
  }
  const proc = Bun.spawn(["claude", "-p", prompt], { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited; clearTimeout(killer);
  if (code !== 0) { const err = await new Response(proc.stderr).text(); return { ok: false, error: err.slice(0, 200) || `claude exit ${code}` }; }
  if (AI_CACHE && cacheFile) { try { mkdirSync(AI_CACHE, { recursive: true }); writeFileSync(cacheFile, out); } catch {} }
  return { ok: true, out };
}
import sanitizeHtml from "sanitize-html";

const PORT = Number(process.env.PORT) || 4321;
const ARG = resolve(process.argv[2] ?? "./sample.md");
let ROOT: string;
let LAUNCH_FILE: string | null;
if (existsSync(ARG) && statSync(ARG).isDirectory()) { ROOT = ARG; LAUNCH_FILE = null; }
else { ROOT = dirname(ARG); LAUNCH_FILE = ARG; }
try { ROOT = realpathSync(ROOT); } catch {}

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
function inVault(p: string): boolean { const real = realParent(p); return real === ROOT || real.startsWith(ROOT + sep); }
function okNotePath(p: string): boolean { return inVault(p) && NOTE_RE.test(resolve(p)); }
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
function toTrash(p: string) {
  const trash = join(ROOT, ".trash");
  if (!existsSync(trash)) mkdirSync(trash, { recursive: true });
  let dest = join(trash, `${basename(p)}.${Date.now()}`);
  let i = 0; while (existsSync(dest)) dest = join(trash, `${basename(p)}.${Date.now()}.${++i}`);
  renameSync(p, dest); // never clobber an existing trash entry
}
// Calibrated sanitize for AI (Model B) rich-HTML output: keep the design
// (classes, inline styles, SVG) but strip the real execution vectors
// (script/iframe/object, on* handlers, javascript: URLs).
const SVG_ATTRS = ["viewBox","preserveAspectRatio","xmlns","xmlns:xlink","d","fill","fill-opacity","fill-rule","stroke","stroke-width","stroke-linecap","stroke-linejoin","stroke-dasharray","x","y","x1","y1","x2","y2","cx","cy","r","rx","ry","width","height","points","transform","offset","stop-color","stop-opacity","gradientUnits","gradientTransform","text-anchor","dominant-baseline","font-size","font-family","font-weight","opacity","marker-end","marker-start","clip-path","mask"];
function safeRichHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "div","span","p","section","article","header","footer","main","aside","nav",
      "h1","h2","h3","h4","h5","h6","ul","ol","li","dl","dt","dd",
      "table","thead","tbody","tfoot","tr","td","th","caption","colgroup","col",
      "figure","figcaption","img","picture","blockquote","pre","code","kbd","samp","var",
      "strong","em","b","i","u","s","sub","sup","mark","small","hr","br","wbr",
      "details","summary","time","abbr","cite","q","label","meter","progress",
      "svg","g","path","circle","ellipse","rect","line","polyline","polygon","text","tspan",
      "defs","linearGradient","radialGradient","stop","clipPath","use","symbol","marker","pattern","mask","title","desc",
    ],
    allowedAttributes: {
      "*": ["class", "id", "style", "title", "role", "data-*", "aria-*"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height", "loading"],
      svg: SVG_ATTRS, g: SVG_ATTRS, path: SVG_ATTRS, circle: SVG_ATTRS, ellipse: SVG_ATTRS,
      rect: SVG_ATTRS, line: SVG_ATTRS, polyline: SVG_ATTRS, polygon: SVG_ATTRS, text: SVG_ATTRS,
      tspan: SVG_ATTRS, stop: SVG_ATTRS, linearGradient: SVG_ATTRS, radialGradient: SVG_ATTRS,
      use: SVG_ATTRS, clipPath: SVG_ATTRS, marker: SVG_ATTRS, pattern: SVG_ATTRS, mask: SVG_ATTRS,
    },
    allowedSchemes: ["http", "https", "data", "mailto"],
    allowVulnerableTags: false,
  });
}

// ---- client bundle ----
async function bundleClient(): Promise<string> {
  const b = await Bun.build({ entrypoints: ["./client/editor.ts"], target: "browser", minify: true });
  if (!b.success) { console.error("=== CLIENT BUILD FAILED ==="); for (const l of b.logs) console.error(String(l)); return "document.body.innerHTML='<pre style=\"padding:24px;color:#db2777\">client build failed — see server logs</pre>';"; }
  console.log("client bundled ok");
  return await b.outputs[0].text();
}
let EDITOR_JS = await bundleClient();

function fmtOf(p: string): string {
  const e = extname(p).toLowerCase();
  if (e === ".md" || e === ".markdown") return "md";
  if (e === ".html" || e === ".htm") return "html";
  return "txt";
}
function listNotes(dir: string): { name: string; path: string; rel: string; fmt: string }[] {
  const root = resolve(dir);
  const out: { name: string; path: string; rel: string; fmt: string }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || out.length > 800) return;
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const full = `${d}/${e}`;
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (NOTE_RE.test(e)) out.push({ name: e, path: full, rel: full.slice(root.length + 1), fmt: fmtOf(e) });
    }
  };
  walk(root, 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}
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
  .layout{display:flex;align-items:flex-start}
  .sidebar{width:256px;flex:none;border-right:1px solid var(--border);height:calc(100vh - 40px);overflow:auto;padding:10px 8px;position:sticky;top:40px}
  .sidebar .vault{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--muted);padding:4px 8px 2px}
  .sidebar .filter{width:100%;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;padding:6px 9px;font:inherit;font-size:12.5px;margin:6px 0 8px;outline:none}
  .sidebar .filter:focus{border-color:var(--accent-line)}
  .sidebar .new{display:flex;align-items:center;gap:7px;width:100%;text-align:left;font:inherit;font-size:13px;color:var(--muted);background:transparent;border:1px dashed var(--border-strong);border-radius:7px;padding:7px 10px;margin-bottom:8px;cursor:pointer}
  .sidebar .new:hover{color:var(--accent-ink);border-color:var(--accent-line)}
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
  .main{flex:1;min-width:0}
  .doc{max-width:760px;margin:0 auto;padding:40px 32px 22vh}
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
  .ProseMirror blockquote{border-left:3px solid var(--border-strong);margin:0 0 14px;padding-left:14px;color:var(--muted)}
  .ProseMirror>*:first-child{margin-top:0}
  .ProseMirror .rich-block{margin:16px 0;border-radius:8px;position:relative}
  .ProseMirror .rich-block.ProseMirror-selectednode{outline:2px solid var(--accent);outline-offset:4px}
  .ProseMirror .rich-block::after{content:"rich block · ⌘K to edit";position:absolute;top:-9px;right:8px;font-family:ui-monospace,Menlo,monospace;font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:var(--bg);padding:1px 6px;border-radius:3px;opacity:0;transition:opacity .12s}
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
  .onboard .actions{display:flex;gap:10px;justify-content:center}
  .onboard button{font:inherit;font-size:14px;border-radius:8px;padding:9px 16px;cursor:pointer;border:1px solid var(--border-strong);background:var(--surface);color:var(--text)}
  .onboard button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .chat{position:fixed;top:0;right:0;width:384px;max-width:92vw;height:100vh;background:var(--surface);border-left:1px solid var(--border);box-shadow:-10px 0 34px rgba(0,0,0,.08);display:flex;flex-direction:column;transform:translateX(102%);transition:transform .18s ease;z-index:55}
  /* when chat is open, push the bar + note body left so the drawer never covers the note */
  .bar,.layout{transition:margin-right .18s ease}
  body.chat-open .bar,body.chat-open .layout{margin-right:384px}
  @media(max-width:720px){body.chat-open .bar,body.chat-open .layout{margin-right:0}}
  .chat.show{transform:none}
  .chat-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600}
  .chat-head .spacer{flex:1}
  .chat-head button{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:6px;padding:3px 9px;cursor:pointer}
  .chat-head button:hover{color:var(--text);border-color:var(--border-strong)}
  .chat-log{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
  .chat-empty{color:var(--subtle);font-size:12.5px;text-align:center;margin:auto;max-width:230px;line-height:1.5}
  .chat-msg{font-size:13.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
  .chat-msg.user{align-self:flex-end;background:var(--accent-tint);padding:8px 12px;border-radius:12px 12px 3px 12px;max-width:86%}
  .chat-msg.assistant{align-self:flex-start;max-width:96%}
  .chat-msg.thinking{color:var(--muted);font-style:italic}
  .chat-msg.md{white-space:normal}
  .chat-msg.md p{margin:0 0 8px}.chat-msg.md>p:last-of-type{margin-bottom:0}
  .chat-msg.md ul{margin:4px 0 8px 18px;padding:0}.chat-msg.md li{margin:2px 0}
  .chat-msg.md code{font-family:ui-monospace,Menlo,monospace;font-size:.85em;background:var(--code-bg);color:var(--code-ink);padding:1px 4px;border-radius:4px}
  .chat-msg .insert{display:block;margin-top:7px;font:inherit;font-size:11px;color:var(--accent-ink);background:var(--accent-tint);border:none;border-radius:6px;padding:3px 9px;cursor:pointer}
  .chat-msg .insert:hover{filter:brightness(.97)}
  .chat-foot{border-top:1px solid var(--border);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
  .chat-sel{font-size:11.5px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:6px 9px;display:none;gap:6px;align-items:flex-start}
  .chat-sel.show{display:flex}
  .chat-sel .x{margin-left:auto;cursor:pointer;color:var(--subtle);flex:none}
  .chat-addsel{font:inherit;font-size:11.5px;color:var(--muted);background:transparent;border:1px dashed var(--border-strong);border-radius:7px;padding:5px 9px;cursor:pointer;align-self:flex-start}
  .chat-addsel:hover{color:var(--accent-ink);border-color:var(--accent-line)}
  .chat-row{display:flex;gap:8px;align-items:flex-end}
  .chat-input{flex:1;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:9px;padding:9px 11px;font:inherit;font-size:13.5px;line-height:1.45;resize:none;outline:none;max-height:140px}
  .chat-input:focus{border-color:var(--accent-line)}
  .chat-send{font:inherit;font-size:13px;color:#fff;background:var(--accent);border:none;border-radius:8px;padding:9px 14px;cursor:pointer}
  .chat-send:disabled{opacity:.5;cursor:default}`;
}

function shell(note: { file: string; format: string; content: string } | null): string {
  const title = escHtml(note ? basename(note.file).replace(NOTE_RE, "") : "note-editor");
  const json = note ? JSON.stringify({ ...note, root: ROOT }).replace(/</g, "\\u003c") : `{"root":${JSON.stringify(ROOT).replace(/</g, "\\u003c")}}`;
  const body = note
    ? `<div class="bar"><span class="title" id="title">${title}</span><span class="badge">${note.format}</span><span class="spacer"></span><span class="status dirty" id="savestatus"><span class="dot"></span><span class="lbl">—</span></span><button class="chip" id="askchip"><kbd>⌘K</kbd> AI edit</button><button class="chip" id="chatchip"><kbd>⌘L</kbd> Chat</button><button class="chip" id="insertchip">+ Insert</button></div>
  <div class="layout"><aside class="sidebar" id="sidebar"></aside><main class="main"><div id="editor" class="doc"></div></main></div>`
    : `<div class="onboard"><h1>Your notes, in HTML, with AI.</h1><p>Open a folder of markdown or HTML notes, or create your first one. Everything stays local, in your own files.</p><div class="actions"><button class="primary" id="ob-open">Open folder…</button><button id="ob-new">New note</button></div></div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${styles()}</style></head>
<body>
  ${body}
  <script>window.__NOTE__=${json};</script>
  <script type="module" src="/editor.js"></script>
</body></html>`;
}

function json(data: unknown, status = 200) { return Response.json(data as any, { status }); }

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/editor.js") return new Response(EDITOR_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });

    if (req.method === "POST") {
      if (!sameOrigin(req)) return json({ ok: false, error: "bad origin" }, 403);
      const body: any = await req.json().catch(() => ({}));
      if (url.pathname === "/save") {
        const p = resolve(String(body.file || ""));
        if (!okNotePath(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(p)) return json({ ok: false, error: "no such note (use create)" }, 404);
        try { atomicWrite(p, String(body.content ?? "")); return json({ ok: true }); } catch (e) { return json({ ok: false, error: String(e) }, 500); }
      }
      if (url.pathname === "/create") {
        const p = resolve(String(body.file || ""));
        if (!okNotePath(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (existsSync(p)) return json({ ok: false, error: "a note with that name already exists" });
        try { atomicWrite(p, String(body.content ?? "")); return json({ ok: true, path: p }); } catch (e) { return json({ ok: false, error: String(e) }, 500); }
      }
      if (url.pathname === "/rename") {
        const a = resolve(String(body.from || "")), b = resolve(String(body.to || ""));
        if (!okNotePath(a) || !okNotePath(b)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(a)) return json({ ok: false, error: "missing" });
        if (existsSync(b)) return json({ ok: false, error: "target exists" });
        try { renameSync(a, b); return json({ ok: true, path: b }); } catch (e) { return json({ ok: false, error: String(e) }, 500); }
      }
      if (url.pathname === "/delete") {
        const p = resolve(String(body.file || ""));
        if (!okNotePath(p)) return json({ ok: false, error: "path not allowed" }, 403);
        if (!existsSync(p)) return json({ ok: false, error: "missing" });
        try { toTrash(p); return json({ ok: true }); } catch (e) { return json({ ok: false, error: String(e) }, 500); }
      }
      if (url.pathname === "/open-folder") {
        let d: string; try { d = realpathSync(resolve(String(body.dir || ""))); } catch { return json({ ok: false, error: "not a folder" }); }
        if (!statSync(d).isDirectory()) return json({ ok: false, error: "not a folder" });
        // bound vault switches to inside the user's home so a stray POST can't repoint to / or system dirs
        const home = (() => { try { return realpathSync(process.env.HOME || "/"); } catch { return "/"; } })();
        if (d !== home && !d.startsWith(home + sep)) return json({ ok: false, error: "folder must be inside your home directory" });
        ROOT = d; LAUNCH_FILE = null;
        return json({ ok: true, first: firstNote() });
      }
      if (url.pathname === "/rewrite") {
        try {
          const r = await runClaude(String(body.prompt || ""), 60000);
          if (!r.ok) return json({ ok: false, error: r.error });
          let text = r.out.trim();
          const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
          if (fence) text = fence[1].trim();
          let html = body.mode === "rich";
          if (body.mode === "author" && /<[a-z][\s\S]*>/i.test(text)) html = true; // AI chose to author HTML
          if (html) text = safeRichHtml(text);
          return json({ ok: !!text, text, html });
        } catch (e) { return json({ ok: false, error: String(e) }, 500); }
      }
      if (url.pathname === "/chat") {
        try {
          const msgs = Array.isArray(body.messages) ? body.messages : [];
          const noteCtx = String(body.note || "").slice(0, 12000);
          const sel = String(body.selection || "").slice(0, 6000);
          const convo = msgs.map((m: any) => (m.role === "user" ? "User" : "Assistant") + ": " + String(m.content || "")).join("\n\n");
          const prompt = "You are a writing co-author embedded in the user's local notes app. You can see the current note and, when provided, a selected excerpt. Be concise and concrete. When asked to draft or rewrite, output the result directly (it can be inserted into the note). No code fences unless showing code.\n\n=== CURRENT NOTE ===\n" + (noteCtx || "(empty)") + "\n\n" + (sel ? "=== SELECTED EXCERPT ===\n" + sel + "\n\n" : "") + "=== CONVERSATION ===\n" + convo + "\n\nAssistant:";
          const r = await runClaude(prompt, 90000);
          if (!r.ok) return json({ ok: false, error: r.error });
          const reply = r.out.trim();
          return json({ ok: !!reply, reply });
        } catch (e) { return json({ ok: false, error: String(e) }, 500); }
      }
      return json({ ok: false, error: "unknown" }, 404);
    }

    if (url.pathname === "/list") {
      const dir = url.searchParams.get("dir");
      const d = dir ? resolve(dir) : ROOT;
      if (!inVault(d)) return json({ files: [], root: ROOT });
      return json({ files: listNotes(d), root: ROOT });
    }
    if (url.pathname !== "/") return new Response("not found", { status: 404 });

    const fileParam = url.searchParams.get("file");
    let path: string | null = fileParam ? resolve(fileParam) : (LAUNCH_FILE || firstNote());
    if (path && (!inVault(path) || !existsSync(path) || !NOTE_RE.test(path) || !statSync(path).isFile())) path = null;
    if (!path) return new Response(shell(null), { headers: { "content-type": "text/html; charset=utf-8" } });
    let content: string; try { content = readFileSync(path, "utf8"); } catch { return new Response(shell(null), { headers: { "content-type": "text/html; charset=utf-8" } }); }
    return new Response(shell({ file: path, format: fmtOf(path), content }), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`note-editor-spike → http://localhost:${PORT}/   vault: ${ROOT}`);
