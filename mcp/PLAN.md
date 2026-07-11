# Co-authoring Phase 2 — setText tracer bullet + id-minting scheme

## Context

Phase 1 (branch `co-authoring/phase1-verifier`, PR #99) built the grader: pure engine (`client/engine.ts`), fidelity verifier CLI, 26 golden tasks, fidelity-verify skill. Phase 2 builds the thinnest end-to-end co-authoring slice per the playbook: **setText — MCP → validate → verify → structural diff → gate → surgical save** — plus the id work the baseline red inventory motivates (#83), and clears the decision debt feeding it (#93, #95, the gate-F visual-judge addendum). Gate for the phase (playbook): *the walkthrough works on one real case*.

Branch: `co-authoring/phase2-tracer` off phase 1. Plan file copied to `mcp/PLAN.md` (playbook: phases spanning sessions write the plan to a repo file).

**Decisions locked with Ben (2026-07-10):**
- **Id policy: mint on co-authoring touch.** Author ids/data-* always preserved (#83 fix). Nodes without ids get deterministic provisional ids at MCP read; an id persists to disk only when an approved edit touches that node. Docs never co-authored stay byte-pristine.
- **#93: fix, evidence-gated** — `mergeNestedSpanStyles: false`; land only if corpus e2e + golden + verifier green; separate spike on whether shorthand longhand-expansion mutates saves in real Chromium.
- **#95: clock removal is step 0** (scope in the issue: engine/editor/lib/golden/validity + data-clock degrade migration, data-calendar precedent in `prepareDoc`).
- **Visual judge: build in Phase 2, non-gating** until it re-detects the two known findings (#94 iframe-blank-panes, item-outside-list), then promoted.
- Already locked in Phase 0 (don't re-litigate): D2 MCP surface + deny-rule enforcement; D3 gate = diffApprove spine, every hunk maps to exactly one node op; D5 routing heuristic.

## Architecture (tracer topology)

```
Claude Code (user's, in vault) ──stdio MCP──► mcp/server.ts (thin Bun process;
    registers happy-dom via verifier/engine-io import; imports client/engine + client/ops;
    computes outline, provisional ids, headless op-apply, 4 fidelity checks, panes)
        │ HTTP localhost
        ▼
server.ts (+in-memory proposal queue: server/proposals.ts, 5 small routes)
        │ polled every 2s by the open editor tab for that file
        ▼
client/editor.ts — THE single writer while a tab is open:
    re-validates preconditions vs live doc → diffApprove (+summary line) →
    on approve: ONE PM transaction (setText + persist minted id) → markEdited → flushSave
    → POST decision → the blocked MCP tool call resolves
```

- **The editor applies the op, never the MCP process.** There is no conflict check / watcher / push channel today — an external write to an open doc is silently clobbered by the next autosave. Routing the approved op through the live PM doc makes it compose with unsaved user edits and reuses the whole save/retry/beforeunload machinery.
- **No tab open ⇒ reject** with `no_live_tab: … open it in weftel and retry`. Headless direct-apply would bypass human-always-approves and reintroduce the write race. Queued-until-open is Phase 3.
- **"Surgical save"** = op-scoped model mutation; the file write stays whole-file via the verified round-trip (that's what the verifier certifies). Post-#83/#93, the on-disk diff is minimal.

**Scope rationale (why setText-only, why MCP at all):**
- setText is the whole op vocabulary for this phase by design — the playbook's tracer bullet proves the pipeline on one op. The full action space (`replaceProseRange`, `setCell`, `insertBlock`, `moveBlock`, `transformRichBlock`, `setBlockKind`) is specced in the sketch; its granularity is D1, settled by the Phase 3 tournament on the golden tasks. Big structural edits arrive there, with the D3 gate escalating to before/after panes for multi-block proposals.
- `weftel_read_doc` is the addressing layer, not a file read: provisional ids are minted at read time keyed to docVersion, so it's the only source of valid op targets (and far cheaper context than raw bytes). Reading raw files stays allowed; only writes are fenced.
- Ops-as-only-mutation-path is enforced (step 7 deny rules), not offered: direct string-edits are the #83 corruption class made inexpressible, direct file writes race the open tab's autosave, and the gate renders a node-scoped visual diff instead of HTML source. Fidelity + write-safety first; gate UX third.

## Steps and gates (H→P; evidence is runnable, `/fidelity-verify` at H, I, J, and phase end)

### Step 0 — #95 clock removal — **Gate H**
Scope per issue: delete ClockBlock from `client/engine.ts` (node, engineExtensions entry, EngineNodeViews), clockView/slash-item/cmdk routing from `client/editor.ts`, `parseClockTz`/`TZ_ALIASES` from `client/lib.ts`, `div[data-clock]` assertions from `verifier/checks/validity.ts`, `clock-tz-edit` golden task + clock half of `fixtures/callout-clock.html`. Migration in `prepareDoc` before `frameContainer()`: `<div data-clock data-tz="X">` → `<p>clock (removed feature) · X</p>` (data-calendar precedent). Keep `data-clock` in `APP_DATA_HOOKS`; drop the `data-tz` companion rule in `checks/ids.ts`. New corpus fixture `provenance/clock-migration.html` with an `editTarget` directive so saved bytes prove the degrade.
**H:** all four suites green, zero clock refs (`grep -ri clock client/ verifier/` modulo migration), migration fixture passes.

### Step 1 — #83 preservation + id scheme + dedupe — **Gate I**
- **Preservation (flips the pins):** in `PreserveAttrs` (engine.ts:138) add alongside `class` for the same 13 types: `id` (`keepOnSplit: false`, parse/render mirroring class) and `data: { ...dataAttrs().data, keepOnSplit: false }` (reuses APP_DATA_HOOKS exclusion; dataAttrs is called at extension-load time so its line-178 position is fine). Add `id` to `sboxAttrs()`.
- **Id scheme:** format `w-` + 4 base36 chars. `mintIds(doc, docVersion)` in `client/ops.ts`: deterministic — `fnv1a64(docVersion + ":" + ordinal)` windowed to 4 chars, bump window on collision with any existing id. Same file bytes ⇒ same ids in any process; no id map is ever exchanged. Persist-on-touch only: the approved-apply transaction sets the touched node's id; everything else stays pristine.
- **Dedupe:** `IdDedupe` editor-only extension (appended after `engineExtensions()` in editor.ts, no schema impact): `appendTransaction` — when a transaction *increases* an id's count, null the id on later-in-document duplicates (null, don't re-mint; a human paste isn't a co-authoring touch). Pre-existing author dupes from disk untouched. Unit tests: split (keepOnSplit), paste-dupe (nulled), load-with-dupes (no mutation).
- **checks/ids.ts needs no change:** `lost()` diffs before-side keys only, so minted ids (after-only) can't report as losses; minted ids are real `id` attrs, not data-*, so no APP_DATA_HOOKS entry.
- **Pin choreography (same commit):** 5 `ids` pins in `verifier/expectations.ts` xpass → delete; all golden `expectFail` ids pins xpass → delete; `--update-baseline`.
**I:** verifier exit 0 with zero ids pins; golden exit 0 with zero ids xfails; corpus e2e green; dedupe units green; manual spot: the #83 repro class (JS-driven doc, e.g. `~/notebook/job-apps.html`) survives Edit→Interact with ids intact. `<thead>` collapse, if still present, files separately.

### Step 2 — #93 flip + shorthand spike — **Gate J** (parallel with K, L)
- Flip: `TextStyle.configure({ mergeNestedSpanStyles: false })` where used in `engineExtensions()`. Evidence gate: corpus e2e + golden + verifier green → the 7 `FIRST_SAVE_NORM` roundtrip pins xpass → remove + `--update-baseline`. If some fixtures stay red (shorthand class), re-pin survivors with updated reason — don't hold the flip hostage.
- Spike as spec: `tests/e2e/style-shorthand.spec.ts` — authored `style="border-top:4px solid #c9302c;flex:1"` on a styled box, one unrelated edit, assert `window.__serialize()` keeps the shorthand verbatim in real Chromium. Expands → engine fix follow-up (style attrs via getAttribute passthrough, never CSSOM). Headless-only → keep GOTCHAS pin, spec stays as regression guard.
**J:** pins removed/re-pinned honestly, baseline refreshed, verdict recorded in `mcp/PLAN.md` + comment on #93.

> **Gate-J verdict (2026-07-10):** flip landed — the #93 value mutation (nested span gains
> parent color) is gone in real Chromium (guard: `tests/e2e/style-shorthand.spec.ts`).
> ZERO of the 7 roundtrip pins xpassed: the surviving T1≠T2 class is style-STRING
> instability, re-scoped and re-pinned — headless happy-dom CSSOM reformats strings and
> drops modern fns (color-mix survives in Chromium, proven); the browser separately
> rewrites styled-box strings hex→rgb on first save (**#102**, pre-existing, F40-class,
> pinned live via test.fail). Fix direction for #102: getAttribute-passthrough render,
> never CSSOM. One golden pin added (head-template-integrity on adamw — the flip stopped
> mergeNestedSpanStyles from accidentally stabilizing the headless pass).

### Step 3 — hoist ops: `client/ops.ts` — **Gate K** (parallel with J, L)
Move `schema`, `findNode` (innermost-match comment intact), `findText`, `topLevelBlock`, `applyOp` from `verifier/golden/ops.ts` (which becomes a re-export shim; `Op`/`NodeMatch` move to ops.ts, golden/types.ts re-exports). Header mirrors the engine invariant: imports only `./engine` + `@tiptap/*`, never `./editor`.
New in `client/ops.ts`: `Op` gains `{ kind: "setText"; nodeId: string; text: string }`; `fnv1a64`, `docVersionOf(rawBytes)`, `OutlineBlock { id, authorId, kind, depth, path, text≤120, textHash, pristine }`, `mintIds`, `outline`, `findById(doc, id, minted?)`, `validateOp`. setText semantics (documented in the tool description): replaces the block's entire inline content with plain unmarked text — richer ops are Phase 3. Add a golden task doing setText-by-id on `anchors-toc.html`.
**K:** new unit tests (mint determinism across two processes, collision bump, findById, setText apply); golden green through the shim; verifier green.

### Step 4 — proposal queue: `server/proposals.ts` + routes — **Gate L** (parallel with J, K)
`Proposal { id, file, op, baseVersion, target { nodeId, authorId, nodeType, path, textHash, preview }, summary, beforeNodeHtml, afterNodeHtml, verify[], state: pending|approved|rejected|stale|expired, reason?, createdAt, decidedAt?, ttlMs=120000 }`. `ProposalQueue { propose, forFile (heartbeat), get, decide (first wins), bye, sweep, isLive (65s window) }`.
`server.ts` routes beside `/save`, same `okNotePath`/`sameOrigin` guards: `POST /api/propose` (rejects `no_live_tab`), `GET /api/proposals?file=` (editor poll + heartbeat), `GET /api/proposal?id=` (MCP poll), `POST /api/proposal-decision`, `POST /api/proposals-bye` (unload beacon). `sweep()` on every proposal-route hit. In-memory is correct for the tracer: restart ⇒ MCP mid-poll 404 ⇒ `server_restarted` guidance.
**L:** queue unit tests + integration test that spawns `bun run server.ts <tmp-vault>` as a subprocess and drives the routes over HTTP (never import server.ts).

### Step 5 — editor gate wiring — **Gate M**
In `client/editor.ts` (~120 lines, after the save system): 2s poll while a note is open + poll on focus (stale-tab-guard pattern); `sendBeacon` bye on unload; FIFO one-gate-at-a-time; 1.5s typing-idle guard before surfacing the modal (diffApprove captures Enter/Esc).
Precondition ladder vs the LIVE doc: (1) scan for `attrs.id === nodeId`; text drifted (`fnv1a64(textContent) !== textHash`) ⇒ stale `text_drifted`; (2) provisional id: walk `target.path`, accept iff type + textHash match; (3) unique nodeType+textHash scan; (4) else stale `node_not_found` with re-read guidance. `baseVersion` mismatch alone is deliberately NOT a hard gate — unsaved edits elsewhere must not strand a valid node op.
Panes recomputed from the live located node (proposal HTML is fallback) — the gate always shows truth; single-node op ⇒ assert exactly one non-same hunk (the D3 invariant). Gate: `diffApprove(before, after, "prose", { title: "Claude proposes an edit", summary, css: RICH_STYLES })` — add `summary?: string` to `DiffApproveOpts` (~8 lines, muted line under the header, no behavior change when absent).
On approve: one transaction (persist minted id iff `!authorId` + replace inline content), `markEdited()`, `await flushSave()`; POST decision only after save returns true (save failure ⇒ ttl expiry ⇒ honest `approval_timeout`). Reject ⇒ `human_rejected`.
**M:** `tests/e2e/proposal-gate.spec.ts` — POST proposal via Playwright request (sameOrigin passes no-Origin), gate appears with summary, Accept ⇒ decision approved + vault file has new text AND `id="w-…"` on exactly the touched node; Reject path; pre-edited target ⇒ stale `text_drifted`, gate never shows.

### Step 6 — MCP server: `mcp/server.ts` + `mcp/tools.ts` — **Gate N**
`package.json`: add `@modelcontextprotocol/sdk ^1.29.0` as a direct dep (present in node_modules as peer today); script `"mcp"`. `mcp/server.ts`: `import "../verifier/engine-io"` first (registers happy-dom, guard confirmed at engine-io.ts:5), McpServer + StdioServerTransport; env `WEFTEL_URL` (default `http://localhost:4321`), `WEFTEL_APPROVAL_TIMEOUT_MS` (120000).
- **`weftel_read_doc { file }`**: `.md` ⇒ `md_not_supported` (tracer is HTML-only); read bytes → `prepareDoc → htmlToDoc → outline()` ⇒ `{ file, docVersion, liveTab, blocks: [{ id, authorId, kind, depth, text, pristine }] }`. Description explains provisional `w-` ids and setText's plain-text semantics.
- **`weftel_set_text { file, nodeId, newText, expectedVersion? }`**: version check ⇒ `stale_doc`; `findById` miss ⇒ `node_not_found`; headless apply + serialize; **verify-in-pipeline** — roundtrip/validity/ids checks on the proposed bytes, any fail ⇒ reject pre-gate with `verify_failed` + per-check detail (contrast advisory: setText never touches color, mirroring golden `contrastGate` semantics); build proposal → `POST /api/propose`; poll 500ms to timeout. Terminal states mapped to agent-readable strings: `approved` (+newVersion), `human_rejected` (don't retry; ask the user), `stale` (re-read and retry), `approval_timeout`, `server_restarted`.
**N:** `tests/unit/mcp-tools.test.ts` (pipeline against fixtures, no transport) + `tests/e2e/mcp-tracer.spec.ts` — full stack: spawn server.ts on temp vault, spawn mcp/server.ts with the SDK's stdio Client, read_doc → set_text, Playwright page approves; assert error strings for `no_live_tab`/`stale_doc`/`node_not_found`.

### Step 7 — enforcement (minimal, documented) — **Gate O** (parallel with P)
Ship examples + README, don't auto-install: `mcp/examples/mcp.json` (vault `.mcp.json` launching `bun run …/mcp/server.ts`), `mcp/examples/vault-settings.json` (vault `.claude/settings.json` permission **deny** rules for Edit/Write on `**/*.{html,htm,md}` — declarative beats a PreToolUse hook for the tracer; the hook variant that emits a steering message is documented as the upgrade path). `mcp/README.md`: setup, single-writer contract, no-tab behavior, timeouts, trade-offs.
**O:** live Claude Code session in a test vault: Edit denied; text-change request flows read_doc → set_text → gate in the open tab → approve → file updated with minted id. Transcript attached to the PR.

### Step 8 — dual-renderer visual judge (non-gating) — **Gate P** (parallel with N, O)
`verifier/golden/visual.ts` — standalone bun script (model calls don't belong in the deterministic e2e suite), playwright **as a library**, spawns `bun run server.ts <tmp-vault>` subprocess. Per golden task: before/after saved bytes → render 4 ways (app `/?file=` waiting `.ProseMirror`; raw `file://`) × (`emulateMedia colorScheme light|dark`) → screenshots to `verifier/golden/_visual/<task>/`. Judge via **claude-agent-sdk `query()`** with screenshot file paths + `allowedTools: ["Read"]` (BYO-subscription auth, CloudProvider precedent — no API key requirement enters the repo). Two questions per task: does after match the instruction; do the renderers agree. Verdicts → `verifier/golden/visual-report.jsonl`; always exit 0 unless `--gate`.
Promotion mechanics: `verifier/golden/visual-probes/` archives reproductions of #94 (iframe-panes doc: renders raw, blank in app) and the item-outside-list before/after; `--probes` runs only these and the judge must flag both. Both re-detected on 3 consecutive runs ⇒ flip the wrapper to `--gate`, recorded in `mcp/PLAN.md`.
**P:** `--probes` flags both archived findings; full run produces jsonl + screenshots; zero gating effect on existing suites.

## Dependency spine

H → I → {J ∥ K ∥ L} → M → N → {O ∥ P}. I must precede M/N (verify-in-pipeline's ids check would reject proposals on id-bearing docs until preservation lands).

## Risks (ranked) & mitigations

1. **Autosave-clobber race** — single-writer topology; MCP never writes files; decision POSTed only after `flushSave()` true.
2. **happy-dom divergence in the MCP process** — headless side only computes previews + verify results; applied truth is the browser-side live doc; divergences fail safe (false pre-gate reject, never a corrupt save). New ones → GOTCHAS per the skill rule.
3. **Provisional-id staleness** — deterministic minting keyed to docVersion + node-level relocation ladder; worst case is a spurious re-read, never a mis-targeted edit.
4. **Gate granularity for setText** — node-scoped panes, one hunk = one op asserted, summary line states exact old→new.
5. **In-memory queue across restarts** — accepted; `server_restarted` guidance; ttl sweep kills zombie gates.
6. **mergeNestedSpanStyles flip breaking real docs** — evidence-gated, one-line revert, residual reds re-pinned.
7. **Background-tab timer throttling** — 65s liveness window vs 2s poll; bye-beacon on unload; 120s ttl bounds the worst case.

## Critical files

- `client/engine.ts` — clock removal + migration; PreserveAttrs/sboxAttrs id+data; TextStyle flip
- `client/ops.ts` (new) — hoisted ops + setText/mintIds/findById/outline; `verifier/golden/ops.ts` → shim
- `client/editor.ts` — poller, precondition ladder, gate wiring, apply+save; IdDedupe
- `client/diff-viewer.ts` — `summary` opt
- `server/proposals.ts` (new) + `server.ts` — proposal routes beside `/save`
- `mcp/{server.ts,tools.ts,README.md,examples/}` (new); `package.json` (+`@modelcontextprotocol/sdk`)
- `verifier/expectations.ts` + `verifier/baseline/baseline.json` — pin removals at I and J
- `verifier/golden/{tasks.ts,visual.ts,visual-probes/}` — clock task removal, setText-by-id task, judge
- `tests/`: unit (dedupe, mint, ops, proposals, mcp-tools), e2e (`proposal-gate`, `mcp-tracer`, `style-shorthand`, clock-migration fixture)

## Verification

- `/fidelity-verify` at gates H, I, J and phase end (append failures per protocol; xpass ⇒ un-pin + baseline same commit).
- Corpus e2e (`npx playwright test tests/e2e/corpus.spec.ts`) at every engine-touching gate; app boot via `./dev.sh` spot-checks at I (job-apps Interact) and O (live demo).
- The phase gate is O + N together: the tracer walkthrough works on one real case, with the transcript as evidence.

## Bookkeeping

- Copy approved plan → `mcp/PLAN.md`; update wiki status flag in `~/weftel-wiki/co-authoring-layer-sketch.md` (phase 2 started, branch, plan path).
- Issues: close #83 (preservation + dedupe), #93 (flip + spike verdict), #95 (removal + migration) via PR `Fixes` lines; comment the shorthand verdict on #93.
- Out of scope (next plan-mode sessions): queued-until-open proposals, richer op vocabulary + D1/D4 tournament (Phase 3), md-note support, fuzz-until-dry (Phase 4).
