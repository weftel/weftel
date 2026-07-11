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

// First-save normalization class, RE-SCOPED at gate J (2026-07-10): the
// mergeNestedSpanStyles value mutation is FIXED (TextStyle.configure flip; browser guard
// in tests/e2e/style-shorthand.spec.ts). What remains is style-ATTR-STRING instability:
//   • headless: happy-dom CSSOM reformats style strings (spacing/trailing-;) and DROPS
//     modern fns (color-mix/var) entirely — verifier-side limitation, values proven intact
//     in Chromium by the style-shorthand spec;
//   • browser: first save normalizes styled-box style strings (hex→rgb, spacing) — #102,
//     value-preserving, settles once.
// Pinned red until #102 lands a getAttribute-passthrough render (never CSSOM).
const FIRST_SAVE_NORM = "first-save style-string normalization: T1≠T2 once then settles — headless CSSOM reformat/modern-fn loss + browser hex→rgb rewrite (#102)";

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
