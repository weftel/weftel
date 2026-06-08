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
import { Editor, Node, Mark, Extension, InputRule } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Placeholder from "@tiptap/extension-placeholder";
import Suggestion from "@tiptap/suggestion";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { stripActive, escapeAttr, spliceBody, GENERIC_INLINE_PROPS, filterInlineStyle, proseModelable, editableModelable, nativeInsertable, tidyInsertHtml, mdLite, buildTree, countFiles, type TreeNode } from "./lib";
import { DOMSerializer } from "@tiptap/pm/model";

type Note = { file: string; format: string; content: string; root: string };
const W = window as any;
const note: Note | null = W.__NOTE__ && W.__NOTE__.file ? W.__NOTE__ : null;
const ROOT: string = (W.__NOTE__ && W.__NOTE__.root) || "";

// ============================ inline-style marks ============================
// Color/highlight/font on text stay EDITABLE PROSE (marks), not atomic blocks. These
// extend the stock marks with markdown serializers so styled text round-trips a .md file
// as inline <span>/<mark> (which Obsidian & co. render fine).
const StyledTextStyle = TextStyle.extend({
  addStorage() {
    return { markdown: { serialize: {
      open(_s: any, mark: any) {
        const a = mark.attrs || {}; const css: string[] = [];
        if (a.color) css.push("color:" + a.color);
        if (a.fontFamily) css.push("font-family:" + a.fontFamily);
        if (a.fontSize) css.push("font-size:" + a.fontSize);
        return css.length ? '<span style="' + css.join(";") + '">' : "";
      },
      close(_s: any, mark: any) { const a = mark.attrs || {}; return (a.color || a.fontFamily || a.fontSize) ? "</span>" : ""; },
      mixable: true, expelEnclosingWhitespace: true,
    } } };
  },
});
const StyledHighlight = Highlight.extend({
  addStorage() {
    return { markdown: { serialize: {
      open(_s: any, mark: any) { const c = mark.attrs && mark.attrs.color; return c ? '<mark style="background-color:' + c + '">' : "<mark>"; },
      close() { return "</mark>"; },
      mixable: true, expelEnclosingWhitespace: true,
    } } };
  },
});

// GENERIC carrier mark: preserves ANY whitelisted inline text-presentation CSS (font,
// size, spacing, …) as an editable mark, so styled words stay editable prose without a
// hard-coded mark per property. Only claims a span if it carries a whitelisted prop;
// color/weight/etc. are left to their specific marks (composes — they nest cleanly).
const InlineStyle = Mark.create({
  name: "inlineStyle",
  addAttributes() { return { style: { default: null, parseHTML: (el: any) => filterInlineStyle(el.getAttribute("style") || ""), renderHTML: (attrs: any) => (attrs.style ? { style: attrs.style } : {}) } }; },
  parseHTML() { return [{ tag: "span[style]", getAttrs: (el: any) => (filterInlineStyle(el.getAttribute("style") || "") ? null : false) }]; },
  renderHTML({ HTMLAttributes }: any) { return ["span", HTMLAttributes, 0]; },
  addStorage() {
    return { markdown: { serialize: {
      open(_s: any, mark: any) { return mark.attrs.style ? '<span style="' + mark.attrs.style + '">' : ""; },
      close(_s: any, mark: any) { return mark.attrs.style ? "</span>" : ""; },
      mixable: true, expelEnclosingWhitespace: true,
    } } };
  },
});

// ============================ custom nodes ============================
// (b) Styled box — a <div> carrying its INLINE style, with editable block content inside.
// Lets bespoke HTML designs (stat cards, comparisons…) be editable prose in a preserved
// layout instead of a frozen rich block. Serializes the whole subtree as one raw-HTML blob
// so nested boxes round-trip cleanly (esp. in markdown).
const StyledBox = Node.create({
  name: "styledBox", group: "block", content: "block+", defining: true,
  addAttributes() { return { style: { default: null, parseHTML: (el: any) => el.getAttribute("style"), renderHTML: (a: any) => (a.style ? { style: a.style } : {}) } }; },
  parseHTML() { return [{ tag: "div", getAttrs: (el: any) => (!el.getAttribute("class") && el.getAttribute("style") ? {} : false) }]; },
  renderHTML({ HTMLAttributes }: any) { return ["div", { ...HTMLAttributes, "data-sbox": "" }, 0]; },
  addStorage() {
    return { markdown: { serialize(state: any, node: any) {
      const dom = DOMSerializer.fromSchema(node.type.schema).serializeNode(node) as HTMLElement;
      dom.querySelectorAll("[data-sbox]").forEach((e) => e.removeAttribute("data-sbox")); dom.removeAttribute("data-sbox");
      state.write(dom.outerHTML); state.closeBlock(node);
    } } };
  },
});

const richMd = { markdown: { serialize(state: any, node: any) { state.write("<div data-rich-block>" + (node.attrs.html || "") + "</div>"); state.closeBlock(node); } } };

const RichBlock = Node.create({
  name: "richBlock", group: "block", atom: true, selectable: true, draggable: true,
  addAttributes() { return { html: { default: "", parseHTML: (el: any) => stripActive(el.innerHTML), renderHTML: () => ({}) } }; },
  addStorage() { return richMd; },
  // If the block's content is fully prose-modelable, REJECT the atomic rule (getAttrs:false)
  // so TipTap parses the inner HTML as editable prose+marks instead. Shrinks the atomic set.
  parseHTML() { return [{ tag: "div[data-rich-block]", getAttrs: (el: any) => (editableModelable(el.innerHTML) ? false : null) }]; },
  renderHTML({ node }: any) { const d = document.createElement("div"); d.setAttribute("data-rich-block", ""); d.innerHTML = node.attrs.html; return d; },
  addNodeView() {
    return ({ node }: any) => {
      const d = document.createElement("div"); d.setAttribute("data-rich-block", ""); d.className = "rich-block"; d.contentEditable = "false";
      // Render the (already-sanitized) HTML + the doc's styles in a SHADOW ROOT so the
      // content's CSS is fully contained — it can't reach out and restyle the editor.
      const shadow = d.attachShadow({ mode: "open" });
      shadow.innerHTML = (RICH_STYLES || "") + (node.attrs.html || "");
      return { dom: d };
    };
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
  addStorage() { return { markdown: { serialize(state: any, node: any) { state.write(`<div data-calendar data-src="${escapeAttr(node.attrs.src)}"></div>`); state.closeBlock(node); } } }; },
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
  addStorage() { return { markdown: { serialize(state: any, node: any) { state.write(`<div data-clock data-tz="${escapeAttr(node.attrs.tz)}"></div>`); state.closeBlock(node); } } }; },
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

// Callout: a styled, editable container (info/warn/tip). Holds real prose, so it's a
// content node, not an atom. Serializes to an HTML <div data-callout> with a blank line
// before/after the inner content so markdown-it re-parses the inside as markdown on load
// (the div wrapper round-trips via parseHTML).
const CALLOUT_KINDS: Record<string, { icon: string; label: string }> = {
  info: { icon: "ℹ", label: "Info" }, tip: { icon: "✦", label: "Tip" }, warn: { icon: "▲", label: "Warning" },
};
const Callout = Node.create({
  name: "callout", group: "block", content: "block+", defining: true,
  addAttributes() { return { kind: { default: "info", parseHTML: (el: any) => el.getAttribute("data-kind") || "info", renderHTML: (a: any) => ({ "data-kind": a.kind }) } }; },
  addStorage() {
    return { markdown: { serialize(state: any, node: any) {
      state.write(`<div data-callout data-kind="${escapeAttr(node.attrs.kind)}">\n\n`);
      state.renderContent(node);
      state.write(`</div>`); state.closeBlock(node);
    } } };
  },
  parseHTML() { return [{ tag: "div[data-callout]" }]; },
  renderHTML({ node, HTMLAttributes }: any) { return ["div", { ...HTMLAttributes, "data-callout": "", class: "callout callout-" + node.attrs.kind }, 0]; },
  addNodeView() {
    return ({ node }: any) => {
      const dom = document.createElement("div"); dom.className = "callout callout-" + node.attrs.kind; dom.setAttribute("data-callout", ""); dom.setAttribute("data-kind", node.attrs.kind);
      const icon = document.createElement("div"); icon.className = "callout-icon"; icon.contentEditable = "false"; icon.textContent = (CALLOUT_KINDS[node.attrs.kind] || CALLOUT_KINDS.info).icon;
      const content = document.createElement("div"); content.className = "callout-body";
      dom.appendChild(icon); dom.appendChild(content);
      return { dom, contentDOM: content };
    };
  },
});

// Markdown-style shortcuts for to-dos: "[] ", "[ ] ", or "[x] " at the start of a line
// turns the line into a checklist item.
const TaskInputRule = Extension.create({
  name: "taskInputRule",
  addInputRules() {
    return [new InputRule({
      find: /^\[( |x|X)?\]\s$/,
      handler: ({ state, range, match, chain }: any) => {
        const checked = (match[1] || "").toLowerCase() === "x";
        chain().deleteRange(range).toggleList("taskList", "taskItem").run();
        if (checked) chain().updateAttributes("taskItem", { checked: true }).run();
      },
    })];
  },
});

// Slash menu. Cross-references into the main scope (Ask AI → cmd+K, calendar prompt)
// go through this hooks object, populated once the editor + helpers exist.
const slashHooks: { askAI?: () => void; insertEmbed?: (k: string) => void } = {};
type SlashItem = { title: string; group: string; hint?: string; aliases?: string; run: (editor: any, range: any) => void };
const del = (editor: any, range: any) => editor.chain().focus().deleteRange(range);
const SLASH_ITEMS: SlashItem[] = [
  { title: "Text", group: "Writing", aliases: "paragraph body", run: (e, r) => del(e, r).setNode("paragraph").run() },
  { title: "Heading 1", group: "Writing", hint: "#", aliases: "title h1", run: (e, r) => del(e, r).setNode("heading", { level: 1 }).run() },
  { title: "Heading 2", group: "Writing", hint: "##", aliases: "h2 subtitle", run: (e, r) => del(e, r).setNode("heading", { level: 2 }).run() },
  { title: "Heading 3", group: "Writing", hint: "###", aliases: "h3", run: (e, r) => del(e, r).setNode("heading", { level: 3 }).run() },
  { title: "Bullet list", group: "Writing", hint: "-", aliases: "unordered ul", run: (e, r) => del(e, r).toggleBulletList().run() },
  { title: "Numbered list", group: "Writing", hint: "1.", aliases: "ordered ol", run: (e, r) => del(e, r).toggleOrderedList().run() },
  { title: "To-do", group: "Writing", hint: "[]", aliases: "task checkbox todo", run: (e, r) => del(e, r).toggleList("taskList", "taskItem").run() },
  { title: "Quote", group: "Writing", hint: ">", aliases: "blockquote", run: (e, r) => del(e, r).toggleBlockquote().run() },
  { title: "Callout", group: "Writing", aliases: "info note admonition", run: (e, r) => del(e, r).insertContent({ type: "callout", attrs: { kind: "info" }, content: [{ type: "paragraph" }] }).run() },
  { title: "Table", group: "Writing", aliases: "grid", run: (e, r) => del(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { title: "Code block", group: "Writing", hint: "```", aliases: "pre monospace", run: (e, r) => del(e, r).toggleCodeBlock().run() },
  { title: "Divider", group: "Writing", hint: "---", aliases: "hr rule separator", run: (e, r) => del(e, r).setHorizontalRule().run() },
  { title: "Rich HTML block", group: "Embeds", aliases: "html custom design", run: (e, r) => { del(e, r).run(); slashHooks.insertEmbed?.("rich"); } },
  { title: "Calendar", group: "Embeds", aliases: "gcal google schedule", run: (e, r) => { del(e, r).run(); slashHooks.insertEmbed?.("calendar"); } },
  { title: "Clock", group: "Embeds", aliases: "time live", run: (e, r) => { del(e, r).run(); slashHooks.insertEmbed?.("clock"); } },
  { title: "Write with AI…", group: "AI", aliases: "generate cmdk diagram ask", run: (e, r) => { del(e, r).run(); slashHooks.askAI?.(); } },
];
function filterSlash(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((it) => (it.title + " " + (it.aliases || "")).toLowerCase().includes(q));
}
const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [Suggestion({
      editor: this.editor,
      char: "/",
      startOfLine: false,
      // only trigger at the start of a block or after whitespace, so "6/5" or "and/or" don't pop the menu
      allow: ({ state, range }: any) => {
        const before = state.doc.textBetween(Math.max(0, range.from - 1), range.from, "\n", "\n");
        return before === "" || /\s/.test(before);
      },
      command: ({ editor, range, props }: any) => props.run(editor, range),
      items: ({ query }: any) => filterSlash(query),
      render: () => {
        let el: HTMLElement | null = null; let items: SlashItem[] = []; let sel = 0; let pick: ((i: SlashItem) => void) | null = null;
        const destroy = () => { el?.remove(); el = null; };
        const paint = () => {
          if (!el) return;
          if (!items.length) { el.innerHTML = '<div class="slash-empty">No matches</div>'; return; }
          let html = ""; let lastGroup = "";
          items.forEach((it, i) => {
            if (it.group !== lastGroup) { html += '<div class="slash-group">' + it.group + "</div>"; lastGroup = it.group; }
            html += '<div class="slash-item' + (i === sel ? " sel" : "") + '" data-i="' + i + '"><span class="t">' + it.title + "</span>" + (it.hint ? '<span class="k">' + it.hint + "</span>" : "") + "</div>";
          });
          el.innerHTML = html;
          el.querySelectorAll(".slash-item").forEach((n) => {
            n.addEventListener("mousedown", (ev) => { ev.preventDefault(); const i = Number((n as HTMLElement).dataset.i); if (items[i] && pick) pick(items[i]); });
            n.addEventListener("mousemove", () => { sel = Number((n as HTMLElement).dataset.i); paint(); });
          });
          const cur = el.querySelector(".slash-item.sel"); if (cur) (cur as HTMLElement).scrollIntoView({ block: "nearest" });
        };
        const place = (rect: any) => { if (!el || !rect) return; const r = rect(); if (!r) return; el.style.left = Math.min(r.left, window.innerWidth - 280) + "px"; el.style.top = (r.bottom + window.scrollY + 6) + "px"; };
        return {
          onStart: (props: any) => {
            items = props.items; sel = 0; pick = props.command;
            el = document.createElement("div"); el.className = "slash"; document.body.appendChild(el);
            paint(); place(props.clientRect);
          },
          onUpdate: (props: any) => { items = props.items; pick = props.command; if (sel >= items.length) sel = 0; paint(); place(props.clientRect); },
          onKeyDown: (props: any) => {
            const k = props.event.key;
            if (k === "ArrowDown") { sel = (sel + 1) % Math.max(items.length, 1); paint(); return true; }
            if (k === "ArrowUp") { sel = (sel - 1 + items.length) % Math.max(items.length, 1); paint(); return true; }
            if (k === "Enter") { if (items[sel] && pick) pick(items[sel]); return true; }
            if (k === "Escape") { destroy(); return true; }
            return false;
          },
          onExit: destroy,
        };
      },
    })];
  },
});

// ============================ html load/save (lossless) ============================
const PROSE_TAGS = new Set(["H1","H2","H3","H4","H5","H6","P","UL","OL","BLOCKQUOTE","PRE","HR","TABLE"]);
let htmlTemplate: string | null = null; // full original doc with %%NOTE_BODY%% where editable content goes
let BODY_TOKEN = "%%NOTE_BODY%%"; // reassigned per-load to a collision-free value (see prepareHtml)
let RICH_STYLES = ""; // an imported doc's <style> blocks — injected into each rich block's SHADOW root (scoped, no global leak)

function prepareHtml(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  // Preserve every <style>/<script> by relocating into <head> BEFORE tokenizing the
  // body — otherwise styles living inside <body>/<article> get wiped on save.
  doc.querySelectorAll("style, script").forEach((el) => doc.head.appendChild(el));
  // Capture the doc's styles to inject into each rich block's SHADOW root — scoped, so
  // they render the content but NEVER leak into the editor chrome (the white-bg bug).
  // Rewrite :root → :host so a doc's custom props (e.g. --font-mono) resolve in the shadow.
  RICH_STYLES = Array.from(doc.querySelectorAll("style")).map((s) => "<style>" + (s.textContent || "").replace(/:root\b/g, ":host") + "</style>").join("\n");
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
  // Pick a token guaranteed not to already exist in the doc (e.g. a literal
  // "%%NOTE_BODY%%" sitting in a head comment), so serialize() splices the body into
  // exactly the right place — never the head, never a stray match.
  let tok = BODY_TOKEN, n = 0;
  while (raw.includes(tok)) tok = "%%NOTE_BODY_" + (++n) + "%%";
  BODY_TOKEN = tok;
  container.innerHTML = tok;
  htmlTemplate = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  return content;
}

// ============================ editor ============================
const mount = document.getElementById("editor");
let editor: Editor | null = null;

if (note && mount) {
  const extensions: any[] = [
    StarterKit,
    StyledTextStyle, Color, StyledHighlight.configure({ multicolor: true }), InlineStyle,
    TaskList, TaskItem.configure({ nested: true }), TaskInputRule,
    Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
    Callout,
    StyledBox, RichBlock, CalendarBlock, ClockBlock,
    SlashMenu,
    Placeholder.configure({ placeholder: ({ node }: any) => (node.type.name === "heading" ? "Heading" : "Write, or press “/” for commands…"), showOnlyCurrent: true }),
  ];
  let content = note.content;
  if (note.format === "md") extensions.push(Markdown.configure({ html: true, linkify: true }));
  else if (note.format === "html") { try { content = prepareHtml(note.content); } catch { htmlTemplate = null; content = note.content; } }

  editor = new Editor({ element: mount, extensions, content, autofocus: "end" });
  W.__editor = editor;

  // -------- serialize --------
  const serialize = (): string => {
    if (!editor) return "";
    if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); }
    const bodyHtml = editor.getHTML();
    if (htmlTemplate) return spliceBody(htmlTemplate, BODY_TOKEN, bodyHtml);
    return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><article>\n${bodyHtml}\n</article></body></html>\n`;
  };

  // -------- toast + save status --------
  const toast = document.createElement("div"); toast.className = "toast"; document.body.appendChild(toast);
  const flash = (m: string, ok = true) => { toast.textContent = m; (toast.style as any).background = ok ? "var(--win)" : "var(--risk)"; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 1300); };
  const statusEl = document.getElementById("savestatus");
  const setStatus = (cls: string, label: string) => { if (!statusEl) return; statusEl.className = "status " + cls; const l = statusEl.querySelector(".lbl"); if (l) l.textContent = label; };

  // -------- save system: single-flight chain, flushable --------
  let lastSaved = serialize();
  let dirty = false;
  let armed = false; // never auto-save until a genuine user edit — opening/normalizing a note must NOT rewrite it
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<boolean> = Promise.resolve(true);
  // One save at a time: chain so a new save never races a /save already in flight
  // (both POST the same file; concurrent writes could otherwise land out of order).
  function actualSave(): Promise<boolean> {
    return (async () => {
      const out = serialize();
      if (out === lastSaved) { dirty = false; setStatus("saved", "Saved"); return true; }
      setStatus("saving", "Saving…");
      try {
        const r = await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: note.file, content: out }) }).then((x) => x.json());
        if (r.ok) { lastSaved = out; if (serialize() === out) { dirty = false; setStatus("saved", "Saved"); } return true; } // stay dirty if edited mid-save
        setStatus("error", "Save failed — retry"); return false;
      } catch { setStatus("error", "Save failed — retry"); return false; }
    })();
  }
  function doSave(): Promise<boolean> { saveChain = saveChain.then(actualSave, actualSave); return saveChain; }
  function scheduleSave() { if (!armed) return; dirty = true; setStatus("dirty", "Unsaved"); clearTimeout(timer); timer = setTimeout(doSave, 600); }
  async function flushSave(): Promise<boolean> { clearTimeout(timer); if (dirty) return await doSave(); await saveChain; return true; }
  editor.on("update", scheduleSave);
  setStatus("saved", "Saved");
  // Arm auto-save only on real user input. Programmatic edits (cmd+K, chat insert, block
  // insert) call markEdited() themselves. Load-time normalization fires neither, so just
  // viewing a note never writes it back to disk.
  function markEdited() { armed = true; scheduleSave(); }
  const armNow = () => { armed = true; };
  editor.view.dom.addEventListener("beforeinput", armNow);
  editor.view.dom.addEventListener("paste", armNow);
  editor.view.dom.addEventListener("cut", armNow);
  editor.view.dom.addEventListener("drop", armNow);

  // flush before leaving (covers cmd+W / refresh). sendBeacon caps payload (~64KB in
  // some engines); if it refuses, block the unload so the user keeps their edits.
  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    const out = serialize();
    let sent = false;
    try { sent = navigator.sendBeacon("/save", new Blob([JSON.stringify({ file: note.file, content: out })], { type: "application/json" })); } catch {}
    if (!sent) { e.preventDefault(); (e as any).returnValue = ""; }
  });
  // navigate helper: flush first; if the save fails, stay put so edits aren't lost
  async function go(href: string) { const ok = await flushSave(); if (!ok) { flash("save failed — staying so you don't lose edits", false); return; } location.href = href; }

  // placeholder is handled by the Placeholder extension (per-node, current line only)

  // ============================ cmd+K ============================
  const cmdk = document.createElement("div"); cmdk.className = "cmdk";
  cmdk.innerHTML = '<input type="text" placeholder="Tell AI what to edit or write… (Enter to run, Esc to cancel)"><div class="cmdk-hint"></div>';
  document.body.appendChild(cmdk);
  const cmdkInput = cmdk.querySelector("input") as HTMLInputElement;
  const cmdkHint = cmdk.querySelector(".cmdk-hint") as HTMLElement;
  let cmdkTarget: any = null;

  const docContext = (): string => { if (!editor) return ""; if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); } return editor.getHTML(); };

  function openCmdk() {
    if (!editor) return;
    const sel: any = editor.state.selection;
    if (sel.node && sel.node.type.name === "richBlock") { cmdkTarget = { mode: "rich", html: sel.node.attrs.html, pos: sel.from }; cmdkHint.textContent = "rewrite this rich block — e.g. “make the grid 6×6”"; }
    else {
      const text = editor.state.doc.textBetween(sel.from, sel.to, " ");
      if (text) { cmdkTarget = { mode: "prose", from: sel.from, to: sel.to, text }; cmdkHint.textContent = '"' + text.slice(0, 56) + (text.length > 56 ? "…" : "") + '"'; }
      else { cmdkTarget = { mode: "author", from: sel.from, to: sel.to }; cmdkHint.textContent = "add — a paragraph, or a diagram / table / chart (AI builds the HTML)"; }
    }
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
      ? "Rewrite the INNER HTML of one block per the instruction. Output the resulting inner HTML.\n\nInstruction: " + intent + "\n\nCurrent inner HTML:\n" + t.html
      : t.mode === "author"
      ? "Insert content at the cursor per the instruction — prose as text, or a structured/visual HTML fragment when appropriate.\n\nInstruction: " + intent + "\n\nNote so far (context):\n" + docContext().slice(0, 8000)
      : "Rewrite the selected text per the instruction.\n\nInstruction: " + intent + "\n\nSelected text:\n" + t.text + "\n\nNote (context):\n" + docContext().slice(0, 8000);
    try {
      // stream the result so the output appears live (perceived speed)
      const res = await fetch("/rewrite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, mode: t.mode }) });
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ""; let preview = ""; let r: any = null;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith("data: ")) continue;
          const obj = JSON.parse(line.slice(6));
          if (obj.chunk) { preview += obj.chunk; cmdkHint.textContent = preview.replace(/\s+/g, " ").trim().slice(-90) || "…"; }
          else if (obj.done) r = obj.done;
          else if (obj.error) { cmdkInput.disabled = false; cmdkHint.textContent = "failed: " + obj.error; return; }
        }
      }
      if (!r || !r.ok || !r.text) { cmdkInput.disabled = false; cmdkHint.textContent = "failed: " + ((r && r.error) || "empty"); return; }
      if (t.mode === "rich") {
        if (r.text.indexOf("<") < 0) { cmdkInput.disabled = false; cmdkHint.textContent = "AI didn't return HTML — try again"; return; }
        // trust the captured pos if it still points at this block; else re-find by content
        let pos: number | null = t.pos;
        const at = pos == null ? null : editor.state.doc.nodeAt(pos);
        if (!at || at.type.name !== "richBlock" || at.attrs.html !== t.html) pos = findRichPos(t.html);
        if (pos == null) { cmdkInput.disabled = false; cmdkHint.textContent = "block moved — try again"; return; }
        const node = editor.state.doc.nodeAt(pos);
        editor.chain().command(({ tr }: any) => { tr.setNodeMarkup(pos as number, undefined, { ...(node ? node.attrs : {}), html: r.text }); return true; }).run(); // undoable via cmd+Z
      } else if (t.mode === "author") {
        const at = Math.min(t.from, editor.state.doc.content.size);
        // prefer editable: only lock into an atomic rich block if the HTML isn't prose-modelable
        if (r.html && !nativeInsertable(r.text)) editor.chain().focus().insertContentAt(at, { type: "richBlock", attrs: { html: r.text } }).run();
        else editor.chain().focus().insertContentAt(at, tidyInsertHtml(r.text)).run();
      } else {
        const to = Math.min(t.to, editor.state.doc.content.size); const from = Math.min(t.from, to);
        editor.chain().focus().insertContentAt({ from, to }, r.text).run();
      }
      markEdited(); closeCmdk(); flash("rewritten → saved");
    } catch { cmdkInput.disabled = false; cmdkHint.textContent = "failed — try again"; }
  });

  // chat panel removed — chat is Claude Code for now (deferred). A future in-app chat will
  // be a vault-scoped Agent SDK session. (Removal kept in git history.)

  // ============================ selection toolbar (bubble) ============================
  const bubble = document.createElement("div"); bubble.className = "bubble";
  bubble.innerHTML = '<button data-a="bold" title="Bold ⌘B"><b>B</b></button>'
    + '<button data-a="italic" title="Italic ⌘I"><i>I</i></button>'
    + '<button data-a="code" title="Code"><span class="mono">&lt;&gt;</span></button>'
    + '<button data-a="link" title="Link">↗</button>'
    + '<label class="cswatch" title="Text color"><input type="color" value="#7c3aed"></label>'
    + '<button data-a="hilite" title="Highlight"><span class="hl">H</span></button>'
    + '<span class="bsep"></span>'
    + '<button data-a="ai" class="accent">✦ AI edit</button>';
  document.body.appendChild(bubble);
  const colorInput = bubble.querySelector(".cswatch input") as HTMLInputElement;
  colorInput?.addEventListener("input", () => { if (editor) { editor.chain().focus().setColor(colorInput.value).run(); markEdited(); refreshBubble(); } });
  const hideBubble = () => bubble.classList.remove("show");
  bubble.addEventListener("mousedown", (e) => e.preventDefault()); // don't blur / collapse the selection
  bubble.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    if (!editor) return;
    const a = (b as HTMLElement).dataset.a;
    if (a === "bold") editor.chain().focus().toggleBold().run();
    else if (a === "italic") editor.chain().focus().toggleItalic().run();
    else if (a === "code") editor.chain().focus().toggleCode().run();
    else if (a === "hilite") editor.chain().focus().toggleHighlight({ color: "#fde047" }).run();
    else if (a === "link") { const prev = editor.getAttributes("link").href || ""; const url = window.prompt("Link URL:", prev); if (url === null) return; if (url === "") editor.chain().focus().extendMarkRange("link").unsetLink().run(); else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run(); }
    else if (a === "ai") { hideBubble(); openCmdk(); return; }
    markEdited(); // format buttons are programmatic edits — arm the save (no beforeinput fires)
    refreshBubble();
  }));
  function refreshBubble() {
    if (!editor) return;
    ["bold", "italic", "code"].forEach((m) => { const btn = bubble.querySelector('[data-a="' + m + '"]'); if (btn) btn.classList.toggle("on", editor!.isActive(m)); });
    const hb = bubble.querySelector('[data-a="hilite"]'); if (hb) hb.classList.toggle("on", editor!.isActive("highlight"));
    const cur = editor.getAttributes("textStyle").color; if (cur && colorInput) colorInput.value = cur;
  }
  function updateBubble() {
    if (!editor || !editor.isFocused) { hideBubble(); return; }
    const selState: any = editor.state.selection;
    if (selState.node || selState.empty) { hideBubble(); return; } // skip node selections (rich blocks) + carets
    const text = editor.state.doc.textBetween(selState.from, selState.to, " ").trim();
    if (!text) { hideBubble(); return; }
    const s = window.getSelection(); if (!s || !s.rangeCount) { hideBubble(); return; }
    const r = s.getRangeAt(0).getBoundingClientRect(); if (!r.width && !r.height) { hideBubble(); return; }
    bubble.classList.add("show"); refreshBubble();
    const bw = bubble.offsetWidth || 240;
    bubble.style.left = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, window.innerWidth - bw - 8)) + "px";
    bubble.style.top = Math.max(8, r.top + window.scrollY - bubble.offsetHeight - 8) + "px";
  }
  editor.on("selectionUpdate", updateBubble);
  editor.on("blur", () => setTimeout(() => { if (!bubble.matches(":hover")) hideBubble(); }, 100));
  window.addEventListener("scroll", () => { if (bubble.classList.contains("show")) updateBubble(); }, true);

  // ============================ insert menu ============================
  function insertBlock(kind: string) {
    if (!editor) return;
    if (kind === "calendar") { const def = "https://calendar.google.com/calendar/embed?src=benjamingonzales121102%40gmail.com&ctz=America%2FLos_Angeles"; const url = window.prompt("Google Calendar embed URL:", def); if (url) { editor.chain().focus().insertContent({ type: "calendarBlock", attrs: { src: url } }).run(); markEdited(); } }
    else if (kind === "clock") { editor.chain().focus().insertContent({ type: "clockBlock", attrs: { tz: "local" } }).run(); markEdited(); }
    else if (kind === "rich") { editor.chain().focus().insertContent('<div data-rich-block><div style="padding:16px;border:1px dashed var(--border-strong);border-radius:8px;text-align:center;color:var(--muted)">empty rich block — ⌘K to fill it with AI</div></div>').run(); markEdited(); }
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
  // wire slash-menu cross-references now that openCmdk + insertBlock exist
  slashHooks.askAI = () => openCmdk();
  slashHooks.insertEmbed = (k: string) => insertBlock(k);
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

  // folder tree helpers (buildTree/countFiles) live in lib.ts (pure, unit-tested)
  // expanded-folder state survives the full-page navigations, keyed per vault.
  // We track which folders are OPEN (default: all closed) so a fresh vault starts tidy.
  function expandKey(): string { return "tree-expanded:" + ROOT; }
  function loadExpanded(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(expandKey()) || "[]")); } catch { return new Set(); } }
  function toggleExpanded(rel: string) { const s = loadExpanded(); s.has(rel) ? s.delete(rel) : s.add(rel); try { localStorage.setItem(expandKey(), JSON.stringify([...s])); } catch {} }
  // ancestor folders of the open note are always shown so the active note stays visible
  function activeAncestors(): Set<string> {
    const s = new Set<string>();
    if (!note || !note.file) return s;
    const rel = note.file.startsWith(ROOT) ? note.file.slice(ROOT.length).replace(/^\//, "") : "";
    const parts = rel.split("/");
    for (let i = 0; i < parts.length - 1; i++) s.add(parts.slice(0, i + 1).join("/"));
    return s;
  }
  // native folder picker (macOS via /pick-folder); falls back to a path prompt if unavailable
  (window as any).__pickFolder = async (): Promise<string | null> => {
    let r: any = null;
    try { r = await fetch("/pick-folder", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((x) => x.json()); } catch {}
    if (r && r.ok) return r.path;
    if (r && r.cancelled) return null;
    return window.prompt("Open a folder as your vault (absolute path):", ROOT);
  };

  // Open/switch the vault to any folder (Obsidian-style). Uses the native picker above.
  async function openVault() {
    const W2 = window as any;
    const dir = W2.__pickFolder ? await W2.__pickFolder() : window.prompt("Open a folder as your vault (absolute path):", ROOT);
    if (!dir) return;
    await flushSave();
    const r = await fetch("/open-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir }) }).then((x) => x.json());
    if (!r.ok) { flash(r.error || "couldn't open that folder", false); return; }
    go(r.first ? "/?file=" + encodeURIComponent(r.first) : "/");
  }

  function renderSidebar(filterStr = "") {
    const sb = document.getElementById("sidebar"); if (!sb) return;
    const dir = ROOT;
    sb.innerHTML = "";
    const head = document.createElement("button"); head.className = "vault"; head.title = "Switch vault — open another folder";
    head.innerHTML = '<span>📁 <span class="vname"></span></span><span class="vcaret">⌄</span>';
    (head.querySelector(".vname") as HTMLElement).textContent = dir.split("/").pop() || dir;
    head.onclick = openVault; sb.appendChild(head);
    const filter = document.createElement("input"); filter.className = "filter"; filter.placeholder = "Filter notes…"; filter.value = filterStr;
    filter.oninput = () => renderList(filter.value);
    sb.appendChild(filter);
    const nb = document.createElement("button"); nb.className = "new"; nb.textContent = "＋ New note"; nb.onclick = () => newNote(); sb.appendChild(nb);
    const list = document.createElement("div"); list.id = "notelist"; sb.appendChild(list);
    renderList(filterStr);
    function renderList(q: string) {
      const ql = q.toLowerCase();
      list.innerHTML = "";
      const filtered = allNotes.filter((f) => !ql || f.rel.toLowerCase().includes(ql) || noteTitle(f).toLowerCase().includes(ql));
      if (!filtered.length) { const e = document.createElement("div"); e.className = "note-empty"; e.textContent = ql ? "No matching notes" : "No notes yet"; list.appendChild(e); return; }
      const tree = buildTree(filtered);
      const filtering = !!ql; // while filtering, force-expand so every match is visible
      const expanded = loadExpanded();
      const pinned = activeAncestors(); // ancestors of the open note: always expanded
      renderNode(tree, 0);

      // dirs first (alpha), then files (by title); indentation by depth
      function renderNode(node: TreeNode, depth: number) {
        [...node.dirs.keys()].sort((a, b) => a.localeCompare(b)).forEach((seg) => {
          const child = node.dirs.get(seg)!;
          const isCollapsed = !filtering && !expanded.has(child.rel) && !pinned.has(child.rel);
          const row = document.createElement("div"); row.className = "folder-row"; row.style.paddingLeft = (10 + depth * 13) + "px"; row.title = child.rel;
          const car = document.createElement("span"); car.className = "fcaret"; car.textContent = isCollapsed ? "▶" : "▼";
          const ic = document.createElement("span"); ic.className = "ficon"; ic.textContent = isCollapsed ? "📁" : "📂";
          const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = seg;
          const ct = document.createElement("span"); ct.className = "fcount"; ct.textContent = String(countFiles(child));
          row.appendChild(car); row.appendChild(ic); row.appendChild(nm); row.appendChild(ct);
          const acts = document.createElement("span"); acts.className = "row-act";
          const nn = document.createElement("button"); nn.textContent = "＋"; nn.title = "New note in this folder"; nn.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); newNote(child.rel); };
          acts.appendChild(nn); row.appendChild(acts);
          row.onclick = () => { if (!filtering) { toggleExpanded(child.rel); renderList(q); } };
          list.appendChild(row);
          if (!isCollapsed) renderNode(child, depth + 1);
        });
        node.files.sort((a, b) => noteTitle(a).localeCompare(noteTitle(b))).forEach((f) => {
          const a = document.createElement("a"); a.className = "note-link" + (note && f.path === note.file ? " active" : ""); a.style.paddingLeft = (10 + depth * 13) + "px";
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
  }
  async function loadNotes() { try { const { files } = await fetch("/list?dir=" + encodeURIComponent(ROOT)).then((r) => r.json()); allNotes = files || []; renderSidebar(); } catch { renderSidebar(); } }
  async function newNote(folderRel?: string) {
    const where = folderRel ? ` (in ${folderRel}/)` : "";
    const name = window.prompt("New note name" + where + ":"); if (!name) return;
    const wantsHtml = /\.html?$/i.test(name.trim()); // decide ext from raw input…
    const clean = name.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").trim(); // …then strip the ext before cleaning so the dot doesn't get eaten
    if (!clean) { flash("invalid name", false); return; }
    const dir = folderRel ? ROOT + "/" + folderRel : ROOT;
    const path = dir + "/" + clean + (wantsHtml ? ".html" : ".md");
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
    const W2 = window as any;
    const dir = W2.__pickFolder ? await W2.__pickFolder() : window.prompt("Open folder (absolute path to your notes vault):", ROOT);
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
