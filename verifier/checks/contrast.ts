// Contrast: WCAG ratio on COMPOSITED colors, computed headless from the saved doc string
// (the product's fidelity loop must score an AI proposal without mounting the app, so
// Playwright/getComputedStyle is not an option here). Conservative by design: any element
// whose color/background can't be fully resolved is a `skip` with a reason — never a guess.
// Advisory by default on corpus runs (a user's imported doc having low contrast is a doc
// property, not an engine regression); hard-gates inside golden tasks that touch color.
import type { CheckResult } from "../types";
import { frag } from "../engine-io";
import { parseSheets, customProps, substVars, parseColor, declared, contrastRatio, over, type Rule, type RGBA } from "./css";

const THRESHOLD = 4.5; // AA normal text (large-text 3.0 refinement: future gotcha)

// raw material for both the corpus check and the golden DELTA gate (new failures only)
export function contrastReport(s1: string): { fails: string[]; judged: number; skips: string[] } {
  const doc = frag(s1);
  const rules = parseSheets(Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || ""));
  const vars = customProps(rules);
  const resolve = (v: string | undefined): RGBA | null | undefined => {
    if (v == null) return undefined;              // not declared
    const subst = substVars(v, vars);
    return subst == null ? null : parseColor(subst); // null → unresolvable
  };

  const body = doc.querySelector("body") || doc;
  // page backdrop: body/html declared background, else white
  const pageBgRaw = resolve(declared((doc.querySelector("body") || document.createElement("body")) as Element, "background-color", rules) ?? declared((doc.querySelector("html") || document.createElement("html")) as Element, "background-color", rules) ?? (declared((doc.querySelector("body") || document.createElement("body")) as Element, "background", rules)));
  const pageBg: RGBA = pageBgRaw && pageBgRaw.a === 1 ? pageBgRaw : { r: 255, g: 255, b: 255, a: 1 };

  const fails: string[] = [];
  const skips: string[] = [];
  let judged = 0;

  const els = Array.from(body.querySelectorAll("*")).filter((el) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 2) &&
    !/^(script|style|title)$/i.test(el.tagName));

  for (const el of els) {
    // foreground: walk up until a declared color; default black
    let fg: RGBA | null | undefined;
    for (let n: Element | null = el; n; n = n.parentElement) {
      fg = resolve(declared(n, "color", rules));
      if (fg !== undefined) break;
    }
    if (fg === null) { skips.push(tag(el) + " (unresolvable color)"); continue; }
    const fgc = fg ?? { r: 0, g: 0, b: 0, a: 1 };

    // background: composite translucent layers walking up to the page backdrop
    let bg: RGBA = pageBg;
    const layers: RGBA[] = [];
    let unresolvable = false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const v = declared(n, "background-color", rules) ?? declared(n, "background", rules);
      if (v == null) continue;
      if (/gradient|url\(/i.test(v)) { unresolvable = true; skips.push(tag(el) + " (image/gradient background)"); break; }
      const c = resolve(v);
      if (c == null) { unresolvable = true; skips.push(tag(el) + " (unresolvable background)"); break; }
      layers.push(c);
      if (c.a === 1) break;
    }
    if (unresolvable) continue;
    for (const layer of layers.reverse()) bg = over(layer, bg);

    judged++;
    const ratio = contrastRatio(fgc.a < 1 ? over(fgc, bg) : fgc, bg);
    if (ratio < THRESHOLD) fails.push(`${tag(el)} ratio ${ratio.toFixed(2)} < ${THRESHOLD}`);
  }
  return { fails, judged, skips };
}

export function checkContrast(file: string, s1: string, advisory: boolean): CheckResult[] {
  const { fails, judged, skips } = contrastReport(s1);
  const out: CheckResult[] = [];
  if (fails.length) {
    out.push({ file, check: "contrast", state: "fail", advisory, detail: `${fails.length}/${judged} judged elements below AA: ${fails.slice(0, 4).join(" · ")}${fails.length > 4 ? ` (+${fails.length - 4})` : ""}` });
  } else {
    out.push({ file, check: "contrast", state: judged ? "pass" : "skip", advisory, detail: judged ? `${judged} judged, ${skips.length} skipped` : "no judgeable text elements" + (skips.length ? ` (${skips.length} unresolvable)` : "") });
  }
  return out;
}

const tag = (el: Element) => `<${el.tagName.toLowerCase()}${el.getAttribute("class") ? "." + (el.getAttribute("class") || "").split(/\s+/)[0] : ""}>`;
