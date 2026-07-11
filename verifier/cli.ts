// Fidelity verifier CLI — phase-1 gate of the co-authoring layer (see verifier/PLAN.md).
//
//   bun verifier/cli.ts [file|dir ...] [--check roundtrip,ids,validity,contrast]
//                       [--json] [--update-baseline] [--strict-contrast]
//
// Default target: tests/e2e/corpus/ (every category; _shots/dot-dirs skipped; the
// gitignored real-career/ runs when present). Exit 0 = green (xfail = tracked known-red
// counts as green; skip counts as green), 1 = any fail or xpass, 2 = harness error.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";
import { ALL_CHECKS, type CheckId, type CheckResult } from "./types";
import { EXPECTED_FAIL } from "./expectations";
import { applyExpectations, buildReport, renderHuman } from "./report";
import { roundTrip } from "./engine-io";
import { checkRoundtrip } from "./checks/roundtrip";
import { checkValidity } from "./checks/validity";
import { checkIds } from "./checks/ids";
import { checkContrast } from "./checks/contrast";

const REPO = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const optOf = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const targets = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--check");
const checks: CheckId[] = (optOf("--check")?.split(",").filter((c): c is CheckId => (ALL_CHECKS as string[]).includes(c))) || ALL_CHECKS;
const strictContrast = flag("--strict-contrast");

function discover(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return path.endsWith(".html") ? [path] : [];
  const out: string[] = [];
  for (const name of readdirSync(path)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const p = join(path, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...discover(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out.sort();
}

const roots = targets.length ? targets : [join(REPO, "tests/e2e/corpus")];
const files = roots.flatMap((r) => (existsSync(r) ? discover(resolve(r)) : (console.error("no such target: " + r), [])));

const results: CheckResult[] = [];
for (const abs of files) {
  const file = relative(REPO, abs);
  const raw = readFileSync(abs, "utf8");
  let rt;
  try {
    rt = roundTrip(raw);
  } catch (e: any) {
    for (const c of checks) results.push({ file, check: c, state: "error", detail: "engine crashed: " + (e?.message || e) });
    continue;
  }
  try {
    if (checks.includes("roundtrip")) results.push(...checkRoundtrip(file, rt));
    if (checks.includes("validity")) results.push(...checkValidity(file, raw, rt.t2, rt.s1));
    if (checks.includes("ids")) results.push(...checkIds(file, raw, rt.s1));
    if (checks.includes("contrast")) results.push(...checkContrast(file, rt.s1, !strictContrast));
  } catch (e: any) {
    results.push({ file, check: "roundtrip", state: "error", detail: "check crashed: " + (e?.message || e) });
  }
}

let commit = "unknown";
try { commit = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim(); } catch {}

const report = buildReport(applyExpectations(results, EXPECTED_FAIL), files.length, commit);

if (flag("--update-baseline")) {
  mkdirSync(join(REPO, "verifier/baseline"), { recursive: true });
  writeFileSync(join(REPO, "verifier/baseline/baseline.json"), JSON.stringify(report, null, 1) + "\n");
  console.error("baseline written: verifier/baseline/baseline.json");
}
console.log(flag("--json") ? JSON.stringify(report, null, 1) : renderHuman(report));
process.exit(report.exitCode);
