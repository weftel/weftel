// Round-trip fidelity: source → tree T1 → save S1 → re-parse T2 must be the IDENTICAL tree
// (canonical form: reformat churn is zero diff), serialization must settle (S3 === S2, the
// corpus.spec.ts step-3.5 standard), and the preserved shell must splice cleanly.
import type { CheckResult } from "../types";
import { canonEq, type RoundTrip } from "../engine-io";

export function checkRoundtrip(file: string, rt: RoundTrip): CheckResult[] {
  const out: CheckResult[] = [];

  if (!canonEq(rt.t1, rt.t2)) {
    out.push({ file, check: "roundtrip", state: "fail", detail: "tree changed across save+reparse (T1 ≠ T2 in canonical form)" });
  }
  if (rt.s3 !== rt.s2) {
    out.push({ file, check: "roundtrip", state: "fail", detail: "serialization never settles (S3 ≠ S2 — file would churn on every open)" });
  }
  if (rt.prep.template) {
    if (rt.s1.includes(rt.prep.token)) {
      out.push({ file, check: "roundtrip", state: "fail", detail: `body token ${rt.prep.token} leaked into saved bytes (splice failed)` });
    }
    const headEnd = rt.prep.template.indexOf(rt.prep.token);
    const headSrc = rt.prep.template.slice(0, headEnd);
    if (headEnd > 0 && !rt.s1.startsWith(headSrc)) {
      out.push({ file, check: "roundtrip", state: "fail", detail: "preserved shell before the body splice point was altered" });
    }
  }
  if (!out.length) out.push({ file, check: "roundtrip", state: "pass" });
  return out;
}
