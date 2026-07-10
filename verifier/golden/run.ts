// Golden task runner: per task — load source → engine parse → apply the deterministic op
// headless → save → grade (task expectations + all four fidelity checks on the edited doc).
//
//   bun verifier/golden/run.ts [taskId ...] [--json] [--review N]
//
// --review N writes an HTML review sheet (source, instruction, before/after render) for N
// randomly-chosen tasks to verifier/golden/review.html — the human-in-the-loop spot-check
// (gate F). Results append to verifier/golden/results.jsonl (crash-safe, one line per task).
// Exit 0 = all green (xfails counted green), 1 = any unexpected failure.
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { prepareDoc, serializeDoc, htmlToDoc, docToBody } from "../../client/engine";
import { scopeCss } from "../../client/lib";
import { frag } from "../engine-io";
import { checkRoundtrip } from "../checks/roundtrip";
import { checkValidity } from "../checks/validity";
import { checkIds } from "../checks/ids";
import { contrastReport } from "../checks/contrast";
import { roundTrip } from "../engine-io";
import { applyOp, schema, findNode } from "./ops";
import { Node as PMNode } from "@tiptap/pm/model";
import { TASKS } from "./tasks";
import type { Expectation, GoldenTask, TaskResult } from "./types";

const REPO = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const optOf = (f: string) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : undefined; };
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--review");

function gradeExpect(e: Expectation, saved: string, doc: PMNode, before: string): string | null {
  const fail = (msg: string) => `expect ${e.kind}: ${msg}`;
  switch (e.kind) {
    case "savedContains": return saved.includes(e.text) ? null : fail(`missing "${e.text}"`);
    case "savedNotContains": return !saved.includes(e.text) ? null : fail(`still contains "${e.text}"`);
    case "nodeText": { try { const f = findNode(doc, e.match); return f.node.textContent.trim() === e.equals ? null : fail(`got "${f.node.textContent.trim()}"`); } catch (err: any) { return fail(String(err?.message || err)); } }
    case "nodeAttr": { try { const f = findNode(doc, e.match); return f.node.attrs[e.attr] === e.equals ? null : fail(`${e.attr}=${JSON.stringify(f.node.attrs[e.attr])}`); } catch (err: any) { return fail(String(err?.message || err)); } }
    case "tableDims": { try { const f = findNode(doc, { type: "table" }); const rows = f.node.childCount; const cols = f.node.child(0)?.childCount || 0; return rows === e.rows && cols === e.cols ? null : fail(`got ${rows}×${cols}`); } catch (err: any) { return fail(String(err?.message || err)); } }
    case "columnOrder": { try { const f = findNode(doc, { ...e.match, type: e.match.type || "table" }); const vals: string[] = []; f.node.forEach((r) => { if (r.child(0)?.type.name !== "tableHeader") vals.push(r.child(e.column).textContent.trim()); }); return JSON.stringify(vals) === JSON.stringify(e.values) ? null : fail(`got ${vals.join(",")}`); } catch (err: any) { return fail(String(err?.message || err)); } }
    case "countNodes": { let n = 0; doc.descendants((nd) => { if (nd.type.name === e.type) n++; return true; }); return n === e.equals ? null : fail(`counted ${n} ${e.type}`); }
    case "byteIdenticalRegion": {
      // whitespace BETWEEN tags is collapsed before comparing: happy-dom drops whitespace-only
      // text nodes inside frozen subtrees (headless-only; the browser path is byte-faithful —
      // see tests/e2e/js-roundtrip.spec.ts). Attribute/content changes still fail.
      const norm = (s: string) => s.replace(/>\s+</g, "><");
      const pick = (s: string) => frag(s).querySelector(e.selector)?.outerHTML ?? (s.match(new RegExp(`<${e.selector}[\\s\\S]*?</${e.selector}>`, "i"))?.[0] || "");
      return norm(pick(before)) === norm(pick(saved)) ? null : fail(`<${e.selector}> region changed`);
    }
    case "markPreserved": { let ok = false; doc.descendants((nd) => { if (nd.isText && (nd.text || "").includes(e.find) && nd.marks.some((m) => m.type.name === e.mark)) ok = true; return true; }); return ok ? null : fail(`"${e.find}" lacks mark ${e.mark}`); }
  }
}

function runTask(t: GoldenTask): { res: TaskResult; before: string; saved: string } {
  const raw = readFileSync(join(REPO, t.source), "utf8");
  const prep = prepareDoc(raw);
  const doc = PMNode.fromJSON(schema, htmlToDoc(prep.content));
  const edited = applyOp(doc, t.op);
  const saved = serializeDoc(docToBody(edited.toJSON ? PMNode.fromJSON(schema, edited.toJSON()).toJSON() : edited), prep);

  const failures: string[] = [];
  const xfails: string[] = [];
  const xf = new Set(t.expectFail?.checks || []);
  for (const e of t.expect) { const f = gradeExpect(e, saved, edited, raw); if (f) failures.push(f); }
  const push = (check: string, msgs: string[]) => {
    if (!msgs.length) { if (xf.has(check as any)) failures.push(`xpass: ${check} pinned expected-fail but PASSED — remove the pin`); return; }
    if (xf.has(check as any)) xfails.push(...msgs.map((m) => `${check}: ${m}`));
    else failures.push(...msgs.map((m) => `${check}: ${m}`));
  };
  const rt = roundTrip(saved);
  push("roundtrip", checkRoundtrip(t.source, rt).filter((r) => r.state === "fail").map((r) => r.detail || ""));
  push("validity", checkValidity(t.source, saved, rt.t2, rt.s1).filter((r) => r.state === "fail").map((r) => r.detail || ""));
  push("ids", checkIds(t.source, raw, saved, t.deletes || []).filter((r) => r.state === "fail").map((r) => r.detail || ""));
  if (t.contrastGate) {
    // DELTA semantics: the gate judges the EDIT, not the doc — only contrast failures the
    // op introduced fail the task; pre-existing doc contrast is the corpus run's advisory
    // business. The baseline is the SAVED-BEFORE doc (not raw): the engine re-represents
    // elements on save (<div>→<p>/<strong>), so raw-vs-saved comparisons misattribute
    // pre-existing failures as new.
    const baseline = serializeDoc(docToBody(htmlToDoc(prep.content)), prep);
    const beforeFails = new Set(contrastReport(baseline).fails);
    push("contrast", contrastReport(saved).fails.filter((f) => !beforeFails.has(f)));
  }

  return { res: { id: t.id, ok: !failures.length, failures, xfails }, before: raw, saved };
}

const tasks = only.length ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
let commit = "unknown"; try { commit = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim(); } catch {}
const results: TaskResult[] = [];
const rendered: { t: GoldenTask; before: string; saved: string }[] = [];
for (const t of tasks) {
  try {
    const { res, before, saved } = runTask(t);
    results.push(res);
    rendered.push({ t, before, saved });
  } catch (e: any) {
    results.push({ id: t.id, ok: false, failures: ["runner error: " + (e?.message || e)], xfails: [] });
  }
  const last = results[results.length - 1];
  appendFileSync(join(REPO, "verifier/golden/results.jsonl"), JSON.stringify({ commit, ...last }) + "\n");
  console.log(`${last.ok ? "✓" : "✗"} ${last.id}${last.xfails.length ? ` (${last.xfails.length} xfail)` : ""}${last.failures.length ? " — " + last.failures.join(" | ") : ""}`);
}

const reviewN = optOf("--review");
if (reviewN && rendered.length) {
  // tier-prioritized sample: delegate tasks (representation-scale, where taste matters most)
  // always make the sheet, then assist, then substrate — deterministic, stable within tier.
  const rank = { delegate: 0, assist: 1, substrate: 2 } as Record<string, number>;
  const picks = [...rendered]
    .sort((a, b) => (rank[a.t.tier || "substrate"] - rank[b.t.tier || "substrate"]) || a.t.id.localeCompare(b.t.id))
    .slice(0, reviewN);
  // Panes are SCOPED DIVS, not iframes: weftel's live render strips script/iframe/object/
  // embed (stripActive — own-files security model), so an iframe-based sheet reads as empty
  // panes in the app. Each pane inlines the doc's body with its styles rewritten to the
  // pane's class via the app's own scopeCss — legible in weftel AND a raw browser.
  const cell = (taskId: string, label: string, html: string) => {
    const t = document.createElement("template"); t.innerHTML = html;
    const styles = Array.from(t.content.querySelectorAll("style")).map((s) => s.textContent || "").join("\n");
    t.content.querySelectorAll("style,script,title,meta,link").forEach((e) => e.remove());
    const cls = `pane-${taskId}-${label}`;
    // Pane reset BEFORE the doc's own styles: panes render against browser defaults
    // regardless of the app's dark canvas (#96 — the app fills undeclared colors from its
    // dark theme, garbling light-styled tables). No !important, and NOTHING color-related
    // inline (inline would beat everything — a self-dark-themed doc like adamw could
    // never paint its own background): colors live in the reset SHEET, and the doc's
    // scoped rules come after it, so `body{…}` (mapped to .pane-x by scopeCss) wins by
    // order and self-themed docs render as themselves. Table chrome defaults included:
    // in-app, classed tables lose their class in the live DOM (#97 — resizable TableView
    // rebuilds the element), so class-scoped table rules die without a fallback.
    const reset = `.${cls}{background:#fff;color:#111}.${cls} :is(p,h1,h2,h3,h4,li,td,th,span,div,strong,em,code){color:#111}.${cls} th{background:#f2f4f8}.${cls} :is(th,td){border:1px solid #c8cdd6}`;
    return `<div style="flex:1;min-width:0"><h4>${label}</h4><style>${reset}\n${scopeCss(styles, "." + cls)}</style><div class="${cls}" style="border:1px solid #ccc;border-radius:6px;padding:14px;max-height:480px;overflow:auto">${t.innerHTML}</div></div>`;
  };
  // instructions are prose that may mention literal tags ("the <head> must not change") —
  // escape or the browser eats them as markup
  const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sections = picks.map(({ t, before, saved }) => `<section style="margin:28px 0"><h2>${t.id}</h2><p><em>${escText(t.instruction)}</em> · <code>${t.source}</code></p><div style="display:flex;gap:12px">${cell(t.id, "before", before)}${cell(t.id, "after", saved)}</div></section>`).join("\n");
  writeFileSync(join(REPO, "verifier/golden/review.html"), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Golden review sheet</title></head><body style="font:15px/1.5 sans-serif;max-width:1100px;margin:2rem auto"><h1>Golden task review — ${commit}</h1>${sections}</body></html>`);
  console.log(`review sheet: verifier/golden/review.html (${picks.length} tasks)`);
}

const bad = results.filter((r) => !r.ok);
if (flag("--json")) console.log(JSON.stringify(results, null, 1));
console.log(`\n${results.length} tasks · ${results.length - bad.length} ok · ${bad.length} failing → exit ${bad.length ? 1 : 0}`);
process.exit(bad.length ? 1 : 0);
