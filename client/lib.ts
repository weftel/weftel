// Pure, side-effect-free helpers — the integrity-critical logic, extracted so it can be
// unit-tested without booting the whole editor. (Some use the DOM via <template>, which
// is inert; tests provide a DOM via happy-dom.)

// Strip active content (inline on* handlers, script/iframe/object/embed, javascript:
// URLs) before any HTML reaches a live DOM. Parsed into an inert <template>, so this
// itself never executes. Imported note content is untrusted.
export function stripActive(html: string): string {
  const t = document.createElement("template"); t.innerHTML = html || "";
  t.content.querySelectorAll("script,iframe,object,embed").forEach((e) => e.remove());
  t.content.querySelectorAll("*").forEach((el) => {
    Array.from((el as HTMLElement).attributes).forEach((a) => {
      const n = a.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(a.name);
      else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    });
  });
  return t.innerHTML;
}

export function escapeAttr(s: any): string { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Splice body into a template at the FIRST occurrence of token, slice-based (never
// String.replace, whose $-patterns silently corrupt bodies containing $&, $`, $', $$).
export function spliceBody(template: string, token: string, body: string): string {
  const i = template.indexOf(token);
  return i < 0 ? template : template.slice(0, i) + body + template.slice(i + token.length);
}

// MISSION: maximize directly-human-editable HTML; the atomic rich block is a fallback,
// not a default. proseModelable() asks "is this HTML fully representable as editable
// content (known tags + only styles we model as marks)?" If yes, we insert/unwrap it as
// editable prose instead of locking it in an atomic block.
export const PROSE_OK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "BR", "HR", "STRONG", "EM", "B", "I", "U", "S", "DEL", "CODE", "A", "SPAN", "MARK"]);
// Inline text-presentation styles the generic InlineStyle mark carries — everything safe
// the specific marks (color/highlight/bold/italic/underline) don't already own. Add a
// property here and it becomes editable+preserved with no other code: the whole point.
export const GENERIC_INLINE_PROPS = new Set(["font-family", "font-size", "letter-spacing", "text-transform", "font-variant", "word-spacing", "line-height", "text-shadow", "font-stretch", "background-color", "background"]);
export function filterInlineStyle(style: string): string | null {
  const keep = (style || "").split(";").map((s) => s.trim()).filter(Boolean).filter((decl) => GENERIC_INLINE_PROPS.has(decl.split(":")[0].trim().toLowerCase()));
  return keep.length ? keep.join("; ") : null;
}
// Everything we can model as an editable mark today (specific marks + the generic carrier).
// proseModelable lets text through as editable prose iff ALL its styles live in here — so
// "editable vs atomic" is a category question (text-presentation vs layout), not a list.
export const MODELED_STYLE_PROPS = new Set(["color", "font-weight", "font-style", "text-decoration", "text-decoration-line", ...GENERIC_INLINE_PROPS]);
export function proseModelable(html: string, relaxClass = false): boolean {
  const t = document.createElement("template"); t.innerHTML = html || "";
  const els = Array.from(t.content.querySelectorAll("*"));
  if (!els.length) return false; // plain text / empty — nothing to gain, leave as-is
  for (const el of els) {
    if (!PROSE_OK_TAGS.has(el.tagName)) return false;        // unknown tag (svg, div, img…) → keep atomic
    if (!relaxClass && el.getAttribute("class")) return false; // a class usually = a styled component we can't model losslessly
    if (!relaxClass && el.tagName === "SPAN" && !!el.querySelector("span")) return false; // strict path: span-in-span (see nestedSpan)
    const style = el.getAttribute("style");
    if (style) {
      const props = style.split(";").map((s) => s.split(":")[0].trim().toLowerCase()).filter(Boolean);
      if (props.some((p) => !MODELED_STYLE_PROPS.has(p))) return false; // a style we don't model (layout, etc.) → keep atomic
    }
  }
  return true;
}

// Broader classifier for (b): can this HTML become editable NESTED nodes (styled-box
// containers + editable prose + native blocks) rather than a frozen atomic block? Yes if
// every element is one we model — prose tags, native blocks (table…), and div/span
// containers — with no unmodelable element (svg/img/canvas/iframe/media).
//
// `relaxClass` (the FULL_PARSE experiment): when true, a `class` no longer freezes a block.
// The class's appearance lives in a <style> sheet we now carry into the live editor (scoped,
// see scopeCss) and preserve verbatim in the saved file — so classed content can be edited
// in place as nested nodes that keep their `class` attrs. When false (legacy), any class
// freezes the block, preserving it as an opaque atomic rich block.
const EDITABLE_TAGS = new Set([...PROSE_OK_TAGS, "DIV", "PRE", "IMG", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "COLGROUP", "COL", "CAPTION",
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "DL", "DT", "DD", "SMALL", "SUB", "SUP", "KBD", "SAMP", "VAR", "ABBR", "CITE", "Q", "TIME", "DETAILS", "SUMMARY"]);
// IMG is editable: modeled as a native image node (paste support), src preserved verbatim.
// FIGURE/FIGCAPTION are NOT: the schema has no figure node, so ProseMirror would silently
// FLATTEN the tags (children kept, <figure> lost) — a lossless violation. Figures freeze
// whole (captioned-media units, preserved verbatim) until we model a real figure node.
// svg/canvas/iframe remain unmodelable.
export function editableModelable(html: string, relaxClass = false): boolean {
  const t = document.createElement("template"); t.innerHTML = html || "";
  if (!t.content.querySelectorAll("*").length) return false;
  stripOwnDialect(t.content); // app-authored constructs (task lists…) are native-parseable — exempt their internals (label/input) from the scan
  const els = Array.from(t.content.querySelectorAll("*"));
  for (const el of els) {
    if (!EDITABLE_TAGS.has(el.tagName)) return false;  // svg / img / canvas / iframe / media → freeze (preserve verbatim)
    if (!relaxClass && el.getAttribute("class")) return false; // class-styled → can't reproduce its look → freeze
    if (!relaxClass && nestedSpan(el)) return false;   // strict path: span-in-span would drop the outer wrapper
  }
  return true;
}
// For load-time isolation (isolateRich): does this element's WHOLE subtree contain only
// modelable tags (no svg/img/canvas/iframe/media)? Unlike editableModelable, a text-only leaf
// (<h1>hi</h1>, <span style>x</span>) counts as editable — here we ask "is anything here
// unpreservable?", not "is there nested structure to unwrap". relaxClass mirrors FULL_PARSE.
// CLOSURE INVARIANT: anything the editor itself can author must be recognized as editable
// on reload — the app must always be able to re-read its own writing. These are the app's
// own serialized constructs; they carry tags the generic classifier would freeze (a task
// list's <label><input type=checkbox>), but TipTap parses them natively, so trust them.
// Add a selector here whenever a new authorable construct serializes non-prose tags.
const OWN_DIALECT = 'ul[data-type="taskList"]';
export function isOwnDialect(el: Element): boolean { return !!(el.matches && el.matches(OWN_DIALECT)); }
export function stripOwnDialect(root: ParentNode): void { root.querySelectorAll(OWN_DIALECT).forEach((e) => e.remove()); }

// A span CONTAINING a span can't round-trip as MARKS (one mark type per text node — the
// outer wrapper silently dropped). Under FULL_PARSE classed spans are inline NODES
// (StyledSpan), and nodes nest fine — so nesting is only unmodelable on the strict path,
// where spans still map to the inlineStyle mark.
export function nestedSpan(el: Element): boolean { return el.tagName === "SPAN" && !!el.querySelector("span"); }

export function subtreeEditable(el: Element, relaxClass = true): boolean {
  if (isOwnDialect(el)) return true;                 // app-authored construct — TipTap parses it natively
  if (!EDITABLE_TAGS.has(el.tagName)) return false;
  if (!relaxClass && el.getAttribute("class")) return false;
  if (!relaxClass && nestedSpan(el)) return false;
  for (const c of Array.from(el.children)) if (!subtreeEditable(c, relaxClass)) return false;
  return true;
}
// Whether AI output should insert as editable native content vs an atomic rich block.
// AI inserts bare fragments with no accompanying <style>, so a classed fragment would render
// unstyled — keep AI on the strict (no-class) gate even under the FULL_PARSE experiment.
export function nativeInsertable(html: string): boolean { return editableModelable(html); }

// ── SVG text editing (K1 / "crack open frozen leaves") ────────────────────────
// An <svg> still freezes whole (it can't be modeled as prose), but its DECLARATIVE
// text runs are reachable: replacing ONE run's text touches no surrounding SVG byte
// (geometry, paths, gradients) — so the SVG round-trips byte-faithfully while the words
// become editable in place. The rendered text elements are <text>, <tspan> and <textPath>
// (curved text on a path; its <path>/<defs> are untouched by an edit). A run is editable
// in two shapes:
//   • SIMPLE LEAF  — a text element holding ONLY text (no element children): edit its text.
//   • DIRECT RUN   — a text element that MIXES a direct text run with child elements
//                    (F26: `<text>Label: <tspan>5</tspan></text>`, or a <tspan> wrapping a
//                    nested <tspan>): each direct (non-whitespace) child text node is its own
//                    editable run, edited without disturbing the sibling elements.
// FROZEN by design: text inside <foreignObject> (HTML, e.g. Marp slides) is not a native SVG
// run; text inside <defs>/<symbol> is a non-rendered TEMPLATE (it only paints via <use>, with
// no geometry of its own to click) — both stay view-only, deliberately, not half-editable.
const SVG_TEXT_TAGS = new Set(["text", "tspan", "textpath"]);
function svgTextTag(el: Element): boolean { return SVG_TEXT_TAGS.has(((el as any).localName || el.tagName || "").toLowerCase()); }
// In a non-rendered / foreign SVG scope? Walk ancestors (case-robust; avoids querySelector's
// case-sensitivity on camelCase SVG names like foreignObject across DOM impls).
function inFrozenSvgScope(el: Element): boolean {
  let p: Element | null = el.parentElement;
  while (p) {
    const t = ((p as any).localName || p.tagName || "").toLowerCase();
    if (t === "foreignobject" || t === "defs" || t === "symbol") return true;
    p = p.parentElement;
  }
  return false;
}
export function isSvgTextLeaf(el: Element): boolean {
  if (!svgTextTag(el)) return false;
  if (el.children && el.children.length) return false;       // wraps elements → container, not a simple leaf
  if (!(el.textContent || "").trim()) return false;          // empty / whitespace-only → nothing to edit
  if (inFrozenSvgScope(el)) return false;                    // foreignObject HTML / defs+symbol template — frozen
  return true;
}
// The direct (non-whitespace) child text nodes of a MIXED text container — the runs that sit
// alongside <tspan>/<textPath> children (F26). A whitespace-only gap between elements is not a
// run. Empty for a simple leaf (handled above) or a pure container (only element children).
export function svgDirectTextRuns(el: Element): Text[] {
  if (!svgTextTag(el) || inFrozenSvgScope(el)) return [];
  if (!(el.children && el.children.length)) return [];       // simple leaf, not a mixed container
  return Array.from(el.childNodes).filter((n) => n.nodeType === 3 && !!(n.textContent || "").trim()) as Text[];
}
// camelCase <textPath> is matched case-sensitively in a browser; include both spellings.
const SVG_TEXT_SELECTOR = "text, tspan, textPath, textpath";
export function collectSvgTextLeaves(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(SVG_TEXT_SELECTOR)).filter(isSvgTextLeaf);
}
// Every editable direct run across the tree, paired with its container element (for wiring a
// dblclick listener — the run's own text node is not an event target).
export function collectSvgTextRuns(root: ParentNode): { el: Element; node: Text }[] {
  const out: { el: Element; node: Text }[] = [];
  root.querySelectorAll(SVG_TEXT_SELECTOR).forEach((el) => svgDirectTextRuns(el).forEach((node) => out.push({ el, node })));
  return out;
}

// ── HTML text-leaf editing (F36 / generalize "crack open frozen leaves") ──────
// The SVG section above cracks open native <text>/<tspan> runs inside a frozen block. F36
// applies the SAME byte-faithful mechanism to HTML text leaves, so EVERY visible text node in
// a frozen rich block is editable — a flow-chart <div> label ("Commit"), a <figcaption>, a
// <p>/<li>/<td>/heading — not just SVG. Same invariant: replacing ONE text node's content
// touches no surrounding byte, so the block round-trips byte-faithfully. Two shapes (mirroring SVG):
//   • SIMPLE LEAF — an element holding ONLY text (no element children): edit its text in place.
//   • MIXED RUN   — an element mixing a direct text run with INLINE element children
//                   (`<p>Lead <strong>x</strong> tail`): each direct (non-whitespace) text node is
//                   its own editable run, edited without disturbing the sibling elements.
// FROZEN/skipped by design: SVG-namespaced text (the SVG path owns it, not here); text inside
// <foreignObject> (frozen per F27); empty / whitespace-only / decorative elements (no text → not a
// leaf, so F12's empty/decorative spans stay non-editable). This classifier is pure structure; the
// nodeView only ever runs it INSIDE the frozen RichBlock shadow, so editable-in-the-normal-flow
// content (an org-chart <div> NOT in a data-rich-block) is never re-routed through the frozen path.
const HTML_NS = "http://www.w3.org/1999/xhtml";
const HTML_LEAF_TAGS = new Set(["FIGCAPTION", "DIV", "SPAN", "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "DT", "DD", "CAPTION", "SMALL", "STRONG", "EM", "B", "I", "U", "CODE", "A", "LABEL", "SUMMARY"]);
// Inline children a mixed-run container may hold and still expose its DIRECT text as editable runs
// (editing one run can't disturb block layout). A BLOCK child (div/p/table/svg…) means the element
// isn't a flat text run — its block descendants carry their own leaves instead.
const HTML_INLINE_TAGS = new Set(["SPAN", "STRONG", "EM", "B", "I", "U", "CODE", "A", "SMALL", "SUB", "SUP", "MARK", "LABEL", "TIME", "ABBR", "CITE", "Q", "KBD", "SAMP", "VAR", "BR", "WBR", "DEL", "INS", "S"]);
// HTML-namespaced? SVG/MathML elements carry their own namespaceURI — exclude them so the SVG path
// keeps sole ownership of <text>/<tspan> and an SVG <a>/<title> never counts as an HTML leaf.
function htmlNamespaced(el: Element): boolean { const ns = (el as any).namespaceURI; return !ns || ns === HTML_NS; }
// Inside a <foreignObject>? Its HTML is frozen (F27) even though it's HTML-namespaced in a real
// browser — walk ancestors (case-robust, like inFrozenSvgScope's camelCase handling).
export function inForeignObject(el: Element): boolean {
  let p: Element | null = el.parentElement;
  while (p) { if (((p as any).localName || p.tagName || "").toLowerCase() === "foreignobject") return true; p = p.parentElement; }
  return false;
}
function htmlLeafTag(el: Element): boolean { return htmlNamespaced(el) && HTML_LEAF_TAGS.has((el.tagName || "").toUpperCase()); }
function htmlInlineEl(el: Element): boolean { return htmlNamespaced(el) && HTML_INLINE_TAGS.has((el.tagName || "").toUpperCase()); }
export function isHtmlTextLeaf(el: Element): boolean {
  if (!htmlLeafTag(el)) return false;
  if (el.children && el.children.length) return false;       // wraps elements → container, not a simple leaf
  if (!(el.textContent || "").trim()) return false;          // empty / whitespace-only / decorative → nothing to edit (F12)
  if (inForeignObject(el)) return false;                     // frozen foreignObject HTML (F27)
  return true;
}
// The direct (non-whitespace) child text nodes of a MIXED container — the runs sitting alongside
// inline element children (`<p>Lead <strong>x</strong> tail`). Empty for a simple leaf (handled
// above), a pure container (only element children + whitespace), or a container holding a BLOCK
// child (its block descendants own their own leaves — keeping runs strictly inline-safe).
export function htmlDirectTextRuns(el: Element): Text[] {
  if (!htmlLeafTag(el) || inForeignObject(el)) return [];
  const kids = Array.from(el.children);
  if (!kids.length) return [];                               // simple leaf, not a mixed container
  if (kids.some((c) => !htmlInlineEl(c))) return [];         // a block/SVG child → not a flat inline-text run
  return Array.from(el.childNodes).filter((n) => n.nodeType === 3 && !!(n.textContent || "").trim()) as Text[];
}
const HTML_LEAF_SELECTOR = Array.from(HTML_LEAF_TAGS).map((t) => t.toLowerCase()).join(",");
export function collectHtmlTextLeaves(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(HTML_LEAF_SELECTOR)).filter(isHtmlTextLeaf);
}
// Every editable direct run across the tree, paired with its container element (for wiring a
// dblclick listener — the run's own text node is not an event target).
export function collectHtmlTextRuns(root: ParentNode): { el: Element; node: Text }[] {
  const out: { el: Element; node: Text }[] = [];
  root.querySelectorAll(HTML_LEAF_SELECTOR).forEach((el) => htmlDirectTextRuns(el).forEach((node) => out.push({ el, node })));
  return out;
}

// ── CSS scoping ──────────────────────────────────────────────────────────────
// Rewrite an imported note's stylesheet so every rule is confined to a scope wrapper (the
// editor mount), letting the note's class/element CSS render the EDITABLE content while
// never clobbering the editor chrome (.bar/.sidebar/.cmdk live outside the scope). Global
// selectors (:root/html/body) map to the scope itself so the note's custom props + base
// styles apply to the surface and inherit down. Pure brace-depth string transform (no
// CSSOM) so it's deterministic and works under happy-dom; only ever used for the LIVE
// editor — the original <style> round-trips verbatim and is what gets saved.
export function scopeCss(css: string, scope: string): string {
  return scopeBlock(stripCssComments(css || ""), scope);
}
function stripCssComments(s: string): string { return s.replace(/\/\*[\s\S]*?\*\//g, ""); }
function scopeBlock(src: string, scope: string): string {
  let out = "", i = 0; const n = src.length;
  while (i < n) {
    // skip to the next top-level '{' (a rule) or ';' (an @import/@charset statement)
    let j = i;
    while (j < n && src[j] !== "{" && src[j] !== ";") j++;
    if (j >= n) break;
    if (src[j] === ";") { const stmt = src.slice(i, j + 1).trim(); if (stmt) out += stmt; i = j + 1; continue; }
    const prelude = src.slice(i, j).trim();
    let d = 0, k = j;
    for (; k < n; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (d === 0) { k++; break; } } }
    out += renderRule(prelude, src.slice(j + 1, k - 1), scope);
    i = k;
  }
  return out;
}
function renderRule(prelude: string, body: string, scope: string): string {
  if (!prelude) return "";
  if (prelude[0] === "@") {
    const kw = (prelude.match(/^@([a-z-]+)/i) || ["", ""])[1].toLowerCase();
    // nested-rule at-rules → recurse into the body; everything else (keyframes/font-face/
    // page/property) is selector-free and must pass through verbatim.
    if (kw === "media" || kw === "supports" || kw === "container" || kw === "layer" || kw === "scope")
      return prelude + "{" + scopeBlock(body, scope) + "}";
    return prelude + "{" + body + "}";
  }
  const sel = splitTopLevel(prelude, ",").map((s) => scopeSelector(s.trim(), scope)).filter(Boolean).join(",");
  return sel ? sel + "{" + body + "}" : "";
}
// Split on a separator only at the top level (ignore commas inside :is(), [attr], strings).
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = []; let depth = 0, buf = "", str = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) { buf += c; if (c === str && s[i - 1] !== "\\") str = ""; continue; }
    if (c === '"' || c === "'") { str = c; buf += c; continue; }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === sep && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}
function scopeSelector(sel: string, scope: string): string {
  sel = sel.trim();
  if (!sel) return "";
  // Drop the doc's :focus/:hover-on-anything interaction rules for FOCUS: they're meant for
  // the original page, but inside the editor the focused element is the contenteditable
  // itself — a doc's `:focus-visible{outline:accent}` ends up drawing a ring around the
  // entire editing surface (looks like a mysterious container; found dogfooding adamw).
  if (/:focus/i.test(sel)) return "";
  if (/^(:root|html|body)$/i.test(sel)) return scope;                 // whole global selector → the scope itself
  const m = sel.match(/^(?::root|html|body)(\s*[>+~]\s*|\s+)([\s\S]*)$/i);
  if (m) { const comb = m[1].trim(); return scope + (comb ? " " + comb + " " : " ") + m[2].trim(); } // "body h1"→"<scope> h1", "body>.x"→"<scope> > .x"
  return scope + " " + sel;                                           // ".card h3", "*", "strong.t" → descendant of scope
}

// ProseMirror turns whitespace text-nodes between table cells (pretty-printed HTML) into
// spurious empty cells — a clean 2-col table parses as 5. Strip whitespace-only text nodes
// that are direct children of table-structural elements before inserting.
export function tidyInsertHtml(html: string): string {
  if (!/<table[\s>]/i.test(html)) return html;
  const t = document.createElement("template"); t.innerHTML = html;
  t.content.querySelectorAll("table, thead, tbody, tfoot, tr, colgroup").forEach((el) => {
    Array.from(el.childNodes).forEach((n) => {
      if (n.nodeType === 3 && !(n.textContent || "").trim()) el.removeChild(n);
    });
  });
  // a tableCell needs block content — an empty <td> (common from Haiku) is invalid, so
  // give empty cells an empty paragraph.
  t.content.querySelectorAll("td, th").forEach((cell) => {
    if (!cell.querySelector("*") && !(cell.textContent || "").trim()) cell.innerHTML = "<p></p>";
  });
  return t.innerHTML;
}

// Save-time table tidy: ProseMirror's table extension leaks editor defaults into the
// serialized HTML — colspan/rowspan="1" on every cell, a min-width <colgroup> scaffold,
// a <p> wrapper in every cell — so the saved file renders differently OUTSIDE the editor
// than the file that was opened. Strip what's default-valued; keep what the user actually
// set (genuine column widths from a resize, multi-block cells).
export function tidySaveHtml(html: string): string {
  if (!/<table[\s>]/i.test(html)) return html;
  const t = document.createElement("template"); t.innerHTML = html;
  t.content.querySelectorAll('td[colspan="1"],th[colspan="1"]').forEach((c) => c.removeAttribute("colspan"));
  t.content.querySelectorAll('td[rowspan="1"],th[rowspan="1"]').forEach((c) => c.removeAttribute("rowspan"));
  const realWidth = (s: string | null) => !!(s || "").replace(/min-width\s*:[^;]*/gi, "").match(/(^|[\s;])width\s*:/i);
  t.content.querySelectorAll("colgroup").forEach((cg) => {
    if (Array.from(cg.querySelectorAll("col")).every((c) => !c.getAttribute("width") && !realWidth(c.getAttribute("style")))) cg.remove();
  });
  t.content.querySelectorAll("table").forEach((tb) => {
    const st = (tb.getAttribute("style") || "").split(";").map((s) => s.trim()).filter(Boolean).filter((d) => !/^min-width\s*:/i.test(d));
    if (st.length) tb.setAttribute("style", st.join("; ")); else tb.removeAttribute("style");
  });
  // a cell holding exactly one attribute-less <p> renders with default p margins outside
  // the editor — unwrap it (the parser re-wraps on load, so the round-trip stays closed)
  t.content.querySelectorAll("td, th").forEach((cell) => {
    const kids = Array.from(cell.childNodes).filter((n) => n.nodeType !== 3 || (n.textContent || "").trim());
    const only = kids.length === 1 ? (kids[0] as HTMLElement) : null;
    if (only && only.nodeType === 1 && only.tagName === "P" && !only.attributes.length) cell.replaceChildren(...Array.from(only.childNodes));
  });
  return t.innerHTML;
}

// Minimal, SAFE markdown for chat bubbles: HTML is escaped FIRST, then a small set of
// inline/list transforms are applied — so AI output can never inject live markup.
export function mdLite(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return src.replace(/\r/g, "").split(/\n{2,}/).map((blk) => {
    const lines = blk.split("\n");
    if (lines.some((l) => /^\s*[-*]\s+/.test(l)) && lines.every((l) => /^\s*[-*]\s+/.test(l) || !l.trim())) {
      return "<ul>" + lines.filter((l) => l.trim()).map((l) => "<li>" + inline(l.replace(/^\s*[-*]\s+/, "")) + "</li>").join("") + "</ul>";
    }
    return "<p>" + lines.map(inline).join("<br>") + "</p>";
  }).join("");
}

// ── interact mode (Edit/Interact toggle, K5) ─────────────────────────────────
// Executable <script> types — a <script> only makes a doc interactive if it's one of these
// (or typeless). Data/template scripts (application/json, ld+json, text/template, x-tmpl…)
// are inert payloads, not behavior.
export const EXEC_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"]);

// F31: gate the Interact affordance on the doc actually containing executable JS, so the
// toggle is only offered when toggling would DO something. True iff the raw bytes hold a
// <script> that is an executable type AND carries real code (a `src`, or a non-trivial inline
// body). Regex-based (no DOM) so it runs identically server-side (Bun, gates the toggle markup)
// and client-side. Markdown notes have no <script>, so they never qualify.
export function hasInteractiveScript(html: string): boolean {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html || ""))) {
    const attrs = m[1] || "", body = m[2] || "";
    const tm = /\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const type = (tm ? (tm[2] ?? tm[3] ?? tm[4] ?? "") : "").trim().toLowerCase();
    if (type && !EXEC_SCRIPT_TYPES.has(type)) continue;   // data/template script — inert
    if (/\bsrc\s*=/i.test(attrs)) return true;            // external script/module
    if (body.trim().length > 1) return true;              // non-trivial inline code
  }
  return false;
}

// F30: a doc "brings its own design" if it declares ANY styling — a <style> block, a linked
// stylesheet, or an inline `style` attribute. Unstyled docs get the app's base note CSS
// injected in interact (below) so the render stays themed+centered like edit, instead of
// jumping to a bare white, left-aligned page. Parsed inert (<template>) — nothing runs/loads.
export function hasOwnStyling(html: string): boolean {
  const t = document.createElement("template"); t.innerHTML = html || "";
  return !!t.content.querySelector("style, link[rel~='stylesheet' i], [style]");
}

// The app's base reading theme, mirrored for the sandbox iframe: the same centered 760 column,
// font, and light/dark surface as edit mode — so toggling an UNSTYLED doc changes "JS runs",
// not the whole look (F30). Themed via prefers-color-scheme to track the app's own theming.
export const BASE_NOTE_CSS = `
  html{background:#fbfbfa;color:#1c1c1e}
  body{max-width:760px;margin:0 auto;padding:40px 32px;background:transparent;color:inherit;
    font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
  img,svg,video{max-width:100%;height:auto}
  a{color:#5a49d6}
  @media(prefers-color-scheme:dark){html{background:#0e0e11;color:#ececef}a{color:#bcb1ff}}`;

// F33: inside the opaque-origin sandbox, history.pushState/replaceState throw SecurityError
// ('origin "null" … about:srcdoc') — repeated console noise, and pushState-routing docs half
// -break with no explanation. Neutralize the History API (call-through, swallow on throw: keep
// behavior where the sandbox allows it, silence where it forbids it) so such docs degrade
// gracefully and the console stays clean. Also stub navigator.wakeLock (policy-violation
// warning in sandbox). Injected as the FIRST <script> in <head> so it runs before the doc's
// own (typically end-of-body) scripts.
export const SANDBOX_SHIM = `<script>(function(){try{var h=window.history;["pushState","replaceState"].forEach(function(m){var o=h[m];if(typeof o!=="function")return;h[m]=function(){try{return o.apply(h,arguments);}catch(e){return undefined;}};});}catch(e){}try{if(navigator.wakeLock&&navigator.wakeLock.request){navigator.wakeLock.request=function(){return Promise.reject(new DOMException("wake lock unavailable in sandbox","NotAllowedError"));};}}catch(e){}})();</script>`;

// Build the sandbox srcdoc from the RAW file bytes, injecting ONLY: (1) the history/wakeLock
// shim (always — F33), and (2) the base note CSS for unstyled docs (F30). String-spliced right
// after the opening <head> so the doc's own bytes are otherwise untouched — never DOM-reparsed
// /reserialized, which would relocate the doc's end-of-body scripts (the exact bug this feature
// exists to avoid, see F28). Returns the verbatim bytes plus the head injection.
export function buildInteractSrcdoc(raw: string): string {
  raw = raw || "";
  let inject = SANDBOX_SHIM;
  if (!hasOwnStyling(raw)) inject += `\n<style>${BASE_NOTE_CSS}</style>`;
  const head = /<head\b[^>]*>/i.exec(raw);
  if (head) { const i = head.index + head[0].length; return raw.slice(0, i) + inject + raw.slice(i); }
  const htmlTag = /<html\b[^>]*>/i.exec(raw);
  if (htmlTag) { const i = htmlTag.index + htmlTag[0].length; return raw.slice(0, i) + "<head>" + inject + "</head>" + raw.slice(i); }
  return inject + raw;
}

// ---- folder tree -------------------------------------------------------------
// Build a nested tree from each note's `rel` path (e.g. "Projects/Alpha/spec.md").
// The server already walks subdirs and emits `rel`; this groups them for the sidebar.
export type NoteRef = { rel: string; [k: string]: any };
export type TreeNode = { rel: string; dirs: Map<string, TreeNode>; files: NoteRef[] };
export function buildTree(notes: NoteRef[]): TreeNode {
  const root: TreeNode = { rel: "", dirs: new Map(), files: [] };
  for (const f of notes) {
    const parts = String(f.rel).split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = cur.dirs.get(seg);
      if (!child) { child = { rel: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] }; cur.dirs.set(seg, child); }
      cur = child;
    }
    cur.files.push(f);
  }
  return root;
}
// Sanitize a user-typed new-note / rename name that MAY include "/" to nest into folders
// (e.g. "Projects/ideas/spec"). Each path SEGMENT keeps letters, digits, space, ".", "_" and
// "-" (so "Meeting 2024.01", "v1.2" keep their dots); "/" stays as the folder separator.
// Leading dots per segment are stripped (no hidden ".ssh" files, no "."/".." traversal — a
// pure-dot segment collapses to empty and is dropped). Leading/trailing/duplicate slashes
// collapse and empty segments drop. Returns the clean relative path WITHOUT a note extension,
// or null if nothing usable remains. Pure — unit-tested; the server still re-validates.
export function sanitizeRelNotePath(name: string): string | null {
  const segs = String(name || "")
    .split("/")
    .map((s) => s.replace(/[^a-zA-Z0-9 ._-]/g, "").trim().replace(/^\.+/, ""))
    .filter((s) => s.length > 0);
  return segs.length ? segs.join("/") : null;
}

// Total notes under a node, recursively (the count shown next to a folder).
export function countFiles(n: TreeNode): number {
  let c = n.files.length;
  n.dirs.forEach((d) => (c += countFiles(d)));
  return c;
}

// ── Tab ghost-text (Cursor-Tab for notes, v1) ────────────────────────────── // [AI:ghost]
// Pure, DOM-free decision layer for the inline ghost-completion feature, shared by the client
// controller (client/ghost-completion.ts) and the /ghost server route. Kept here so the trigger
// GATE, the prompt, the output-clean, and the cursor-join are unit-tested without booting the
// editor or making a model call. v1 SCOPE: prose + SIMPLE structure (paragraphs, headings, list
// items, table cells, blockquotes). Rich / class-styled / code blocks are deliberately out of
// scope (a later gated expansion) — the controller maps the cursor to one of these names or null,
// and shouldRequestGhost refuses anything else.
export const GHOST_BLOCK_TYPES = new Set(["paragraph", "heading", "listItem", "taskItem", "tableCell", "tableHeader", "blockquote"]);
// Human label per block type for the prompt's "Continue this <label>" — keeps the prompt readable
// while the controller/gate speak the TipTap node names above.
const GHOST_BLOCK_LABELS: Record<string, string> = {
  paragraph: "paragraph", heading: "heading", listItem: "list item", taskItem: "to-do item",
  tableCell: "table cell", tableHeader: "table header", blockquote: "blockquote",
};
// Don't offer a completion until there's at least this much real text in the block to continue
// from — firing on an empty/one-letter line is noise, not help.
export const GHOST_MIN_CONTEXT = 3;
// Hard cap on a ghost: it's a 1–2 clause hint, never a paragraph. Bounds both the visible span
// and what Tab inserts (defence-in-depth against a chatty model).
export const GHOST_MAX_LEN = 120;

// The single trigger predicate (integrity-critical: this is where the v1 scope discipline lives).
// All inputs are plain values the controller derives from ProseMirror state, so this stays pure.
export function shouldRequestGhost(ctx: {
  selectionEmpty: boolean;   // a range selection is not a completion point
  atTextEnd: boolean;        // cursor at the very end of the block's text (continue, don't insert mid-word)
  inCodeBlock: boolean;      // out of scope — never predict code
  inRichBlock: boolean;      // out of scope — frozen / class-styled rich block
  blockType: string | null;  // mapped TipTap node name, or null if none of the supported kinds
  textBefore: string;        // the block text up to the cursor
  hasPatternContext?: boolean; // [next-edit] a repeating list/table pattern precedes the cursor
}): boolean {
  if (!ctx.selectionEmpty) return false;
  if (ctx.inCodeBlock || ctx.inRichBlock) return false;
  if (!ctx.atTextEnd) return false;
  if (!ctx.blockType || !GHOST_BLOCK_TYPES.has(ctx.blockType)) return false;
  // [next-edit] Normally we need a few chars of current-block text to continue. But in a list/table
  // where a pattern already precedes the cursor, fire even on an empty/short item — that's the
  // "type 'A', Enter, Tab → 'B'" moment, and the FIM model continues the sequence from the prefix.
  if (!ctx.hasPatternContext && ctx.textBefore.trim().length < GHOST_MIN_CONTEXT) return false;
  return true;
}

// Tight prompt for a short continuation. Built on the SERVER (single call-site through streamAI)
// so the model layer can be swapped with a one-line change. Self-contained — does not rely on the
// note's surrounding SYSTEM prompt — and explicitly tells the model to emit ONLY the continuation.
export function buildGhostPrompt(blockType: string, context: string): string {
  const label = GHOST_BLOCK_LABELS[blockType] || "text";
  return `Continue this ${label} naturally, 1-2 short clauses, no preamble.\n`
    + `Output ONLY the text that comes immediately AFTER the user's text — do not repeat or restate it, no quotes, no explanation. If it already reads as complete, output nothing.\n\n`
    + `<text>${context}</text>`;
}

// Special / sentinel tokens a completion model can leak into its output: FIM markers
// (<|fim_prefix|>, <|fim_middle|>, <|fim_pad|>, <|endoftext|>, <|im_end|>…), CodeLlama-style
// <PRE>/<SUF>/<MID>/<EOT>, and the </s> end token. Stripped wherever they appear.
const GHOST_SENTINELS = /<\|[a-zA-Z0-9_]+\|>|<\/?(?:PRE|SUF|MID|EOT|FILL_ME|s)>/g;

// Clean a raw model completion into a short, single-segment continuation. Pure. Order matters:
// strip model artifacts FIRST (FIM/special tokens, code fences, stray HTML tag fragments like a
// trailing "</p>" — a small completion model leaks these even in FIM mode), THEN reduce to one
// line + drop wrapping quotes + cap length. So a chatty or junk-laden response still renders as a
// 1–2 clause prose ghost. Does NOT add the cursor-join space — that depends on the live preceding
// char (see joinGhost).
export function cleanGhostCompletion(raw: string): string {
  let s = (raw || "").replace(/\r/g, "");
  s = s.replace(GHOST_SENTINELS, "");                    // FIM / chat / EOT special tokens
  s = s.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, ""); // code-fence artifacts ("```html")
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");             // stray HTML tag fragments ("</p>", "<li>")
  s = s.split("\n")[0];                                   // first line only — a ghost is one segment
  s = s.replace(/^\s*["'`]+/, "").replace(/["'`]+\s*$/, ""); // drop wrapping quotes/backticks
  s = s.trim();
  if (s.length > GHOST_MAX_LEN) {
    // cut at the last word boundary within the cap so we never sever a word mid-letter
    s = s.slice(0, GHOST_MAX_LEN);
    const sp = s.lastIndexOf(" ");
    if (sp > GHOST_MAX_LEN * 0.6) s = s.slice(0, sp);
  }
  return s.trimEnd();
}

// Join a cleaned completion to the live text before the cursor, inserting a single leading space
// only when needed: the preceding char is a word/closing char AND the completion starts with a
// word char (so "The quick"+"brown" → " brown", but "The quick "+"brown" stays "brown" and
// "word"+", then" gets no space before the comma). The ghost SPAN shows exactly this string and
// Tab inserts exactly this string, so what you see is what you accept.
export function joinGhost(textBefore: string, completion: string): string {
  if (!completion) return "";
  const prev = textBefore.slice(-1);
  const first = completion[0];
  const needSpace = !!prev && /[A-Za-z0-9)\]"'.,!?:;]/.test(prev) && /[A-Za-z0-9([{"']/.test(first);
  return (needSpace ? " " : "") + completion;
}

// Tab arbitration (ghost-accept vs list-indent), as a pure mirror of the runtime contract: a
// VISIBLE ghost claims Tab (accept + consume the key); with no ghost, Tab "falls through" to the
// existing TabKeys list-indent / code-tab / table behavior, unchanged. The editor wires this via
// a `ghostAcceptTab()` hook at the top of TabKeys (returns true exactly when this is "accept").
export function ghostTabAction(ghostVisible: boolean): "accept" | "fallthrough" {
  return ghostVisible ? "accept" : "fallthrough";
}

// ── ⌘K intent routing (rebuild) ───────────────────────────────────────────────
// [AI:cmdk] The old ⌘K sent EVERY instruction to the model, which then (1) emitted literal
// markdown into prose ("**bold**" as text, not a real mark) and (2) "edited" a native block by
// generating a fresh one BESIDE it. The fix is a deterministic client-side router that handles
// the surgical cases WITHOUT a model call: a formatting verb on a text selection becomes a real
// editor mark; a native-block instruction becomes an ATTR/STRUCTURE change on that exact node.
// Only genuine generation (rewrite prose, author content, rebuild an HTML block) reaches the AI.
// These recognizers are pure + unit-tested; editor.ts maps their output to TipTap commands.

// Content-generation verbs — if present, the instruction is a REWRITE/GENERATE task, never a
// one-word format command, so the format recognizer bows out and lets the AI path take it.
const REWRITE_VERBS = /\b(rewrite|rephrase|paraphrase|summar|shorten|expand|elaborat|translat|explain|describe|continue|simplif|proofread|correct|draft|generate|compose|reword)\b/;
// Named colors → a concrete value (so "make it red" sets a real color mark). Hex passes through.
const NAMED_COLORS: Record<string, string> = {
  red: "#e5484d", orange: "#f76808", amber: "#ffb224", yellow: "#fde047", gold: "#f5d90a",
  green: "#30a46c", teal: "#12a594", cyan: "#05a2c2", blue: "#3b82f6", indigo: "#3e63dd",
  violet: "#7c3aed", purple: "#8e4ec6", magenta: "#c2298a", pink: "#e93d82",
  gray: "#8b8d98", grey: "#8b8d98", black: "#1c1c1e", white: "#ffffff",
};
function colorFrom(s: string): string | null {
  const hex = s.match(/#[0-9a-f]{3,8}\b/i);
  if (hex) return hex[0];
  for (const name in NAMED_COLORS) if (new RegExp("\\b" + name + "\\b").test(s)) return NAMED_COLORS[name];
  return null;
}

// A FORMATTING instruction on selected text → a real editor mark, applied client-side (never
// inserted as literal markdown). Returns null when the instruction isn't a short format command
// (it then falls through to the AI prose-rewrite path). Marks supported: the ones the editor
// actually has (bold/italic/strike/code/highlight/color + clear) — no underline (no extension).
export type FormatOp =
  | { op: "bold" | "italic" | "strike" | "code" | "clear" }
  | { op: "highlight"; color?: string }
  | { op: "color"; color: string };
export function parseFormatIntent(intent: string): FormatOp | null {
  const raw = (intent || "").trim().toLowerCase();
  if (!raw) return null;
  if (REWRITE_VERBS.test(raw)) return null;                 // a content op, not a format command
  if (raw.split(/\s+/).length > 6) return null;             // a sentence → a rewrite, not "bold this"
  const has = (re: RegExp) => re.test(raw);
  if (has(/\bbold|embolden|\bstrong\b/)) return { op: "bold" };
  if (has(/\bitalic|italici[sz]e|\bemphasi[sz]e\b/)) return { op: "italic" };
  if (has(/\bstrike|strikethrough\b/) || (has(/\bcross\b/) && has(/\bout\b/))) return { op: "strike" };
  if (has(/\b(inline )?code\b|monospace|\bmono\b/)) return { op: "code" };
  if (has(/\bhighlight|\bmarker\b/)) { const c = colorFrom(raw); return c ? { op: "highlight", color: c } : { op: "highlight" }; }
  if (has(/\b(clear|remove|reset|strip)\b/) && has(/\b(format|formatting|style|styling|marks?)\b/)) return { op: "clear" };
  const c = colorFrom(raw);
  if (c && (has(/\bcolou?r\b/) || raw.split(/\s+/).length <= 3)) return { op: "color", color: c };
  return null;
}

// A CLOCK instruction → an IANA timezone for the node's `tz` attr (so "change clock to PT" edits
// the existing block, never spawns a second one). Common abbreviations + a few city names; a raw
// IANA zone typed directly ("America/Sao_Paulo") is accepted too. Longest alias match wins so
// "pacific" isn't shadowed by an incidental "pt". null → unrecognized (editor.ts shows a hint).
const TZ_ALIASES: Record<string, string> = {
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pacific: "America/Los_Angeles", la: "America/Los_Angeles",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver", mountain: "America/Denver", denver: "America/Denver",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago", central: "America/Chicago", chicago: "America/Chicago",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", eastern: "America/New_York", nyc: "America/New_York", "new york": "America/New_York",
  utc: "UTC", gmt: "UTC", zulu: "UTC", z: "UTC",
  london: "Europe/London", uk: "Europe/London", paris: "Europe/Paris", berlin: "Europe/Berlin", cet: "Europe/Paris",
  tokyo: "Asia/Tokyo", japan: "Asia/Tokyo", jst: "Asia/Tokyo",
  india: "Asia/Kolkata", ist: "Asia/Kolkata", delhi: "Asia/Kolkata",
  sydney: "Australia/Sydney", aest: "Australia/Sydney",
  local: "local",
};
export function parseClockTz(intent: string): string | null {
  const t = (intent || "").toLowerCase();
  let best: string | null = null, bestLen = 0;
  for (const k in TZ_ALIASES) {
    if (new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(t) && k.length > bestLen) { best = TZ_ALIASES[k]; bestLen = k.length; }
  }
  if (!best) { const iana = (intent || "").match(/\b[A-Z][A-Za-z]+\/[A-Za-z_]+\b/); if (iana) best = iana[0]; }
  return best;
}

// A CALLOUT instruction → its kind attr (info/tip/warn), so "make this a warning" recolors the
// existing callout in place. null → unrecognized (the kinds the editor renders are info/tip/warn).
// Guard: an AUTHORING request ("write a tip about X") is content, not a kind change — bow out so it
// routes to generation instead of silently recoloring the callout.
export function parseCalloutKind(intent: string): "info" | "tip" | "warn" | null {
  const t = (intent || "").toLowerCase();
  if (/\b(write|add|create|insert|list|draft|generate|compose|fill)\b/.test(t) || REWRITE_VERBS.test(t)) return null;
  if (/\b(warn|warning|caution|danger|alert|stop|error|important)\b/.test(t)) return "warn";
  if (/\b(tip|success|good|positive|hint|pro[- ]?tip)\b/.test(t)) return "tip";
  if (/\b(info|information|note|neutral|fyi)\b/.test(t)) return "info";
  return null;
}

// A TABLE instruction → a structural TipTap table command name, applied to the table the cursor
// is in (so the edit targets THAT table, never a duplicate). null → unrecognized (cell *content*
// is edited by normal typing; this is only the add/remove-row/column structure).
export type TableOp = "addRowAfter" | "addRowBefore" | "addColumnAfter" | "addColumnBefore" | "deleteRow" | "deleteColumn" | "deleteTable" | "toggleHeaderRow";
export function parseTableIntent(intent: string): TableOp | null {
  const t = (intent || "").toLowerCase();
  if (/\b(delete|remove|drop)\b.*\btable\b/.test(t)) return "deleteTable";
  if (/\b(toggle|add|remove)?\s*header\b/.test(t)) return "toggleHeaderRow";
  const isRow = /\brow\b/.test(t), isCol = /\bcolumn|\bcol\b/.test(t);
  const del = /\b(delete|remove|drop)\b/.test(t);
  const before = /\b(above|before|left|top)\b/.test(t);
  if (del && isRow) return "deleteRow";
  if (del && isCol) return "deleteColumn";
  if (/\b(add|new|insert)\b/.test(t) && isRow) return before ? "addRowBefore" : "addRowAfter";
  if (/\b(add|new|insert)\b/.test(t) && isCol) return before ? "addColumnBefore" : "addColumnAfter";
  return null;
}

// [AI:cmdk] Output-format hygiene shared by server (post-AI) and client. Strip a ```lang fence
// the model sometimes wraps output in despite the "no code fences" rule (criterion 4: produce the
// artifact, not a presentation of it). Pure string op — safe under Bun (no DOM).
export function stripCodeFence(s: string): string {
  const m = (s || "").trim().match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : (s || "")).trim();
}
// Clean a PROSE result: de-fence, drop a leading "Sure," / "Here's …:" narration lead-in, and
// unwrap a wholly-quoted block — so a stray conversational reply still lands as the bare artifact.
export function cleanProseResult(s: string): string {
  let t = stripCodeFence(s);
  t = t.replace(/^\s*(sure[,.! ]+|certainly[,.! ]+|here(?:'s| is| are)[^\n:]{0,60}:\s*)/i, "");
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("“") && t.endsWith("”"))) t = t.slice(1, -1);
  return t.trim();
}

// [AI:cmdk] Route a ⌘K instruction, given a lightweight CONTEXT — the primary target kind plus
// whether the caret/selection sits IN OR ON a table or callout. This is the brittle bit a hands-on
// dogfood caught: a text selection (or cell-selection) inside a table classified as "prose", so
// "add row" never reached parseTableIntent and fell through to the model (which then timed out).
// The fix, kept pure + unit-tested: a NATIVE-BLOCK instruction wins whenever we're in/on that block,
// regardless of whether a text range is selected — so it stays deterministic and never duplicates a
// block. Everything else keeps the selection-first behavior (format marks, then model generation).
export type CmdkRoute =
  | { kind: "table"; op: TableOp }
  | { kind: "callout"; calloutKind: "info" | "tip" | "warn" }
  | { kind: "clock"; tz: string }
  | { kind: "calendar"; src: string }
  | { kind: "format"; op: FormatOp }
  | { kind: "ai"; mode: "rich" | "prose" | "author" }
  | { kind: "hint"; target: "clock" | "calendar" | "callout" | "table" };
export function routeCmdkIntent(ctx: { kind: string; inTable?: boolean; inCallout?: boolean }, intent: string): CmdkRoute {
  // 1. In/on a native block → its structural/attr op takes priority (no model call, can't duplicate).
  if (ctx.inTable) { const op = parseTableIntent(intent); if (op) return { kind: "table", op }; }
  if (ctx.inCallout) { const k = parseCalloutKind(intent); if (k) return { kind: "callout", calloutKind: k }; }
  // 2. Node-selected dynamic atoms (clock / calendar): attr edit, or a hint if unrecognized.
  if (ctx.kind === "clock") { const tz = parseClockTz(intent); return tz ? { kind: "clock", tz } : { kind: "hint", target: "clock" }; }
  if (ctx.kind === "calendar") { const src = (intent.match(/https?:\/\/\S+/) || [])[0]; return src ? { kind: "calendar", src } : { kind: "hint", target: "calendar" }; }
  // 3. A callout as the PRIMARY target with no matching native instruction → hint, NOT generation
  //    (generation BESIDE an existing block is the duplication failure we're avoiding; a callout's
  //    prose stays rewritable by selecting the cell text). A table (next line) differs.
  if (ctx.kind === "callout") { const k = parseCalloutKind(intent); return k ? { kind: "callout", calloutKind: k } : { kind: "hint", target: "callout" }; }
  // [F47] A TABLE as the primary target (whole-table NodeSelection / multi-cell CellSelection): a
  // structural op still wins (deterministic, no model), but ANY other instruction is now a free-form
  // REWRITE of the whole table → the model (rich HTML) + gate, instead of dead-ending in a hint. A
  // table differs from a callout (whose prose is reachable by selecting cell text): its structure
  // can't be rewritten any other way, and the apply step REPLACES the table node in place — so there
  // is no duplication risk (the reason a callout still hints rather than generates beside itself).
  if (ctx.kind === "table") { const op = parseTableIntent(intent); return op ? { kind: "table", op } : { kind: "ai", mode: "rich" }; }
  // 4. Prose selection: a formatting command → real marks; anything else → model rewrite.
  if (ctx.kind === "prose") { const op = parseFormatIntent(intent); return op ? { kind: "format", op } : { kind: "ai", mode: "prose" }; }
  // 5. Rich block → model (pure HTML); bare caret → model author.
  return { kind: "ai", mode: ctx.kind === "rich" ? "rich" : "author" };
}
