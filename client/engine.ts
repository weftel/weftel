// Pure round-trip engine — the canonical-HTML schema (every Node/Mark), the parse-side
// normalizer (prepareDoc) and the save-side serializer (serializeDoc), extracted from
// editor.ts so the SAME engine runs in the live editor and headless (verifier CLI, the
// AI-edit fidelity loop). No module-load side effects, no window/mount coupling: node
// views are injected by the editor via engineExtensions({nodeViews}); everything here
// needs only a DOM implementation (browser or happy-dom).
//
// Invariants:
//   • This module NEVER imports ./editor, ./diff-viewer, ./ghost-completion or ./commands.
//   • engineExtensions() is the single source of truth for the schema — editor and
//     verifier consume the same list, so schema drift between them is impossible.
//   • Extension ORDER is load-bearing (parse priorities interact) — keep it byte-identical
//     to the editor's historical array.
//
import { Node, Mark, Extension, InputRule, generateJSON, generateHTML } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import HardBreak from "@tiptap/extension-hard-break";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { DOMSerializer } from "@tiptap/pm/model";
import { stripActive, escapeAttr, spliceBody, filterInlineStyle, editableModelable, subtreeEditable, scopeCss, tidySaveHtml } from "./lib";

// FULL_PARSE (experiment): parse class/<style>-driven bespoke HTML into editable nodes —
// preserving classes and scoping the doc's <style> into the live editor — instead of
// freezing it into an atomic shadow-DOM rich block. Set false to revert to the legacy
// behavior byte-for-byte (the frozen RichBlock path below is never removed).
export const FULL_PARSE = true;

// F42: soft line breaks (a single "\n" with no blank line) must render like Obsidian's
// default — a visible line break — not collapse onto the previous line the way strict
// CommonMark does (it renders a softbreak as a space). We turn on markdown-it's `breaks`
// (see Markdown.configure in editor.ts) so a softbreak parses to a hardBreak node. But
// tiptap-markdown's default hardBreak serializer writes "\\\n" (a literal backslash +
// newline), which would inject stray backslashes into the file on every autosave — an
// F40-class round-trip mutation, and ugly in the raw markdown the user also edits in
// Obsidian. So we override the serializer to emit a plain newline (and keep the inline
// "<br>" form inside tables, where a bare newline would break the row). Net: soft breaks
// render as line breaks AND round-trip without backslash injection.
const HardBreakMd = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any, parent: any, index: number) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) { state.write(state.inTable ? "<br>" : "\n"); return; }
          }
        },
        parse: {},
      },
    };
  },
});

// A rich block round-trips as `<div data-rich-block>…HTML…</div>`. Model-generated SVGs/HTML put
// BLANK LINES between element groups — and CommonMark (markdown-it) ENDS an HTML block at the first
// blank line. So strip blank lines inside the serialized blob; whitespace between HTML/SVG elements
// is insignificant, so the rendered result is unchanged. (See joinRichBlockBlankLines in editor.ts
// for the load-side half of this fix.)
const stripBlankLines = (s: string): string => s.replace(/(\n[ \t]*){2,}/g, "\n");

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
// reload (so echoing one back would flip a styled div into a rich/callout block) or
// that we strip ourselves (data-sbox). Generic names a doc legitimately uses as its own hooks
// (data-type, data-id, data-src, data-state, …) are USER CONTENT and must round-trip — keeping them
// here was the whole point. (The app's companion-keyed callout needs data-callout to
// match, so a lone data-kind on a styled div is unambiguous user content. data-clock stays
// excluded post-#95: it's a legacy app marker consumed by the prepareDoc migration, never
// user content — echoing one back from a styled div would resurrect a removed block.)
export const APP_DATA_HOOKS = new Set(["data-sbox", "data-rich-block", "data-clock", "data-callout"]);
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
export const StyledBox = Node.create({
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
export const StyledInlineBox = Node.create({
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

// A CLASSED span is a component with element identity (<span class="pill">, badges, tags) —
// it can NOT be a mark: ProseMirror merges adjacent same-marked text (two pills collapse
// into one) and splits a marked range at every inner bold/code boundary (one span becomes
// three, shattering flex layouts). An inline NODE keeps the element's identity while the
// text inside stays editable. Style-only spans remain the InlineStyle mark.
export const StyledSpan = Node.create({
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
export const DecoSpan = Node.create({
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
// it writes). The SAVED src stays the note-relative path (portable file); the editor's
// NodeView (injected via engineExtensions({nodeViews})) displays it through /raw?file= so
// it renders while editing. Serialization uses renderHTML (original src), independent of
// the NodeView.
export const ImageNode = Node.create({
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
});

const richMd = { markdown: { serialize(state: any, node: any) { state.write("<div data-rich-block>" + stripBlankLines(node.attrs.html || "") + "</div>"); state.closeBlock(node); } } };

export const RichBlock = Node.create({
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
});

// Callout: a styled, editable container (info/warn/tip). Holds real prose, so it's a
// content node, not an atom. Serializes to an HTML <div data-callout> with a blank line
// before/after the inner content so markdown-it re-parses the inside as markdown on load
// (the div wrapper round-trips via parseHTML).
export const Callout = Node.create({
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

// F44: faithful task-list round-trip. Two defects in tiptap-markdown's default taskList
// serialize (it just calls prosemirror-markdown's renderList):
//   (a) TIGHT→LOOSE: MarkdownTightLists only registers the `tight` attr on bulletList/
//       orderedList, never taskList, and the serializer state is built without a
//       `tightLists` option (so it defaults FALSE). Net: EVERY checklist serialized loose
//       — a blank line injected between every checkbox on save, even a tight source list.
//   (b) DOUBLE-BLANK OSCILLATION (non-idempotence): a source that switches bullet marker
//       between consecutive task items ("- [ ]" then "* [ ]", common in this vault) is two
//       SEPARATE lists per CommonMark, so PM holds two adjacent taskList nodes. renderList
//       puts flushClose(3) — a DOUBLE blank line — between adjacent same-type lists. On the
//       next load those two "-"-marker lists, now blank-separated, MERGE into one loose
//       list; the following save emits a single blank → save≠reload≠save.
// Fix: a tight-by-default list renderer that (1) honours a parsed `tight` attr (mirrors
// MarkdownTightLists' proven <p>-presence heuristic) and (2) keeps adjacent task lists
// CONTIGUOUS (single newline, no blank gap) so they read back as the one checklist the
// user sees — idempotent. Parse is inherited from tiptap-markdown's default taskList spec
// (getMarkdownSpec merges our serialize over it), so the markdown-it task plugin + the
// data-type=taskList updateDOM still run.
function renderTightTaskList(state: any, node: any, delim: string, firstDelim: (i: number) => string) {
  if (state.closed && state.closed.type === node.type) state.flushClose(1); // adjacent same-type list → contiguous, not a 2-blank gap
  else if (state.inTightList) state.flushClose(1);
  const isTight = typeof node.attrs.tight !== "undefined" ? node.attrs.tight : true;
  const prevTight = state.inTightList;
  state.inTightList = isTight;
  node.forEach((child: any, _: any, i: number) => {
    if (i && isTight) state.flushClose(1);
    state.wrapBlock(delim, firstDelim(i), node, () => state.render(child, node, i));
  });
  state.inTightList = prevTight;
}
const TaskListMd = TaskList.extend({
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      // Same heuristic MarkdownTightLists uses for bullet/ordered lists: a list markdown-it
      // rendered without <p> wrappers (no blank lines in source) is tight. Default tight.
      tight: {
        default: true,
        parseHTML: (el: any) => el.getAttribute("data-tight") === "true" || !el.querySelector("p"),
        renderHTML: (attrs: any) => (attrs.tight ? { "data-tight": "true" } : {}),
      },
    };
  },
  addStorage() {
    return { markdown: { serialize(state: any, node: any) { renderTightTaskList(state, node, "  ", () => "- "); } } };
  },
});

// ============================ extension list (the schema) ============================
// The editor's default link options: NEVER rewrite a file's link attrs (the default injects
// target=_blank + rel="noopener…" into every saved link — mutates notes on save). Defaults
// null ⇒ the file's own target/rel round-trip verbatim. openOnClick off — the editor's
// handleClick routes clicks itself.
const DEFAULT_LINK_OPTS = { openOnClick: false, HTMLAttributes: { target: null, rel: null } } as any;

// The three node views the live editor injects (verifier passes none — schema-only).
export type EngineNodeViews = { image?: any; richBlock?: any; callout?: any };

// The single source of truth for the schema, shared by the live editor and every headless
// consumer. Order is load-bearing — byte-identical to the editor's historical array. The
// editor appends its UI-only extensions (SlashMenu, TabKeys, EscapeTrap, Placeholder — and
// Markdown for .md notes) after this list; none of those contribute schema.
export function engineExtensions(opts: { linkOpts?: any; nodeViews?: EngineNodeViews } = {}): any[] {
  const linkOpts = opts.linkOpts ?? DEFAULT_LINK_OPTS;
  const nv = opts.nodeViews || {};
  const withView = (node: any, view: any) => (view ? node.extend({ addNodeView() { return view; } }) : node);
  return [
    // FULL_PARSE swaps stock Bold/Italic for tag-preserving variants (see BoldTagged).
    FULL_PARSE ? StarterKit.configure({ bold: false, italic: false, hardBreak: false, link: linkOpts }) : StarterKit.configure({ hardBreak: false, link: linkOpts }),
    HardBreakMd, // F42: replaces StarterKit's hardBreak so softbreaks round-trip as "\n", not "\\\n"
    ...(FULL_PARSE ? [BoldTagged, ItalicTagged, PreserveAttrs] : []),
    StyledTextStyle, Color, StyledHighlight.configure({ multicolor: true }), InlineStyle,
    TaskListMd, TaskItem.configure({ nested: true }), TaskInputRule, MarkdownListFix,
    Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
    withView(Callout, nv.callout),
    StyledInlineBox, StyledBox, StyledSpan, DecoSpan,
    withView(ImageNode, nv.image), withView(RichBlock, nv.richBlock),
  ];
}

// Headless tree conversions — the verifier's round-trip primitives. Same schema, same
// parse/serialize paths TipTap uses inside the live editor (node views never participate).
export function htmlToDoc(content: string): any { return generateJSON(content, engineExtensions()); }
export function docToBody(json: any): string { return generateHTML(json, engineExtensions()); }

// ============================ html load/save (lossless) ============================
const PROSE_TAGS = new Set(["H1","H2","H3","H4","H5","H6","P","UL","OL","BLOCKQUOTE","PRE","HR","TABLE"]);

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
    if (subtreeEditable(child)) return;                                                     // no unmodelable element anywhere — keep editable
    if (STRUCTURAL_TAGS.has(child.tagName)) { isolateRich(child, doc); return; }            // block wrapper (classed or not) — descend, isolate only the leaves
    const wrap = doc.createElement("div"); wrap.setAttribute("data-rich-block", "");        // unmodelable leaf / unsplittable text element — freeze whole
    child.replaceWith(wrap); wrap.appendChild(child);
  });
}

// F78: pick the page-FRAME container — the top-level wrapper that holds the doc's content — NOT a
// nested semantic <article>/<main> used as a content CARD. The old `doc.querySelector("article,
// main")` matched the FIRST such element ANYWHERE in the doc, so a page built from
// <section><article class="card">… cards (no top-level <main>) had its whole edit surface collapsed
// to the first card: every later section vanished from the view (still preserved on disk via
// htmlTemplate, but unrendered and uneditable). A frame must be TOP-LEVEL — not itself nested
// inside another content region (<article>/<main>/<section>): that rules out a content card AND its
// inverse (a <main> tucked inside an outer <article> frame, where grabbing the inner <main> would
// drop the article's surrounding content). Prefer a top-level <main> (the single page-content
// region); else a SOLE top-level <article> (a page wrapping all its content in one <article>).
// Multiple top-level articles, or none, mean article/main is content — fall back to <body> so
// isolateRich keeps every section editable.
function frameContainer(doc: Document): HTMLElement {
  const body = doc.body;
  const topLevel = (el: Element) => !(el.parentElement && el.parentElement.closest("article, main, section"));
  const mains = Array.from(body.querySelectorAll("main")).filter(topLevel) as HTMLElement[];
  if (mains.length === 1) return mains[0];
  const articles = Array.from(body.querySelectorAll("article")).filter(topLevel) as HTMLElement[];
  if (mains.length === 0 && articles.length === 1) return articles[0];
  return body;
}

// Everything prepareDoc derives from a raw HTML note. `content` feeds the editor/parser;
// the rest is save-splice + render state the caller owns (the editor stores them in module
// vars; the verifier threads them straight into serializeDoc).
export interface PreparedDoc {
  content: string;                                            // editor-ready body HTML
  template: string | null;                                    // full original doc with the token where editable content goes
  token: string;                                              // collision-free body splice token
  richStyles: string;                                         // doc's <style> blocks, :root→:host, for rich-block shadow roots
  scopedCss: string;                                          // doc's <style> rewritten to .note-scope (live-only, never saved)
  frame: { tag: string; cls: string; style: string } | null;  // F39: stripped container identity for own-frame detection
}

// The parse-side normalizer (was prepareHtml) — de-globalized: returns everything it used
// to assign to module state, so it's pure and reusable headless.
export function prepareDoc(raw: string): PreparedDoc {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  // The Google Calendar embed block was removed. A note saved earlier may still carry a
  // <div data-calendar data-src="URL">; with no calendarBlock node to claim it, degrade it in
  // place to a plain link so the embed URL is PRESERVED (never silently dropped) and the note
  // opens without a missing-node crash. Empty (src-less) markers just drop out.
  doc.querySelectorAll("div[data-calendar]").forEach((el) => {
    const src = el.getAttribute("data-src") || "";
    if (src) {
      const p = doc.createElement("p");
      const a = doc.createElement("a"); a.setAttribute("href", src); a.textContent = src;
      p.appendChild(a); el.replaceWith(p);
    } else { el.remove(); }
  });
  // The Clock block (PoC dynamic block) was removed (#95). A note saved earlier may still
  // carry <div data-clock data-tz="X">; with no clockBlock node to claim it, degrade it in
  // place to a small visible paragraph so the marker stays readable and deletable instead
  // of crashing or vanishing (same policy as data-calendar above).
  doc.querySelectorAll("div[data-clock]").forEach((el) => {
    const tz = el.getAttribute("data-tz") || "local";
    const p = doc.createElement("p");
    p.textContent = "clock (removed feature) · " + tz;
    el.replaceWith(p);
  });
  const container = frameContainer(doc);
  // F39: record the container's identity (only when it's a real wrapper, not body) so own-frame
  // detection can probe whether IT carried the page frame (max-width + margin:auto) the editor stripped.
  const frame = (FULL_PARSE && container !== doc.body)
    ? { tag: container.tagName.toLowerCase(), cls: container.getAttribute("class") || "", style: container.getAttribute("style") || "" }
    : null;
  // Preserve <style>/<script> across tokenizing the body (container.innerHTML = token would wipe
  // anything inside the container). Two different rules, because POSITION matters differently:
  //   • <style> → <head>: position-independent, so an in-container sheet is safe to hoist.
  //   • <script> → END of <body> (NOT <head>): an author's wiring script must keep running AFTER
  //     the DOM it touches exists. The old code dumped EVERY script into <head>, so an end-of-body
  //     script ran before the spliced content existed — the F32 corruption that silently killed
  //     tabs/toggles on save and rewrote the file on disk on the next autosave. We detach
  //     in-container scripts now (so they aren't parsed as editable content) and re-attach them at
  //     the end of <body> after tokenizing, below. Scripts ALREADY OUTSIDE the container (e.g.
  //     already at end of <body>) are left untouched and preserved verbatim in place by the template.
  // Preserving a user's script is lossless (their files, often Claude-Code-authored — deleting it is
  // the worse failure); it is SAFE in-app because the head/body template is never injected into the
  // live page (the template is only a save-splice string) and rich blocks render via innerHTML,
  // which never executes <script>. Body active content is still neutralized by stripActive for live
  // render. Hardening against genuinely untrusted imported HTML is deferred — see corpus 'security'.
  container.querySelectorAll("style").forEach((el) => doc.head.appendChild(el));
  const heldScripts = Array.from(container.querySelectorAll("script")); heldScripts.forEach((el) => el.remove());
  // Capture the doc's styles to inject into each rich block's SHADOW root — scoped, so
  // they render the content but NEVER leak into the editor chrome (the white-bg bug).
  // Rewrite :root → :host so a doc's custom props (e.g. --font-mono) resolve in the shadow.
  const richStyles = Array.from(doc.querySelectorAll("style")).map((s) => "<style>" + (s.textContent || "").replace(/:root\b/g, ":host") + "</style>").join("\n");
  // FULL_PARSE: rewrite the same styles to the editor-mount scope so class/element rules render
  // the EDITABLE content without clobbering the chrome (live-only; the original <style> still
  // round-trips verbatim through the template's head).
  const scopedCss = FULL_PARSE ? scopeCss(Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || "").join("\n"), ".note-scope") : "";
  const hasMarkers = !!container.querySelector("[data-rich-block]");
  if (FULL_PARSE) {
    // Re-derive rich blocks from CONTENT, not stale markers: drop every data-rich-block wrapper
    // (from a prior save / md-to-redesigned output — these often pin a whole <article> atomic),
    // then recursively isolate ONLY the minimal
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
      if (el.hasAttribute("data-rich-block")) return;
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
  // "%%NOTE_BODY%%" sitting in a head comment), so serializeDoc splices the body into
  // exactly the right place — never the head, never a stray match.
  let tok = "%%NOTE_BODY%%", n = 0;
  while (raw.includes(tok)) tok = "%%NOTE_BODY_" + (++n) + "%%";
  container.innerHTML = tok;
  heldScripts.forEach((el) => doc.body.appendChild(el)); // re-attach in-container scripts at end of <body> (runs after the spliced DOM)
  const template = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  return { content, template, token: tok, richStyles, scopedCss, frame };
}

// Strip the editor-only data-sbox hook from saved HTML (it's a styling/margin hook, not content).
function stripSbox(html: string): string {
  if (html.indexOf("data-sbox") < 0) return html;
  const t = document.createElement("template"); t.innerHTML = html;
  t.content.querySelectorAll("[data-sbox]").forEach((e) => e.removeAttribute("data-sbox"));
  return t.innerHTML;
}

// The save-side serializer (was the editor's serialize() html branch): body HTML out of
// the model → tidy → splice into the preserved shell. Falls back to a minimal shell when
// prepareDoc failed on load (template null) or the caller has no shell.
export function serializeDoc(bodyHtml: string, prep: { template: string | null; token: string } | null): string {
  const body = tidySaveHtml(stripSbox(bodyHtml));
  if (prep && prep.template) return spliceBody(prep.template, prep.token, body);
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><article>\n${body}\n</article></body></html>\n`;
}
