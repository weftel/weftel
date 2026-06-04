// note-editor-spike — TipTap rebuild.
//
// Serves a fluid document-model editor (TipTap/ProseMirror) for a note, bundling
// the client with Bun.build. Edits are fluid (cross-block delete, Enter = new
// block); on save the doc is serialized back to the file's native format.
//
//   bun run server.ts [default-file]
//   open http://localhost:4321/?file=/abs/path/note.md
//
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, extname, basename } from "node:path";

const PORT = 4321;
const DEFAULT_FILE = resolve(process.argv[2] ?? "./sample.md");

async function bundleClient(): Promise<string> {
  const b = await Bun.build({ entrypoints: ["./client/editor.ts"], target: "browser", minify: true });
  if (!b.success) {
    console.error("=== CLIENT BUILD FAILED ===");
    for (const l of b.logs) console.error(String(l));
    return "document.body.innerHTML='<pre style=\"padding:24px;color:#db2777\">client build failed — see server logs</pre>';";
  }
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

function shell(note: { file: string; format: string; content: string }): string {
  const json = JSON.stringify(note).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${basename(note.file)} · editor</title>
<style>
  :root{--bg:#fafafa;--surface:#fff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#7c3aed;--accent-soft:#f3eeff;--win:#16a34a;--risk:#db2777}
  @media(prefers-color-scheme:dark){:root{--bg:#09090b;--surface:#18181b;--text:#f4f4f5;--muted:#a1a1aa;--border:#27272a;--accent:#a78bfa;--accent-soft:#2e1065;--win:#22c55e;--risk:#ec4899}}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
  .bar{position:sticky;top:0;display:flex;gap:12px;align-items:center;padding:10px 20px;background:var(--surface);border-bottom:1px solid var(--border);font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);z-index:5}
  .bar .fmt{padding:1px 7px;border-radius:3px;background:var(--accent-soft);color:var(--accent);text-transform:uppercase;letter-spacing:.06em}
  .bar .mode{margin-left:auto}
  .doc{max-width:820px;margin:0 auto;padding:32px 28px 80px}
  .ProseMirror{outline:none;min-height:60vh}
  .ProseMirror h1{font-size:30px;letter-spacing:-.02em;margin:0 0 16px}.ProseMirror h2{font-size:21px;letter-spacing:-.01em;margin:26px 0 10px}.ProseMirror h3{font-size:17px;margin:22px 0 8px}
  .ProseMirror p{margin:0 0 14px}.ProseMirror ul,.ProseMirror ol{margin:0 0 14px 22px}.ProseMirror li{margin-bottom:4px}.ProseMirror li>p{margin:0}
  .ProseMirror a{color:var(--accent)}
  .ProseMirror code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:var(--accent-soft);color:var(--accent);padding:1px 5px;border-radius:3px}
  .ProseMirror pre{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:14px;overflow:auto}
  .ProseMirror pre code{background:none;color:inherit;padding:0}
  .ProseMirror blockquote{border-left:3px solid var(--border);margin:0 0 14px;padding-left:14px;color:var(--muted)}
  .ProseMirror>*:first-child{margin-top:0}
  .ProseMirror .rich-block{margin:16px 0;border-radius:8px;position:relative}
  .ProseMirror .rich-block.ProseMirror-selectednode{outline:2px solid var(--accent);outline-offset:4px}
  .ProseMirror .rich-block::after{content:"rich block · ⌘K to edit (soon)";position:absolute;top:-9px;right:8px;font:600 9px ui-monospace,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);background:var(--bg);padding:1px 6px;border-radius:3px;opacity:0;transition:opacity .12s}
  .ProseMirror .rich-block:hover::after{opacity:1}
  .bar-btn{margin-left:8px;font-family:inherit;font-size:12px;background:var(--accent);color:#fff;border:none;border-radius:5px;padding:4px 11px;cursor:pointer}
  .ProseMirror .app-block{margin:18px 0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)}
  .ProseMirror .app-block.ProseMirror-selectednode{outline:2px solid var(--accent);outline-offset:3px}
  .ProseMirror .app-head{display:flex;align-items:center;justify-content:space-between;padding:8px 13px;font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--border)}
  .ProseMirror .app-btn{font-family:ui-monospace,Menlo,monospace;font-size:10px;text-transform:none;letter-spacing:0;background:var(--accent-soft);color:var(--accent);border:none;border-radius:4px;padding:3px 9px;cursor:pointer}
  .ProseMirror .app-block iframe{display:block}
  .cmdk{position:absolute;display:none;width:360px;background:var(--surface);border:1px solid var(--accent);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.20);padding:8px;z-index:30}
  .cmdk.show{display:block}
  .cmdk input{width:100%;border:none;outline:none;background:transparent;color:var(--text);font-size:14px;padding:6px}
  .cmdk-hint{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);padding:2px 6px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .layout{display:flex;align-items:flex-start}
  .sidebar{width:258px;flex:none;border-right:1px solid var(--border);height:calc(100vh - 41px);overflow:auto;padding:10px 8px;position:sticky;top:41px}
  .sidebar .vault{font-family:ui-monospace,Menlo,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:4px 8px 8px}
  .sidebar .new{display:block;width:100%;text-align:left;font-family:inherit;font-size:13px;background:var(--accent-soft);color:var(--accent);border:none;border-radius:6px;padding:7px 10px;margin-bottom:8px;cursor:pointer}
  .note-link{display:block;font-size:13px;color:var(--text);text-decoration:none;padding:5px 10px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .note-link:hover{background:var(--accent-soft)}
  .note-link.active{background:var(--accent);color:#fff}
  .main{flex:1;min-width:0}
  .main .doc{padding-top:24px}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;transition:opacity .15s,transform .15s;color:#fff;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:7px 14px;border-radius:6px;pointer-events:none;z-index:20}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style></head>
<body>
  <div class="bar"><span>${basename(note.file)}</span><span class="fmt">${note.format}</span><span class="mode">TipTap · fluid editing · autosaves</span></div>
  <div class="layout"><aside class="sidebar" id="sidebar"></aside><main class="main"><div id="editor" class="doc"></div></main></div>
  <script>window.__NOTE__=${json};</script>
  <script type="module" src="/editor.js"></script>
</body></html>`;
}

// List the .md/.html notes under a folder (the "vault"), for the sidebar.
function listNotes(dir: string): { name: string; path: string; rel: string }[] {
  const root = resolve(dir);
  const out: { name: string; path: string; rel: string }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || out.length > 500) return;
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const full = `${d}/${e}`;
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (/\.(md|markdown|html?|htm)$/i.test(e)) out.push({ name: e, path: full, rel: full.slice(root.length + 1) });
    }
  };
  walk(root, 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/editor.js") {
      return new Response(EDITOR_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (req.method === "POST" && url.pathname === "/save") {
      try {
        const { file, content } = await req.json();
        writeFileSync(resolve(file), content, "utf8");
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 400 });
      }
    }
    // cmd+K: client builds the prompt (with context), server runs the user's Claude
    // and returns the text. The client applies it to the editor; autosave persists.
    if (req.method === "POST" && url.pathname === "/rewrite") {
      try {
        const { prompt } = await req.json();
        const proc = Bun.spawn(["claude", "-p", String(prompt)], { stdout: "pipe", stderr: "pipe" });
        const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        clearTimeout(killer);
        let text = out.trim();
        const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
        if (fence) text = fence[1].trim();
        return Response.json({ ok: !!text, text });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 400 });
      }
    }
    if (url.pathname === "/list") {
      const dir = url.searchParams.get("dir") || ".";
      return Response.json({ files: listNotes(dir) });
    }
    if (url.pathname !== "/") return new Response("not found", { status: 404 });
    const file = url.searchParams.get("file");
    const path = file ? resolve(file) : DEFAULT_FILE;
    if (!existsSync(path)) return new Response("file not found", { status: 404 });
    const content = readFileSync(path, "utf8");
    return new Response(shell({ file: path, format: fmtOf(path), content }), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`note-editor-spike (TipTap) → http://localhost:${PORT}/  (default: ${DEFAULT_FILE})`);
console.log(`open: http://localhost:${PORT}/?file=/abs/path/note.md`);
