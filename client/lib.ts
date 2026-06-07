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
export function proseModelable(html: string): boolean {
  const t = document.createElement("template"); t.innerHTML = html || "";
  const els = Array.from(t.content.querySelectorAll("*"));
  if (!els.length) return false; // plain text / empty — nothing to gain, leave as-is
  for (const el of els) {
    if (!PROSE_OK_TAGS.has(el.tagName)) return false;        // unknown tag (svg, div, img…) → keep atomic
    if (el.getAttribute("class")) return false;              // a class usually = a styled component we can't model losslessly
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
// containers carrying INLINE styles — with no unmodelable element (svg/img/canvas/iframe)
// and no class (a class's appearance lives in CSS we don't carry → freeze to preserve).
const EDITABLE_TAGS = new Set([...PROSE_OK_TAGS, "DIV", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "COLGROUP", "COL", "CAPTION", "FIGURE", "FIGCAPTION"]);
export function editableModelable(html: string): boolean {
  const t = document.createElement("template"); t.innerHTML = html || "";
  const els = Array.from(t.content.querySelectorAll("*"));
  if (!els.length) return false;
  for (const el of els) {
    if (!EDITABLE_TAGS.has(el.tagName)) return false;  // svg / img / canvas / iframe / style → freeze (preserve verbatim)
    if (el.getAttribute("class")) return false;        // class-styled → can't reproduce its look → freeze
  }
  return true;
}
// Whether AI output should insert as editable native content vs an atomic rich block.
export function nativeInsertable(html: string): boolean { return editableModelable(html); }

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
