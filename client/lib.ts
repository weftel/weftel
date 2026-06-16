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
