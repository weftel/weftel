# Co-authoring layer — Phase 0 wrap + Phase 1 (verifier-first) execution plan

## Context

Ben committed to building the co-authoring layer (`weftel-wiki/co-authoring-layer-sketch.md`) using the method in `weftel-wiki/build-playbook.md`. The playbook is verifier-first: before any feature code, build the thing that grades it — a standalone fidelity-verifier CLI + ~20 golden co-authoring tasks. Per the sketch, this verifier doubles as the product's Layer-4 fidelity loop ("build once, use twice"). All build work happens in **`/Users/benja/weftel`** on a feature branch; the wiki only gets a status-flag update.

**Exploration findings that shaped this plan:**
- The round-trip engine is browser-coupled inside `client/editor.ts` (~2,564 lines; module globals `htmlTemplate`/`BODY_TOKEN`/…, live TipTap editor). But headless `generateJSON`/`generateHTML` exist in the installed `@tiptap/core`, and the only browser-bound parts of the node definitions are 4 node views (ImageNode l.427, RichBlock l.482, ClockBlock l.767, Callout l.802) — so a pure-engine extraction is feasible and is gated by the existing differential corpus e2e suite (`tests/e2e/corpus.spec.ts`, checks real saved bytes + idempotence over 32+ fixtures).
- **No node-id scheme exists anywhere.** `id` is absent from the `PreserveAttrs`/`sboxAttrs` allowlists, so ids on modeled nodes are dropped on save (the known #83 class); ids survive only inside frozen `data-rich-block` subtrees. The verifier's id-survival check will be honestly red today — that red is tracked via expected-fail pins, and id minting is deliberately deferred to Phase 2 (Layer 1 work).
- A golden-task + grader harness precedent exists to mirror: `experiments/cloud-vs-local/` (`types.ts` locked contracts, `tasks.ts`, `checks.ts`, crash-safe `runner.ts` with jsonl append, `grade.ts` LLM judge via `server/providers.ts`).
- No `.claude/` dir exists in the weftel repo — the `fidelity-verify` skill will be its first.
- Constraints: Bun, no tsconfig, ESM, relative imports, never import `server.ts` (boots Bun.serve); unit tests register happy-dom inline (`tests/unit/lib.test.ts` pattern).

## Phase 0 outputs (locked now, recorded in this plan)

Think-first decisions from the sketch's decision stack, locked:
- **D2 (agent surface):** MCP server, with enforcement (permission deny / PreToolUse hook rejecting Edit/Write on vault files) — Phase 2 concern, locked as direction.
- **D3 (approve-gate UX):** per `design-approval-gate.html` — inline thread, auto-escalate to panes; invariant: every hunk maps to exactly one node op.
- **D5 (routing):** ship the obvious heuristic (selection size × ambiguity), instrument, tune later.
Build-to-decide (D1 op granularity, D4 context payload) wait for the Phase 3 tournament; the golden tasks built here are their grading substrate.

Bookkeeping in this plan's execution:
- Branch in `~/weftel`: `co-authoring/phase1-verifier`.
- Copy this approved plan to `~/weftel/verifier/PLAN.md` (playbook: phases spanning sessions write the plan to a file).
- Wiki: update the status flag in `co-authoring-layer-sketch.md` (sketch-for-later → in build, Phase 1 started 2026-07-10).

## Phase 1 execution

### Step 1 — Extract the pure engine: `client/engine.ts` (the one risky step, done first)

Move from `editor.ts` (line refs today): marks + `PreserveAttrs` (l.45–58, 130–205), attr helpers `dataAttrs`/`sboxAttrs`/`APP_DATA_HOOKS` (l.214–249), all node definitions **minus their node views** (l.250–811), md/list helpers (l.821–930), `STRUCTURAL_TAGS`/`isolateRich`/`frameContainer` (l.1042–1080), `prepareHtml` (l.1082–1168), `stripSbox` + serialize composition (l.1413–1427).

New API (pure; imports only `./lib` + `@tiptap/*`; never imports `./editor`):
```ts
export function prepareDoc(raw: string): PreparedDoc  // {content, template, token, richStyles, scopedCss, frame} — returns instead of setting globals
export function serializeDoc(bodyHtml: string, prep: Pick<PreparedDoc,"template"|"token"> | null): string
export function engineExtensions(opts?: {linkOpts?, nodeViews?: NodeViewOverrides}): any[]  // ONE list for editor + verifier; order preserved byte-identical
export function htmlToDoc(content: string): JSONContent   // generateJSON
export function docToBody(json: JSONContent): string      // generateHTML
```
`editor.ts` becomes a thin consumer: globals assigned from `prepareDoc()`'s return at l.1204; extension array = `[...engineExtensions({linkOpts, nodeViews}), SlashMenu, TabKeys, EscapeTrap, Placeholder]` with the 4 node-view factories staying in editor.ts; `serialize()` html branch → `serializeDoc(editor.getHTML(), {template, token})`. `window.__serialize` seam unchanged. `Bun.build({target:"browser"})` needs no config change.

**Gate A:** `bun test tests/unit` green + corpus e2e green before and after the refactor; app boots via `./dev.sh` on a real-published fixture.
**Gate B (go/no-go spike):** `tests/unit/engine.test.ts` under happy-dom — `prepareDoc → generateJSON → generateHTML → serializeDoc` on 3 fixtures (schema/table, styling-source/class-and-style, real-published/adamw); assert settle (S3==S2) and parity with one Playwright-captured `window.__serialize()` snapshot. If happy-dom fundamentally can't parse the corpus → fallback: verifier drives the real app via Playwright seams (product-loop reuse deferred).

### Step 2 — Verifier CLI: `verifier/`

```
verifier/{types.ts, engine-io.ts, cli.ts, report.ts, expectations.ts,
          checks/{roundtrip,ids,validity,contrast,css}.ts, baseline/baseline.json}
```
`bun verifier/cli.ts [file|dir ...] [--check ...] [--json] [--update-baseline] [--strict-contrast]` — default target `tests/e2e/corpus/` (skip `_shots`/dot dirs). States per (file × check): `pass|fail|xfail|xpass|skip|error`. Exit 0 = green (xfail counts as expected); exit 1 = any `fail` **or `xpass`** (a fixed bug must be un-pinned — fixes tracked, not hidden); exit 2 = harness error.

- **roundtrip**: `prepareDoc → generateJSON = T1 → generateHTML → serializeDoc = S1 → re-prepare → T2`; compare canonicalized trees (attr-key sort, drop null attrs); plus headless settle S3==S2 and template-integrity (token consumed, head preserved).
- **validity**: `PMNode.fromJSON(getSchema(engineExtensions()), T2).check()`; `data-clock`/`data-callout` still parse to their node kinds with legal attrs; `<script>` bodies parse via `new Bun.Transpiler().transformSync` (parse-only, never executed); `<style>` survives `scopeCss` with balanced braces.
- **ids**: inventory author ids before (classified `modeled|frozen|shell` via `prepareDoc` relocation) + author `data-*` + `href="#…"` anchor targets; diff after save as multisets; exempt op-declared `deletes[]`. Report classifies losses by region — the honest #83 tracker. Add new corpus category `tests/e2e/corpus/identity/` (~3 fixtures: ids on headings/cells/boxes, a TOC of anchors, ids inside frozen SVG as survives-control), each with a normal `<!--corpus …-->` directive so the Playwright suite adopts them too.
- **contrast**: pure-TS compositing in `checks/css.ts` (doc `<style>` CSSOM + inline styles; cascade w/ simple specificity; alpha composite up the ancestor chain; one-level `var(--x)`; luminance math lifted from `tests/e2e/sidebar.spec.ts:85-91`; threshold 4.5). Unresolvable (gradients/images/opacity stacking) → `skip` with reason, never a guess. **Advisory by default** on corpus runs; hard-fail inside golden tasks whose op touches color; `--strict-contrast` promotes globally. (Playwright-based contrast rejected: the product loop must score a proposal string without mounting the app.)
- **expectations.ts**: central explicit per-fixture xfail pins (no globs; never fixture comments — fixtures are round-trip inputs), each with reason + issue ref.

**Gate C:** CLI exits 0 on `corpus/schema`. **Gate D:** ids check red on identity fixtures for the modeled-region reason; corpus e2e still green; unit tests (contrast WCAG vectors, ids diff, xfail accounting) green.
**Gate E — THE phase gate:** full-corpus run → pin every red explicitly → `--update-baseline` commits `baseline/baseline.json` → `bun verifier/cli.ts` exits **0** on today's app with the honest red inventory visible as xfails.

### Step 3 — Golden tasks: `verifier/golden/`

`golden/{types.ts, ops.ts, tasks.ts, run.ts, fixtures/}` mirroring the experiments contracts. Each `GoldenTask` = source doc (corpus path) + human `instruction` (doubles as the Phase-2 AI prompt) + deterministic scripted `Op` (replaceText, setNodeAttr, insertBlock, deleteBlock, moveBlock, sortTable, wrap/unwrapMark, sequence) + `deletes?[]` + deterministic `Expectation[]` (savedContains, nodeText, nodeAttr, tableDims, columnOrder, countNodes, byteIdenticalRegion, markPreserved) + optional non-gating LLM-judge axes (via `server/providers.ts getProvider()` — safe import).

Runner: prepareDoc → htmlToDoc → apply op on headless `EditorState` → docToBody → serializeDoc → task expects **plus all four checks** on the edited doc; jsonl append for crash safety.

**Human in the loop (three points, never per-run):** (1) Ben reviews all task instructions + expected outcomes before they're locked (part of Gate F); (2) `run.ts --review [n]` emits an HTML review sheet (source, instruction, before/after render, diff) for n random tasks — Ben eyeballs ~5 at baseline (doubles as Layer-3 diff-readability evidence); (3) a human look is required whenever a task is added/changed or deterministic checks and the LLM judge disagree.

21 tasks spanning: cell edits (2), prose/mark edits (basic, across-marks, classed heading, inline-style color w/ contrast hard-gate, styled-span-heavy, deco-span survival), block ops (insert, delete-section w/ deletes, move, multi-block restructure), table sort, task-list toggle+add, callout kind change, clock tz edit, frozen-block byte-identity, script preservation, id-anchor-critical (**xfail #83**), id-delete-one-keep-rest (**xfail #83**), head/template integrity. New fixtures: `golden/fixtures/callout-clock.html`, `corpus/identity/{anchors-toc,deco-dots,+1}.html`.

**Gate F:** golden runner exits 0 with id-class tasks xfailed; two consecutive runs identical (determinism); Ben has signed off on the task set and spot-checked ~5 rendered outcomes via `--review`.

### Step 4 — Skill: `.claude/skills/fidelity-verify/`

`SKILL.md` + append-only `failures.log`. SKILL.md: when to run (changes to engine/editor/lib/safe-html/fixtures; before landing AI features); memory protocol (tail failures.log + GOTCHAS before running); commands; result glossary incl. **xpass ⇒ un-pin in expectations.ts + `--update-baseline` in the same commit**; failure-log line format `date | check | file | op | state | detail | commit` (paths only for gitignored `real-career/`); gotcha promotion rule (same check×root-cause ≥2 times, or >15-min diagnosis → promote to GOTCHAS bullet). Seed GOTCHAS with spike-found happy-dom divergences; seed failures.log with baseline reds.

**Gate G:** invoke `/fidelity-verify` in a fresh session — reads memory, runs both runners, appends correctly.

### Step 5 — Wrap-up

`git diff` touches only `client/engine.ts`, `client/editor.ts` (shrink), `verifier/`, `tests/`, `.claude/` — no id-minting, no server/UI changes. Commit, push branch. Update wiki status flag. Retro note: what the baseline red inventory says about Phase 2 priorities (the #83 fix + id-minting design is the first Layer-1 work item).

## Verification

- Refactor safety: corpus e2e (real saved bytes + idempotence) green before/after; app boots and saves a real fixture via `./dev.sh`.
- Verifier correctness: unit tests for contrast math (known WCAG vectors), ids diffing, xfail/xpass accounting; Gate B parity spike against Playwright-captured saves.
- Phase gate: `bun verifier/cli.ts` exit 0 with committed baseline; `bun verifier/golden/run.ts` exit 0, deterministic across two runs.

## Out of scope (next plan-mode sessions per playbook)

- **Phase 2 tracer bullet:** `setText` end-to-end (MCP → validate → verify → structural diff → gate → surgical save) + the id-minting scheme the baseline red inventory motivates.
- **Phase 3 tournament:** D1 (op granularity) + D4 (context payload), graded on these golden tasks.
- **Phases 4–5:** fuzz-until-dry on the engine, board burn-down, Stop-hook enforcement.
