// Validity: the saved doc re-parses to a LEGAL canonical doc (ProseMirror schema check),
// dynamic/companion blocks keep parseable attrs, embedded <script> still parses (parse
// only — NEVER executed) and <style> survives scoping with balanced braces.
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { engineExtensions } from "../../client/engine";
import { scopeCss } from "../../client/lib";
import type { CheckResult } from "../types";
import { frag } from "../engine-io";

const schema = getSchema(engineExtensions());
// IANA-ish tz sanity: "Area/City" (allow underscores/hyphens/nested), or "local"
const TZ_RE = /^(local|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;
const CALLOUT_KINDS = new Set(["info", "tip", "warn"]);

export function checkValidity(file: string, raw: string, t2: any, s1: string): CheckResult[] {
  const out: CheckResult[] = [];

  try {
    PMNode.fromJSON(schema, t2).check();
  } catch (e: any) {
    out.push({ file, check: "validity", state: "fail", detail: "re-parsed doc violates the canonical schema: " + (e?.message || e) });
  }

  const f = frag(s1);
  f.querySelectorAll("div[data-clock]").forEach((el) => {
    const tz = el.getAttribute("data-tz") || "local";
    if (!TZ_RE.test(tz)) out.push({ file, check: "validity", state: "fail", detail: `clock block has implausible tz "${tz}"` });
  });
  f.querySelectorAll("div[data-callout]").forEach((el) => {
    const kind = el.getAttribute("data-kind") || "";
    if (!CALLOUT_KINDS.has(kind)) out.push({ file, check: "validity", state: "fail", detail: `callout block has unknown kind "${kind}"` });
  });

  // embedded code still parses — a save must never corrupt a doc's own wiring script
  const transpiler = new Bun.Transpiler({ loader: "js" });
  f.querySelectorAll("script").forEach((el, i) => {
    const src = el.textContent || "";
    if (!src.trim() || el.getAttribute("type") === "application/json") return;
    try { transpiler.transformSync(src); } catch (e: any) {
      out.push({ file, check: "validity", state: "fail", detail: `saved <script> #${i} no longer parses: ${e?.message || e}` });
    }
  });
  f.querySelectorAll("style").forEach((el, i) => {
    const css = el.textContent || "";
    const opens = (css.match(/{/g) || []).length, closes = (css.match(/}/g) || []).length;
    if (opens !== closes) out.push({ file, check: "validity", state: "fail", detail: `saved <style> #${i} has unbalanced braces (${opens} vs ${closes})` });
    try { scopeCss(css, ".note-scope"); } catch (e: any) {
      out.push({ file, check: "validity", state: "fail", detail: `saved <style> #${i} breaks scopeCss: ${e?.message || e}` });
    }
  });

  if (!out.length) out.push({ file, check: "validity", state: "pass" });
  return out;
}
