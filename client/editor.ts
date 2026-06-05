// note-editor-spike client — TipTap block model.
//
//   ProseBlock   fluid text (md/html)
//   RichBlock    arbitrary HTML, verbatim + atomic (div[data-rich-block])
//   CalendarBlock / ClockBlock   live dynamic apps (node views)
//
// Safety: lossless html round-trip (full <head>/shell preserved; unmodelable
// top-level elements wrapped, never flattened); sequence-guarded autosave with a
// status pill, flush-on-navigate, and beforeunload flush; hardened cmd+K.
//
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

type Note = { file: string; format: string; content: string; root: string };
const W = window as any;
const note: Note | null = W.__NOTE__ && W.__NOTE__.file ? W.__NOTE__ : null;
const ROOT: string = (W.__NOTE__ && W.__NOTE__.root) || "";

// ============================ custom nodes ============================
const richMd = { markdown: { serialize(state: any, node: any) { state.write(node.attrs.html || ""); state.closeBlock(node); } } };

const RichBlock = Node.create({
  name: "richBlock", group: "block", atom: true, selectable: true, draggable: true,
  addAttributes() { return { html: { default: "", parseHTML: (el: any) => el.innerHTML, renderHTML: () => ({}) } }; },
  addStorage() { return richMd; },
  parseHTML() { return [{ tag: "div[data-rich-block]" }]; },
  renderHTML({ node }: any) { const d = document.createElement("div"); d.setAttribute("data-rich-block", ""); d.innerHTML = node.attrs.html; return d; },
  addNodeView() {
    return ({ node }: any) => { const d = document.createElement("div"); d.setAttribute("data-rich-block", ""); d.className = "rich-block"; d.contentEditable = "false"; d.innerHTML = node.attrs.html; return { dom: d }; };
  },
});

function appHead(title: string, onSettings?: () => void): HTMLElement {
  const head = document.createElement("div"); head.className = "app-head";
  const lhs = document.createElement("div"); lhs.className = "lhs";
  const live = document.createElement("span"); live.className = "live"; live.innerHTML = '<span class="dot"></span>LIVE';
  const name = document.createElement("span"); name.textContent = title;
  lhs.appendChild(live); lhs.appendChild(name); head.appendChild(lhs);
  if (onSettings) { const b = document.createElement("button"); b.className = "app-btn"; b.textContent = "settings"; b.onclick = onSettings; head.appendChild(b); }
  return head;
}

const CalendarBlock = Node.create({
  name: "calendarBlock", group: "block", atom: true, selectable: true, draggable: true,
  addAttributes() { return { src: { default: "" } }; },
  addStorage() { return { markdown: { serialize(state: any, node: any) { state.write(`<div data-calendar data-src="${node.attrs.src}"></div>`); state.closeBlock(node); } } }; },
  parseHTML() { return [{ tag: "div[data-calendar]", getAttrs: (el: any) => ({ src: el.getAttribute("data-src") || "" }) }]; },
  renderHTML({ node }: any) { return ["div", { "data-calendar": "", "data-src": node.attrs.src }]; },
  addNodeView() {
    return ({ node, editor, getPos }: any) => {
      const dom = document.createElement("div"); dom.className = "app-block"; dom.setAttribute("data-calendar", ""); dom.contentEditable = "false";
      dom.appendChild(appHead("Google Calendar", () => {
        const next = window.prompt("Google Calendar embed URL:", node.attrs.src);
        if (next != null && typeof getPos === "function") editor.chain().command(({ tr }: any) => { tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, src: next }); return true; }).run();
      }));
      const f = document.createElement("iframe"); f.src = node.attrs.src; f.style.width = "100%"; f.style.height = "600px"; f.style.border = "0"; f.setAttribute("frameborder", "0");
      dom.appendChild(f);
      return { dom, stopEvent: () => true, ignoreMutation: () => true };
    };
  },
});

// Auth-free dynamic block — proves the live-component mechanism without any login.
const ClockBlock = Node.create({
  name: "clockBlock", group: "block", atom: true, selectable: true, draggable: true,
  addAttributes() { return { tz: { default: "local" } }; },
  addStorage() { return { markdown: { serialize(state: any, node: any) { state.write(`<div data-clock data-tz="${node.attrs.tz}"></div>`); state.closeBlock(node); } } }; },
  parseHTML() { return [{ tag: "div[data-clock]", getAttrs: (el: any) => ({ tz: el.getAttribute("data-tz") || "local" }) }]; },
  renderHTML({ node }: any) { return ["div", { "data-clock": "", "data-tz": node.attrs.tz }]; },
  addNodeView() {
    return ({ node }: any) => {
      const dom = document.createElement("div"); dom.className = "app-block"; dom.setAttribute("data-clock", ""); dom.contentEditable = "false";
      dom.appendChild(appHead("Clock"));
      const face = document.createElement("div"); face.style.cssText = "font:600 38px ui-monospace,Menlo,monospace;letter-spacing:.04em;text-align:center;padding:26px 0;color:var(--accent-ink)";
      dom.appendChild(face);
      const tick = () => { const d = new Date(); face.textContent = d.toLocaleTimeString(); };
      tick(); const iv = setInterval(tick, 1000);
      return { dom, stopEvent: () => true, ignoreMutation: () => true, destroy: () => clearInterval(iv) };
    };
  },
});

// ============================ html load/save (lossless) ============================
const PROSE_TAGS = new Set(["H1","H2","H3","H4","H5","H6","P","UL","OL","BLOCKQUOTE","PRE","HR","TABLE"]);
let htmlTemplate: string | null = null; // full original doc with %%NOTE_BODY%% where editable content goes
const BODY_TOKEN = "%%NOTE_BODY%%";

function prepareHtml(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  // Preserve every <style>/<script> by relocating into <head> BEFORE tokenizing the
  // body — otherwise styles living inside <body>/<article> get wiped on save.
  doc.querySelectorAll("style, script").forEach((el) => doc.head.appendChild(el));
  // Render styles live so rich blocks show with their CSS (styles only, not scripts).
  const styleHtml = Array.from(doc.head.querySelectorAll("style")).map((s) => s.outerHTML).join("\n");
  if (styleHtml) { const h = document.createElement("div"); h.innerHTML = styleHtml; document.head.append(...Array.from(h.children)); }
  const container = (doc.querySelector("article, main") as HTMLElement) || doc.body;
  const hasMarkers = !!container.querySelector("[data-rich-block],[data-calendar],[data-clock]");
  if (hasMarkers) {
    // App-authored note: keep prose fluid; wrap any stray non-prose top-level
    // element so it's preserved atomic rather than flattened.
    Array.from(container.children).forEach((child) => {
      const el = child as HTMLElement;
      if (el.hasAttribute("data-rich-block") || el.hasAttribute("data-calendar") || el.hasAttribute("data-clock")) return;
      if (PROSE_TAGS.has(el.tagName)) return;
      const wrap = doc.createElement("div"); wrap.setAttribute("data-rich-block", "");
      el.replaceWith(wrap); wrap.appendChild(el);
    });
  } else {
    // Arbitrary imported HTML (no markers): preserve the ENTIRE body as one atomic
    // rich block — guaranteed lossless, rendered verbatim, view-only until adopted.
    const inner = container.innerHTML;
    const wrap = doc.createElement("div"); wrap.setAttribute("data-rich-block", "");
    wrap.innerHTML = inner; container.innerHTML = ""; container.appendChild(wrap);
  }
  const content = container.innerHTML;
  container.innerHTML = BODY_TOKEN;
  htmlTemplate = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  return content;
}

// ============================ editor ============================
const mount = document.getElementById("editor");
let editor: Editor | null = null;

if (note && mount) {
  const extensions: any[] = [StarterKit, RichBlock, CalendarBlock, ClockBlock];
  let content = note.content;
  if (note.format === "md") extensions.push(Markdown.configure({ html: true, linkify: true }));
  else if (note.format === "html") content = prepareHtml(note.content);

  editor = new Editor({ element: mount, extensions, content, autofocus: "end" });
  W.__editor = editor;

  // -------- serialize --------
  const serialize = (): string => {
    if (!editor) return "";
    if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); }
    const bodyHtml = editor.getHTML();
    if (htmlTemplate) return htmlTemplate.replace(BODY_TOKEN, bodyHtml);
    return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><article>\n${bodyHtml}\n</article></body></html>\n`;
  };

  // -------- toast + save status --------
  const toast = document.createElement("div"); toast.className = "toast"; document.body.appendChild(toast);
  const flash = (m: string, ok = true) => { toast.textContent = m; (toast.style as any).background = ok ? "var(--win)" : "var(--risk)"; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 1300); };
  const statusEl = document.getElementById("savestatus");
  const setStatus = (cls: string, label: string) => { if (!statusEl) return; statusEl.className = "status " + cls; const l = statusEl.querySelector(".lbl"); if (l) l.textContent = label; };

  // -------- save system: sequence-guarded, flushable --------
  let lastSaved = serialize();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let saveSeq = 0;
  async function doSave(): Promise<boolean> {
    const out = serialize();
    if (out === lastSaved) { dirty = false; setStatus("saved", "Saved"); return true; }
    const seq = ++saveSeq; saving = true; setStatus("saving", "Saving…");
    try {
      const r = await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: note.file, content: out }) }).then((x) => x.json());
      saving = false;
      if (seq !== saveSeq) return true; // a newer save superseded this one
      if (r.ok) { lastSaved = out; dirty = false; setStatus("saved", "Saved"); return true; }
      setStatus("error", "Save failed — retry"); return false;
    } catch { saving = false; if (seq === saveSeq) setStatus("error", "Save failed — retry"); return false; }
  }
  function scheduleSave() { dirty = true; setStatus("dirty", "Unsaved"); clearTimeout(timer); timer = setTimeout(doSave, 600); }
  async function flushSave() { clearTimeout(timer); if (dirty || saving) await doSave(); }
  editor.on("update", scheduleSave);
  setStatus("saved", "Saved");

  // flush before leaving (covers cmd+W / refresh)
  window.addEventListener("beforeunload", () => {
    if (!dirty) return;
    const out = serialize();
    try { navigator.sendBeacon("/save", new Blob([JSON.stringify({ file: note.file, content: out })], { type: "application/json" })); } catch {}
  });
  // navigate helper: always flush first so edits in the debounce window aren't lost
  async function go(href: string) { await flushSave(); location.href = href; }

  // -------- placeholder on empty doc --------
  const updatePlaceholder = () => {
    if (!editor) return;
    const first = mount!.querySelector(".ProseMirror > p:first-child");
    const empty = editor.isEmpty;
    mount!.querySelectorAll(".ProseMirror > p.is-empty").forEach((e) => { e.classList.remove("is-empty"); });
    if (empty && first) { first.classList.add("is-empty"); first.setAttribute("data-placeholder", "Type, or press ⌘K to ask AI…"); }
  };
  editor.on("update", updatePlaceholder); editor.on("create", updatePlaceholder); updatePlaceholder();

  // ============================ cmd+K ============================
  const cmdk = document.createElement("div"); cmdk.className = "cmdk";
  cmdk.innerHTML = '<input type="text" placeholder="Ask AI… (Enter to run, Esc to cancel)"><div class="cmdk-hint"></div>';
  document.body.appendChild(cmdk);
  const cmdkInput = cmdk.querySelector("input") as HTMLInputElement;
  const cmdkHint = cmdk.querySelector(".cmdk-hint") as HTMLElement;
  let cmdkTarget: any = null;

  const docContext = (): string => { if (!editor) return ""; if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); } return editor.getHTML(); };

  function openCmdk() {
    if (!editor) return;
    const sel: any = editor.state.selection;
    if (sel.node && sel.node.type.name === "richBlock") { cmdkTarget = { mode: "rich", html: sel.node.attrs.html }; cmdkHint.textContent = "rewrite this rich block — e.g. “make the grid 6×6”"; }
    else { const text = editor.state.doc.textBetween(sel.from, sel.to, " "); cmdkTarget = { mode: "prose", from: sel.from, to: sel.to, text }; cmdkHint.textContent = text ? ('"' + text.slice(0, 56) + (text.length > 56 ? "…" : "") + '"') : "insert at cursor"; }
    let left = 60, top = 130;
    const s = window.getSelection();
    if (s && s.rangeCount && String(s)) { const r = s.getRangeAt(0).getBoundingClientRect(); if (r.width || r.height) { left = r.left; top = r.bottom + window.scrollY + 8; } }
    cmdk.style.left = Math.max(12, Math.min(left, window.innerWidth - 392)) + "px"; cmdk.style.top = top + "px";
    cmdk.classList.add("show"); cmdkInput.value = ""; cmdkInput.disabled = false; cmdkInput.focus();
  }
  function closeCmdk() { cmdk.classList.remove("show"); cmdkTarget = null; if (editor) editor.commands.focus(); }

  function findRichPos(html: string): number | null {
    if (!editor) return null; let pos: number | null = null;
    editor.state.doc.descendants((n: any, p: number) => { if (pos === null && n.type.name === "richBlock" && n.attrs.html === html) pos = p; });
    return pos;
  }

  cmdkInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !cmdkTarget || !cmdkInput.value.trim() || !editor) return;
    const intent = cmdkInput.value.trim(); const t = cmdkTarget;
    cmdkInput.disabled = true; cmdkHint.textContent = "thinking with your Claude…";
    const prompt = t.mode === "rich"
      ? "You are editing one rich HTML block inside a note. Rewrite its INNER HTML per the instruction. Output ONLY the resulting inner HTML — no explanation, no code fences.\n\nInstruction: " + intent + "\n\nCurrent inner HTML:\n" + t.html
      : "You are editing a note. Rewrite the selected text per the instruction. Output ONLY the replacement as plain prose — no markdown, no fences, no explanation. Use the rest of the note as context.\n\nInstruction: " + intent + "\n\nSelected text:\n" + (t.text || "(none — generate new text to insert)") + "\n\nFull note for context:\n" + docContext().slice(0, 8000);
    try {
      const r = await fetch("/rewrite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, mode: t.mode }) }).then((x) => x.json());
      if (!r.ok || !r.text) { cmdkInput.disabled = false; cmdkHint.textContent = "failed: " + (r.error || "empty"); return; }
      if (t.mode === "rich") {
        if (r.text.indexOf("<") < 0) { cmdkInput.disabled = false; cmdkHint.textContent = "AI didn't return HTML — try again"; return; }
        const pos = findRichPos(t.html); // re-find by content; tolerant of position drift
        if (pos == null) { cmdkInput.disabled = false; cmdkHint.textContent = "block moved — try again"; return; }
        const node = editor.state.doc.nodeAt(pos);
        editor.chain().command(({ tr }: any) => { tr.setNodeMarkup(pos, undefined, { ...(node ? node.attrs : {}), html: r.text }); return true; }).run(); // undoable via cmd+Z
      } else {
        editor.chain().focus().insertContentAt({ from: t.from, to: t.to }, r.text).run();
      }
      closeCmdk(); flash("rewritten → saved");
    } catch { cmdkInput.disabled = false; cmdkHint.textContent = "failed"; }
  });

  // ============================ insert menu ============================
  function insertBlock(kind: string) {
    if (!editor) return;
    if (kind === "calendar") { const def = "https://calendar.google.com/calendar/embed?src=benjamingonzales121102%40gmail.com&ctz=America%2FLos_Angeles"; const url = window.prompt("Google Calendar embed URL:", def); if (url) editor.chain().focus().insertContent({ type: "calendarBlock", attrs: { src: url } }).run(); }
    else if (kind === "clock") editor.chain().focus().insertContent({ type: "clockBlock", attrs: { tz: "local" } }).run();
    else if (kind === "rich") editor.chain().focus().insertContent('<div data-rich-block><div style="padding:16px;border:1px dashed var(--border-strong);border-radius:8px;text-align:center;color:var(--muted)">empty rich block — ⌘K to fill it with AI</div></div>').run();
  }

  // ============================ chrome wiring ============================
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCmdk(); }
    else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); flushSave(); }
    else if (mod && (e.key.toLowerCase() === "p" || e.key.toLowerCase() === "o")) { e.preventDefault(); openSwitcher(); }
    else if (e.key === "Escape") { if (cmdk.classList.contains("show")) closeCmdk(); else if (switcher.classList.contains("show")) closeSwitcher(); }
  });
  document.getElementById("askchip")?.addEventListener("click", openCmdk);
  document.getElementById("insertchip")?.addEventListener("click", () => {
    const k = window.prompt("Insert block: type 'calendar', 'clock', or 'rich'", "clock");
    if (k) insertBlock(k.trim().toLowerCase());
  });
  // title from first H1 if present
  const t = document.getElementById("title");
  const h1 = mount.querySelector(".ProseMirror h1");
  if (t && h1 && h1.textContent && h1.textContent.trim()) t.textContent = h1.textContent.trim();

  // ============================ sidebar ============================
  const GLYPH: Record<string, string> = { md: "·", html: "<>", txt: "·" };
  let allNotes: any[] = [];
  function noteTitle(f: any): string { return f.name.replace(/\.(md|markdown|html?|htm)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()); }
  function renderSidebar(filterStr = "") {
    const sb = document.getElementById("sidebar"); if (!sb) return;
    const dir = ROOT;
    sb.innerHTML = "";
    const head = document.createElement("div"); head.className = "vault"; head.textContent = "📁 " + (dir.split("/").pop() || dir); sb.appendChild(head);
    const filter = document.createElement("input"); filter.className = "filter"; filter.placeholder = "Filter notes…"; filter.value = filterStr;
    filter.oninput = () => renderList(filter.value);
    sb.appendChild(filter);
    const nb = document.createElement("button"); nb.className = "new"; nb.textContent = "＋ New note"; nb.onclick = newNote; sb.appendChild(nb);
    const list = document.createElement("div"); list.id = "notelist"; sb.appendChild(list);
    renderList(filterStr);
    function renderList(q: string) {
      const ql = q.toLowerCase();
      list.innerHTML = "";
      allNotes.filter((f) => !ql || f.rel.toLowerCase().includes(ql) || noteTitle(f).toLowerCase().includes(ql)).forEach((f) => {
        const a = document.createElement("a"); a.className = "note-link" + (note && f.path === note.file ? " active" : "");
        const gl = document.createElement("span"); gl.className = "gl"; gl.textContent = GLYPH[f.fmt] || "·";
        const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = noteTitle(f); nm.title = f.rel;
        a.appendChild(gl); a.appendChild(nm);
        const acts = document.createElement("span"); acts.className = "row-act";
        const rn = document.createElement("button"); rn.textContent = "rename"; rn.title = "rename"; rn.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); renameNote(f); };
        const dl = document.createElement("button"); dl.textContent = "✕"; dl.title = "delete"; dl.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); deleteNote(f); };
        acts.appendChild(rn); acts.appendChild(dl); a.appendChild(acts);
        a.onclick = (ev) => { ev.preventDefault(); go("/?file=" + encodeURIComponent(f.path)); };
        list.appendChild(a);
      });
    }
  }
  async function loadNotes() { try { const { files } = await fetch("/list?dir=" + encodeURIComponent(ROOT)).then((r) => r.json()); allNotes = files || []; renderSidebar(); } catch { renderSidebar(); } }
  async function newNote() {
    const name = window.prompt("New note name:"); if (!name) return;
    const clean = name.replace(/[^a-zA-Z0-9 _-]/g, "").trim(); if (!clean) { flash("invalid name", false); return; }
    const path = ROOT + "/" + clean + (/\.html?$/i.test(name) ? "" : ".md");
    const r = await fetch("/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: path, content: "# " + clean + "\n\n" }) }).then((x) => x.json());
    if (!r.ok) { flash(r.error || "couldn't create", false); return; }
    go("/?file=" + encodeURIComponent(path));
  }
  async function renameNote(f: any) {
    const name = window.prompt("Rename note to:", noteTitle(f)); if (!name) return;
    const clean = name.replace(/[^a-zA-Z0-9 _-]/g, "").trim(); if (!clean) { flash("invalid name", false); return; }
    const to = f.path.replace(/[^/]+$/, "") + clean + "." + (f.path.split(".").pop());
    const r = await fetch("/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: f.path, to }) }).then((x) => x.json());
    if (!r.ok) { flash(r.error || "couldn't rename", false); return; }
    if (note && f.path === note.file) go("/?file=" + encodeURIComponent(to)); else loadNotes();
  }
  async function deleteNote(f: any) {
    if (!window.confirm("Move “" + noteTitle(f) + "” to trash?")) return;
    const r = await fetch("/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: f.path }) }).then((x) => x.json());
    if (!r.ok) { flash(r.error || "couldn't delete", false); return; }
    if (note && f.path === note.file) { const other = allNotes.find((x) => x.path !== f.path); go(other ? "/?file=" + encodeURIComponent(other.path) : "/"); } else loadNotes();
  }
  loadNotes();

  // ============================ quick switcher ============================
  const switcher = document.createElement("div"); switcher.className = "switcher";
  switcher.innerHTML = '<div class="box"><input type="text" placeholder="Jump to note…"><div class="results"></div></div>';
  document.body.appendChild(switcher);
  const swInput = switcher.querySelector("input") as HTMLInputElement;
  const swResults = switcher.querySelector(".results") as HTMLElement;
  let swSel = 0, swMatches: any[] = [];
  function openSwitcher() { switcher.classList.add("show"); swInput.value = ""; swSel = 0; renderSw(""); swInput.focus(); }
  function closeSwitcher() { switcher.classList.remove("show"); if (editor) editor.commands.focus(); }
  function renderSw(q: string) {
    const ql = q.toLowerCase();
    swMatches = allNotes.filter((f) => !ql || f.rel.toLowerCase().includes(ql) || noteTitle(f).toLowerCase().includes(ql)).slice(0, 50);
    if (swSel >= swMatches.length) swSel = 0;
    swResults.innerHTML = "";
    swMatches.forEach((f, i) => { const d = document.createElement("div"); d.className = "res" + (i === swSel ? " sel" : ""); d.innerHTML = `<span class="gl">${GLYPH[f.fmt] || "·"}</span><span>${noteTitle(f)}</span><span class="pth">${f.rel}</span>`; d.onclick = () => go("/?file=" + encodeURIComponent(f.path)); swResults.appendChild(d); });
  }
  swInput.addEventListener("input", () => { swSel = 0; renderSw(swInput.value); });
  swInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); swSel = Math.min(swSel + 1, swMatches.length - 1); renderSw(swInput.value); }
    else if (e.key === "ArrowUp") { e.preventDefault(); swSel = Math.max(swSel - 1, 0); renderSw(swInput.value); }
    else if (e.key === "Enter") { e.preventDefault(); const f = swMatches[swSel]; if (f) go("/?file=" + encodeURIComponent(f.path)); }
  });
  switcher.addEventListener("click", (e) => { if (e.target === switcher) closeSwitcher(); });
}

// ============================ onboarding (no note) ============================
if (!note) {
  document.getElementById("ob-open")?.addEventListener("click", async () => {
    const dir = window.prompt("Open folder (absolute path to your notes vault):", ROOT);
    if (!dir) return;
    const r = await fetch("/open-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir }) }).then((x) => x.json());
    if (!r.ok) { alert(r.error || "couldn't open folder"); return; }
    location.href = r.first ? "/?file=" + encodeURIComponent(r.first) : "/";
  });
  document.getElementById("ob-new")?.addEventListener("click", async () => {
    const name = window.prompt("New note name:"); if (!name) return;
    const clean = name.replace(/[^a-zA-Z0-9 _-]/g, "").trim(); if (!clean) return;
    const path = ROOT + "/" + clean + ".md";
    const r = await fetch("/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: path, content: "# " + clean + "\n\n" }) }).then((x) => x.json());
    if (r.ok) location.href = "/?file=" + encodeURIComponent(path); else alert(r.error || "couldn't create");
  });
}
