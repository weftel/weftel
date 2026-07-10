// LOCKED contracts for the fidelity verifier (discipline copied from
// experiments/cloud-vs-local/types.ts — change shapes here deliberately, never ad hoc).

export type CheckId = "roundtrip" | "ids" | "validity" | "contrast";
export const ALL_CHECKS: CheckId[] = ["roundtrip", "ids", "validity", "contrast"];

// pass     — check ran, held
// fail     — check ran, violated (gates exit 1)
// xfail    — violated, but pinned in expectations.ts (tracked known-red; exit 0)
// xpass    — pinned as expected-fail but PASSED — the pin is stale, un-pin it (gates exit 1)
// skip     — check could not judge this input (reason required; never a guess)
// error    — harness/engine crash on this input (gates exit 2)
export type ResultState = "pass" | "fail" | "xfail" | "xpass" | "skip" | "error";

export interface CheckResult {
  file: string;          // repo-relative fixture path
  check: CheckId;
  state: ResultState;
  detail?: string;       // human-readable evidence (what was lost / ratio measured / why skipped)
  advisory?: boolean;    // contrast on corpus runs: reported, not gating
}

export interface Xfail {
  file: string;          // exact repo-relative path — no globs, so a fix/regression flips one line
  check: CheckId;
  reason: string;
  issue?: string;        // board ref, e.g. "#83"
}

export interface RunReport {
  when: string;          // ISO timestamp
  commit: string;        // git HEAD at run time
  files: number;
  results: CheckResult[];
  counts: Record<ResultState, number>;
  exitCode: 0 | 1 | 2;
}
