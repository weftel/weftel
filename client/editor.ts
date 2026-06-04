// TipTap editor client — block model.
//
//   ProseBlock  (h/p/ul/quote/code)   → TipTap standard nodes, fully fluid
//   RichBlock   (div[data-rich-block]) → arbitrary HTML preserved VERBATIM, atomic.
//                                        TipTap never re-serializes its content, so
//                                        the design can't be mangled. (AI-edited later.)
//
// md notes: no rich blocks, fluid as before. html notes: prose + rich blocks,
// the note's <style> is preserved so rich blocks render with their CSS.
//
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

type Note = { file: string; format: string; content: string };
const note: Note = (window as any).__NOTE__;
const mount = document.querySelector("#editor") as HTMLElement;

// ---- RichBlock: holds raw HTML, renders it verbatim, atomic ----
const RichBlock = Node.create({
  name: "richBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { html: { default: "", parseHTML: (el: any) => el.innerHTML, renderHTML: () => ({}) } };
  },
  parseHTML() {
    return [{ tag: "div[data-rich-block]" }];
  },
  renderHTML({ node }: any) {
    const dom = document.createElement("div");
    dom.setAttribute("data-rich-block", "");
    dom.innerHTML = node.attrs.html;
    return dom;
  },
  addNodeView() {
    return ({ node }: any) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-rich-block", "");
      dom.className = "rich-block";
      dom.contentEditable = "false";
      dom.innerHTML = node.attrs.html;
      return { dom };
    };
  },
});

// ---- CalendarBlock: a DYNAMIC block — a live, interactive component (gcal iframe).
// Same node-view mechanism as RichBlock, but it mounts a live app instead of
// static HTML. This is the proof that the editor can hold dynamic software.
// Saved to source as a clean marker: <div data-calendar data-src="URL">.
const CalendarBlock = Node.create({
  name: "calendarBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { src: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-calendar]", getAttrs: (el: any) => ({ src: el.getAttribute("data-src") || "" }) }];
  },
  renderHTML({ node }: any) {
    return ["div", { "data-calendar": "", "data-src": node.attrs.src }];
  },
  addNodeView() {
    return ({ node, editor, getPos }: any) => {
      const dom = document.createElement("div");
      dom.className = "app-block";
      dom.setAttribute("data-calendar", "");
      dom.contentEditable = "false";

      const head = document.createElement("div");
      head.className = "app-head";
      const label = document.createElement("span");
      label.textContent = "📅 Google Calendar · live";
      const gear = document.createElement("button");
      gear.className = "app-btn";
      gear.textContent = "change calendar";
      gear.onclick = () => {
        const next = window.prompt("Google Calendar embed URL:", node.attrs.src);
        if (next != null && typeof getPos === "function") {
          editor.chain().command(({ tr }: any) => { tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, src: next }); return true; }).run();
        }
      };
      head.appendChild(label);
      head.appendChild(gear);

      const frame = document.createElement("iframe");
      frame.src = node.attrs.src;
      frame.style.width = "100%";
      frame.style.height = "600px";
      frame.style.border = "0";
      frame.setAttribute("frameborder", "0");

      dom.appendChild(head);
      dom.appendChild(frame);
      // let the iframe + button be fully interactive; don't let ProseMirror intercept
      return { dom, stopEvent: () => true, ignoreMutation: () => true };
    };
  },
});

// ---- HTML note prep: lift <style> into the page, return the editable body ----
let preservedStyles = "";
function prepareHtml(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  preservedStyles = Array.from(doc.querySelectorAll("style")).map((s) => s.outerHTML).join("\n");
  if (preservedStyles) {
    const holder = document.createElement("div");
    holder.innerHTML = preservedStyles;
    document.head.append(...Array.from(holder.children));
  }
  const container = (doc.querySelector("article, main") as HTMLElement) || doc.body;
  return container.innerHTML;
}

const extensions: any[] = [StarterKit, RichBlock, CalendarBlock];
let content = note.content;
if (note.format === "md") extensions.push(Markdown.configure({ html: true, linkify: true }));
else if (note.format === "html") content = prepareHtml(note.content);

const editor = new Editor({ element: mount, extensions, content, autofocus: "end" });
(window as any).__editor = editor;

// Toolbar: insert a live Google Calendar block (the dynamic-block proof).
const bar = document.querySelector(".bar");
if (bar) {
  const btn = document.createElement("button");
  btn.className = "bar-btn";
  btn.textContent = "+ Calendar";
  btn.onclick = () => {
    const def = "https://calendar.google.com/calendar/embed?src=benjamingonzales121102%40gmail.com&ctz=America%2FLos_Angeles";
    const url = window.prompt("Paste your Google Calendar embed URL\n(Calendar settings → Settings for my calendars → Integrate calendar → Embed code's src, or the public URL). Default is your primary calendar:", def);
    if (url) editor.chain().focus().insertContent({ type: "calendarBlock", attrs: { src: url } }).run();
  };
  bar.appendChild(btn);
}

// ---- cmd+K (Model B): AI edit the selection, or the selected rich block ----
const cmdk = document.createElement("div");
cmdk.className = "cmdk";
cmdk.innerHTML = '<input type="text" placeholder="Ask AI… (Enter to run, Esc to cancel)"><div class="cmdk-hint"></div>';
document.body.appendChild(cmdk);
const cmdkInput = cmdk.querySelector("input") as HTMLInputElement;
const cmdkHint = cmdk.querySelector(".cmdk-hint") as HTMLElement;
let cmdkTarget: any = null;

function docContext(): string {
  if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); }
  return editor.getHTML();
}
function openCmdk() {
  const sel: any = editor.state.selection;
  if (sel.node && sel.node.type.name === "richBlock") {
    cmdkTarget = { mode: "rich", pos: sel.from, attrs: sel.node.attrs };
    cmdkHint.textContent = "rewrite this rich block (e.g. “make the grid 6×6”)";
  } else {
    const text = editor.state.doc.textBetween(sel.from, sel.to, " ");
    cmdkTarget = { mode: "prose", from: sel.from, to: sel.to, text };
    cmdkHint.textContent = text ? ('"' + text.slice(0, 50) + (text.length > 50 ? "…" : "") + '"') : "insert at cursor";
  }
  let left = 40, top = 120;
  const s = window.getSelection();
  if (s && s.rangeCount && String(s)) { const r = s.getRangeAt(0).getBoundingClientRect(); if (r.width || r.height) { left = r.left; top = r.bottom + window.scrollY + 8; } }
  cmdk.style.left = Math.max(12, Math.min(left, window.innerWidth - 372)) + "px";
  cmdk.style.top = top + "px";
  cmdk.classList.add("show");
  cmdkInput.value = ""; cmdkInput.disabled = false; cmdkInput.focus();
}
function closeCmdk() { cmdk.classList.remove("show"); cmdkTarget = null; }

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openCmdk(); }
  else if (e.key === "Escape" && cmdk.classList.contains("show")) closeCmdk();
});
cmdkInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || !cmdkTarget || !cmdkInput.value.trim()) return;
  const intent = cmdkInput.value.trim();
  const t = cmdkTarget;
  cmdkInput.disabled = true; cmdkHint.textContent = "thinking with your Claude…";
  const prompt = t.mode === "rich"
    ? "You are editing one rich HTML block inside a note. Rewrite its INNER HTML per the instruction. Output ONLY the resulting inner HTML — no explanation, no code fences.\n\nInstruction: " + intent + "\n\nCurrent inner HTML:\n" + t.attrs.html
    : "You are editing a note. Rewrite the selected text per the instruction. Output ONLY the replacement as plain prose — no markdown, no fences, no explanation. Use the rest of the note as context.\n\nInstruction: " + intent + "\n\nSelected text:\n" + (t.text || "(none — generate new text to insert)") + "\n\nFull note for context:\n" + docContext().slice(0, 8000);
  try {
    const r = await fetch("/rewrite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) }).then((x) => x.json());
    if (!r.ok || !r.text) { cmdkInput.disabled = false; cmdkHint.textContent = "failed: " + (r.error || "empty"); return; }
    if (t.mode === "rich") {
      editor.chain().command(({ tr }: any) => { tr.setNodeMarkup(t.pos, undefined, { ...t.attrs, html: r.text }); return true; }).run();
    } else {
      editor.chain().focus().insertContentAt({ from: t.from, to: t.to }, r.text).run();
    }
    closeCmdk(); flash("rewritten → saved");
  } catch { cmdkInput.disabled = false; cmdkHint.textContent = "failed"; }
});

function serialize(): string {
  if (note.format === "md") {
    const s: any = editor.storage;
    return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText();
  }
  const body = editor.getHTML();
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n${preservedStyles}\n</head>\n<body><article>\n${body}\n</article></body></html>\n`;
}

const toast = document.createElement("div");
toast.className = "toast";
document.body.appendChild(toast);
function flash(msg: string, ok = true) {
  toast.textContent = msg;
  (toast.style as any).background = ok ? "var(--win)" : "var(--risk)";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1200);
}

let lastSaved = serialize();
let timer: ReturnType<typeof setTimeout>;
async function save() {
  const out = serialize();
  if (out === lastSaved) return;
  try {
    const r = await fetch("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: note.file, content: out }),
    }).then((x) => x.json());
    if (r.ok) { lastSaved = out; flash("saved → source"); } else flash("save failed", false);
  } catch { flash("save failed", false); }
}
editor.on("update", () => { clearTimeout(timer); timer = setTimeout(save, 600); });

// ---- Sidebar: every note in the current folder (the "vault") ----
(function renderSidebar() {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const dir = note.file.replace(/\/[^/]+$/, "");
  const vault = dir.split("/").pop() || dir;
  fetch("/list?dir=" + encodeURIComponent(dir))
    .then((r) => r.json())
    .then(({ files }: any) => {
      sb.innerHTML = "";
      const head = document.createElement("div");
      head.className = "vault";
      head.textContent = "📁 " + vault;
      sb.appendChild(head);
      const nb = document.createElement("button");
      nb.className = "new";
      nb.textContent = "+ New note";
      nb.onclick = async () => {
        const name = window.prompt("New note name:", "untitled");
        if (!name) return;
        const path = dir + "/" + name.replace(/[^a-zA-Z0-9 _-]/g, "").trim() + ".md";
        await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: path, content: "# " + name + "\n\n" }) });
        location.href = "/?file=" + encodeURIComponent(path);
      };
      sb.appendChild(nb);
      (files || []).forEach((f: any) => {
        const a = document.createElement("a");
        a.className = "note-link" + (f.path === note.file ? " active" : "");
        a.href = "/?file=" + encodeURIComponent(f.path);
        a.textContent = f.rel;
        a.title = f.rel;
        sb.appendChild(a);
      });
    })
    .catch(() => {});
})();
