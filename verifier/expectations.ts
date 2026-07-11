// Expected-fail manifest — the honest ledger of what's known-red on today's engine.
// Rules of the ledger:
//   • EXPLICIT per-fixture pins only. No globs — a fix or regression must flip exactly
//     one line, so `xpass` (a stale pin) is a loud, reviewable event.
//   • Pins live HERE, never as fixture annotations (fixtures are round-trip INPUTS;
//     mutating them to describe expectations contaminates the experiment).
//   • Every pin carries the reason and, where one exists, the board issue.
//   • An `xpass` run means a pinned bug got FIXED: remove the pin and refresh
//     baseline/baseline.json (`bun verifier/cli.ts --update-baseline`) in the same commit.
import type { Xfail } from "./types";

// First-save normalization class: parse→save changes the tree ONCE (T1 ≠ T2) then settles
// (S3 === S2 everywhere). Known contributor: TipTap TextStyle mergeNestedSpanStyles:true
// mutates nested span styles at parse (see tests/unit/engine.test.ts gate-B notes). The
// browser corpus harness tolerates one settle pass; tree-identity on first round-trip is
// pinned red until phase 2 decides fix-vs-spec.
const FIRST_SAVE_NORM = "first-save normalization: T1≠T2 once, settles by S2 (mergeNestedSpanStyles / span reorder class)";

// (#83 ids pins removed 2026-07-10: id/data-* preservation + identity-signal parse rules
// landed in client/engine.ts — all 5 pins flipped to xpass on the same run.)
export const EXPECTED_FAIL: Xfail[] = [
  { file: "tests/e2e/corpus/provenance/ai-card.html", check: "roundtrip", reason: FIRST_SAVE_NORM, issue: "#93" },
  { file: "tests/e2e/corpus/real-career/decision-thesis.html", check: "roundtrip", reason: FIRST_SAVE_NORM, issue: "#93" },
  { file: "tests/e2e/corpus/real-career/project-deep-dives.html", check: "roundtrip", reason: FIRST_SAVE_NORM, issue: "#93" },
  { file: "tests/e2e/corpus/real-published/adamw.html", check: "roundtrip", reason: FIRST_SAVE_NORM, issue: "#93" },
  { file: "tests/e2e/corpus/real-published/layernorm-vs-rmsnorm.html", check: "roundtrip", reason: FIRST_SAVE_NORM, issue: "#93" },
  { file: "tests/e2e/corpus/real-published/tokenization.html", check: "roundtrip", reason: FIRST_SAVE_NORM, issue: "#93" },
  { file: "tests/e2e/corpus/styling-source/inline-only.html", check: "roundtrip", reason: FIRST_SAVE_NORM, issue: "#93" },
];
