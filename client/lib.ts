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
const EDITABLE_TAGS = new Set([...PROSE_OK_TAGS, "DIV", "PRE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "COLGROUP", "COL", "CAPTION", "FIGURE", "FIGCAPTION",
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "DL", "DT", "DD", "SMALL", "SUB", "SUP", "KBD", "SAMP", "VAR", "ABBR", "CITE", "Q", "TIME", "DETAILS", "SUMMARY"]);
export function editableModelable(html: string, relaxClass = false): boolean {
  const t = document.createElement("template"); t.innerHTML = html || "";
  const els = Array.from(t.content.querySelectorAll("*"));
  if (!els.length) return false;
  for (const el of els) {
    if (!EDITABLE_TAGS.has(el.tagName)) return false;  // svg / img / canvas / iframe / media → freeze (preserve verbatim)
    if (!relaxClass && el.getAttribute("class")) return false; // class-styled → can't reproduce its look → freeze
  }
  return true;
}
// For load-time isolation (isolateRich): does this element's WHOLE subtree contain only
// modelable tags (no svg/img/canvas/iframe/media)? Unlike editableModelable, a text-only leaf
// (<h1>hi</h1>, <span style>x</span>) counts as editable — here we ask "is anything here
// unpreservable?", not "is there nested structure to unwrap". relaxClass mirrors FULL_PARSE.
export function subtreeEditable(el: Element, relaxClass = true): boolean {
  if (!EDITABLE_TAGS.has(el.tagName)) return false;
  if (!relaxClass && el.getAttribute("class")) return false;
  for (const c of Array.from(el.children)) if (!subtreeEditable(c, relaxClass)) return false;
  return true;
}
// Whether AI output should insert as editable native content vs an atomic rich block.
// AI inserts bare fragments with no accompanying <style>, so a classed fragment would render
// unstyled — keep AI on the strict (no-class) gate even under the FULL_PARSE experiment.
export function nativeInsertable(html: string): boolean { return editableModelable(html); }

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
// Total notes under a node, recursively (the count shown next to a folder).
export function countFiles(n: TreeNode): number {
  let c = n.files.length;
  n.dirs.forEach((d) => (c += countFiles(d)));
  return c;
}
