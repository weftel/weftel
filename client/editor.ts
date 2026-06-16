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
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
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
import { stripActive, escapeAttr, spliceBody, GENERIC_INLINE_PROPS, filterInlineStyle, proseModelable, editableModelable, subtreeEditable, nativeInsertable, collectSvgTextLeaves, collectSvgTextRuns, collectHtmlTextLeaves, collectHtmlTextRuns, scopeCss, tidyInsertHtml, tidySaveHtml, mdLite, buildTree, countFiles, buildInteractSrcdoc, type TreeNode } from "./lib";
import { DOMSerializer } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";

type Note = { file: string; format: string; content: string; root: string; interactive?: boolean };
// FULL_PARSE (experiment): parse class/<style>-driven bespoke HTML into editable nodes —
// preserving classes and scoping the doc's <style> into the live editor — instead of
// freezing it into an atomic shadow-DOM rich block. Set false to revert to the legacy
// behavior byte-for-byte (the frozen RichBlock path below is never removed).
const FULL_PARSE = true;
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
  addAttributes() { return {
    style: { default: null, parseHTML: (el: any) => filterInlineStyle(el.getAttribute("style") || ""), renderHTML: (attrs: any) => (attrs.style ? { style: attrs.style } : {}) },
    // FULL_PARSE: a bare <span class> carries its styling via the scoped doc sheet — keep it
    // as an editable mark so classed inline text (e.g. a styled badge) stays editable.
    class: { default: null, parseHTML: (el: any) => (FULL_PARSE ? el.getAttribute("class") : null), renderHTML: (attrs: any) => (attrs.class ? { class: attrs.class } : {}) },
  }; },
  parseHTML() { return [{ tag: "span", getAttrs: (el: any) => ((filterInlineStyle(el.getAttribute("style") || "") || (FULL_PARSE && el.getAttribute("class"))) ? null : false) }]; },
  renderHTML({ HTMLAttributes }: any) { return ["span", HTMLAttributes, 0]; },
  addStorage() {
    return { markdown: { serialize: {
      open(_s: any, mark: any) { const a = mark.attrs || {}; if (!a.style && !a.class) return ""; return "<span" + (a.class ? ' class="' + a.class + '"' : "") + (a.style ? ' style="' + a.style + '"' : "") + ">"; },
      close(_s: any, mark: any) { return (mark.attrs.style || mark.attrs.class) ? "</span>" : ""; },
      mixable: true, expelEnclosingWhitespace: true,
    } } };
  },
});

// FULL_PARSE: preserve the exact emphasis tag (<b> vs <strong>, <i> vs <em>) so the note's
// own element-level CSS (e.g. `b{color:#fff}`) keeps matching after a round-trip. TipTap's
// stock Bold/Italic re-render everything as <strong>/<em>, which silently drops those rules.
const emphTag = (ok: string[]) => ({ default: null, parseHTML: (el: any) => { const t = (el.tagName || "").toLowerCase(); return ok.indexOf(t) >= 0 ? t : null; }, renderHTML: () => ({}) });
const BoldTagged = Bold.extend({
  addAttributes() { return { ...(this.parent?.() || {}), htmlTag: emphTag(["b", "strong"]) }; },
  renderHTML({ mark, HTMLAttributes }: any) { return [mark.attrs.htmlTag || "strong", HTMLAttributes, 0]; },
});
const ItalicTagged = Italic.extend({
  addAttributes() { return { ...(this.parent?.() || {}), htmlTag: emphTag(["i", "em"]) }; },
  renderHTML({ mark, HTMLAttributes }: any) { return [mark.attrs.htmlTag || "em", HTMLAttributes, 0]; },
});

// FULL_PARSE: carry `class` through the round-trip on native nodes + marks ProseMirror would
// otherwise strip it from, so classed prose (<h3 class>, <li class>, <ul class>, <strong
// class>) keeps rendering via the scoped doc sheet and saves its classes back verbatim.
const PreserveAttrs = Extension.create({
  name: "preserveClassAttr",
  addGlobalAttributes() {
    if (!FULL_PARSE) return [];
    return [{
      types: ["paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock", "horizontalRule", "table", "tableRow", "tableHeader", "tableCell", "bold", "italic", "code", "strike", "link"],
      // keepOnSplit:false — Enter at the end of <p class="lead"> must start a CLEAN
      // paragraph; carrying the class made fresh typing inherit the previous line's look.
      attributes: { class: { default: null, keepOnSplit: false, parseHTML: (el: any) => el.getAttribute("class"), renderHTML: (attrs: any) => (attrs.class ? { class: attrs.class } : {}) } },
    }];
  },
});

// ============================ custom nodes ============================
// (b) Styled box — a <div> carrying its INLINE style, with editable block content inside.
// Lets bespoke HTML designs (stat cards, comparisons…) be editable prose in a preserved
// layout instead of a frozen rich block. Serializes the whole subtree as one raw-HTML blob
// so nested boxes round-trip cleanly (esp. in markdown).
// Tags that count as inline content (so a <div> holding only these is a styled *inline* box,
// not a block container). Anything else as a child → block container (StyledBox).
const INLINE_TAGS = new Set(["A", "B", "I", "EM", "STRONG", "SPAN", "CODE", "MARK", "U", "S", "DEL", "INS", "SMALL", "SUB", "SUP", "KBD", "SAMP", "VAR", "ABBR", "CITE", "Q", "TIME", "BR"]);
const hasBlockChild = (el: any) => Array.from(el.children).some((c: any) => !INLINE_TAGS.has(c.tagName));
// data-sbox markdown serializer (shared by both styled boxes): emit the whole subtree as one
// raw-HTML blob via DOMSerializer, stripped of the editor-only data-sbox hook.
const sboxMd = { markdown: { serialize(state: any, node: any) {
  const dom = DOMSerializer.fromSchema(node.type.schema).serializeNode(node) as HTMLElement;
  dom.querySelectorAll("[data-sbox]").forEach((e) => e.removeAttribute("data-sbox")); dom.removeAttribute("data-sbox");
  state.write(dom.outerHTML); state.closeBlock(node);
} } };
// Preserve ARBITRARY data-* attributes on styled nodes (e.g. the data-p/data-t hooks a doc's own
// end-of-body <script> reads to drive tabs/toggles). data-* carry no executable content, so they're
// safe on the live editable surface — and silently dropping them broke script-driven docs on save
// (F32: the tabs no longer switched because every panel's data-p was gone). The exclusion list is
// ONLY the editor's own structural <div> markers — those that a *different* node would re-claim on
// reload (so echoing one back would flip a styled div into a rich/calendar/clock/callout block) or
// that we strip ourselves (data-sbox). Generic names a doc legitimately uses as its own hooks
// (data-type, data-id, data-src, data-state, …) are USER CONTENT and must round-trip — keeping them
// here was the whole point. (The app's companion-keyed nodes need data-calendar/clock/callout to
// match, so a lone data-kind/data-src/data-tz on a styled div is unambiguous user content.)
const APP_DATA_HOOKS = new Set(["data-sbox", "data-rich-block", "data-calendar", "data-clock", "data-callout"]);
const dataAttrs = () => ({
  data: {
    default: null,
    parseHTML: (el: any) => {
      const o: Record<string, string> = {};
      for (const a of Array.from(el.attributes) as any[]) { const n = (a.name || "").toLowerCase(); if (n.startsWith("data-") && !APP_DATA_HOOKS.has(n)) o[a.name] = a.value; }
      return Object.keys(o).length ? o : null;
    },
    renderHTML: (a: any) => a.data || {},
  },
});
const sboxAttrs = () => ({
  style: { default: null, parseHTML: (el: any) => el.getAttribute("style"), renderHTML: (a: any) => (a.style ? { style: a.style } : {}) },
  class: { default: null, parseHTML: (el: any) => el.getAttribute("class"), renderHTML: (a: any) => (a.class ? { class: a.class } : {}) },
  ...dataAttrs(),
});
const StyledBox = Node.create({
  name: "styledBox", group: "block", content: "block+", defining: true,
  addAttributes() { return sboxAttrs(); },
  // Legacy (FULL_PARSE off): only an inline-styled, class-free div. FULL_PARSE: any div with a
  // class or style AND block children — its look comes from the scoped doc sheet / inline style.
  parseHTML() { return [{ tag: "div", getAttrs: (el: any) => {
    const cls = el.getAttribute("class"); const sty = el.getAttribute("style");
    if (!FULL_PARSE) return (!cls && sty) ? {} : false;
    return ((cls || sty) && hasBlockChild(el)) ? {} : false;
  } }]; },
  renderHTML({ HTMLAttributes }: any) { return ["div", { ...HTMLAttributes, "data-sbox": "" }, 0]; },
  addStorage() { return sboxMd; },
});
// FULL_PARSE: a <div class/style> holding only inline content (e.g. `<div class="sub">text</div>`).
// Separate from StyledBox so its text isn't wrapped in a <p> (which would drift the design).
// Higher parse priority so it claims inline-only divs before StyledBox sees them.
const StyledInlineBox = Node.create({
  name: "styledInlineBox", group: "block", content: "inline*", defining: true,
  addAttributes() { return sboxAttrs(); },
  parseHTML() { return [{ tag: "div", priority: 60, getAttrs: (el: any) => {
    if (!FULL_PARSE) return false;
    const cls = el.getAttribute("class"); const sty = el.getAttribute("style");
    return ((cls || sty) && !hasBlockChild(el)) ? {} : false;
  } }]; },
  renderHTML({ HTMLAttributes }: any) { return ["div", { ...HTMLAttributes, "data-sbox": "" }, 0]; },
  addStorage() { return sboxMd; },
});

// In a SELF-FRAMED doc (own-frame) the trailing escape paragraph is a trap: a caret that
// lands there (autofocus end, click below the page) puts typing OUTSIDE the page frame,
// hard-left. Selection remapping is racy (the DOM caret can lag the state and the first
// keystroke follows the DOM), so converge on CONTENT instead: the moment the escape slot
// holds anything, fold it into the page wrapper and put the caret after it. Wherever the
// keystroke physically lands, it ends up in the page.
let OWN_FRAME = false; // set once the scoped CSS confirms the doc frames itself
const EscapeTrap = Extension.create({
  name: "escapeTrap",
  addKeyboardShortcuts() {
    return {
      // Enter in an EMPTY paragraph at the end of the page wrapper: ProseMirror's
      // liftEmptyBlock would "exit the container" (double-Enter-to-leave, sensible for
      // blockquotes) — but leaving the page means landing hard-left outside the frame.
      // Keep adding lines INSIDE the page instead.
      Enter: ({ editor: e }: any) => {
        if (!OWN_FRAME) return false;
        const { $from, empty } = e.state.selection;
        if (!empty || $from.depth !== 2 || $from.parent.type.name !== "paragraph" || $from.parent.content.size) return false;
        const box = $from.node(1);
        if (box.type.name !== "styledBox" || e.state.doc.firstChild !== box) return false;
        if ($from.index(1) !== box.childCount - 1) return false; // only at the very end
        return e.commands.splitBlock();
      },
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(trs: any[], _old: any, state: any) {
        if (!OWN_FRAME || !trs.some((t) => t.docChanged)) return null;
        const d = state.doc, fc = d.firstChild, last = d.lastChild;
        if (d.childCount !== 2 || !fc || fc.type.name !== "styledBox") return null;
        if (!last || last.type.name !== "paragraph" || !last.content.size) return null;
        const insertPos = fc.nodeSize - 1;
        const tr = state.tr;
        tr.delete(fc.nodeSize, d.content.size);
        tr.insert(insertPos, last);
        tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + last.nodeSize - 1), -1));
        return tr;
      },
    })];
  },
});

// Tab must never throw focus out of the editor ("takes me to weird places"). Lists
// indent/outdent, code blocks get a literal tab, tables keep their own cell-hopping
// (pass through), and anywhere else the key is consumed.
const TabKeys = Extension.create({
  name: "tabKeys",
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor: e }: any) => {
        if (e.isActive("table")) return false; // Table's own Tab → next cell
        if (e.isActive("codeBlock")) return e.commands.insertContent("\t");
        if (e.can().sinkListItem("taskItem")) return e.commands.sinkListItem("taskItem");
        if (e.can().sinkListItem("listItem")) return e.commands.sinkListItem("listItem");
        return true; // consume — never tab focus away mid-document
      },
      "Shift-Tab": ({ editor: e }: any) => {
        if (e.isActive("table")) return false;
        if (e.can().liftListItem("taskItem")) return e.commands.liftListItem("taskItem");
        if (e.can().liftListItem("listItem")) return e.commands.liftListItem("listItem");
        return true;
      },
    };
  },
});

// A CLASSED span is a component with element identity (<span class="pill">, badges, tags) —
// it can NOT be a mark: ProseMirror merges adjacent same-marked text (two pills collapse
// into one) and splits a marked range at every inner bold/code boundary (one span becomes
// three, shattering flex layouts). An inline NODE keeps the element's identity while the
// text inside stays editable. Style-only spans remain the InlineStyle mark.
const StyledSpan = Node.create({
  name: "styledSpan", inline: true, group: "inline", content: "inline*", defining: true,
  addAttributes() { return sboxAttrs(); },
  parseHTML() { return [{ tag: "span", priority: 65, getAttrs: (el: any) => {
    if (!FULL_PARSE || !el.getAttribute("class")) return false;          // style-only → mark
    if (!el.children.length && !(el.textContent || "").trim()) return false; // empty → DecoSpan
    return {};
  } }]; },
  renderHTML({ HTMLAttributes }: any) { return ["span", HTMLAttributes, 0]; },
  addStorage() { return { markdown: { serialize(state: any, node: any) {
    const dom = DOMSerializer.fromSchema(node.type.schema).serializeNode(node) as HTMLElement;
    state.write(dom.outerHTML);
  } } }; },
});

// Decorative EMPTY span (e.g. <span class="dot"></span>, colored/sized purely by CSS) —
// ProseMirror drops empty inline elements, which silently deleted them from saved files
// (found when a real note's status dots vanished). Modeled as an inline atom that
// round-trips class/style verbatim; the scoped doc sheet renders its look.
const DecoSpan = Node.create({
  name: "decoSpan", inline: true, group: "inline", atom: true, selectable: true,
  addAttributes() { return sboxAttrs(); },
  parseHTML() { return [{ tag: "span", priority: 70, getAttrs: (el: any) => {
    if (el.children.length || (el.textContent || "").trim()) return false;
    return (el.getAttribute("class") || el.getAttribute("style")) ? {} : false;
  } }]; },
  renderHTML({ HTMLAttributes }: any) { return ["span", HTMLAttributes]; },
  addStorage() { return { markdown: { serialize(state: any, node: any) {
    const a = node.attrs || {};
    // emit any preserved data-* too (symmetry with the HTML path; the sibling styled nodes serialize
    // theirs via DOMSerializer) so a decorative span's hooks survive a .md round-trip as well
    const dataStr = a.data ? Object.keys(a.data).map((k) => " " + k + '="' + escapeAttr(a.data[k]) + '"').join("") : "";
    state.write("<span" + (a.class ? ' class="' + escapeAttr(a.class) + '"' : "") + (a.style ? ' style="' + escapeAttr(a.style) + '"' : "") + dataStr + "></span>");
  } } }; },
});

// Native image node — a pasted/imported <img> is a first-class editable node (selectable,
// deletable, draggable), NOT a frozen rich block (closure rule: the app must re-read what
// it writes). The SAVED src stays the note-relative path (portable file); the NodeView
// displays it through /raw?file= so it renders while editing. Serialization uses
// renderHTML (original src), independent of the NodeView.
const noteDirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));
// Programmatic edits from nodeviews (e.g. image resize) must arm the autosave like any
// user input; rebound to markEdited once the editor is up.
let armEdit: () => void = () => {};
function imgDisplayUrl(src: string): string {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return src;          // web/data URLs — as-is
  const abs = src.startsWith("/") ? src : (note ? noteDirOf(note.file) : "") + "/" + src;
  return "/raw?file=" + encodeURIComponent(abs);
}
const ImageNode = Node.create({
  // INLINE: real-world images live inside paragraphs (<p><img></p>) — a block node there
  // gets dropped by the parser. Standalone imgs get wrapped in a paragraph, which is fine.
  name: "image", inline: true, group: "inline", atom: true, selectable: true, draggable: true,
  addAttributes() { return {
    src: { default: "" },
    alt: { default: null, renderHTML: (a: any) => (a.alt ? { alt: a.alt } : {}) },
    width: { default: null, renderHTML: (a: any) => (a.width ? { width: a.width } : {}) },
  }; },
  parseHTML() { return [{ tag: "img[src]", getAttrs: (el: any) => ({ src: el.getAttribute("src") || "", alt: el.getAttribute("alt"), width: el.getAttribute("width") }) }]; },
  renderHTML({ HTMLAttributes }: any) { return ["img", HTMLAttributes]; },
  addStorage() { return { markdown: { serialize(state: any, node: any) {
    // a resized image needs the width attr — md image syntax can't carry it, raw <img> can
    // (html:true round-trips it back into this node)
    if (node.attrs.width) {
      const esc = (s: any) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      state.write('<img src="' + esc(node.attrs.src || "") + '"' + (node.attrs.alt ? ' alt="' + esc(node.attrs.alt) + '"' : "") + ' width="' + esc(node.attrs.width) + '">');
    } else state.write("![" + (node.attrs.alt || "") + "](" + (node.attrs.src || "") + ")");
  } } }; },
  addNodeView() {
    return ({ node, editor, getPos }: any) => {
      let cur = node;
      const wrap = document.createElement("span"); wrap.className = "note-img-wrap";
      const img = document.createElement("img"); img.className = "note-img"; img.draggable = false;
      const sync = (n: any) => {
        img.src = imgDisplayUrl(n.attrs.src);
        if (n.attrs.alt) img.alt = n.attrs.alt; else img.removeAttribute("alt");
        if (n.attrs.width) img.setAttribute("width", n.attrs.width); else img.removeAttribute("width");
      };
      sync(node);
      // corner drag-handle (F11): live-preview via style.width, commit the rounded px to the
      // node's width attr on release so it persists in the saved file.
      const handle = document.createElement("span"); handle.className = "note-img-handle"; handle.title = "Drag to resize";
      handle.addEventListener("mousedown", (e: MouseEvent) => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX, startW = img.getBoundingClientRect().width;
        wrap.classList.add("resizing");
        const wAt = (ev: MouseEvent) => Math.max(40, Math.round(startW + (ev.clientX - startX)));
        const onMove = (ev: MouseEvent) => { img.style.width = wAt(ev) + "px"; };
        const onUp = (ev: MouseEvent) => {
          document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
          wrap.classList.remove("resizing"); img.style.width = "";
          armEdit();
          editor.commands.command(({ tr }: any) => { tr.setNodeMarkup(getPos(), undefined, { ...cur.attrs, width: String(wAt(ev)) }); return true; });
        };
        document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
      });
      wrap.append(img, handle);
      return {
        dom: wrap,
        update(n: any) { if (n.type.name !== "image") return false; cur = n; sync(n); return true; },
        selectNode() { wrap.classList.add("sel"); },
        deselectNode() { wrap.classList.remove("sel"); },
        ignoreMutation: () => true,
      };
    };
  },
});

const richMd = { markdown: { serialize(state: any, node: any) { state.write("<div data-rich-block>" + (node.attrs.html || "") + "</div>"); state.closeBlock(node); } } };

const RichBlock = Node.create({
  name: "richBlock", group: "block", atom: true, selectable: true, draggable: true,
  addAttributes() { return { html: { default: "", parseHTML: (el: any) => stripActive(el.innerHTML), renderHTML: () => ({}) } }; },
  addStorage() { return richMd; },
  // If the block's content is fully prose-modelable, REJECT the atomic rule (getAttrs:false)
  // so TipTap parses the inner HTML as editable prose+marks instead. Shrinks the atomic set.
  // A block that is EMPTY after sanitization (e.g. it held only a stripped <iframe>) is also
  // rejected — otherwise an empty frozen husk lingers in the editor and the saved file.
  parseHTML() { return [{ tag: "div[data-rich-block]", getAttrs: (el: any) => {
    if (!stripActive(el.innerHTML).trim()) return false;
    return editableModelable(el.innerHTML, FULL_PARSE) ? false : null;
  } }]; },
  renderHTML({ node }: any) { const d = document.createElement("div"); d.setAttribute("data-rich-block", ""); d.innerHTML = node.attrs.html; return d; },
  addNodeView() {
    return ({ node, editor, getPos }: any) => {
      const d = document.createElement("div"); d.setAttribute("data-rich-block", ""); d.className = "rich-block"; d.contentEditable = "false";
      // Render the (already-sanitized) HTML + the doc's styles in a SHADOW ROOT so the
      // content's CSS is fully contained — it can't reach out and restyle the editor.
      const shadow = d.attachShadow({ mode: "open" });
      let currentHtml = node.attrs.html || "";
      let contentNodes: ChildNode[] = []; // the live content top-level nodes (NOT the injected <style>s)
      // The single floating overlay editor for an SVG text leaf — or an HTML MIXED RUN (a direct
      // text node, which can't be made contentEditable in isolation) — currently being edited. A
      // leaf is an Element (a whole <text>/<tspan>/<textPath> run) or a Text node; both expose
      // textContent for read + write.
      let overlay: HTMLInputElement | null = null, overlayLeaf: Node | null = null, overlayOrig = "", overlayBlur: (() => void) | null = null, committing = false;
      // F36: the HTML element leaf currently edited IN PLACE via contentEditable (better fidelity +
      // multi-line than the SVG overlay input; Chromium WILL caret HTML text). Null when none active.
      let activeLeaf: HTMLElement | null = null, activeLeafOrig = "", activeLeafHandlers: (() => void) | null = null;
      // Geometry/style for either leaf kind: a Text node has no box of its own, so measure it
      // with a Range and read its font off the parent element.
      const elementOf = (n: Node): Element => (n.nodeType === 1 ? (n as Element) : (n.parentElement as Element));
      const rectOf = (n: Node): DOMRect => { if (n.nodeType === 1) return (n as Element).getBoundingClientRect(); const r = document.createRange(); r.selectNode(n); return r.getBoundingClientRect(); };

      // Re-serialize ONLY the content (styles are injected fresh each render, never saved).
      // Editing a leaf changes just its text node, so EVERY surrounding byte is preserved —
      // elements verbatim, and comment nodes (e.g. an exporter banner) kept too.
      const contentHtml = () => contentNodes.map((n) =>
        n.nodeType === 1 ? (n as Element).outerHTML
        : n.nodeType === 8 ? "<!--" + ((n as any).data || "") + "-->"
        : (n.textContent || "")).join("");

      // The ONE shared commit body for every leaf kind (SVG overlay, HTML mixed-run overlay, HTML
      // in-place contentEditable). Writes new text into the single leaf node, re-serializes the
      // verbatim block (only that node changed), and pushes an undoable markup update. Reading the
      // leaf's textContent — never innerHTML — is the security guarantee: any markup the browser or a
      // paste slipped into a contentEditable leaf is discarded, so typed `<script>` persists as inert
      // escaped TEXT and can never execute on reload.
      const commitLeaf = (leaf: Node, newText: string): void => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (typeof pos !== "number") return;                  // node torn down / moved → drop the edit, never throw
        leaf.textContent = newText;                           // single clean text node — no contentEditable cruft
        const newHtml = stripActive(contentHtml());           // matches the reload-parse form exactly (idempotent)
        currentHtml = newHtml;                                // mark as ours so update() skips a redundant rebuild
        editor.commands.command(({ tr }: any) => { tr.setNodeMarkup(pos, undefined, { html: newHtml }); return true; }); // undoable via ⌘Z
        armEdit();
      };

      // SILENT close — detach the blur listener BEFORE removing the input, so tearing the
      // overlay down (render / destroy / leaf-switch) can never re-enter as a phantom commit.
      const closeOverlay = () => {
        if (!overlay) return;
        if (overlayBlur) overlay.removeEventListener("blur", overlayBlur);
        overlay.remove(); overlay = null; overlayLeaf = null; overlayBlur = null;
      };
      // Commit the overlay's text into the SVG string, then close. No-op when unchanged —
      // compared against the input's OWN initial value (the browser may normalize it, e.g. strip
      // newlines), so merely focusing+blurring a whitespace/multi-line leaf never churns the file.
      const commitOverlay = () => {
        if (!overlay || committing) return;
        committing = true;
        try {
          const leaf = overlayLeaf, val = overlay.value;
          closeOverlay();
          if (!leaf || val === overlayOrig) return;             // untouched → leave the bytes exactly as they were
          commitLeaf(leaf, val);
        } finally { committing = false; }
      };

      // K1: open a floating plain-text editor over an SVG <text>/<tspan> leaf on DOUBLE-CLICK.
      // Single click still node-selects the whole block (⌘K rewrite / drag) — only dblclick edits.
      // (contentEditable doesn't work on SVG text in Chromium, so we edit via this overlay input
      // and write the result straight back into the verbatim SVG string.)
      function openOverlay(leaf: Node) {
        bankPending(); // bank any in-progress edit (overlay or in-place leaf) on a sibling first
        const rect = rectOf(leaf);
        const cs = getComputedStyle(elementOf(leaf));
        const input = document.createElement("input"); input.type = "text"; input.className = "svgtext-overlay";
        input.value = leaf.textContent || "";
        overlayOrig = input.value; // capture AFTER the browser normalizes the value
        input.style.cssText = "position:absolute;z-index:80;box-sizing:border-box;"
          + "left:" + (window.scrollX + rect.left - 5) + "px;top:" + (window.scrollY + rect.top - 3) + "px;"
          + "min-width:" + Math.max(34, Math.round(rect.width) + 18) + "px;height:" + (Math.max(16, Math.round(rect.height)) + 8) + "px;"
          + "font-size:" + (cs.fontSize || "14px") + ";font-family:" + (cs.fontFamily || "inherit") + ";"
          + "padding:1px 4px;border:1px solid var(--accent);border-radius:5px;background:var(--surface);color:var(--text);"
          + "box-shadow:0 6px 22px rgba(0,0,0,.22);outline:none;text-align:center";
        overlay = input; overlayLeaf = leaf; overlayBlur = commitOverlay;
        input.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") { e.preventDefault(); commitOverlay(); }
          else if (e.key === "Escape") { e.preventDefault(); closeOverlay(); editor.commands.focus(); }
        });
        input.addEventListener("blur", overlayBlur);
        document.body.appendChild(input);
        input.focus(); input.select();
      }

      // F36: edit an HTML element leaf (a <figcaption>/<div>/<p>/<li>… holding only text) IN PLACE
      // via contentEditable — caret lands in the real styled box (fidelity + natural wrapping), no
      // floating overlay needed. SILENT close: detach listeners + strip the transient
      // contentEditable attr BEFORE clearing state, so the re-serialized block stays attribute-clean
      // and a teardown can never re-enter as a phantom commit.
      let committingLeaf = false;
      const closeActiveLeaf = () => {
        if (!activeLeaf) return;
        if (activeLeafHandlers) activeLeafHandlers();
        activeLeaf.removeAttribute("contenteditable"); activeLeaf.removeAttribute("spellcheck");
        activeLeaf = null; activeLeafHandlers = null;
      };
      const commitActiveLeaf = () => {
        if (!activeLeaf || committingLeaf) return;
        committingLeaf = true;
        try {
          const leaf = activeLeaf, val = activeLeaf.textContent || ""; // textContent ONLY — never innerHTML (drops any stray markup/paste)
          closeActiveLeaf();
          if (val === activeLeafOrig) return;                  // untouched → byte-identical, no churn
          commitLeaf(leaf, val);
        } finally { committingLeaf = false; }
      };
      // Commit ANY in-progress edit (overlay or in-place leaf) before opening a new one or rendering.
      const bankPending = () => { commitOverlay(); commitActiveLeaf(); };
      function openLeaf(leaf: HTMLElement) {
        bankPending();
        activeLeaf = leaf; activeLeafOrig = leaf.textContent || "";
        leaf.setAttribute("contenteditable", "true"); leaf.setAttribute("spellcheck", "false");
        // PLAINTEXT GUARD: a contentEditable can otherwise accrue <br>/<div> on Enter or absorb rich
        // pasted markup. We neutralize both — Enter commits (these leaves are single logical lines),
        // and paste inserts text/plain only. commit reads textContent regardless, so this is purely
        // to keep the LIVE shadow DOM clean mid-edit; nothing here can make imported markup execute.
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "Enter") { e.preventDefault(); commitActiveLeaf(); editor.commands.focus(); }
          else if (e.key === "Escape") { e.preventDefault(); closeActiveLeaf(); editor.commands.focus(); }
        };
        const onBeforeInput = (e: InputEvent) => {
          const t = (e as any).inputType || "";
          if (t === "insertParagraph") { e.preventDefault(); commitActiveLeaf(); editor.commands.focus(); }
          else if (t === "insertLineBreak") e.preventDefault(); // no hard breaks (textContent would drop them anyway)
        };
        const onPaste = (e: ClipboardEvent) => {
          e.preventDefault();
          const text = ((e.clipboardData && e.clipboardData.getData("text/plain")) || "").replace(/\r/g, "");
          const sel: Selection | null = (shadow as any).getSelection ? (shadow as any).getSelection() : window.getSelection();
          if (sel && sel.rangeCount) { const r = sel.getRangeAt(0); r.deleteContents(); const tn = document.createTextNode(text); r.insertNode(tn); r.setStartAfter(tn); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
        };
        const onBlur = () => commitActiveLeaf();
        leaf.addEventListener("keydown", onKey);
        leaf.addEventListener("beforeinput", onBeforeInput as EventListener);
        leaf.addEventListener("paste", onPaste as EventListener);
        leaf.addEventListener("blur", onBlur);
        activeLeafHandlers = () => {
          leaf.removeEventListener("keydown", onKey);
          leaf.removeEventListener("beforeinput", onBeforeInput as EventListener);
          leaf.removeEventListener("paste", onPaste as EventListener);
          leaf.removeEventListener("blur", onBlur);
        };
        leaf.focus();
        try { const s: Selection | null = (shadow as any).getSelection ? (shadow as any).getSelection() : window.getSelection(); const r = document.createRange(); r.selectNodeContents(leaf); s!.removeAllRanges(); s!.addRange(r); } catch {}
      }

      const render = (html: string) => {
        closeOverlay(); closeActiveLeaf();
        shadow.innerHTML = RICH_STYLES || ""; // styles first (scoped, never leak / never saved)
        const tpl = document.createElement("template"); tpl.innerHTML = html || "";
        contentNodes = Array.from(tpl.content.childNodes);
        contentNodes.forEach((n) => shadow.appendChild(n)); // move content in after the styles — identical DOM to before
        // Wire every text leaf for double-click-to-edit. NO attribute is ever added to a leaf
        // (that would leak into the saved file) — only listeners + a shadow cursor hint. A direct
        // RUN's text node isn't an event target, so its listener rides the container element; on
        // dblclick we pick the run whose box is nearest the pointer (multiple runs per container are
        // possible). Child leaves stopPropagation, so they keep their own edit.
        // RUN container helper (shared by SVG runs + HTML mixed runs — both edit via the overlay).
        const wireRunContainer = (el: Element, nodes: Text[]) => el.addEventListener("dblclick", (e: Event) => {
          e.preventDefault(); e.stopPropagation();
          const ev = e as MouseEvent; let best = nodes[0], bestD = Infinity;
          for (const n of nodes) {
            const r = rectOf(n);
            const cx = Math.max(r.left, Math.min(ev.clientX, r.right)), cy = Math.max(r.top, Math.min(ev.clientY, r.bottom));
            const dx = ev.clientX - cx, dy = ev.clientY - cy, dist = dx * dx + dy * dy;
            if (dist < bestD) { bestD = dist; best = n; }
          }
          openOverlay(best);
        });
        const byEl = (runs: { el: Element; node: Text }[]) => { const m = new Map<Element, Text[]>(); runs.forEach(({ el, node }) => { const a = m.get(el) || []; a.push(node); m.set(el, a); }); return m; };

        // K1/F26: SVG text leaves + direct runs (`<text>Label <tspan>x</tspan></text>`) → overlay
        // input (Chromium won't caret SVG text, so editing is driven through a floating input).
        const svgLeaves = collectSvgTextLeaves(shadow);
        const svgRunsByEl = byEl(collectSvgTextRuns(shadow));
        if (svgLeaves.length || svgRunsByEl.size) {
          d.setAttribute("data-svg-editable", "");
          const hint = document.createElement("style"); hint.textContent = "text,tspan,textPath{cursor:text}"; shadow.appendChild(hint);
          svgLeaves.forEach((leaf) => leaf.addEventListener("dblclick", (e: Event) => { e.preventDefault(); e.stopPropagation(); openOverlay(leaf); }));
          svgRunsByEl.forEach((nodes, el) => wireRunContainer(el, nodes));
        } else d.removeAttribute("data-svg-editable");

        // F36: HTML element leaves (<figcaption>/<div>/<p>/<li>… holding only text) → edit IN PLACE
        // via contentEditable; HTML mixed runs (direct text alongside inline children) → overlay.
        const htmlLeaves = collectHtmlTextLeaves(shadow);
        const htmlRunsByEl = byEl(collectHtmlTextRuns(shadow));
        if (htmlLeaves.length || htmlRunsByEl.size) {
          d.setAttribute("data-leaf-editable", "");
          const hint = document.createElement("style"); hint.textContent = "[contenteditable]{cursor:text;outline:1.5px solid var(--accent);outline-offset:2px;border-radius:3px}"; shadow.appendChild(hint);
          htmlLeaves.forEach((leaf) => (leaf as HTMLElement).addEventListener("dblclick", (e: Event) => { e.preventDefault(); e.stopPropagation(); openLeaf(leaf as HTMLElement); }));
          htmlRunsByEl.forEach((nodes, el) => wireRunContainer(el, nodes));
        } else d.removeAttribute("data-leaf-editable");
      };
      render(currentHtml);

      return {
        dom: d,
        // Re-render only on an EXTERNAL change (⌘K rewrite, undo/redo); our own text commit
        // already updated the live DOM and set currentHtml, so skip the rebuild (keeps caret/feel).
        update(n: any) { if (n.type.name !== "richBlock") return false; if (n.attrs.html === currentHtml) return true; currentHtml = n.attrs.html || ""; render(currentHtml); return true; },
        destroy: () => { closeOverlay(); closeActiveLeaf(); },
        // While a leaf edits in place via contentEditable, swallow events at the nodeView boundary so
        // ProseMirror keymaps (Enter splits a block, Backspace deletes the node…) never fire on the
        // shadow keystrokes — the leaf's own handlers own them.
        stopEvent: () => !!activeLeaf,
        ignoreMutation: () => true,
      };
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
// markdown-it merges an adjacent bullet list + task list into ONE <ul>, and the task plugin
// tags the whole thing contains-task-list — a MIXED list ProseMirror's taskList schema can't
// hold (content "taskItem+"), so PM fabricates an empty taskItem and hoists the rest out: a
// phantom "- [ ]" that degrades into escaped junk on every save (found by the idempotence
// sweep). Split mixed lists into homogeneous runs BEFORE PM parses (tiptap-markdown collects
// this parse.updateDOM hook from any extension).
const MarkdownListFix = Extension.create({
  name: "markdownListFix",
  addStorage() {
    return { markdown: { parse: { updateDOM(element: HTMLElement) {
      // markdown-it's task plugin needs TEXT after "- [ ]" — an EMPTY to-do parses as a
      // plain bullet with literal "[ ]" text, which then saves as escaped junk (- \[ \])
      // and the checkbox is lost. Recognize bare "[ ]"/"[x]" bullets and rebuild the
      // checkbox li the way the plugin would have. (This also heals already-corrupted
      // "- \[ \]" lines back into the to-do the author typed.)
      element.querySelectorAll("li").forEach((li) => {
        if (li.classList.contains("task-list-item")) return;
        const m = (li.textContent || "").trim().match(/^\[( |x|X)?\]$/);
        if (!m) return;
        // emit the NORMALIZED shape (tiptap-markdown's task normalization has already run
        // by the time this hook fires, so a raw checkbox <input> here would be ignored)
        li.classList.add("task-list-item");
        li.setAttribute("data-type", "taskItem");
        li.setAttribute("data-checked", (m[1] || "").toLowerCase() === "x" ? "true" : "false");
        li.textContent = " ";
        const ul = li.parentElement;
        if (ul) { ul.classList.add("contains-task-list"); }
      });
      element.querySelectorAll("ul.contains-task-list").forEach((list) => {
        const kids = Array.from(list.children);
        const isTask = (li: Element) => li.classList.contains("task-list-item");
        if (!kids.length || kids.every(isTask)) return; // homogeneous — fine as-is
        const frag = document.createDocumentFragment();
        let run: Element[] = []; let runTask = isTask(kids[0]);
        const flush = () => {
          if (!run.length) return;
          const ul = document.createElement("ul");
          if (runTask) { ul.className = "contains-task-list"; ul.setAttribute("data-type", "taskList"); }
          else ul.setAttribute("data-tight", "true"); // markdown-it rendered the merged list loose (<p> in li); hand-written bullets are tight
          run.forEach((li) => ul.appendChild(li));
          frag.appendChild(ul); run = [];
        };
        kids.forEach((li) => { const t = isTask(li); if (t !== runTask) { flush(); runTask = t; } run.push(li); });
        flush();
        list.replaceWith(frag);
      });
    } } } };
  },
});

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
let SCOPED_NOTE_CSS = ""; // FULL_PARSE: the doc's <style> rewritten to the .note-scope wrapper, injected live so classed editable content renders right (never saved)

// Pure grouping wrappers — when unstyled, descend THROUGH them to isolate only the minimal
// unmodelable subtree, instead of freezing a whole wrapper just because one svg sits deep inside.
const STRUCTURAL_TAGS = new Set(["DIV", "ARTICLE", "MAIN", "SECTION", "BODY", "HEADER", "FOOTER", "ASIDE", "NAV"]);
// FULL_PARSE: walk the tree and wrap in data-rich-block ONLY the smallest subtrees we can't model.
// Block-grouping wrappers (div/article/section/…) are descended through — CLASSED OR NOT — so we
// isolate just the unmodelable leaves (svg/img/button/…) and keep the wrapper's prose editable (the
// wrapper survives as a styled-box with its class intact). Only a child that is ITSELF unmodelable,
// or a text-level element (p/h/li/figure) holding inline unmodelable content we can't split, freezes
// whole. Earlier this froze any *classed* wrapper whole — so one <button>/<svg> sank a whole page.
function isolateRich(el: HTMLElement, doc: Document) {
  Array.from(el.children).forEach((c) => {
    const child = c as HTMLElement;
    if (child.hasAttribute("data-calendar") || child.hasAttribute("data-clock")) return;    // dynamic block — leave for its node
    if (subtreeEditable(child)) return;                                                     // no unmodelable element anywhere — keep editable
    if (STRUCTURAL_TAGS.has(child.tagName)) { isolateRich(child, doc); return; }            // block wrapper (classed or not) — descend, isolate only the leaves
    const wrap = doc.createElement("div"); wrap.setAttribute("data-rich-block", "");        // unmodelable leaf / unsplittable text element — freeze whole
    child.replaceWith(wrap); wrap.appendChild(child);
  });
}

function prepareHtml(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const container = (doc.querySelector("article, main") as HTMLElement) || doc.body;
  // Preserve <style>/<script> across tokenizing the body (container.innerHTML = token would wipe
  // anything inside the container). Two different rules, because POSITION matters differently:
  //   • <style> → <head>: position-independent, so an in-container sheet is safe to hoist.
  //   • <script> → END of <body> (NOT <head>): an author's wiring script must keep running AFTER
  //     the DOM it touches exists. The old code dumped EVERY script into <head>, so an end-of-body
  //     script ran before the spliced content existed — the F32 corruption that silently killed
  //     tabs/toggles on save and rewrote the file on disk on the next autosave. We detach
  //     in-container scripts now (so they aren't parsed as editable content) and re-attach them at
  //     the end of <body> after tokenizing, below. Scripts ALREADY OUTSIDE the container (e.g.
  //     already at end of <body>) are left untouched and preserved verbatim in place by htmlTemplate.
  // Preserving a user's script is lossless (their files, often Claude-Code-authored — deleting it is
  // the worse failure); it is SAFE in-app because the head/body template is never injected into the
  // live page (htmlTemplate is only a save-splice string) and rich blocks render via innerHTML,
  // which never executes <script>. Body active content is still neutralized by stripActive for live
  // render. Hardening against genuinely untrusted imported HTML is deferred — see corpus 'security'.
  container.querySelectorAll("style").forEach((el) => doc.head.appendChild(el));
  const heldScripts = Array.from(container.querySelectorAll("script")); heldScripts.forEach((el) => el.remove());
  // Capture the doc's styles to inject into each rich block's SHADOW root — scoped, so
  // they render the content but NEVER leak into the editor chrome (the white-bg bug).
  // Rewrite :root → :host so a doc's custom props (e.g. --font-mono) resolve in the shadow.
  RICH_STYLES = Array.from(doc.querySelectorAll("style")).map((s) => "<style>" + (s.textContent || "").replace(/:root\b/g, ":host") + "</style>").join("\n");
  // FULL_PARSE: rewrite the same styles to the editor-mount scope so class/element rules render
  // the EDITABLE content without clobbering the chrome (live-only; the original <style> still
  // round-trips verbatim through htmlTemplate's head).
  SCOPED_NOTE_CSS = FULL_PARSE ? scopeCss(Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || "").join("\n"), ".note-scope") : "";
  const hasMarkers = !!container.querySelector("[data-rich-block],[data-calendar],[data-clock]");
  if (FULL_PARSE) {
    // Re-derive rich blocks from CONTENT, not stale markers: drop every data-rich-block wrapper
    // (from a prior save / md-to-redesigned output — these often pin a whole <article> atomic),
    // keep dynamic markers (data-calendar/clock), then recursively isolate ONLY the minimal
    // unmodelable subtrees (svg/img/…). A single nested svg no longer freezes the whole document;
    // everything else parses into editable nodes rendered by the scoped doc sheet.
    container.querySelectorAll("[data-rich-block]").forEach((rb) => {
      const p = rb.parentNode; if (!p) return;
      while (rb.firstChild) p.insertBefore(rb.firstChild, rb);
      p.removeChild(rb);
    });
    isolateRich(container, doc);
  } else if (hasMarkers) {
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
    // Legacy: preserve the ENTIRE body as one atomic rich block — guaranteed lossless,
    // rendered verbatim, view-only until adopted.
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
  heldScripts.forEach((el) => doc.body.appendChild(el)); // re-attach in-container scripts at end of <body> (runs after the spliced DOM)
  htmlTemplate = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  return content;
}

// ============================ editor ============================
const mount = document.getElementById("editor");
let editor: Editor | null = null;

if (note && mount) {
  // Links: NEVER rewrite a file's link attrs (the default injects target=_blank +
  // rel="noopener…" into every saved link — mutates notes on save). Defaults null ⇒ the
  // file's own target/rel round-trip verbatim. openOnClick off — handleClick below routes
  // clicks properly (relative note links navigate IN-APP; web links open a tab).
  const linkOpts = { openOnClick: false, HTMLAttributes: { target: null, rel: null } } as any;
  const extensions: any[] = [
    // FULL_PARSE swaps stock Bold/Italic for tag-preserving variants (see BoldTagged).
    FULL_PARSE ? StarterKit.configure({ bold: false, italic: false, link: linkOpts }) : StarterKit.configure({ link: linkOpts }),
    ...(FULL_PARSE ? [BoldTagged, ItalicTagged, PreserveAttrs] : []),
    StyledTextStyle, Color, StyledHighlight.configure({ multicolor: true }), InlineStyle,
    TaskList, TaskItem.configure({ nested: true }), TaskInputRule, MarkdownListFix,
    Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
    Callout,
    StyledInlineBox, StyledBox, StyledSpan, DecoSpan, ImageNode, RichBlock, CalendarBlock, ClockBlock,
    SlashMenu, TabKeys, EscapeTrap,
    Placeholder.configure({ placeholder: ({ node }: any) => (node.type.name === "heading" ? "Heading" : "Write, or press “/” for commands…"), showOnlyCurrent: true }),
  ];
  let content = note.content;
  if (note.format === "md") extensions.push(Markdown.configure({ html: true, linkify: true }));
  else if (note.format === "html") { try { content = prepareHtml(note.content); } catch { htmlTemplate = null; content = note.content; } }

  // Paste an image → save as a sidecar file (<note-dir>/assets/) via /asset, insert a native
  // image node with the note-relative src. Sync-consume the event, finish async.
  async function pasteImage(file: File) {
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
    const buf = new Uint8Array(await file.arrayBuffer());
    let b64 = ""; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + CH) as any);
    b64 = btoa(b64);
    try {
      const r = await fetch("/asset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: note!.file, ext, data: b64 }) }).then((x) => x.json());
      if (!r.ok || !r.src) { flash("image save failed: " + (r.error || "?"), false); return; }
      editor!.chain().focus().insertContent({ type: "image", attrs: { src: r.src, alt: file.name || "" } }).run();
      markEdited();
    } catch { flash("image save failed", false); }
  }
  editor = new Editor({
    element: mount, extensions, content, autofocus: "end",
    editorProps: {
      // Make links WORK in the editor (clicks in contenteditable don't navigate natively):
      // relative .md/.html links navigate the app to the sibling note (wiki-style cross-links);
      // web/mailto links open outside; anything else is left alone.
      handleClick(_view: any, _pos: number, event: MouseEvent) {
        const a = (event.target as HTMLElement | null)?.closest?.("a");
        if (!a) return false;
        const href = a.getAttribute("href") || "";
        if (!href || href.startsWith("#")) return false;
        if (/^(https?:|mailto:)/i.test(href)) { window.open(href, "_blank", "noopener"); event.preventDefault(); return true; }
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return true; // other protocols (incl. javascript:) — swallow
        if (/\.(md|markdown|html?|htm)(#.*)?$/i.test(href)) {
          const clean = href.split("#")[0];
          const abs = clean.startsWith("/") ? clean : noteDirOf(note!.file) + "/" + clean;
          event.preventDefault();
          // F9: preflight the target — a dead link used to dump you on the welcome
          // screen with no explanation. Explain in place and stay on the doc.
          fetch("/exists?file=" + encodeURIComponent(abs)).then((r) => r.json()).then((x) => {
            if (x.exists && x.inVault && x.isNote) go("/?file=" + encodeURIComponent(abs));
            else if (!x.exists) flash("linked note doesn't exist: " + clean, false);
            else if (!x.inVault) flash("linked note is outside your open folder: " + clean, false);
            else flash("link target isn't a note: " + clean, false);
          }).catch(() => flash("couldn't check link target: " + clean, false));
          return true;
        }
        return true; // unknown relative target — swallow rather than 404 the app
      },
      handlePaste(_view: any, event: ClipboardEvent) {
        const items = event.clipboardData?.items; if (!items) return false;
        for (const it of Array.from(items)) {
          if (it.kind === "file" && it.type.startsWith("image/")) {
            const f = it.getAsFile(); if (!f) continue;
            event.preventDefault(); pasteImage(f);
            return true; // consumed — don't let PM paste the raw blob/html
          }
        }
        return false;
      },
    },
  });
  W.__editor = editor;
  // EDIT (default) vs INTERACT mode (K5). Flipped by the mode controller below; read here so
  // the click-to-continue handler stands down while the sandboxed preview owns the pane.
  let interactMode = false;

  // FULL_PARSE: scope the doc's <style> to the editor mount so classed/styled editable content
  // renders with its real design, while editor chrome (outside #editor) is untouched.
  if (note.format === "html" && FULL_PARSE && SCOPED_NOTE_CSS) {
    mount.classList.add("note-scope");
    const st = document.createElement("style"); st.id = "note-scoped"; st.textContent = SCOPED_NOTE_CSS;
    document.head.appendChild(st);
    // F29: a JS-driven doc ships its non-active panels with display:none (e.g. class="… hidden");
    // edit mode never runs the doc's JS that would toggle them, so only the first tab's panel was
    // editable and the rest were invisible/unreachable. Reveal them FOR EDITING — STACK every
    // hidden element visible at once, each carrying a small "hidden by default" marker. The markup
    // /attributes are untouched (the class stays in the model), so a save round-trips byte-faithful
    // and Interact mode still hides/switches correctly. This is a LIVE-ONLY override sheet, derived
    // from the scoped sheet's own display:none rules — never serialized.
    requestAnimationFrame(() => {
      const scoped = (document.getElementById("note-scoped") as HTMLStyleElement | null)?.sheet;
      if (!scoped) return;
      const sels = new Set<string>();
      const collect = (rules: CSSRuleList, printOnly: boolean) => {
        for (const r of Array.from(rules) as any[]) {
          if (r.selectorText && r.style) {
            if (printOnly || r.style.getPropertyValue("display") !== "none") continue;
            for (const part of String(r.selectorText).split(",")) {
              const s = part.trim();
              if (s && s.indexOf("::") < 0) sels.add(s); // skip pseudo-elements (decorative, not panels)
            }
          } else if (r.cssRules && r.cssRules.length) {
            const media = (r.media && r.media.mediaText) || "";
            collect(r.cssRules, /\bprint\b/i.test(media) && !/\bscreen\b/i.test(media)); // a print-only @media never applies on screen
          }
        }
      };
      try { collect(scoped.cssRules, false); } catch {}
      // inline display:none lives on the element, not the sheet — catch it generically too.
      const targets = [...sels, '.note-scope [style*="display:none"]', '.note-scope [style*="display: none"]'];
      const revealSel = targets.join(",");
      const badgeSel = targets.map((s) => s + "::after").join(",");
      const css =
        revealSel + "{display:revert !important;position:relative;outline:1.5px dashed var(--accent-line);outline-offset:2px}" +
        badgeSel + '{content:"hidden by default";position:absolute;top:0;right:0;z-index:2;font:600 9px/1.45 ui-monospace,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:var(--accent);border-radius:0 0 0 5px;padding:1px 6px;pointer-events:none;opacity:.85}';
      const rs = document.createElement("style"); rs.id = "note-edit-reveal"; rs.textContent = css;
      document.head.appendChild(rs);
    });
    // F6: the doc's body background lands on the 760px mount only — a skinny dark strip on
    // the app-gray pane ("looks and feels weird"). Extend the note's canvas COLOR across the
    // whole note pane; sidebar/bar chrome stays app-themed. (Color only — gradients/images
    // stay on the mount.)
    requestAnimationFrame(() => {
      const main = document.querySelector(".layout .main") as HTMLElement | null;
      const bg = getComputedStyle(mount).backgroundColor;
      if (main && bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") main.style.background = bg;
      // K4: a doc whose top-level wrapper FRAMES ITSELF — its CSS sets a max-width AND
      // centers it (margin auto) — gets the editor's 760px column out of the way so the
      // page centers/sizes exactly like the browser. max-width alone is NOT enough: docs
      // like attention.html cap every element (p{max-width:680px}) and center via an outer
      // grid the editor doesn't carry — dropping the column for those pins them hard-left.
      // Declared values must come from the CSSOM (computed style resolves `auto` to px).
      const selfFraming = (el: HTMLElement): boolean => {
        if (/auto/.test(el.style.margin + " " + el.style.marginLeft) && el.style.maxWidth) return true;
        const sheet = (document.getElementById("note-scoped") as HTMLStyleElement | null)?.sheet;
        if (!sheet) return false;
        let hasMax = !!el.style.maxWidth, hasAuto = /auto/.test(el.style.margin + " " + el.style.marginLeft);
        const walk = (rules: CSSRuleList) => {
          for (const r of Array.from(rules) as any[]) {
            // NB: a plain CSSStyleRule ALSO has .cssRules (CSS nesting) — selectorText first
            if (r.selectorText && r.style) {
              try { if (!el.matches(r.selectorText)) continue; } catch { continue; }
              if (r.style.maxWidth) hasMax = true;
              if (/auto/.test(r.style.marginLeft) || /auto/.test(r.style.margin)) hasAuto = true;
            } else if (r.cssRules && r.cssRules.length) walk(r.cssRules); // @media etc.
          }
        };
        walk(sheet.cssRules);
        return hasMax && hasAuto;
      };
      const first = mount.querySelector(".ProseMirror > *") as HTMLElement | null;
      if (first && selfFraming(first)) {
        mount.classList.add("own-frame");
        // autofocus("end") parks the caret in the escape paragraph AFTER the wrapper —
        // typing there lands outside the page frame, hard-left and unstyled ("my words
        // start at the very left"). Continue-the-document means: caret ends INSIDE the
        // wrapper. (The escape paragraph stays reachable by clicking below the page.)
        // Heal strays: paragraphs that ended up AFTER the wrapper (typed pre-F17, or via
        // clicks below the page) render hard-left outside the frame — in the browser too.
        // They belong to the page: absorb non-empty ones into the wrapper's end, drop empty
        // ones. Pure-load never writes (armed stays false); the heal persists with the
        // user's next real edit.
        editor!.commands.command(({ tr, state }: any) => {
          const doc = state.doc, fcN = doc.firstChild;
          if (!fcN || fcN.type.name !== "styledBox" || doc.childCount <= 1) return false;
          const tail: any[] = [];
          for (let i = 1; i < doc.childCount; i++) tail.push(doc.child(i));
          if (!tail.every((n) => n.type.name === "paragraph")) return false; // only plain strays
          const keep = tail.filter((n) => n.content.size > 0);
          tr.delete(fcN.nodeSize, doc.content.size);
          if (keep.length) tr.insert(fcN.nodeSize - 1, keep);
          return true;
        });
        // Arm the escape-slot trap (see EscapeTrap), then re-apply the current selection
        // through it so autofocus("end") — which may already sit in the escape slot — gets
        // remapped inside the page immediately.
        OWN_FRAME = true;
        const fc = editor!.state.doc.firstChild;
        if (fc && fc.type.name === "styledBox") setTimeout(() => editor!.chain().focus(fc.nodeSize - 2).run(), 0);
      }
    });
  }

  // Strip the editor-only data-sbox hook from saved HTML (it's a styling/margin hook, not content).
  const stripSbox = (html: string): string => {
    if (html.indexOf("data-sbox") < 0) return html;
    const t = document.createElement("template"); t.innerHTML = html;
    t.content.querySelectorAll("[data-sbox]").forEach((e) => e.removeAttribute("data-sbox"));
    return t.innerHTML;
  };

  // -------- serialize --------
  const serialize = (): string => {
    if (!editor) return "";
    if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); }
    const bodyHtml = tidySaveHtml(stripSbox(editor.getHTML()));
    if (htmlTemplate) return spliceBody(htmlTemplate, BODY_TOKEN, bodyHtml);
    return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><article>\n${bodyHtml}\n</article></body></html>\n`;
  };
  W.__serialize = serialize; // test seam: read the exact bytes a save would write (corpus harness)

  // Clicking the empty space below/around the doc must CONTINUE the note, not blur the
  // editor (a click there focused <body> and typing went nowhere). Caret goes to the end;
  // in a self-framed doc the escape-trap then folds typed content into the page.
  document.querySelector(".layout .main")?.addEventListener("mousedown", (e) => {
    if (interactMode) return; // the sandboxed preview owns the pane — don't steal focus to the editor
    const t = e.target as HTMLElement | null;
    if (!editor || !t || t.closest(".ProseMirror") || t.closest("a,button,input,select,textarea")) return;
    e.preventDefault();
    editor.chain().focus("end").run();
  });

  // -------- stale-tab guard --------
  // A tab from before a server restart keeps editing (and saving) with OLD code — twice
  // today that produced phantom bug reports. Compare bundle versions on focus + slow poll;
  // on mismatch show a banner (no auto-reload: the user may have unsaved thoughts mid-edit).
  {
    const mine = ((document.querySelector('script[src^="/editor.js"]') as HTMLScriptElement | null)?.src.split("v=")[1] || "").split("&")[0];
    let shown = false;
    const check = async () => {
      if (shown || !mine) return;
      try {
        const { v } = await fetch("/version").then((r) => r.json());
        if (v && v !== mine) {
          shown = true;
          const bar = document.createElement("div"); bar.className = "stale-bar";
          bar.innerHTML = "⟳ The editor was updated — this tab is running old code. <button>Reload</button>";
          (bar.querySelector("button") as HTMLButtonElement).onclick = () => location.reload();
          document.body.appendChild(bar);
        }
      } catch {}
    };
    window.addEventListener("focus", check);
    setInterval(check, 30_000);
  }

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
  armEdit = markEdited;
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

  // ============================ edit / interact mode (resolves boundary K5) ============================
  // EDIT = today's JS-free ProseMirror editor (unchanged). INTERACT = the document's OWN
  // JavaScript runs so interactive docs (JS tabs, live dashboards) work — by rendering the RAW
  // file in an ISOLATED iframe: `sandbox="allow-scripts"` WITHOUT `allow-same-origin`. That gives
  // the frame an OPAQUE origin, which is the boundary: it can run the doc's JS but cannot read the
  // vault, call the server's file endpoints (POSTs send `Origin: null` → 403; GET responses carry
  // no CORS headers → unreadable cross-origin), or reach the parent page / app cookies+storage.
  // The EDITOR never executes imported JS — only this walled-off frame does. (HTML notes only.)
  //
  // Raw file → iframe via `srcdoc` (the bytes are already in window.__NOTE__.content), NOT a
  // server route: the doc never becomes a navigable app-origin URL, so it can never run with app
  // privileges. srcdoc also preserves the doc's original <script> position (end-of-body IIFEs run
  // after their DOM exists), which a serialize()-rebuilt head would break.
  // F31: only HTML docs that actually contain executable JS are interactable — the server
  // detects this from the raw bytes and passes the flag (single source of truth, no drift).
  const INTERACTABLE = !!note.interactive;
  let interactView: HTMLElement | null = null;
  const mainPane = document.querySelector(".layout .main") as HTMLElement | null;
  const modeSeg = document.getElementById("modeseg");
  const askchip = document.getElementById("askchip");
  const insertchip = document.getElementById("insertchip");
  function setMode(m: "edit" | "interact") {
    if (!INTERACTABLE || (m === "interact") === interactMode) return;
    if (m === "interact") {
      // Close any edit-mode overlay so it can't orphan over the preview, then persist edits to
      // disk (the editor also stays alive, hidden — so toggling back never loses an edit).
      if (cmdk.classList.contains("show")) closeCmdk();
      if (switcher.classList.contains("show")) closeSwitcher();
      flushSave();
      interactView = document.createElement("div"); interactView.className = "interact-view";
      const frame = document.createElement("iframe");
      frame.className = "interact-frame";
      frame.setAttribute("sandbox", "allow-scripts"); // NO allow-same-origin: opaque origin IS the wall
      frame.setAttribute("title", "Interactive preview (sandboxed)");
      // The RAW file AS LOADED — verbatim, unsanitized, only ever a document INSIDE the sandbox.
      // We use the original bytes (not serialize()) deliberately: it's the one representation that
      // keeps the doc's own <script> in its authored position. End-of-body IIFEs that query the DOM
      // (the motivating tabs bug) would break if relocated to <head>, which a save/serialize does.
      // Trade-off: in-session edits are not mirrored in the preview (the editor retains them).
      // buildInteractSrcdoc only HEAD-injects: the history/wakeLock shim (F33, always) and — for
      // docs with no styling of their own — the app's base note CSS so the render stays
      // themed+centered like edit (F30). The doc's own bytes/scripts are otherwise untouched.
      frame.srcdoc = buildInteractSrcdoc(note!.content);
      const tag = document.createElement("div"); tag.className = "interact-note";
      tag.innerHTML = '<span class="dot"></span>Interactive preview — runs this document’s own code, sandboxed';
      interactView.appendChild(frame); interactView.appendChild(tag);
      mainPane?.appendChild(interactView);
      mount!.style.display = "none";
      askchip?.setAttribute("hidden", ""); insertchip?.setAttribute("hidden", "");
      interactMode = true;
    } else {
      interactView?.remove(); interactView = null; // tear the frame down → its JS/timers stop
      mount!.style.display = "";
      askchip?.removeAttribute("hidden"); insertchip?.removeAttribute("hidden");
      interactMode = false;
      editor?.commands.focus();
    }
    modeSeg?.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.mode === m));
  }
  function toggleMode() { if (INTERACTABLE) setMode(interactMode ? "edit" : "interact"); }
  modeSeg?.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setMode((b as HTMLElement).dataset.mode === "interact" ? "interact" : "edit")));
  W.__setMode = setMode; // test seam

  // F34: the interact view's height was `calc(100vh - 40px)` with a hardcoded 40px bar — but the
  // bar measures ~47px at 1280×900, so the sticky bar overlapped the iframe's top ~7px (+ a scroll
  // overflow). Drive the offset off the bar's REAL height via a CSS var, kept in sync on resize.
  const barEl = document.querySelector(".bar") as HTMLElement | null;
  const syncBarH = () => { const h = barEl ? Math.round(barEl.getBoundingClientRect().height) : 40; document.documentElement.style.setProperty("--bar-h", h + "px"); };
  syncBarH();
  window.addEventListener("resize", syncBarH);

  // ============================ chrome wiring ============================
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // ⌘E toggles modes — only claim the key when there's a mode to toggle (HTML notes), so it
    // stays a no-op (not a swallowed shortcut) on md/txt notes.
    if (mod && e.key.toLowerCase() === "e") { if (INTERACTABLE) { e.preventDefault(); toggleMode(); } }
    // In INTERACT mode the editor is hidden — edit/AI shortcuts would mutate it invisibly, so the
    // only keys that apply are ⌘E (above) and Escape (exit). Everything else is ignored.
    else if (interactMode) { if (e.key === "Escape") setMode("edit"); }
    else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCmdk(); }
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
