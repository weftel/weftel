// Result accounting + rendering: apply the expected-fail manifest, compute the exit code,
// render human or --json output. Advisory results (contrast on corpus runs) are reported
// but never gate; --strict-contrast clears the advisory flag upstream.
import type { CheckResult, ResultState, RunReport, Xfail } from "./types";

export function applyExpectations(results: CheckResult[], xfails: Xfail[]): CheckResult[] {
  const pinned = new Set(xfails.map((x) => x.file + "::" + x.check));
  return results.map((r) => {
    const key = r.file + "::" + r.check;
    if (!pinned.has(key)) return r;
    if (r.state === "fail") return { ...r, state: "xfail" as ResultState };
    if (r.state === "pass") return { ...r, state: "xpass" as ResultState, detail: "pinned as expected-fail but PASSED — remove the stale pin from expectations.ts" };
    return r;
  });
}

export function buildReport(results: CheckResult[], files: number, commit: string): RunReport {
  const counts: Record<ResultState, number> = { pass: 0, fail: 0, xfail: 0, xpass: 0, skip: 0, error: 0 };
  let gatingFail = false;
  for (const r of results) {
    counts[r.state]++;
    if ((r.state === "fail" && !r.advisory) || r.state === "xpass") gatingFail = true;
  }
  const exitCode = counts.error > 0 ? 2 : gatingFail ? 1 : 0;
  return { when: new Date().toISOString(), commit, files, results, counts, exitCode };
}

const ICON: Record<ResultState, string> = { pass: "✓", fail: "✗", xfail: "•", xpass: "‼", skip: "~", error: "!" };

export function renderHuman(rep: RunReport): string {
  const lines: string[] = [];
  for (const r of rep.results) {
    if (r.state === "pass") continue; // quiet on green — signal over noise
    const adv = r.advisory && r.state === "fail" ? " (advisory)" : "";
    lines.push(`${ICON[r.state]} ${r.state.toUpperCase()}${adv} ${r.check} ${r.file}${r.detail ? " — " + r.detail : ""}`);
  }
  const c = rep.counts;
  lines.push("");
  lines.push(`${rep.files} files · ${c.pass} pass · ${c.fail} fail · ${c.xfail} xfail · ${c.xpass} xpass · ${c.skip} skip · ${c.error} error → exit ${rep.exitCode}`);
  return lines.join("\n");
}
