// Id survival: every author-provided identity marker present BEFORE must be present AFTER,
// unless an op explicitly declared its subtree deleted. This is the honest #83 tracker:
// today's engine drops id on modeled nodes (absent from the PreserveAttrs/sboxAttrs
// allowlists), so losses are CLASSIFIED by region — modeled (the known-red class), frozen
// (must survive: rich blocks store verbatim HTML) and shell (head/template — must survive).
// Also inventories author data-* (minus the app's own hooks) and in-doc anchor targets.
import { APP_DATA_HOOKS, prepareDoc } from "../../client/engine";
import type { CheckResult } from "../types";
import { engineSave, frag } from "../engine-io";

export type IdRegion = "modeled" | "frozen" | "shell";

function multiset(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of items) m.set(s, (m.get(s) || 0) + 1);
  return m;
}
function lost(before: Map<string, number>, after: Map<string, number>): string[] {
  const out: string[] = [];
  before.forEach((n, k) => { if ((after.get(k) || 0) < n) out.push(k); });
  return out;
}
const idsIn = (root: ParentNode) => Array.from(root.querySelectorAll("[id]")).map((e) => e.getAttribute("id") || "");
const dataIn = (root: ParentNode) => {
  const out: string[] = [];
  root.querySelectorAll("*").forEach((e) => {
    for (const a of Array.from(e.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith("data-") && !APP_DATA_HOOKS.has(n)) out.push(n + "=" + a.value);
    }
  });
  return out;
};
const anchorTargets = (root: ParentNode) =>
  Array.from(root.querySelectorAll("a[href^='#']")).map((e) => (e.getAttribute("href") || "").slice(1)).filter(Boolean);

// classify each source id by where it lands after prepareDoc: inside a data-rich-block
// wrapper → frozen; present only in the shell template → shell; otherwise modeled.
export function classifyIds(raw: string): Map<string, IdRegion> {
  const prep = prepareDoc(raw);
  const content = frag(prep.content);
  const shell = frag(prep.template || "");
  const regions = new Map<string, IdRegion>();
  content.querySelectorAll("[id]").forEach((el) => {
    const id = el.getAttribute("id") || "";
    regions.set(id, el.closest("[data-rich-block]") ? "frozen" : "modeled");
  });
  idsIn(shell).forEach((id) => { if (!regions.has(id)) regions.set(id, "shell"); });
  return regions;
}

// beforeHtml → afterHtml survival diff. For pure round-trip runs afterHtml is the engine
// save of beforeHtml; golden tasks pass their post-op save + explicit `deletes` exemptions.
export function checkIds(file: string, beforeHtml: string, afterHtml?: string, deletes: string[] = []): CheckResult[] {
  const after = afterHtml ?? engineSave(beforeHtml).s1;
  const b = frag(beforeHtml), a = frag(after);
  const exempt = new Set(deletes);

  const lostIds = lost(multiset(idsIn(b)), multiset(idsIn(a))).filter((id) => !exempt.has(id));
  const lostData = lost(multiset(dataIn(b)), multiset(dataIn(a)));
  const afterIds = new Set(idsIn(a));
  const brokenAnchors = [...new Set(anchorTargets(a))].filter((t) => !afterIds.has(t) && !exempt.has(t));

  if (!lostIds.length && !lostData.length && !brokenAnchors.length) {
    return [{ file, check: "ids", state: "pass" }];
  }
  const regions = classifyIds(beforeHtml);
  const byRegion: Record<IdRegion, string[]> = { modeled: [], frozen: [], shell: [] };
  lostIds.forEach((id) => byRegion[regions.get(id) || "modeled"].push(id));
  const parts: string[] = [];
  (Object.keys(byRegion) as IdRegion[]).forEach((r) => {
    if (byRegion[r].length) parts.push(`lost ${byRegion[r].length} id(s) region=${r}: ${byRegion[r].join(",")}`);
  });
  if (lostData.length) parts.push(`lost data-*: ${lostData.slice(0, 5).join(" ")}${lostData.length > 5 ? ` (+${lostData.length - 5})` : ""}`);
  if (brokenAnchors.length) parts.push(`broken-anchor href="#…" targets: ${brokenAnchors.join(",")}`);
  return [{ file, check: "ids", state: "fail", detail: parts.join(" · ") }];
}
