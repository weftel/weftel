// note-editor-spike client — TipTap block model.
//
//   ProseBlock   fluid text (md/html)
//   RichBlock    arbitrary HTML, verbatim + atomic (div[data-rich-block])
//   ClockBlock    live dynamic app (node view)
//
// Safety: lossless html round-trip (full <head>/shell preserved; unmodelable
// top-level elements wrapped, never flattened); sequence-guarded autosave with a
// status pill, flush-on-navigate, and beforeunload flush; hardened cmd+K.
//
import { Editor, Extension } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import Placeholder from "@tiptap/extension-placeholder";
import Suggestion from "@tiptap/suggestion";
import { stripActive, escapeAttr, nativeInsertable, collectSvgTextLeaves, collectSvgTextRuns, collectHtmlTextLeaves, collectHtmlTextRuns, tidyInsertHtml, buildTree, countFiles, buildInteractSrcdoc, sanitizeRelNotePath, routeCmdkIntent, type FormatOp, type TableOp, type TreeNode } from "./lib"; // [AI:cmdk] intent router
import { DOMSerializer } from "@tiptap/pm/model";
import { FULL_PARSE, prepareDoc, serializeDoc, engineExtensions } from "./engine"; // shared round-trip engine: schema + parse/serialize (see client/engine.ts)
import { diffApprove } from "./diff-viewer"; // [AI:diff-gate]
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { mountGhostCompletion } from "./ghost-completion"; // [AI:ghost] Tab ghost-text controller
import { commandsFor, FILE_COMMANDS, type Entry, type CmdCtx } from "./commands"; // [fm-sidebar] file/folder command registry — the context menu is built from this


// F42 (residual): a bare, non-indented text line jammed directly under a list item — with no
// blank line — is *lazy-continued* into that item's paragraph by CommonMark (markdown-it). In
// the interview-prep todo, the section initials ("WT", "FS", …) sit between checkboxes that way,
// so they got pulled INTO the preceding checked item and rendered struck-through, as if the
// header were a completed task. Obsidian instead treats a non-indented line as TERMINATING the
// list (it becomes its own paragraph). We match Obsidian by inserting a blank line before such a
// breakout line, so the list ends and the bare line stands alone (flush-left, no checkbox, no
// strikethrough). Scoped narrowly: only fires when the previous line is a list/task marker and
// the current line is non-blank, starts at column 0, and is not itself a list/heading/blockquote/
// table/fence marker. Fenced code blocks are skipped so their contents are never rewritten.
const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])\s/;
function breakoutBareListLines(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false; let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (inFence) { out.push(line); if (fence && fence[2][0] === fenceChar) inFence = false; continue; }
    if (fence) { inFence = true; fenceChar = fence[2][0]; out.push(line); continue; }
    const prev = i > 0 ? lines[i - 1] : "";
    const isBareBreakout = line.trim() !== "" && /^\S/.test(line) && !LIST_MARKER.test(line)
      && !/^#{1,6}\s/.test(line) && !/^>/.test(line) && !/^\|/.test(line);
    if (i > 0 && LIST_MARKER.test(prev) && isBareBreakout) out.push("");
    out.push(line);
  }
  return out.join("\n");
}

// A rich block round-trips as `<div data-rich-block>…HTML…</div>`. Model-generated SVGs/HTML put
// BLANK LINES between element groups — and CommonMark (markdown-it) ENDS an HTML block at the first
// blank line. So on reload everything after that blank line spills OUT of the wrapper (e.g. an SVG's
// children get orphaned into <p>, the diagram renders empty — silent content loss). Strip blank
// lines *inside* each rich-block region so the wrapper stays one contiguous HTML block; whitespace
// between HTML/SVG elements is insignificant, so the rendered result is unchanged. Depth-counts
// <div>/</div> so nested <div>s inside the block don't end the region early. (Load-side fix so
// existing files with blank-line diagrams recover, not just new saves.)
function joinRichBlockBlankLines(md: string): string {
  if (md.indexOf("data-rich-block") < 0) return md;
  const lines = md.split("\n");
  const out: string[] = [];
  let depth = 0;
  const count = (s: string, re: RegExp) => (s.match(re) || []).length;
  for (const line of lines) {
    if (depth === 0) {
      out.push(line);
      if (/<div[^>]*data-rich-block/.test(line)) depth = count(line, /<div\b/gi) - count(line, /<\/div>/gi);
      continue;
    }
    depth += count(line, /<div\b/gi) - count(line, /<\/div>/gi);
    if (line.trim() !== "") out.push(line); // drop the blank line that would terminate the HTML block
  }
  return out.join("\n");
}

type Note = { file: string; format: string; content: string; root: string; interactive?: boolean };
const W = window as any;
const note: Note | null = W.__NOTE__ && W.__NOTE__.file ? W.__NOTE__ : null;
const ROOT: string = (W.__NOTE__ && W.__NOTE__.root) || "";



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

// [AI:ghost] Tab arbitration hook. Rebound to the live ghost controller's acceptTab() when
// GHOST_TEXT_ENABLED mounts it (below). Default no-op returns false, so when no ghost is showing
// (or the flag is off / controller unmounted) Tab falls through to the list-indent / table / code
// behavior below, byte-identical to today. Shared mutable ref — not a TabKeys rewrite.
let ghostAcceptTab: () => boolean = () => false;

// Tab must never throw focus out of the editor ("takes me to weird places"). Lists
// indent/outdent, code blocks get a literal tab, tables keep their own cell-hopping
// (pass through), and anywhere else the key is consumed.
const TabKeys = Extension.create({
  name: "tabKeys",
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor: e }: any) => {
        if (ghostAcceptTab()) return true;      // [AI:ghost] a showing ghost claims Tab (accept + consume); else falls through
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
// Image NodeView (schema lives in engine.ts): display through /raw?file= + corner drag-resize.
const imageView = ({ node, editor, getPos }: any) => {
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

// RichBlock NodeView (schema lives in engine.ts): shadow-DOM render of the verbatim HTML
// + double-click leaf text editing (SVG overlay / HTML leaf overlay).
const richView = ({ node, editor, getPos }: any) => {
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
      // F36: the HTML element leaf currently being edited, plus the floating editor that drives it.
      // Chromium will NOT paint a caret for a contentEditable nested under a contenteditable=false host
      // INSIDE a shadow root — even with focus + a correct collapsed selection in the leaf, the caret
      // is suppressed (the flat-tree editability check sees the false host). So instead of editing the
      // leaf in place we mirror the WORKING SVG path: a real editor in document.body, OUTSIDE PM and the
      // shadow root, gets a reliable caret. Unlike the SVG <input> it's a multi-line contentEditable
      // <div>, so a wrapped figcaption edits naturally. The overlay carries an OPAQUE background (the
      // leaf's effective ancestor bg) so it covers the leaf's own text — we never mutate the leaf
      // itself (no style/attr touch), so the block round-trips byte-faithfully. Null when none active.
      let activeLeaf: HTMLElement | null = null, leafOverlay: HTMLDivElement | null = null, activeLeafOrig = "", activeLeafHandlers: (() => void) | null = null;
      // First non-transparent background walking up from a leaf (through the shadow boundary to the
      // host), so the floating overlay can paint over the leaf's own text without a see-through gap.
      const effectiveBg = (el: Element): string => {
        let n: Node | null = el;
        while (n && (n as Element).nodeType === 1) {
          const bg = getComputedStyle(n as Element).backgroundColor;
          if (bg && bg !== "transparent" && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) return bg;
          const p = (n as Element).parentElement; n = p || ((n as any).getRootNode?.() as ShadowRoot)?.host || null;
        }
        return "var(--surface)";
      };
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

      // F36: edit an HTML element leaf (a <figcaption>/<div>/<p>/<li>… holding only text) through a
      // BODY-LEVEL contentEditable overlay (the SVG path's "plan B", multi-line for wrapped captions).
      // SILENT close: detach listeners + remove the overlay BEFORE clearing state, so a teardown can
      // never re-enter as a phantom commit. The leaf itself is NEVER mutated while editing (no style or
      // attribute touch) — the opaque overlay simply covers it — so the block stays byte-faithful.
      let committingLeaf = false;
      const closeActiveLeaf = () => {
        if (!activeLeaf) return;
        if (activeLeafHandlers) activeLeafHandlers();
        if (leafOverlay) leafOverlay.remove();                 // the leaf was never mutated → nothing to restore
        activeLeaf = null; leafOverlay = null; activeLeafHandlers = null;
      };
      const commitActiveLeaf = () => {
        if (!activeLeaf || !leafOverlay || committingLeaf) return;
        committingLeaf = true;
        try {
          const leaf = activeLeaf, val = leafOverlay.textContent || ""; // textContent ONLY — never innerHTML (drops any stray markup/paste)
          closeActiveLeaf();
          if (val === activeLeafOrig) return;                  // untouched → byte-identical, no churn
          commitLeaf(leaf, val);
        } finally { committingLeaf = false; }
      };
      // Commit ANY in-progress edit (overlay or in-place leaf) before opening a new one or rendering.
      const bankPending = () => { commitOverlay(); commitActiveLeaf(); };
      function openLeaf(leaf: HTMLElement, ev?: MouseEvent) {
        bankPending();
        activeLeaf = leaf; activeLeafOrig = leaf.textContent || "";
        const rect = rectOf(leaf), cs = getComputedStyle(leaf);
        const ov = document.createElement("div"); ov.className = "leaftext-overlay";
        ov.setAttribute("contenteditable", "true"); ov.setAttribute("spellcheck", "false");
        ov.textContent = leaf.textContent || "";
        // Box the overlay exactly over the leaf and copy its type, so it reads as editing in place.
        // An OPAQUE background (the leaf's effective ancestor bg) paints over the leaf's own text so
        // there's no double image — without ever mutating the leaf (byte-faithful). The accent outline
        // is the edit affordance (the in-place version had it via a shadow style hint).
        ov.style.cssText = "position:absolute;z-index:80;margin:0;box-sizing:border-box;border:0;"
          + "left:" + (window.scrollX + rect.left) + "px;top:" + (window.scrollY + rect.top) + "px;"
          + "width:" + (Math.ceil(rect.width) + 2) + "px;min-height:" + Math.ceil(rect.height) + "px;"
          + "background:" + effectiveBg(leaf) + ";outline:1.5px solid var(--accent);outline-offset:2px;border-radius:3px";
        (["fontFamily","fontSize","fontWeight","fontStyle","fontVariant","lineHeight","letterSpacing",
          "wordSpacing","textAlign","textTransform","textIndent","whiteSpace","color",
          "paddingTop","paddingRight","paddingBottom","paddingLeft"] as const)
          .forEach((p) => { (ov.style as any)[p] = (cs as any)[p]; });
        document.body.appendChild(ov); leafOverlay = ov;
        // PLAINTEXT GUARD: a contentEditable can otherwise accrue <br>/<div> on Enter or absorb rich
        // pasted markup. We neutralize both — Enter commits (these leaves are single logical lines),
        // and paste inserts text/plain only. commit reads textContent regardless, so this is purely
        // to keep the LIVE overlay clean mid-edit; nothing here can make imported markup execute.
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
          const sel: Selection | null = window.getSelection();
          if (sel && sel.rangeCount) { const r = sel.getRangeAt(0); r.deleteContents(); const tn = document.createTextNode(text); r.insertNode(tn); r.setStartAfter(tn); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
        };
        const onBlur = () => commitActiveLeaf();
        ov.addEventListener("keydown", onKey);
        ov.addEventListener("beforeinput", onBeforeInput as EventListener);
        ov.addEventListener("paste", onPaste as EventListener);
        ov.addEventListener("blur", onBlur);
        activeLeafHandlers = () => {
          ov.removeEventListener("keydown", onKey);
          ov.removeEventListener("beforeinput", onBeforeInput as EventListener);
          ov.removeEventListener("paste", onPaste as EventListener);
          ov.removeEventListener("blur", onBlur);
        };
        ov.focus();
        // Place a COLLAPSED caret (a visible blinking cursor), not a select-all. The overlay lives in
        // document.body (light DOM), so window.getSelection drives it and the caret paints reliably.
        // Prefer the exact double-click point (the overlay now sits on top there); else end-of-text.
        try {
          const s: Selection | null = window.getSelection();
          let r: Range | null = null;
          if (ev && (document as any).caretRangeFromPoint) {
            const cr: Range | null = (document as any).caretRangeFromPoint(ev.clientX, ev.clientY);
            if (cr && ov.contains(cr.startContainer)) { cr.collapse(true); r = cr; }
          }
          if (!r) { r = document.createRange(); r.selectNodeContents(ov); r.collapse(false); }
          s!.removeAllRanges(); s!.addRange(r);
        } catch {}
      }

      const render = (html: string) => {
        closeOverlay(); closeActiveLeaf();
        // [AI:cmdk] base fallback first (caps an unstyled AI SVG to the column — never enlarges, so
        // a small icon keeps its size); the doc's own <style> (RICH_STYLES) is injected AFTER, so an
        // imported design still wins. None of this is ever serialized (styles live in the shadow only).
        shadow.innerHTML = "<style>svg{max-width:100%;height:auto}</style>" + (RICH_STYLES || "");
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
          htmlLeaves.forEach((leaf) => (leaf as HTMLElement).addEventListener("dblclick", (e: Event) => { e.preventDefault(); e.stopPropagation(); openLeaf(leaf as HTMLElement, e as MouseEvent); }));
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

function appHead(title: string, onSettings?: () => void): HTMLElement {
  const head = document.createElement("div"); head.className = "app-head";
  const lhs = document.createElement("div"); lhs.className = "lhs";
  const live = document.createElement("span"); live.className = "live"; live.innerHTML = '<span class="dot"></span>LIVE';
  const name = document.createElement("span"); name.textContent = title;
  lhs.appendChild(live); lhs.appendChild(name); head.appendChild(lhs);
  if (onSettings) { const b = document.createElement("button"); b.className = "app-btn"; b.textContent = "settings"; b.onclick = onSettings; head.appendChild(b); }
  return head;
}

// Clock NodeView (schema lives in engine.ts): the live ticking face.
const clockView = ({ node }: any) => {
      const dom = document.createElement("div"); dom.className = "app-block"; dom.setAttribute("data-clock", ""); dom.contentEditable = "false";
      // [AI:cmdk] render the node's tz attr (so a ⌘K "change clock to PT" edit is actually visible),
      // label the zone in the head, and fall back to local time if the zone is invalid/unsupported.
      const tz = node.attrs.tz && node.attrs.tz !== "local" ? String(node.attrs.tz) : "";
      dom.appendChild(appHead("Clock" + (tz ? " · " + tz : "")));
      const face = document.createElement("div"); face.style.cssText = "font:600 38px ui-monospace,Menlo,monospace;letter-spacing:.04em;text-align:center;padding:26px 0;color:var(--accent-ink)";
      dom.appendChild(face);
      const tick = () => { try { face.textContent = new Date().toLocaleTimeString([], tz ? { timeZone: tz } : undefined); } catch { face.textContent = new Date().toLocaleTimeString(); } };
      tick(); const iv = setInterval(tick, 1000);
      return { dom, stopEvent: () => true, ignoreMutation: () => true, destroy: () => clearInterval(iv) };
    };

// Callout NodeView chrome (schema lives in engine.ts): icon column + editable body.
const CALLOUT_KINDS: Record<string, { icon: string; label: string }> = {
  info: { icon: "ℹ", label: "Info" }, tip: { icon: "✦", label: "Tip" }, warn: { icon: "▲", label: "Warning" },
};
const calloutView = ({ node }: any) => {
      const dom = document.createElement("div"); dom.className = "callout callout-" + node.attrs.kind; dom.setAttribute("data-callout", ""); dom.setAttribute("data-kind", node.attrs.kind);
      const icon = document.createElement("div"); icon.className = "callout-icon"; icon.contentEditable = "false"; icon.textContent = (CALLOUT_KINDS[node.attrs.kind] || CALLOUT_KINDS.info).icon;
      const content = document.createElement("div"); content.className = "callout-body";
      dom.appendChild(icon); dom.appendChild(content);
      return { dom, contentDOM: content };
    };


// In-app AI edit (⌘K) — cut for first launch (net-negative on dogfooding; see
// notes-editor-wiki/quality-gaps.html F23). The plumbing stays behind this flag; the
// rebuild flips it on. Single source of truth is the server const, injected into the page
// (server.ts shell()). Off ⇒ no ⌘K keybinding, chip, slash item, or bubble button.
const AI_EDIT_ENABLED: boolean = !!(window as any).__AI_EDIT_ENABLED;

// [AI:firstrun] Live provider-connection state, filled by initAiConnectBanner() from /api/ai-status.
// null = unknown (not yet checked / AI off); false = a provider is missing (banner shown); true =
// reachable. The ⌘K path reads it so a rewrite that fails while NOT connected shows the actionable
// "connect your Claude / point at Ollama" step instead of a raw provider error.
let aiConnected: boolean | null = null;
let aiConnectHint = "";

// [AI:diff-gate] Optional human-approval gate: when on, a computed AI edit is shown as a
// RENDERED visual diff (client/diff-viewer.ts) and only inserted on accept. Default OFF so
// base behavior is byte-identical to the no-gate path; the rebuild flips __DIFF_GATE_ENABLED.
const DIFF_GATE_ENABLED: boolean = !!(window as any).__DIFF_GATE_ENABLED;

// Slash menu. Cross-references into the main scope (Ask AI → cmd+K, insert-block prompts)
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
  { title: "Clock", group: "Embeds", aliases: "time live", run: (e, r) => { del(e, r).run(); slashHooks.insertEmbed?.("clock"); } },
  ...(AI_EDIT_ENABLED ? [{ title: "Write with AI…", group: "AI", aliases: "generate cmdk diagram ask", run: (e: any, r: any) => { del(e, r).run(); slashHooks.askAI?.(); } } as SlashItem] : []),
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
let htmlTemplate: string | null = null; // full original doc with %%NOTE_BODY%% where editable content goes
let BODY_TOKEN = "%%NOTE_BODY%%"; // reassigned per-load to a collision-free value (see engine.ts prepareDoc)
let RICH_STYLES = ""; // an imported doc's <style> blocks — injected into each rich block's SHADOW root (scoped, no global leak)
let SCOPED_NOTE_CSS = ""; // FULL_PARSE: the doc's <style> rewritten to the .note-scope wrapper, injected live so classed editable content renders right (never saved)
// F39: prepareHtml takes the doc's <article>/<main> as the editable CONTAINER and strips it to
// htmlTemplate — so when that container is the page FRAME (e.g. <main class="wrap"> capping width
// and centering itself), its frame is absent from the edit surface and the content falls into the
// editor's plain column (and a scoped body{margin:0} pins it hard-left). Remember the container's
// identity so own-frame detection can re-apply its frame to the column. (null for body-as-container.)
let FRAME_CONTAINER: { tag: string; cls: string; style: string } | null = null;


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
    // The schema comes from the SHARED engine (client/engine.ts) — identical for the live
    // editor and the headless verifier. Only the four NodeViews (browser display/behavior)
    // are injected here; the trailing extensions are UI-only and contribute no schema.
    ...engineExtensions({ linkOpts, nodeViews: { image: imageView, richBlock: richView, clockBlock: clockView, callout: calloutView } }),
    SlashMenu, TabKeys, EscapeTrap,
    Placeholder.configure({ placeholder: ({ node }: any) => (node.type.name === "heading" ? "Heading" : "Write, or press \u201c/\u201d for commands\u2026"), showOnlyCurrent: true }),
  ];
  let content = note.content;
  // F43: linkify is OFF. With it on, markdown-it auto-wrapped every BARE url in a link mark; on
  // save the serializer then rewrote it — `https://x` became `<https://x>` (autolink) or, when the
  // display text and href diverged, `[decoded text](encoded url)` — URL-DECODING the visible text
  // (`%20`→space) and mutating a file the user never edited. It also fuzzy-linked bare domains in
  // prose (`Playabl.ai`→`http://Playabl.ai`). Turning linkify off keeps bare URLs as plain text, so
  // they round-trip byte-for-byte. Explicitly-authored `[text](url)` links are unaffected (they
  // still parse to link marks and stay clickable). Trade-off: bare URLs are no longer clickable —
  // fidelity wins (F40-class zero-mutation invariant). Could be re-added later as a display-only
  // decoration that never touches the document model.
  if (note.format === "md") { content = joinRichBlockBlankLines(breakoutBareListLines(content)); extensions.push(Markdown.configure({ html: true, linkify: false, breaks: true })); } // breaks:true + breakout → F42; joinRichBlockBlankLines → SVG/HTML rich blocks survive reload (blank lines no longer split the HTML block)
  else if (note.format === "html") {
    try {
      const prep = prepareDoc(note.content);
      content = prep.content; htmlTemplate = prep.template; BODY_TOKEN = prep.token;
      RICH_STYLES = prep.richStyles; SCOPED_NOTE_CSS = prep.scopedCss; FRAME_CONTAINER = prep.frame;
    } catch { htmlTemplate = null; content = note.content; }
  }

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
    element: mount, extensions, content, autofocus: "start",
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
      // frameInfo reads an element's DECLARED max-width / margin-auto from inline style + the
      // scoped sheet (matchMedia-gated so a mobile @media override doesn't masquerade as the base).
      const frameInfo = (el: HTMLElement): { hasMax: boolean; hasAuto: boolean; maxWidth: string } => {
        let hasMax = !!el.style.maxWidth, hasAuto = /auto/.test(el.style.margin + " " + el.style.marginLeft);
        let maxWidth = el.style.maxWidth || "";
        const sheet = (document.getElementById("note-scoped") as HTMLStyleElement | null)?.sheet;
        if (sheet) {
          const walk = (rules: CSSRuleList) => {
            for (const r of Array.from(rules) as any[]) {
              // NB: a plain CSSStyleRule ALSO has .cssRules (CSS nesting) — selectorText first
              if (r.selectorText && r.style) {
                try { if (!el.matches(r.selectorText)) continue; } catch { continue; }
                if (r.style.maxWidth) { hasMax = true; maxWidth = r.style.maxWidth; }
                if (/auto/.test(r.style.marginLeft) || /auto/.test(r.style.margin)) hasAuto = true;
              } else if (r.cssRules && r.cssRules.length) {
                // @media: only count it if it currently applies, so a narrow-viewport override
                // (or @print) never overwrites the base frame. @supports/others descend as-is.
                if (r.media && r.media.mediaText) { try { if (!window.matchMedia(r.media.mediaText).matches) continue; } catch {} }
                walk(r.cssRules);
              }
            }
          };
          walk(sheet.cssRules);
        }
        return { hasMax, hasAuto, maxWidth };
      };
      const selfFraming = (el: HTMLElement): boolean => { const f = frameInfo(el); return f.hasMax && f.hasAuto; };
      // F39: the page frame can live on the stripped <article>/<main> CONTAINER instead of on an
      // editable child (project-deep-dives: <main class="wrap"> caps+centers, its children don't).
      // The container isn't in the live DOM, so probe a hidden clone INSIDE .note-scope (so the
      // scoped descendant rules match it) and read its declared frame. Returns the max-width to
      // re-cap the column with, or null when the container carries no frame of its own.
      const containerFrameWidth = (): string | null => {
        if (!FRAME_CONTAINER) return null;
        const probe = document.createElement(FRAME_CONTAINER.tag);
        if (FRAME_CONTAINER.cls) probe.className = FRAME_CONTAINER.cls;
        if (FRAME_CONTAINER.style) probe.setAttribute("style", FRAME_CONTAINER.style);
        probe.style.position = "absolute"; probe.style.visibility = "hidden"; probe.style.pointerEvents = "none"; probe.style.height = "0";
        mount.appendChild(probe);
        try {
          const f = frameInfo(probe);
          return f.hasMax && f.hasAuto && f.maxWidth && f.maxWidth !== "none" ? f.maxWidth : null;
        } finally { probe.remove(); }
      };
      const first = mount.querySelector(".ProseMirror > *") as HTMLElement | null;
      if (first && selfFraming(first)) {
        mount.classList.add("own-frame");
        // Land the caret at the TOP, INSIDE the page wrapper. (Earlier autofocus("end")
        // parked it in the escape paragraph AFTER the wrapper — typing there lands outside
        // the frame, hard-left and unstyled, "my words start at the very left." The escape
        // paragraph stays reachable by clicking below the page.) Continue-the-document means:
        // caret INSIDE the wrapper, at its start.
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
        // Arm the escape-slot trap (see EscapeTrap), then place the caret at the START of the
        // page. autofocus:"start" already lands inside the frame at the top; re-applying it
        // through the armed trap keeps it there (and out of the escape slot below the page).
        OWN_FRAME = true;
        const fc = editor!.state.doc.firstChild;
        if (fc && fc.type.name === "styledBox") setTimeout(() => editor!.chain().focus("start").run(), 0);
      } else if (first && !frameInfo(first).hasMax) {
        // F39: the frame lived on the stripped <main>/<article> container, NOT on an editable
        // child. Two tells separate this from attention.html (the F18 trap): (1) the container
        // itself caps width AND centers (margin:auto), and (2) the content has NO width cap of
        // its OWN — it relied entirely on the container for sizing. attention fails (2): it caps
        // every element (p{max-width}) and only borrows the container for centering, so it must
        // stay in the normal centered column. When both hold, re-cap+center the column at the
        // container's width so edit mode matches the browser instead of falling hard-left.
        const cw = containerFrameWidth();
        if (cw) { mount.style.setProperty("--frame-cap", cw); mount.classList.add("own-frame-cap"); }
      }
    });
  }


  // -------- serialize --------
  const serialize = (): string => {
    if (!editor) return "";
    if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); }
    return serializeDoc(editor.getHTML(), { template: htmlTemplate, token: BODY_TOKEN });
  };
  W.__serialize = serialize; // test seam: read the exact bytes a save would write (corpus harness)

  // Clicking the empty space around the doc must keep the caret in the editor, not blur it
  // (a click there focused <body> and typing went nowhere). The vertical position decides
  // WHERE: a click genuinely BELOW all content continues the note at the end (F20; in a
  // self-framed doc the escape-trap then folds typed content into the page). A click in the
  // SIDE gutter beside the text — Y still within content — must land on the nearest line at
  // that Y (F38), NOT hijack the caret to doc-end. We resolve it with posAtCoords, X clamped
  // into the text column so the point falls on the line the user aimed at.
  document.querySelector(".layout .main")?.addEventListener("mousedown", (e) => {
    if (interactMode) return; // the sandboxed preview owns the pane — don't steal focus to the editor
    const t = e.target as HTMLElement | null;
    if (!editor || !t || t.closest(".ProseMirror") || t.closest("a,button,input,select,textarea")) return;
    e.preventDefault();
    const pm = editor.view.dom.getBoundingClientRect();
    // The PM box carries min-height padding below the last line, so use the last child's
    // bottom as the true content end — the discriminator for "below content" vs "beside it".
    const last = editor.view.dom.lastElementChild as HTMLElement | null;
    const contentBottom = last ? last.getBoundingClientRect().bottom : pm.bottom;
    if (e.clientY > contentBottom) { editor.chain().focus("end").run(); return; } // below all content → continue the note (F20)
    // Side gutter at a Y within content: map to the nearest line, X clamped into the column,
    // Y clamped below the first line so a click above the top maps to the start, never the end.
    const left = Math.min(Math.max(e.clientX, pm.left + 1), pm.right - 1);
    const top = Math.max(e.clientY, pm.top + 1);
    const hit = editor.view.posAtCoords({ left, top });
    if (hit && typeof hit.pos === "number") editor.chain().focus(hit.pos).run();
    else editor.chain().focus("end").run();
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
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  const RETRY_MAX = 6; // bounded auto-retry: a server that stays down isn't hammered forever
  let saveChain: Promise<boolean> = Promise.resolve(true);
  function clearRetry() { clearTimeout(retryTimer); retryTimer = undefined; retryAttempt = 0; }
  // On a failed /save, retry on a bounded exponential backoff (1s,2s,4s,8s,15s,15s) so a
  // transient blip — server restarting/unreachable/non-2xx — self-heals back to "Saved" with NO
  // keystroke (F50). Reset by any success or fresh edit; after RETRY_MAX it parks on a static
  // label and the next edit/navigation re-arms a save. One pending retry at a time.
  function scheduleRetry() {
    if (retryTimer) return;
    if (retryAttempt >= RETRY_MAX) { setStatus("error", "Save failed — retry"); return; }
    const delay = Math.min(15000, 1000 * 2 ** retryAttempt);
    retryAttempt++;
    setStatus("error", "Save failed — retrying…");
    retryTimer = setTimeout(() => { retryTimer = undefined; if (dirty) doSave(); }, delay);
  }
  // One save at a time: chain so a new save never races a /save already in flight
  // (both POST the same file; concurrent writes could otherwise land out of order).
  function actualSave(): Promise<boolean> {
    return (async () => {
      const out = serialize();
      if (out === lastSaved) { dirty = false; clearRetry(); setStatus("saved", "Saved"); return true; }
      setStatus("saving", "Saving…");
      try {
        const r = await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: note.file, content: out }) }).then((x) => x.json());
        if (r.ok) { lastSaved = out; clearRetry(); if (serialize() === out) { dirty = false; setStatus("saved", "Saved"); } return true; } // stay dirty if edited mid-save
        scheduleRetry(); return false; // server reachable but refused — back off and retry
      } catch { scheduleRetry(); return false; } // unreachable — back off and retry
    })();
  }
  function doSave(): Promise<boolean> { saveChain = saveChain.then(actualSave, actualSave); return saveChain; }
  function scheduleSave() { if (!armed) return; dirty = true; clearRetry(); setStatus("dirty", "Unsaved"); clearTimeout(timer); timer = setTimeout(doSave, 600); }
  async function flushSave(): Promise<boolean> { clearTimeout(timer); clearRetry(); if (dirty) return await doSave(); await saveChain; return true; }
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

  // [AI:ghost] Tab ghost-text ("Cursor-Tab for notes", v1) — mounted ONLY when the server flag is
  // on (window.__GHOST_TEXT_ENABLED, default off). Wires the controller's acceptTab into the Tab
  // arbitration hook (ghostAcceptTab, top of TabKeys) so a showing ghost claims Tab and otherwise
  // Tab/list-indent is unchanged. onAccept → markEdited so accepting arms autosave (the insert is
  // programmatic, so no beforeinput fires). When the flag is off this whole block is skipped and
  // ghostAcceptTab stays the no-op — base behavior is byte-identical.
  if ((window as any).__GHOST_TEXT_ENABLED) {
    const ghost = mountGhostCompletion(editor, { onAccept: markEdited });
    ghostAcceptTab = ghost.acceptTab;
  }

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
  cmdk.innerHTML = '<input type="text" placeholder="Edit the selection — format, rewrite, or generate… (Enter to run, Esc to cancel)"><div class="cmdk-hint"></div>'; // [AI:cmdk]
  document.body.appendChild(cmdk);
  const cmdkInput = cmdk.querySelector("input") as HTMLInputElement;
  const cmdkHint = cmdk.querySelector(".cmdk-hint") as HTMLElement;
  let cmdkTarget: any = null;

  const docContext = (): string => { if (!editor) return ""; if (note.format === "md") { const s: any = editor.storage; return s.markdown && s.markdown.getMarkdown ? s.markdown.getMarkdown() : editor.getText(); } return editor.getHTML(); };

  // [AI:cmdk] ⌘K is SELECTION-FIRST: the thing the user selected is the target; the doc is only
  // background context. Classify the target by what's selected, then route on submit — deterministic
  // editor commands for the surgical cases (formatting marks, native-block attr/structure edits) and
  // the model ONLY for genuine generation (rewrite prose / author content / rebuild an HTML block).
  const CMDK_HINT: Record<string, string> = {
    rich: "edit this HTML block — e.g. “make the grid 6×6”",
    clock: "change the clock — “PT”, “Tokyo”, “UTC”",
    callout: "recolor this callout — “make it a warning / tip / info”",
    table: "edit this table — “add a row”, “delete column”, “toggle header”",
    author: "write — a paragraph, list, table, or diagram (HTML when it helps)",
  };
  // Nearest ancestor of one of `names` containing the cursor (for content blocks the cursor sits
  // INSIDE — callout, table — which aren't NodeSelections). Returns the block start + the cursor pos.
  function enclosing(names: string[]): { pos: number; anchor: number } | null {
    const $f: any = editor!.state.selection.$from;
    for (let d = $f.depth; d > 0; d--) { if (names.includes($f.node(d).type.name)) return { pos: $f.before(d), anchor: $f.pos }; }
    return null;
  }
  function openCmdk() {
    if (!editor) return;
    const sel: any = editor.state.selection;
    // [AI:cmdk] Block CONTEXT, computed for EVERY selection shape (cursor in a cell, a cell-selection,
    // a text range, a node-selection): does the caret/selection sit in or on a table / callout? A
    // hands-on dogfood found that a text selection inside a table was classified "prose", so "add
    // row" fell through to the model. These flags let routeCmdkIntent prioritize the native op.
    const tblAnc = enclosing(["table"]);                     // $from-based → works for any selection type
    const coAnc = enclosing(["callout"]);
    const isCellSel = !!sel.$anchorCell;                     // prosemirror-tables CellSelection (cells dragged)
    let tgt: any = null;
    if (sel.node) {                                          // a block node is selected (atom) — target it directly
      const n = sel.node.type.name;
      if (n === "richBlock") tgt = { kind: "rich", nodeType: n, pos: sel.from, html: sel.node.attrs.html };
      else if (n === "clockBlock") tgt = { kind: "clock", nodeType: n, pos: sel.from };
      else if (n === "callout") tgt = { kind: "callout", nodeType: n, pos: sel.from, calloutPos: sel.from };
      else if (n === "table") tgt = { kind: "table", tableAnchor: sel.from + 1 };
    }
    if (!tgt) {
      if (isCellSel) tgt = { kind: "table" };                // cells selected → structural target
      else {
        const text = sel.empty ? "" : editor.state.doc.textBetween(sel.from, sel.to, " ");
        if (text) tgt = { kind: "prose", from: sel.from, to: sel.to, text };  // a text range is PRIMARY
        else tgt = { kind: "author", from: sel.from };       // bare caret → author (in-cell / in-callout too)
      }
    }
    // attach block context so a native instruction routes deterministically regardless of primary kind
    if (tblAnc) { tgt.inTable = true; if (tgt.tableAnchor == null) tgt.tableAnchor = tblAnc.anchor; }
    if (coAnc) { tgt.inCallout = true; if (tgt.calloutPos == null) tgt.calloutPos = coAnc.pos; }
    // [F47] A table TARGET (whole-table or multi-cell selection) can take a free-form model REWRITE,
    // not just the structural ops. Capture the table's node range + serialized HTML so the rich path
    // can prompt on it, gate it, and REPLACE the table node in place (parsed back to a real table).
    if (tgt.kind === "table") {
      const tpos = sel.node ? sel.from : (tblAnc ? tblAnc.pos : null);
      const tnode = tpos == null ? null : editor.state.doc.nodeAt(tpos);
      if (tnode && tnode.type.name === "table") {
        tgt.tablePos = tpos; tgt.tableEnd = tpos + tnode.nodeSize;
        tgt.html = (DOMSerializer.fromSchema(tnode.type.schema).serializeNode(tnode) as HTMLElement).outerHTML;
      }
    }
    cmdkTarget = tgt;
    cmdkHint.textContent = tgt.kind === "prose"
      ? "“" + tgt.text.slice(0, 52) + (tgt.text.length > 52 ? "…" : "") + "” — format, rewrite, or transform"
      : tgt.inTable ? CMDK_HINT.table : tgt.inCallout ? CMDK_HINT.callout : (CMDK_HINT[tgt.kind] || "");
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

  // ---- deterministic appliers (no model) -------------------------------------------------------
  // Format a text selection with REAL marks (the contract: never insert literal markdown).
  function applyFormat(t: any, op: FormatOp) {
    const c: any = editor!.chain().focus().setTextSelection({ from: t.from, to: t.to });
    if (op.op === "bold") c.toggleBold();
    else if (op.op === "italic") c.toggleItalic();
    else if (op.op === "strike") c.toggleStrike();
    else if (op.op === "code") c.toggleCode();
    else if (op.op === "clear") c.unsetAllMarks();
    else if (op.op === "highlight") c.setHighlight({ color: op.color || "#fde047" });
    else if (op.op === "color") c.setColor(op.color);
    c.run();
  }
  // Patch a native block's attrs IN PLACE (re-validating the captured position) — never inserts a
  // second block (the old ⌘K's failure). Returns false + a hint if the node moved/changed.
  function setNodeAttrsAt(pos: number | undefined, nodeType: string, patch: any): boolean {
    if (typeof pos !== "number") return false;
    const node = editor!.state.doc.nodeAt(pos);
    if (!node || node.type.name !== nodeType) { cmdkHint.textContent = "block moved — reopen ⌘K"; return false; }
    const attrs = { ...node.attrs, ...patch };
    editor!.chain().command(({ tr }: any) => { tr.setNodeMarkup(pos, undefined, attrs); return true; }).run(); // undoable
    return true;
  }
  // Run a structural TipTap table command on the table the cursor was in — restore the caret into
  // the table first (the cmdk input had focus) so the command resolves the right cell.
  function runTableOp(anchor: number | undefined, op: TableOp) {
    const chain: any = editor!.chain().focus();
    if (typeof anchor === "number") chain.setTextSelection(anchor);
    chain[op]().run();
  }

  // ---- generative path (model) -----------------------------------------------------------------
  function buildCmdkPrompt(t: any, mode: string, intent: string): string {
    if (t.kind === "table") // [F47] whole-table free-form rewrite — keep the result a single <table>
      return "TARGET: an HTML table. Rewrite it to satisfy the instruction, keeping it a single well-formed <table> (preserve the real cell data unless the instruction says to change it). Output pure HTML — one <table> only, no prose, no code fences.\n\nInstruction: " + intent + "\n\nCurrent table HTML:\n" + t.html;
    if (mode === "rich")
      return "TARGET: an HTML block. Rewrite its inner HTML to satisfy the instruction. Output pure HTML only.\n\nInstruction: " + intent + "\n\nCurrent inner HTML:\n" + t.html;
    if (mode === "author")
      return "TARGET: the cursor position in the note. Produce new content to insert. Prose → plain text; a table / list / diagram / card → pure HTML.\n\nInstruction: " + intent + "\n\nNote so far (context only — do not repeat it):\n" + docContext().slice(0, 6000);
    return "TARGET: the selected text shown between « ». Rewrite ONLY that text to satisfy the instruction. Output plain text only — no markup.\n\nInstruction: " + intent + "\n\nSelected text:\n«" + t.text + "»\n\nSurrounding note (context only):\n" + docContext().slice(0, 4000);
  }
  // Refine prompt — revise the CURRENT proposed content per a follow-up instruction (the diff-gate's
  // follow-up input). Same output contract as buildCmdkPrompt, but the base is the proposal itself,
  // not the target's original content, so iterations compound ("now make the ocean bigger").
  function buildRefinePrompt(mode: string, current: string, followup: string): string {
    if (mode === "prose")
      return "TARGET: the text shown between « ». Revise ONLY that text to satisfy the instruction. Output plain text only — no markup.\n\nInstruction: " + followup + "\n\nCurrent text:\n«" + current + "»";
    // rich + author both produce HTML; the current proposal IS that HTML.
    return "TARGET: an HTML block you just produced. Revise its HTML to satisfy the instruction. Output pure HTML only.\n\nInstruction: " + followup + "\n\nCurrent HTML:\n" + current;
  }
  // Run one /rewrite round: POST the prompt, drain the SSE stream, return the server's `done` payload
  // (or a human-readable error). onChunk streams the partial preview (fills the ⌘K hint live).
  // Extracted so the diff-gate's follow-up refine reuses the exact same model path.
  async function runRewrite(prompt: string, mode: string, onChunk?: (preview: string) => void): Promise<{ ok: boolean; r?: any; error?: string }> {
    try {
      const res = await fetch("/rewrite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, mode }) });
      const reader = res.body!.getReader(); const dec = new TextDecoder();
      let buf = ""; let preview = ""; let r: any = null; let gotChunk = false; let serverErr = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith("data: ")) continue;
          const obj = JSON.parse(line.slice(6));
          if (obj.chunk) { gotChunk = true; preview += obj.chunk; onChunk?.(preview); }
          else if (obj.done) r = obj.done;
          else if (obj.error) serverErr = obj.error;
        }
      }
      if (!r || !r.ok || !r.text)
        return { ok: false, error: serverErr ? "failed: " + serverErr : (!r && gotChunk) ? "response was cut off — try again" : !r ? "no response (timed out?) — try again" : "AI returned nothing — try again" };
      return { ok: true, r };
    } catch { return { ok: false, error: "failed — try again" }; }
  }
  // Commit a model RESULT to its target — the SINGLE place a generated result mutates the doc, so
  // the diff-gate (separate track) has exactly one call to intercept. Returns false (cmdk stays
  // open, with a hint) when it can't apply.
  function applyAiResult(t: any, mode: string, r: any): boolean {
    if (mode === "rich") {
      if (r.text.indexOf("<") < 0) { cmdkHint.textContent = "AI didn’t return HTML — try again"; return false; }
      if (t.kind === "table") {
        // [F47] Replace the TABLE node in place with the rewritten HTML, parsed back into a real,
        // editable table — a table isn't a richBlock, so never setNodeMarkup an html attr on it.
        const node = typeof t.tablePos === "number" ? editor!.state.doc.nodeAt(t.tablePos) : null;
        if (!node || node.type.name !== "table") { cmdkHint.textContent = "table moved — reopen ⌘K"; return false; }
        const to = Math.min(t.tableEnd, editor!.state.doc.content.size);
        editor!.chain().focus().insertContentAt({ from: t.tablePos, to }, tidyInsertHtml(r.text)).run();
        return true;
      }
      let pos: number | null = t.pos;                        // trust the captured pos; else re-find by content
      const at = pos == null ? null : editor!.state.doc.nodeAt(pos);
      if (!at || at.type.name !== "richBlock" || at.attrs.html !== t.html) pos = findRichPos(t.html);
      if (pos == null) { cmdkHint.textContent = "block moved — try again"; return false; }
      const node = editor!.state.doc.nodeAt(pos);
      editor!.chain().command(({ tr }: any) => { tr.setNodeMarkup(pos as number, undefined, { ...(node ? node.attrs : {}), html: r.text }); return true; }).run(); // edits the block, no duplicate
    } else if (mode === "author") {
      const at = Math.min(t.from, editor!.state.doc.content.size);
      if (r.html && !nativeInsertable(r.text)) editor!.chain().focus().insertContentAt(at, { type: "richBlock", attrs: { html: r.text } }).run();
      else editor!.chain().focus().insertContentAt(at, tidyInsertHtml(r.text)).run();
    } else { // prose: replace ONLY the selection with the rewritten plain text
      const to = Math.min(t.to, editor!.state.doc.content.size); const from = Math.min(t.from, to);
      editor!.chain().focus().insertContentAt({ from, to }, r.text).run();
    }
    return true;
  }

  cmdkInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !cmdkTarget || !cmdkInput.value.trim() || !editor) return;
    const intent = cmdkInput.value.trim(); const t = cmdkTarget;

    // 1) Deterministic, in-app ops — routed WITHOUT the model so they can't duplicate a block or
    //    emit a literal markdown mark. A native-block instruction wins whenever the caret/selection
    //    is in or on that block (routeCmdkIntent), so "add row" with text selected in a cell adds a
    //    row — it no longer falls through to generation. Unrecognized native instructions → a hint
    //    (never generation, which is what used to duplicate the block).
    const TABLE_HINT = "try “add a row”, “delete column”, “toggle header”";
    const HINT_FOR: Record<string, string> = { clock: "name a zone — “PT”, “UTC”, “Tokyo”…", callout: "try “make it a warning / tip / info”", table: TABLE_HINT };
    const route = routeCmdkIntent({ kind: t.kind, inTable: t.inTable, inCallout: t.inCallout }, intent);
    if (route.kind === "table") { runTableOp(t.tableAnchor, route.op); markEdited(); closeCmdk(); flash("table updated"); return; }
    if (route.kind === "callout") { if (setNodeAttrsAt(t.calloutPos, "callout", { kind: route.calloutKind })) { markEdited(); closeCmdk(); flash("callout → " + route.calloutKind); } return; }
    if (route.kind === "clock") { if (setNodeAttrsAt(t.pos, "clockBlock", { tz: route.tz })) { markEdited(); closeCmdk(); flash("clock → " + route.tz); } return; }
    if (route.kind === "format") { applyFormat(t, route.op); markEdited(); closeCmdk(); flash("formatted"); return; }
    if (route.kind === "hint") { cmdkHint.textContent = HINT_FOR[route.target]; return; }

    // 2) Generative path — only rich / author / prose-rewrite reach the model. Stream the result.
    const mode = route.mode;
    cmdkInput.disabled = true; cmdkHint.textContent = "thinking with your Claude…";
    // Honest failure UX (cut-off vs timeout vs empty) lives inside runRewrite.error now.
    const out = await runRewrite(buildCmdkPrompt(t, mode, intent), mode, (p) => { cmdkHint.textContent = p.replace(/\s+/g, " ").trim().slice(-90) || "…"; });
    if (!out.ok || !out.r) {
      cmdkInput.disabled = false;
      // [AI:firstrun] If we already know no provider is connected, the failure is a SETUP problem, not a
      // model problem — show the actionable connect step instead of a raw provider error.
      cmdkHint.textContent = aiConnected === false ? (aiConnectHint || "Not connected — connect your Claude, or start a local model (Ollama).") : (out.error || "failed — try again");
      return;
    }
    const r: any = out.r;
    try {
      // [AI:cmdk+diff-gate] Human-approval gate (decision #4) — wired into ⌘K at the SINGLE commit
      // chokepoint. When DIFF_GATE_ENABLED, the computed edit is shown as a RENDERED visual diff and
      // only what's accepted is inserted (r.text becomes the approved whole/per-hunk HTML); rejecting
      // aborts before any mutation. The gate's follow-up input refines the proposal in place via
      // onRefine — re-running the model on the CURRENT proposal so edits compound. `before` is the
      // target's prior content (rich → inner HTML; prose → selected text; author → empty). RICH_STYLES
      // gives the preview the doc's real CSS. Deterministic native ops never reach here.
      if (DIFF_GATE_ENABLED) {
        const before = mode === "rich" ? t.html : mode === "author" ? "" : (t.text || "");
        const gate = await diffApprove(before, r.text, mode as any, {
          ...(mode === "rich" ? { css: RICH_STYLES } : {}),
          onRefine: async (instruction: string, current: string) => {
            const ref = await runRewrite(buildRefinePrompt(mode, current, instruction), mode);
            return ref.ok && ref.r ? { ok: true, text: ref.r.text } : { ok: false, error: ref.error };
          },
        });
        if (!gate.accepted) { cmdkInput.disabled = false; cmdkHint.textContent = "change discarded"; return; }
        if (gate.html != null) r.text = gate.html;
      }
      if (!applyAiResult(t, mode, r)) { cmdkInput.disabled = false; return; }
      markEdited(); closeCmdk(); flash("done → saved");
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
    + (AI_EDIT_ENABLED ? '<span class="bsep"></span><button data-a="ai" class="accent">✦ AI edit</button>' : '');
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
    if (kind === "clock") { editor.chain().focus().insertContent({ type: "clockBlock", attrs: { tz: "local" } }).run(); markEdited(); }
    else if (kind === "rich") { const hint = AI_EDIT_ENABLED ? "empty rich block — ⌘K to fill it with AI" : "empty rich block — paste or write HTML here"; editor.chain().focus().insertContent('<div data-rich-block><div style="padding:16px;border:1px dashed var(--border-strong);border-radius:8px;text-align:center;color:var(--muted)">' + hint + '</div></div>').run(); markEdited(); }
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
    // [AI:cmdk] ⌘K (rebuilt, selection-scoped) stays gated on AI_EDIT_ENABLED — a no-op when off,
    // so it's dark in committed/default builds until the orchestrator flips the flag for eval.
    else if (AI_EDIT_ENABLED && mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCmdk(); }
    else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); flushSave(); }
    else if (mod && (e.key.toLowerCase() === "p" || e.key.toLowerCase() === "o")) { e.preventDefault(); openSwitcher(); }
    else if (e.key === "Escape") { if (cmdk.classList.contains("show")) closeCmdk(); else if (switcher.classList.contains("show")) closeSwitcher(); }
  });
  if (AI_EDIT_ENABLED) document.getElementById("askchip")?.addEventListener("click", openCmdk);
  // wire slash-menu cross-references now that openCmdk + insertBlock exist
  if (AI_EDIT_ENABLED) slashHooks.askAI = () => openCmdk();
  slashHooks.insertEmbed = (k: string) => insertBlock(k);
  document.getElementById("insertchip")?.addEventListener("click", () => {
    const k = window.prompt("Insert block: type 'clock' or 'rich'", "clock");
    if (k) insertBlock(k.trim().toLowerCase());
  });
  // title from first H1 if present
  const t = document.getElementById("title");
  const h1 = mount.querySelector(".ProseMirror h1");
  if (t && h1 && h1.textContent && h1.textContent.trim()) t.textContent = h1.textContent.trim();

  // ============================ sidebar ============================
  const GLYPH: Record<string, string> = { md: "·", html: "<>", txt: "·" };
  let allNotes: any[] = [];
  // [fm-sidebar / Track C] new sidebar state. allDirs is the /list `dirs` array (added by the
  // server at integration → seeds empty folders); empty until then. trashCache lazy-loads from
  // /trash. curFilter + rerenderList let the menu / star / sort handlers re-render just the list
  // (preserving the filter input + focus) instead of rebuilding the whole sidebar chrome.
  let allDirs: string[] = [];
  let curMenu: HTMLElement | null = null;
  let dragEntry: Entry | null = null;
  let trashCache: any[] | null = null, trashLoading = false, trashErr = "";
  let curFilter = "";
  let rerenderList: (q?: string) => void = () => {};
  injectSidebarStyles();
  // Show the filename faithfully — strip ONLY the extension, keep dashes/underscores and
  // the user's own casing (they named the file; don't title-case or reflow it).
  function noteTitle(f: any): string { return f.name.replace(/\.(md|markdown|html?|htm)$/i, ""); }

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

  // ── [fm-sidebar / Track C] explorer + sections helpers ───────────────────────
  // CSS for the new sidebar is injected from the client (no server.ts edits): one <style> tag.
  function injectSidebarStyles() {
    if (document.getElementById("fm-sidebar-styles")) return;
    const s = document.createElement("style"); s.id = "fm-sidebar-styles";
    s.textContent = `
  .fm-toolbar{display:flex;align-items:center;gap:4px;margin:6px 0 8px}
  .fm-tool{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:26px;padding:0 7px;font:inherit;font-size:13px;color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:7px;cursor:pointer}
  .fm-tool:hover{color:var(--accent-ink);border-color:var(--accent-line);background:var(--accent-tint)}
  .fm-tb-spacer{flex:1}
  .fm-sort{font:inherit;font-size:11.5px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:0 4px;height:26px;cursor:pointer;max-width:118px}
  .fm-sort:hover{color:var(--text);border-color:var(--border-strong)}
  .fm-section{margin-bottom:2px}
  .fm-section-head{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;cursor:pointer;user-select:none;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
  .fm-section-head:hover{background:var(--accent-tint);color:var(--text)}
  .fm-sec-caret{font-size:8px;width:9px;flex:none;color:var(--subtle)}
  .fm-sec-icon{font-size:11px;flex:none}
  .fm-sec-title{flex:1;overflow:hidden;text-overflow:ellipsis}
  .fm-sec-count{font-size:10px;color:var(--subtle);font-weight:600}
  .fm-section.collapsed .fm-section-body{display:none}
  .fm-section-body{padding-bottom:4px}
  .fm-empty{font-size:11.5px;color:var(--subtle);padding:5px 12px;font-style:italic}
  .fm-chip{flex:none;font-family:ui-monospace,Menlo,monospace;font-size:10px;font-weight:500;letter-spacing:0;line-height:1.4;color:#8a8a98;min-width:34px}
  .fm-chip.md{color:#7ea9dd}
  .fm-chip.html{color:#b78fe0}
  .fm-chip.txt{color:#8a8a98}
  .fm-reltime{margin-left:auto;font-size:10px;color:var(--subtle);flex:none;padding-left:6px}
  .note-link:hover .fm-reltime{display:none}
  .note-link .row-act .fm-star,.folder-row .row-act .fm-star{font-size:12px;line-height:1}
  .fm-star.on{color:var(--accent-ink)}
  .fm-kebab{font-size:14px;font-weight:700;line-height:1}
  .fm-menu{position:fixed;z-index:80;min-width:188px;max-width:264px;background:var(--surface);border:1px solid var(--border-strong);border-radius:9px;box-shadow:0 12px 40px rgba(0,0,0,.34);padding:5px}
  .fm-menu-item{display:block;width:100%;text-align:left;font:inherit;font-size:13px;color:var(--text);background:transparent;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fm-menu-item:hover{background:var(--accent-tint)}
  .fm-menu-item.danger{color:var(--risk)}
  .fm-menu-item.danger:hover{background:rgba(214,51,108,.14)}
  .fm-menu-sep{height:1px;background:var(--border);margin:5px 8px}
  .fm-menu-fieldlabel{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:5px 10px 3px}
  .fm-menu-field{padding:2px}
  .fm-rename-input{width:100%;min-width:120px;font:inherit;font-size:13px;color:var(--text);background:var(--bg);border:1px solid var(--accent-line);border-radius:6px;padding:4px 7px;outline:none}
  .fm-drop-target{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-tint)!important;border-radius:7px}
  .fm-trash-entry{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);padding:5px 10px;border-radius:7px}
  .fm-trash-entry:hover{background:var(--accent-tint)}
  .fm-trash-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fm-trash-restore{font:inherit;font-size:11px;color:var(--accent-ink);background:transparent;border:1px solid var(--border);border-radius:5px;padding:1px 7px;cursor:pointer;flex:none}
  .fm-trash-restore:hover{border-color:var(--accent-line);background:var(--accent-tint)}`;
    document.head.appendChild(s);
  }
  // MD/HTML/TXT chip label (replaces the faint glyph) + relative-time label for Recent.
  function chipLabel(fmt: string): string { return fmt === "html" ? ".html" : fmt === "md" ? ".md" : ".txt"; }
  function relTime(ms?: number): string {
    if (!ms) return "";
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 45) return "just now";
    const m = Math.floor(s / 60); if (m < 60) return m + "m";
    const h = Math.floor(m / 60); if (h < 24) return h + "h";
    const d = Math.floor(h / 24); if (d < 7) return d + "d";
    const w = Math.floor(d / 7); if (w < 5) return w + "w";
    const mo = Math.floor(d / 30); if (mo < 12) return mo + "mo";
    return Math.floor(d / 365) + "y";
  }
  // favorites (starred rel-paths), sort choice, and section-collapse — all persisted per-vault.
  function favKey() { return "tree-favorites:" + ROOT; }
  function loadFavorites(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(favKey()) || "[]")); } catch { return new Set(); } }
  function toggleFavorite(rel: string) { const s = loadFavorites(); s.has(rel) ? s.delete(rel) : s.add(rel); try { localStorage.setItem(favKey(), JSON.stringify([...s])); } catch {} }
  function sortKey() { return "tree-sort:" + ROOT; }
  function loadSort(): string { try { return localStorage.getItem(sortKey()) || "name"; } catch { return "name"; } }
  function saveSort(v: string) { try { localStorage.setItem(sortKey(), v); } catch {} }
  function sectionsKey() { return "tree-sections:" + ROOT; }
  function loadCollapsedSections(): Set<string> { try { const r = localStorage.getItem(sectionsKey()); if (r != null) return new Set(JSON.parse(r)); } catch {} return new Set(["trash"]); /* Trash starts collapsed (it lazy-loads) */ }
  function toggleSection(id: string) { const s = loadCollapsedSections(); s.has(id) ? s.delete(id) : s.add(id); try { localStorage.setItem(sectionsKey(), JSON.stringify([...s])); } catch {} }
  // Seed empty dirs (from /list `dirs`) into a tree so folders with no files still render.
  function seedDirs(tree: TreeNode, dirs: string[]) {
    for (const rel of dirs || []) {
      const parts = String(rel || "").split("/").filter(Boolean);
      let cur: TreeNode = tree;
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        let child = cur.dirs.get(seg);
        if (!child) { child = { rel: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] }; cur.dirs.set(seg, child); }
        cur = child;
      }
    }
  }
  // ── command registry → context menu. The menu is BUILT from commandsFor(kind); we never
  //    hardcode the action list. Each click drives cmd.run() through a CmdCtx. ────────────────
  function entryForFile(f: any): Entry { return { path: f.path, rel: f.rel, name: noteTitle(f), kind: "file", fmt: f.fmt, mtime: f.mtime }; }
  function entryForFolder(node: TreeNode): Entry { return { path: ROOT + "/" + node.rel, rel: node.rel, name: node.rel.split("/").pop() || node.rel, kind: "folder" }; }
  function trashEntry(e: any): Entry { return { path: e.path || e.trashPath || "", rel: e.rel || e.origRel || e.origName || e.name || "", name: e.origName || e.name || e.rel || "(unnamed)", kind: "trash" }; }
  function ctxFor(entry: Entry): CmdCtx { return { entry, vaultRoot: ROOT, refresh: loadNotes, navigate: (p: string) => go("/?file=" + encodeURIComponent(p)) }; }
  function closeMenu() {
    if (!curMenu) return;
    curMenu.remove(); curMenu = null;
    document.removeEventListener("mousedown", onMenuOutside, true);
    document.removeEventListener("keydown", onMenuKey, true);
  }
  function onMenuOutside(e: MouseEvent) { if (curMenu && !curMenu.contains(e.target as Node)) closeMenu(); }
  function onMenuKey(e: KeyboardEvent) { if (e.key === "Escape") { e.preventDefault(); closeMenu(); } }
  function positionMenu(menu: HTMLElement, x: number, y: number) {
    menu.style.left = "0px"; menu.style.top = "0px";
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + "px";
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + "px";
  }
  function menuItemEl(label: string, danger: boolean, onClick: () => void): HTMLElement {
    const b = document.createElement("button"); b.className = "fm-menu-item" + (danger ? " danger" : ""); b.textContent = label;
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
    return b;
  }
  function menuSep(): HTMLElement { const d = document.createElement("div"); d.className = "fm-menu-sep"; return d; }
  // Build menu items grouped by command.group (open/edit/meta/danger) with separators; the
  // client-only ★ favorites toggle leads for files (it isn't a file command).
  function buildMenu(menu: HTMLElement, entry: Entry) {
    menu.innerHTML = "";
    if (entry.kind === "file") {
      const fav = loadFavorites().has(entry.rel);
      menu.appendChild(menuItemEl(fav ? "★ Remove from favorites" : "☆ Add to favorites", false, () => { toggleFavorite(entry.rel); closeMenu(); rerenderList(curFilter); }));
      menu.appendChild(menuSep());
    }
    const cmds = commandsFor(entry.kind);
    let first = true;
    for (const g of ["open", "edit", "meta", "danger"]) {
      const grp = cmds.filter((c) => c.group === g);
      if (!grp.length) continue;
      if (!first) menu.appendChild(menuSep());
      first = false;
      for (const c of grp) menu.appendChild(menuItemEl(c.title, !!c.danger, () => onMenuCmd(c, entry, menu)));
    }
  }
  function onMenuCmd(cmd: any, entry: Entry, menu: HTMLElement) {
    if (cmd.needsArg === "newName") { menuField(menu, cmd.title, cmd.id === "rename" ? entry.name : "", (v) => { closeMenu(); runCmd(cmd, entry, { newName: v }); }); return; }
    if (cmd.needsArg === "moveTarget") { folderPicker(menu, entry); return; }
    closeMenu(); runCmd(cmd, entry, undefined);
  }
  // Inline text field inside the menu (reuses the inline-rename input) for "newName" commands.
  function menuField(menu: HTMLElement, label: string, initial: string, onCommit: (v: string) => void) {
    menu.innerHTML = "";
    const lab = document.createElement("div"); lab.className = "fm-menu-fieldlabel"; lab.textContent = label;
    const wrap = document.createElement("div"); wrap.className = "fm-menu-field";
    const inp = document.createElement("input"); inp.className = "fm-rename-input"; inp.value = initial;
    wrap.appendChild(inp); menu.appendChild(lab); menu.appendChild(wrap);
    inp.focus(); inp.select();
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); const v = inp.value.trim(); if (v) onCommit(v); else closeMenu(); } };
  }
  // Simple folder picker for "moveTarget" commands: every folder from /list `dirs`, plus root.
  function folderPicker(menu: HTMLElement, entry: Entry) {
    menu.innerHTML = "";
    const lab = document.createElement("div"); lab.className = "fm-menu-fieldlabel"; lab.textContent = "Move to…"; menu.appendChild(lab);
    const parent = entry.rel.split("/").slice(0, -1).join("/");
    const targets = ["", ...(allDirs || [])].filter((d) => d !== entry.rel && d !== parent && !(entry.kind === "folder" && d.startsWith(entry.rel + "/")));
    if (!targets.length) targets.push("");
    for (const d of targets) {
      const toDir = d ? ROOT + "/" + d : ROOT;
      menu.appendChild(menuItemEl("📁 " + (d || "／ vault root"), false, () => { closeMenu(); doMove(entry, toDir); }));
    }
  }
  function openMenu(x: number, y: number, entry: Entry) {
    closeMenu();
    const menu = document.createElement("div"); menu.className = "fm-menu";
    buildMenu(menu, entry);
    document.body.appendChild(menu); curMenu = menu;
    positionMenu(menu, x, y);
    // Attach synchronously: the opening mousedown/contextmenu already fired BEFORE this handler
    // runs, so onMenuOutside won't catch it — and Esc closes the menu without a setTimeout race.
    document.addEventListener("mousedown", onMenuOutside, true);
    document.addEventListener("keydown", onMenuKey, true);
  }
  // Run a registry command, then refresh: navigate if the active note moved, else reload the list.
  async function runCmd(cmd: any, entry: Entry, arg: any) {
    let res: any; try { res = await cmd.run(ctxFor(entry), arg); } catch (e: any) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (res && res.ok) {
      if (cmd.id === "restore" || cmd.id === "delete") trashCache = null; // trash changed → relazy-load
      if (res.path && note && entry.path === note.file) go("/?file=" + encodeURIComponent(res.path));
      else loadNotes();
    } else {
      flash((res && res.error) || (cmd.title + " failed"), false);
      rerenderList(curFilter);
    }
  }
  async function doMove(src: Entry | null, toDir: string) {
    if (!src) return;
    const cmd = FILE_COMMANDS.find((c) => c.id === "move"); if (cmd) await runCmd(cmd, src, { toDir });
  }
  function runRename(entry: Entry, newName: string) {
    const cmd = FILE_COMMANDS.find((c) => c.id === "rename"); if (cmd) runCmd(cmd, entry, { newName });
  }
  // Inline rename: swap a row's name label for an <input>; Enter commits via the rename command,
  // Esc / blur cancels. Used by double-click and by the menu's Rename command.
  function startRowRename(nameEl: HTMLElement, entry: Entry) {
    const cur = entry.name;
    const inp = document.createElement("input"); inp.className = "fm-rename-input"; inp.value = cur;
    const parent = nameEl.parentElement; if (!parent) return;
    parent.replaceChild(inp, nameEl);
    inp.focus(); inp.select();
    let done = false;
    const finish = (commit: boolean) => { if (done) return; done = true; const v = inp.value.trim(); if (commit && v && v !== cur) runRename(entry, v); else rerenderList(curFilter); };
    inp.onmousedown = (e) => e.stopPropagation();
    inp.onclick = (e) => e.stopPropagation();
    inp.ondblclick = (e) => e.stopPropagation();
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } };
    inp.onblur = () => finish(false);
  }
  // Lazy-load Trash (GET /trash?dir=ROOT). The endpoint lands at integration; until then a
  // miss/404 shows an "unavailable" note rather than erroring.
  async function loadTrash() {
    trashLoading = true;
    try {
      const r = await fetch("/trash?dir=" + encodeURIComponent(ROOT));
      if (!r.ok) throw new Error("status " + r.status);
      const j = await r.json();
      trashCache = Array.isArray(j) ? j : (j.items || j.entries || j.files || []);
      trashErr = "";
    } catch {
      trashCache = []; trashErr = "Trash unavailable (needs /trash endpoint)";
    } finally { trashLoading = false; rerenderList(curFilter); }
  }

  function renderSidebar(filterStr = "") {
    const sb = document.getElementById("sidebar"); if (!sb) return;
    sb.innerHTML = "";
    // vault header (also a drop target → moving onto it moves the dragged item to the vault root)
    const head = document.createElement("button"); head.className = "vault"; head.title = "Switch vault — open another folder";
    head.innerHTML = '<span>📁 <span class="vname"></span></span><span class="vcaret">⌄</span>';
    (head.querySelector(".vname") as HTMLElement).textContent = ROOT.split("/").pop() || ROOT;
    head.onclick = openVault;
    head.ondragover = (ev) => { if (dragEntry) { ev.preventDefault(); head.classList.add("fm-drop-target"); } };
    head.ondragleave = () => head.classList.remove("fm-drop-target");
    head.ondrop = (ev) => { ev.preventDefault(); head.classList.remove("fm-drop-target"); const d = dragEntry; dragEntry = null; doMove(d, ROOT); };
    sb.appendChild(head);
    const filter = document.createElement("input"); filter.className = "filter"; filter.placeholder = "Filter notes…"; filter.value = filterStr;
    filter.oninput = () => renderList(filter.value);
    sb.appendChild(filter);
    // compact header toolbar replaces the two big dashed New buttons: new-note, new-folder, sort, collapse-all
    const tb = document.createElement("div"); tb.className = "fm-toolbar";
    const tBtn = (txt: string, title: string, fn: () => void) => { const b = document.createElement("button"); b.className = "fm-tool"; b.textContent = txt; b.title = title; b.onclick = fn; return b; };
    tb.appendChild(tBtn("＋", "New note", () => newNote()));
    tb.appendChild(tBtn("📁＋", "New folder", () => newFolder()));
    const spacer = document.createElement("span"); spacer.className = "fm-tb-spacer"; tb.appendChild(spacer);
    const sortSel = document.createElement("select"); sortSel.className = "fm-sort"; sortSel.title = "Sort the Notebook tree";
    ([["name", "Name A–Z"], ["mtime", "Recently modified"], ["created", "Created"]] as const).forEach(([v, l]) => { const o = document.createElement("option"); o.value = v; o.textContent = l; sortSel.appendChild(o); });
    sortSel.value = loadSort();
    sortSel.onchange = () => { saveSort(sortSel.value); rerenderList(curFilter); };
    tb.appendChild(sortSel);
    const collapseAll = document.createElement("button"); collapseAll.className = "fm-tool"; collapseAll.title = "Collapse all folders";
    collapseAll.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13l-6-6-6 6"/><path d="M18 19l-6-6-6 6"/></svg>';
    collapseAll.onclick = () => { try { localStorage.setItem(expandKey(), "[]"); } catch {} rerenderList(curFilter); };
    tb.appendChild(collapseAll);
    sb.appendChild(tb);
    const list = document.createElement("div"); list.id = "notelist"; sb.appendChild(list);
    rerenderList = renderList;
    renderList(filterStr);

    // ---- sort comparator (Notebook + Favorites; Recent always sorts by mtime) ----
    function noteCmp(a: any, b: any): number {
      const m = loadSort();
      if (m === "mtime") return ((b.mtime || 0) - (a.mtime || 0)) || noteTitle(a).localeCompare(noteTitle(b));
      if (m === "created") return (((b.created ?? b.birthtime ?? 0) - (a.created ?? a.birthtime ?? 0))) || noteTitle(a).localeCompare(noteTitle(b));
      return noteTitle(a).localeCompare(noteTitle(b));
    }
    // ---- a single note row (reused by Favorites / Recent / Notebook) ----
    function noteRow(f: any, depth: number, opts: { reltime?: boolean } = {}): HTMLElement {
      const a = document.createElement("a"); a.className = "note-link" + (note && f.path === note.file ? " active" : ""); a.style.paddingLeft = (10 + depth * 13) + "px";
      a.draggable = true;
      const entry = entryForFile(f);
      const chip = document.createElement("span"); chip.className = "fm-chip " + (f.fmt || "txt"); chip.textContent = chipLabel(f.fmt);
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = noteTitle(f); nm.title = f.rel;
      a.appendChild(chip); a.appendChild(nm);
      if (opts.reltime && f.mtime) { const rt = document.createElement("span"); rt.className = "fm-reltime"; rt.textContent = relTime(f.mtime); a.appendChild(rt); }
      const acts = document.createElement("span"); acts.className = "row-act";
      const isFav = loadFavorites().has(f.rel);
      const star = document.createElement("button"); star.className = "fm-star" + (isFav ? " on" : ""); star.textContent = isFav ? "★" : "☆"; star.title = isFav ? "Unstar" : "Add to favorites";
      star.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleFavorite(f.rel); rerenderList(curFilter); };
      const keb = document.createElement("button"); keb.className = "fm-kebab"; keb.textContent = "⋯"; keb.title = "Actions";
      keb.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); openMenu((ev as MouseEvent).clientX, (ev as MouseEvent).clientY, entry); };
      acts.appendChild(star); acts.appendChild(keb); a.appendChild(acts);
      // Clicking the row (chip / indent) opens instantly; clicking the NAME debounces ~200ms so a
      // double-click can rename in place instead of navigating away on the first click.
      a.onclick = (ev) => { ev.preventDefault(); go("/?file=" + encodeURIComponent(f.path)); };
      let nmTimer: any = null;
      nm.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (nmTimer) return; nmTimer = setTimeout(() => { nmTimer = null; go("/?file=" + encodeURIComponent(f.path)); }, 200); };
      nm.ondblclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (nmTimer) { clearTimeout(nmTimer); nmTimer = null; } startRowRename(nm, entry); };
      a.oncontextmenu = (ev) => { ev.preventDefault(); openMenu(ev.clientX, ev.clientY, entry); };
      a.ondragstart = (ev) => { dragEntry = entry; if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = "move"; try { ev.dataTransfer.setData("text/plain", f.path); } catch {} } };
      a.ondragend = () => { dragEntry = null; document.querySelectorAll(".fm-drop-target").forEach((x) => x.classList.remove("fm-drop-target")); };
      return a;
    }
    // ---- a folder row (drag source + drop target) ----
    function folderRow(child: TreeNode, seg: string, depth: number, isOpen: boolean, forceExpand: boolean): HTMLElement {
      const row = document.createElement("div"); row.className = "folder-row"; row.style.paddingLeft = (10 + depth * 13) + "px"; row.title = child.rel;
      row.draggable = true;
      const entry = entryForFolder(child);
      const car = document.createElement("span"); car.className = "fcaret"; car.textContent = isOpen ? "▼" : "▶";
      const ic = document.createElement("span"); ic.className = "ficon"; ic.textContent = isOpen ? "📂" : "📁";
      const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = seg;
      const ct = document.createElement("span"); ct.className = "fcount"; ct.textContent = String(countFiles(child));
      row.appendChild(car); row.appendChild(ic); row.appendChild(nm); row.appendChild(ct);
      const acts = document.createElement("span"); acts.className = "row-act";
      const nn = document.createElement("button"); nn.textContent = "＋"; nn.title = "New note in this folder"; nn.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); newNote(child.rel); };
      const keb = document.createElement("button"); keb.className = "fm-kebab"; keb.textContent = "⋯"; keb.title = "Actions"; keb.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); openMenu((ev as MouseEvent).clientX, (ev as MouseEvent).clientY, entry); };
      acts.appendChild(nn); acts.appendChild(keb); row.appendChild(acts);
      row.onclick = () => { if (!forceExpand) { toggleExpanded(child.rel); rerenderList(curFilter); } };
      row.oncontextmenu = (ev) => { ev.preventDefault(); openMenu(ev.clientX, ev.clientY, entry); };
      nm.ondblclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); startRowRename(nm, entry); };
      row.ondragstart = (ev) => { ev.stopPropagation(); dragEntry = entry; if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = "move"; try { ev.dataTransfer.setData("text/plain", entry.path); } catch {} } };
      row.ondragend = () => { dragEntry = null; document.querySelectorAll(".fm-drop-target").forEach((x) => x.classList.remove("fm-drop-target")); };
      row.ondragover = (ev) => { if (dragEntry && dragEntry.path !== entry.path) { ev.preventDefault(); row.classList.add("fm-drop-target"); } };
      row.ondragleave = () => row.classList.remove("fm-drop-target");
      row.ondrop = (ev) => { ev.preventDefault(); row.classList.remove("fm-drop-target"); const d = dragEntry; dragEntry = null; doMove(d, entry.path); };
      return row;
    }
    // Indent-guide rails: one subtle vertical line per ancestor level so nesting reads at a glance
    // (incl. "all of this is under Notebook" — every top-level row gets the depth-0 rail). Drawn as
    // fixed-position 1px backgrounds in the row's left gutter; content is indented past them. Applied
    // only to the tree, not the flat Favorites/Recent lists.
    function applyTreeRow(el: HTMLElement, depth: number) {
      const PAD = 14, STEP = 16; // base indent + per-level step (inlined to avoid a TDZ on early render)
      el.style.paddingLeft = (PAD + depth * STEP) + "px";
      const imgs: string[] = [], poss: string[] = [], sizes: string[] = [];
      for (let k = 0; k <= depth; k++) { imgs.push("linear-gradient(#2a2a33,#2a2a33)"); poss.push((7 + k * STEP) + "px 0"); sizes.push("1px 100%"); }
      el.style.backgroundImage = imgs.join(","); el.style.backgroundPosition = poss.join(","); el.style.backgroundSize = sizes.join(","); el.style.backgroundRepeat = "no-repeat";
    }
    // ---- the Notebook tree (dirs alpha, files by sort choice; indentation + guides by depth) ----
    function renderTree(tree: TreeNode, forceExpand: boolean, into: HTMLElement) {
      const expanded = loadExpanded();
      const pinned = activeAncestors(); // ancestors of the open note: always expanded
      (function walk(node: TreeNode, depth: number) {
        [...node.dirs.keys()].sort((a, b) => a.localeCompare(b)).forEach((seg) => {
          const child = node.dirs.get(seg)!;
          const isOpen = forceExpand || expanded.has(child.rel) || pinned.has(child.rel);
          const fr = folderRow(child, seg, depth, isOpen, forceExpand); applyTreeRow(fr, depth); into.appendChild(fr);
          if (isOpen) walk(child, depth + 1);
        });
        [...node.files].sort(noteCmp).forEach((f) => { const nr = noteRow(f, depth); applyTreeRow(nr, depth); into.appendChild(nr); });
      })(tree, 0);
    }
    function emptyInto(el: HTMLElement, msg: string) { const e = document.createElement("div"); e.className = "fm-empty"; e.textContent = msg; el.appendChild(e); }
    function makeSection(id: string, icon: string, title: string): { body: HTMLElement; count: HTMLElement; collapsed: boolean } {
      const collapsed = loadCollapsedSections().has(id);
      const sec = document.createElement("div"); sec.className = "fm-section" + (collapsed ? " collapsed" : ""); sec.setAttribute("data-section", id);
      const hd = document.createElement("div"); hd.className = "fm-section-head";
      const car = document.createElement("span"); car.className = "fm-sec-caret"; car.textContent = collapsed ? "▶" : "▼";
      const ic = document.createElement("span"); ic.className = "fm-sec-icon"; ic.textContent = icon;
      const ti = document.createElement("span"); ti.className = "fm-sec-title"; ti.textContent = title;
      const ct = document.createElement("span"); ct.className = "fm-sec-count";
      hd.appendChild(car); hd.appendChild(ic); hd.appendChild(ti); hd.appendChild(ct);
      hd.onclick = () => { toggleSection(id); rerenderList(curFilter); };
      sec.appendChild(hd);
      const body = document.createElement("div"); body.className = "fm-section-body"; sec.appendChild(body);
      list.appendChild(sec);
      return { body, count: ct, collapsed };
    }

    function renderList(q: string) {
      curFilter = q; rerenderList = renderList;
      const ql = q.toLowerCase().trim();
      list.innerHTML = "";
      // While filtering: a single force-expanded tree of matches (keeps "filter force-expands folders").
      if (ql) {
        const filtered = allNotes.filter((f) => f.rel.toLowerCase().includes(ql) || noteTitle(f).toLowerCase().includes(ql));
        if (!filtered.length) { emptyInto(list, "No matching notes"); return; }
        renderTree(buildTree(filtered), true, list);
        return;
      }
      // Sections top→bottom: Favorites, Recent, Notebook, Trash.
      // ★ Favorites — starred notes (persisted in localStorage).
      {
        const favs = loadFavorites();
        const favNotes = allNotes.filter((f) => favs.has(f.rel)).sort(noteCmp);
        const { body, count, collapsed } = makeSection("favorites", "★", "Favorites");
        count.textContent = favNotes.length ? String(favNotes.length) : "";
        if (!collapsed) { if (favNotes.length) favNotes.forEach((f) => body.appendChild(noteRow(f, 0))); else emptyInto(body, "Star a note to pin it here"); }
      }
      // 🕐 Recent — top 5 by mtime (falls back to alpha when mtime is unknown).
      {
        const hasM = allNotes.some((f) => f.mtime);
        const recent = [...allNotes].sort((a, b) => hasM ? ((b.mtime || 0) - (a.mtime || 0)) : noteTitle(a).localeCompare(noteTitle(b))).slice(0, 5);
        const { body, count, collapsed } = makeSection("recent", "🕐", "Recent");
        count.textContent = recent.length ? String(recent.length) : "";
        if (!collapsed) { if (recent.length) recent.forEach((f) => body.appendChild(noteRow(f, 0, { reltime: hasM }))); else emptyInto(body, "No notes yet"); }
      }
      // 📁 Vault tree — the full tree, with empty folders seeded from /list `dirs`.
      // Title tracks the opened folder's basename (matches the .vname header); falls back to
      // "Notebook" when there's no vault root. Section id stays "notebook" (collapse-state key + tests).
      {
        const vaultName = ROOT.split("/").pop() || "Notebook";
        const { body, count, collapsed } = makeSection("notebook", "📁", vaultName);
        count.textContent = allNotes.length ? String(allNotes.length) : "";
        if (!collapsed) {
          const tree = buildTree(allNotes); seedDirs(tree, allDirs);
          if (tree.dirs.size || tree.files.length) renderTree(tree, false, body); else emptyInto(body, "No notes yet");
        }
      }
      // 🗑 Trash — lazy-loaded; each entry shows origName + a Restore action (registry command).
      {
        const { body, count, collapsed } = makeSection("trash", "🗑", "Trash");
        if (!collapsed) {
          if (trashCache === null) { if (!trashLoading) loadTrash(); emptyInto(body, "Loading trash…"); }
          else if (trashErr) emptyInto(body, trashErr);
          else {
            count.textContent = trashCache.length ? String(trashCache.length) : "";
            if (!trashCache.length) emptyInto(body, "Trash is empty");
            else {
              const rc = FILE_COMMANDS.find((c) => c.id === "restore");
              trashCache.forEach((e) => {
                const entry = trashEntry(e);
                const row = document.createElement("div"); row.className = "fm-trash-entry";
                const nm = document.createElement("span"); nm.className = "fm-trash-name"; nm.textContent = entry.name; nm.title = entry.rel;
                const rb = document.createElement("button"); rb.className = "fm-trash-restore"; rb.textContent = "Restore";
                rb.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (rc) runCmd(rc, entry, undefined); };
                row.appendChild(nm); row.appendChild(rb); body.appendChild(row);
              });
            }
          }
        }
      }
    }
  }
  async function loadNotes() { try { const r = await fetch("/list?dir=" + encodeURIComponent(ROOT)).then((x) => x.json()); allNotes = r.files || []; allDirs = r.dirs || []; renderSidebar(); } catch { renderSidebar(); } }
  async function newNote(folderRel?: string) {
    const where = folderRel ? ` (in ${folderRel}/)` : "";
    // A "/" in the name nests into subfolders — the server mkdirs them on create.
    const name = window.prompt("New note name" + where + " — use “/” to nest, e.g. Projects/ideas:"); if (!name) return;
    const wantsHtml = /\.html?$/i.test(name.trim()); // decide ext from raw input…
    const rel = sanitizeRelNotePath(name.replace(/\.(md|markdown|html?|htm)$/i, "")); // …strip ONLY a real note ext (so "report.final" keeps ".final"), then sanitize each segment (keeps "/")
    if (!rel) { flash("invalid name", false); return; }
    const dir = folderRel ? ROOT + "/" + folderRel : ROOT;
    const path = dir + "/" + rel + (wantsHtml ? ".html" : ".md");
    const title = rel.split("/").pop() || rel; // H1 is the note's own name, not the folder path
    const r = await fetch("/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: path, content: "# " + title + "\n\n" }) }).then((x) => x.json());
    if (!r.ok) { flash(r.error || "couldn't create", false); return; }
    go("/?file=" + encodeURIComponent(path));
  }
  // New folder = create an EMPTY folder (no forced note). Empty folders now render (the server
  // returns `dirs` and the tree seeds them), so there's no need to stuff a starter note inside.
  async function newFolder(parentRel?: string) {
    const where = parentRel ? ` in ${parentRel}/` : "";
    const fname = window.prompt("New folder name" + where + ":"); if (!fname) return;
    const folder = (sanitizeRelNotePath(fname).split("/").pop() || ""); // a single folder segment
    if (!folder) { flash("invalid folder name", false); return; }
    const dir = parentRel ? ROOT + "/" + parentRel : ROOT;
    const r = await fetch("/folder-create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir, name: folder }) }).then((x) => x.json());
    if (!r.ok) { flash(r.error || "couldn't create folder", false); return; }
    if (parentRel) { const s = loadExpanded(); s.add(parentRel); try { localStorage.setItem(expandKey(), JSON.stringify([...s])); } catch {} } // reveal the parent so the new child folder is visible
    await loadNotes();
    flash("Created folder “" + folder + "”", true);
  }
  // (rename + delete moved to the command registry — context menu / inline rename drive them
  //  through commandsFor(kind) now; see runCmd / startRowRename above.)
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

  // Default to INTERACT when the doc has something to run — opening a live dashboard/app should
  // show it RUNNING, not the editor markup. Only fires for INTERACTABLE docs (HTML with executable
  // JS, F31); md/txt and static HTML still open in edit as before. ⌘E or the Edit segment flips to
  // the editor. Runs LAST in setup so setMode's deps (cmdk, switcher, flushSave…) all exist — calling
  // it earlier hits switcher's temporal dead zone. flushSave() inside is a no-op on load (nothing
  // dirty), and the editor stays mounted (hidden) so toggling to edit is instant and loses nothing.
  if (INTERACTABLE) setMode("interact");
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
    const name = window.prompt("New note name — use “/” to nest, e.g. Projects/ideas:"); if (!name) return;
    const wantsHtml = /\.html?$/i.test(name.trim());
    const rel = sanitizeRelNotePath(name.replace(/\.(md|markdown|html?|htm)$/i, "")); if (!rel) return;
    const path = ROOT + "/" + rel + (wantsHtml ? ".html" : ".md");
    const title = rel.split("/").pop() || rel;
    const r = await fetch("/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: path, content: "# " + title + "\n\n" }) }).then((x) => x.json());
    if (r.ok) location.href = "/?file=" + encodeURIComponent(path); else alert(r.error || "couldn't create");
  });
}

// ============================ first-run: connect a provider ============================
// [AI:firstrun] The AI features (⌘K, Tab ghost) depend on a provider the user must connect: a
// logged-in Claude subscription session (Agent SDK OAuth — no API key) OR a running local Ollama
// daemon. That dependency used to be tribal knowledge; a fresh clone had no way to know. This asks
// the server (/api/ai-status, a cheap probe — no inference) whether the provider each ENABLED feature
// routes to is reachable, and if not, shows a dismissible "connect your Claude / point at Ollama"
// strip under the toolbar with the concrete next step. When AI is off (nothing to connect) or a
// provider IS connected, it renders nothing — the banner is invisible on the happy path.
async function initAiConnectBanner() {
  const ghostEnabled = !!(window as any).__GHOST_TEXT_ENABLED;
  if (!AI_EDIT_ENABLED && !ghostEnabled) return; // no AI feature on → nothing to connect
  let s: any;
  try { s = await fetch("/api/ai-status").then((x) => x.json()); } catch { return; } // never block the app on this
  aiConnected = !!s.connected;
  aiConnectHint = s.hint || "";
  if (!s.anyEnabled || s.connected) return; // connected (or nothing enabled) → banner stays invisible
  // Re-show whenever the situation CHANGES (provider swapped, still broken) even if dismissed before —
  // but don't nag across reloads once dismissed for the SAME unmet state.
  const sig = "ai-connect:" + [s.rewrite?.provider, s.rewrite?.connected, s.ghost?.provider, s.ghost?.connected, s.hint].join("|");
  try { if (localStorage.getItem("aiConnectDismissed") === sig) return; } catch {}

  const bar = document.createElement("div");
  bar.className = "ai-connect";
  const hint = escapeAttr(String(s.hint || "Connect your Claude, or point at a local model (Ollama)."));
  bar.innerHTML =
    '<span class="ic">⚡</span>' +
    '<span class="msg"><b>AI features aren’t connected yet.</b> ' + hint + "</span>" +
    '<button class="x" title="Dismiss" aria-label="Dismiss">✕</button>';
  (bar.querySelector(".x") as HTMLElement).onclick = () => { try { localStorage.setItem("aiConnectDismissed", sig); } catch {} bar.remove(); };
  // Under the toolbar when a note is open; at the very top on the onboarding screen.
  const barEl = document.querySelector(".bar");
  if (barEl && barEl.parentElement) barEl.parentElement.insertBefore(bar, barEl.nextSibling);
  else document.body.insertBefore(bar, document.body.firstChild);
}
initAiConnectBanner();
