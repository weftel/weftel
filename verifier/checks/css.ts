// Minimal CSS resolver for the contrast check — deliberately conservative: it resolves the
// simple, common cases (element/class selectors, inline styles, one-level var(), hex/rgb/
// hsl/named colors, alpha compositing up the ancestor chain) and returns null for anything
// it can't be sure about. Callers turn null into an explicit `skip`, NEVER a guess.
// NOTE: inline styles are read from the RAW style attribute string, never el.style —
// happy-dom's CSSOM rejects whole declaration blocks containing modern fns (color-mix()).

export interface Rule { selector: string; props: Map<string, string>; order: number; spec: number }
export type RGBA = { r: number; g: number; b: number; a: number };

const declsOf = (s: string): Map<string, string> => {
  const m = new Map<string, string>();
  // split on ; at top level (values with () never contain ; in practice for our corpus)
  for (const d of s.split(";")) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
    if (k) m.set(k, v);
  }
  return m;
};

const specificity = (sel: string): number =>
  (sel.match(/#[\w-]+/g) || []).length * 100 +
  (sel.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length * 10 +
  (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;

// parse the doc's <style> blocks into flat rules; nested at-rule blocks (@media/@supports/
// @keyframes/@font-face) are DROPPED whole — conservative: we only reason about base rules.
export function parseSheets(cssBlocks: string[]): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (let css of cssBlocks) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, "");
    css = css.replace(/@[\w-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, " "); // strip block at-rules
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const props = declsOf(m[2]);
      if (!props.size) continue;
      for (const sel of m[1].split(",")) {
        const s = sel.trim();
        if (s && !s.startsWith("@")) rules.push({ selector: s, props, order: order++, spec: specificity(s) });
      }
    }
  }
  return rules;
}

// custom properties (one level): from :root/html/body rules, lowest→highest precedence
export function customProps(rules: Rule[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const r of rules) {
    if (!/^(:root|html|body)$/i.test(r.selector)) continue;
    r.props.forEach((v, k) => { if (k.startsWith("--")) vars.set(k, v); });
  }
  return vars;
}

export function substVars(value: string, vars: Map<string, string>): string | null {
  let out = value, guard = 0;
  while (out.includes("var(") && guard++ < 3) {
    const m = out.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/);
    if (!m) return null; // nested/unparseable var()
    const rep = vars.get(m[1]) ?? m[2];
    if (rep == null) return null; // unresolved and no fallback
    out = out.replace(m[0], rep.trim());
  }
  return out.includes("var(") ? null : out;
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", yellow: "#ffff00", orange: "#ffa500",
  purple: "#800080", navy: "#000080", teal: "#008080", maroon: "#800000", olive: "#808000",
  aqua: "#00ffff", cyan: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", lime: "#00ff00",
  transparent: "rgba(0,0,0,0)",
};

export function parseColor(value: string): RGBA | null {
  let v = value.trim().toLowerCase();
  if (NAMED[v]) v = NAMED[v];
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split("").map((c) => parseInt(c + c, 16));
      return { r, g, b, a: h.length === 4 ? a / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  m = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a };
  }
  return null; // color-mix(), oklch(), gradients, … → caller must skip
}

// WCAG relative luminance + ratio (math verbatim from tests/e2e/sidebar.spec.ts:85-91)
export function luminance(c: RGBA): number {
  const lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}
// composite a (possibly translucent) color over an opaque backdrop
export function over(top: RGBA, under: RGBA): RGBA {
  const a = top.a + under.a * (1 - top.a);
  const ch = (t: number, u: number) => Math.round((t * top.a + u * under.a * (1 - top.a)) / (a || 1));
  return { r: ch(top.r, under.r), g: ch(top.g, under.g), b: ch(top.b, under.b), a };
}

// declared value of a property on an element: inline style wins, then matching rules by
// (specificity, source order). Returns the raw declared string or undefined.
export function declared(el: Element, prop: string, rules: Rule[]): string | undefined {
  const inline = declsOf(el.getAttribute("style") || "").get(prop);
  if (inline) return inline;
  let best: { spec: number; order: number; v: string } | undefined;
  for (const r of rules) {
    let hit = false;
    try { hit = el.matches(r.selector); } catch { continue; }
    if (!hit) continue;
    const v = r.props.get(prop);
    if (v == null) continue;
    if (!best || r.spec > best.spec || (r.spec === best.spec && r.order > best.order)) best = { spec: r.spec, order: r.order, v };
  }
  return best?.v;
}
