// Dual-renderer visual judge (phase-2 gate P — NON-GATING until promoted; see mcp/PLAN.md).
// For each golden task (or probe): render before/after in BOTH renderers — the running
// weftel app (/?file=) and a raw browser page (file://) — in BOTH color schemes, then a
// multimodal judge answers: (1) does the after-render reflect the instruction? (2) do the
// two renderers agree? This is the automation of the gate-F human review; a light-only or
// app-only judge has proven blind spots (#94 iframe panes read as empty ONLY in the app;
// the item-outside-list miss is invisible to text/tree checks).
//
//   bun verifier/golden/visual.ts --probes            # the two archived regression probes
//   bun verifier/golden/visual.ts [taskId ...]        # golden tasks (default: delegate+assist tiers)
//   --gate                                            # exit 1 on flags (promotion; default exit 0)
//   --no-judge                                        # screenshots only (free; for eyeballing)
//
// Judge = `claude -p` with the Read tool on the screenshot files (BYO subscription — the
// CloudProvider precedent; no API key enters the repo). Verdicts append to
// verifier/golden/visual-report.jsonl; screenshots land in verifier/golden/_visual/.
// Playwright is used AS A LIBRARY; the weftel server is spawned like dev.sh does (never
// imported). Model calls are non-deterministic — this deliberately lives outside the
// deterministic runners.
import "../engine-io";
import { fetch as bunFetch } from "bun"; // happy-dom (above) replaces global fetch with a CORS-policed one (GOTCHA)
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Node as PMNode } from "@tiptap/pm/model";
import { prepareDoc, serializeDoc, htmlToDoc, docToBody } from "../../client/engine";
import { schema, applyOp } from "../../client/ops";
import { TASKS } from "./tasks";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = join(ROOT, "verifier/golden/_visual");
const REPORT = join(ROOT, "verifier/golden/visual-report.jsonl");
const PROBES_DIR = join(ROOT, "verifier/golden/visual-probes");
const PORT = 4681;
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const PROBES = args.includes("--probes");
const GATE = args.includes("--gate");
const NO_JUDGE = args.includes("--no-judge");
const taskFilter = args.filter((a) => !a.startsWith("--"));

interface Item { id: string; instruction: string; beforeBytes: string; afterBytes: string; kind?: string }

function goldenItems(): Item[] {
  let tasks = taskFilter.length ? TASKS.filter((t) => taskFilter.includes(t.id)) : TASKS.filter((t) => (t.tier || "substrate") !== "substrate");
  return tasks.map((t) => {
    const raw = readFileSync(join(ROOT, t.source), "utf8");
    const prep = prepareDoc(raw);
    const doc = PMNode.fromJSON(schema, htmlToDoc(prep.content));
    const edited = applyOp(doc, t.op);
    const afterBytes = serializeDoc(docToBody(edited.toJSON()), prep.template ? { template: prep.template, token: prep.token } : null);
    return { id: t.id, instruction: t.instruction, beforeBytes: raw, afterBytes };
  });
}

function probeItems(): Item[] {
  const manifest = JSON.parse(readFileSync(join(PROBES_DIR, "probes.json"), "utf8"));
  return manifest.map((p: any) => ({
    id: p.id, instruction: p.instruction, kind: p.kind,
    beforeBytes: readFileSync(join(PROBES_DIR, p.before), "utf8"),
    afterBytes: readFileSync(join(PROBES_DIR, p.after), "utf8"),
  }));
}

async function judge(item: Item, shots: Record<string, string>): Promise<{ instructionMatch: boolean; renderersAgree: boolean; notes: string } | { error: string }> {
  const prompt = `You are a visual document-fidelity judge. An edit was proposed for a document with this instruction:

"${item.instruction}"

Screenshots (use the Read tool on each absolute path):
- BEFORE in the weftel app, light: ${shots["app-light-before"]}
- AFTER  in the weftel app, light: ${shots["app-light-after"]}
- BEFORE in the weftel app, dark:  ${shots["app-dark-before"]}
- AFTER  in the weftel app, dark:  ${shots["app-dark-after"]}
- BEFORE raw browser, light: ${shots["raw-light-before"]}
- AFTER  raw browser, light: ${shots["raw-light-after"]}
- BEFORE raw browser, dark:  ${shots["raw-dark-before"]}
- AFTER  raw browser, dark:  ${shots["raw-dark-after"]}

Answer TWO questions, strictly from the images:
1. instructionMatch — does the BEFORE→AFTER change, as RENDERED, correctly accomplish the instruction? (Structure matters: text landing in the wrong structural place — e.g. outside a list it was meant to join — is a NO.)
2. renderersAgree — does the app render and the raw browser render show the SAME CONTENT? Ignore editor chrome, theme colors, fonts, spacing; flag missing/empty regions, absent sections, blank panes.

Reply with ONLY strict JSON: {"instructionMatch": bool, "renderersAgree": bool, "notes": "one sentence"}`;
  const p = Bun.spawn(["claude", "-p", prompt, "--allowedTools", "Read"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return { error: "judge returned no JSON: " + out.slice(0, 200) };
  try { const j = JSON.parse(m[0]); return { instructionMatch: !!j.instructionMatch, renderersAgree: !!j.renderersAgree, notes: String(j.notes || "") }; }
  catch { return { error: "judge JSON unparseable: " + m[0].slice(0, 200) }; }
}

// ————— render both docs, both renderers, both schemes —————
const vault = mkdtempSync(join(tmpdir(), "weftel-visual-"));
const server = Bun.spawn(["bun", "run", "server.ts", vault], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 50; i++) { try { if ((await bunFetch(`http://localhost:${PORT}/version`)).ok) break; } catch {} await Bun.sleep(200); }
const browser = await chromium.launch();

async function shoot(item: Item): Promise<Record<string, string>> {
  const dir = join(OUT, item.id);
  mkdirSync(dir, { recursive: true });
  const shots: Record<string, string> = {};
  for (const [phase, bytes] of [["before", item.beforeBytes], ["after", item.afterBytes]] as const) {
    const file = join(vault, `${item.id}-${phase}.html`);
    writeFileSync(file, bytes);
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage();
      await page.emulateMedia({ colorScheme: scheme });
      // the app render (edit surface — the renderer the human co-authors in; #100 seam)
      await page.goto(`http://localhost:${PORT}/?file=` + encodeURIComponent(file));
      await page.waitForFunction(() => (window as any).__editor && (window as any).__setMode);
      await page.evaluate(() => (window as any).__setMode("edit"));
      await page.waitForSelector(".ProseMirror");
      await page.waitForTimeout(250);
      const appShot = join(dir, `app-${scheme}-${phase}.png`);
      await page.locator("#editor").screenshot({ path: appShot });
      shots[`app-${scheme}-${phase}`] = appShot;
      // the raw browser render (the doc as a standalone page — its own scripts run)
      await page.goto("file://" + file);
      await page.waitForTimeout(250);
      const rawShot = join(dir, `raw-${scheme}-${phase}.png`);
      await page.screenshot({ path: rawShot, fullPage: true });
      shots[`raw-${scheme}-${phase}`] = rawShot;
      await page.close();
    }
  }
  return shots;
}

const items = PROBES ? probeItems() : goldenItems();
console.log(`visual judge · ${items.length} item(s) · ${PROBES ? "PROBES" : "golden"} · ${NO_JUDGE ? "screenshots only" : "judging"}${GATE ? " · GATING" : " · non-gating"}`);
let flags = 0;
for (const item of items) {
  const shots = await shoot(item);
  if (NO_JUDGE) { console.log(`○ ${item.id} — screenshots at ${join(OUT, item.id)}`); continue; }
  const verdict = await judge(item, shots);
  const line = { when: new Date().toISOString(), id: item.id, kind: item.kind, verdict };
  appendFileSync(REPORT, JSON.stringify(line) + "\n");
  if ("error" in verdict) { console.log(`? ${item.id} — ${verdict.error}`); flags++; continue; }
  const flagged = !verdict.instructionMatch || !verdict.renderersAgree;
  if (flagged) flags++;
  console.log(`${flagged ? "⚑" : "✓"} ${item.id} — instructionMatch=${verdict.instructionMatch} renderersAgree=${verdict.renderersAgree} · ${verdict.notes}`);
}

await browser.close(); server.kill(); rmSync(vault, { recursive: true, force: true });
if (PROBES && !NO_JUDGE) {
  // the probes exist BECAUSE they must flag: iframe-panes → renderersAgree=false,
  // item-outside-list → instructionMatch=false. Re-detection is the promotion criterion.
  const report = readFileSync(REPORT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = (id: string) => [...report].reverse().find((r) => r.id === id)?.verdict || {};
  const iframeCaught = last("iframe-panes").renderersAgree === false;
  const listCaught = last("item-outside-list").instructionMatch === false;
  console.log(`\nprobe re-detection: iframe-panes ${iframeCaught ? "CAUGHT" : "MISSED"} · item-outside-list ${listCaught ? "CAUGHT" : "MISSED"}`);
  process.exit(GATE && !(iframeCaught && listCaught) ? 1 : 0);
}
process.exit(GATE && flags > 0 ? 1 : 0);
