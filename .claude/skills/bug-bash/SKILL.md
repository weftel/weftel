---
name: bug-bash
description: >-
  Orchestrate a parallel, autonomous bug bash over the weftel QA board
  (GitHub Issues). Turns this session into an orchestrator that fans out worker agents which
  pull open sev:bug / sev:gap tickets from a shared claim-locked queue, reproduce each bug
  before fixing it, fix it in an isolated git worktree with self-QA, and hand back a green
  branch that the orchestrator lands on master one at a time behind the full test suite.
  Before fan-out it de-dupes the queue: auto-closes near-identical duplicates and proposes
  the ambiguous "maybe related" pairs for your call. Fully autonomous; raises only genuine
  complications (can't-fix, conflict, red suite, can't-reproduce).
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

# bug-bash

Drain the open bug queue on the **weftel** editor with a team of parallel agents.
Lineage: Anthropic's **orchestrator-worker** pattern (self-contained worker tasks, explicit
boundaries, bounded fan-out) + the canonical bug-fix rule **reproduce before you fix**. Built
entirely on this repo's existing primitives — `scripts/claim` (race-safe queue lock), `dev.sh`,
the `tests/e2e/corpus/` fixtures, `/code-review`, and `frontend-dogfood-qa` — it adds no new
infrastructure.

- **Repo:** `/Users/benja/weftel` (`weftel/weftel`)
- **Board:** Projects/1, grouped by Status (Backlog / Active / In-progress / Done)
- **The session running this skill is the ORCHESTRATOR.** Workers are subagents (Agent tool).

## When to use

Invoke `/bug-bash` to drain the open `sev:bug` + `sev:gap` queue. Safe to re-run: it only
touches **open, unassigned** issues, so a clean queue produces an all-OK report and spawns
nothing. Not for *finding* new bugs (that's `frontend-dogfood-qa`) — it fixes ones already on
the board.

## Posture (fully autonomous)

Without asking, it pulls tickets, reproduces, fixes in isolated worktrees, self-QAs, and lands
green fixes **directly on master — no PRs** (every fix is one revertable `Fixes #N` commit).
It **RAISES to you** only on genuine complications:
- a fix it can't make safely (BLOCKED: 3 failed attempts / risky cross-cutting change / ambiguous spec),
- a merge **conflict** or a **red** post-merge suite (the fix is reverted, issue left open),
- a bug it **can't reproduce** (left open + flagged `needs-review` — you may have read the repro differently than the agent).

It NEVER force-merges a red suite, NEVER auto-closes a non-reproducing bug, and NEVER edits the
9 long-lived feature worktrees or your dirty main working tree.

It will, without asking, **close near-identical duplicate issues** (same root cause + same
repro + near-identical title/body) as part of the pre-flight dedup pass (Step 1.5) — closing
is reversible (reopen), so it fits the autonomous posture. It NEVER auto-closes issues that are
merely *related/overlapping*; those are surfaced as **proposed merges** for your call and left
open and un-bashed until you decide.

**Reserve an issue by assigning yourself to it.** The queue — the orchestrator's work-list AND
`scripts/claim next` — filters `no:assignee`, so any assigned issue is skipped: never claimed,
and never in the report (which only covers issues the bash worked). Self-assign = "mine —
agents, hands off." (`--issues N` and `scripts/claim <N>` are explicit overrides that bypass
this; the default autonomous run honors it.)

## Args

- `--workers N` (default **7**) — parallel workers. Drop to `5` if the machine feels loaded.
- `--scope bug,gap` (default) — severities to bash.
- `--issues 17,30,…` — bash only these (skips the dynamic queue; hand them out round-robin).
- `--no-dedup` — skip the Step 1.5 dedup pass entirely (bash the raw queue as-is).
- `--dedup-only` — run only Step 1.5 (auto-close dups, propose the ambiguous ones), then STOP
  before fan-out. Useful to tidy the board without a full bash.
- `--report-only` — dry run: print the work-list, the **proposed** dedup actions (closes +
  merges, but mutate nothing), fan-out, port map, and the filled worker prompt; **spawn
  nothing, mutate nothing.**

## Step 1 — Pre-flight (read-only)

```bash
R=weftel/weftel; S=/Users/benja/weftel
gh auth status >/dev/null || echo "RAISE: gh not authed"
"$S/scripts/claim" board
gh issue list -R $R --state open \
  --search 'label:qa-board -label:status:deferred no:assignee label:"sev:bug","sev:gap"' \
  --json number,title,labels --jq '.[] | "  #\(.number) \(.title)"'
```
Print the plan: **queue size**, **W workers**, and the **port map**. Workers must AVOID your
live/known servers (default `4321`/`4322`, worktree servers `4331-4333`) — `dev.sh` kills
whatever holds a port. Use a high, free range: worker *i* → Playwright `4460+i` (each gets its
own isolated test server via `playwright.config`'s `webServer`), integration PW `4458`; an
optional ad-hoc dev server uses `4360+i` on a **throwaway `/tmp` vault**, never `~/notebook`.
Re-check live listeners (`lsof -nP -iTCP -sTCP:LISTEN | grep ':43'`) and shift the range up if
anything in `4458-4467` is taken. If `--report-only`: also print the filled
worker prompt and **STOP**. If the queue is empty → report "nothing to bash" and stop. If auth
or the board is broken → raise, don't improvise.

## Step 1.5 — Dedup the queue (before fan-out)

Skip if `--no-dedup` or `--issues` was passed. Goal: never spend a worker on a ticket that's a
copy of another, and let you adjudicate the genuinely-ambiguous overlaps.

Pull the full open `qa-board` set (not just the no:assignee work-list — a dup may sit on an
assigned twin) with titles + bodies, and cluster by similarity:

```bash
gh issue list -R $R --state open --search 'label:qa-board' --limit 200 \
  --json number,title,body,labels,assignees
```

Judge each candidate pair on **root cause + repro steps + observed symptom**, not title wording
alone. Sort each cluster into two buckets:

- **AUTO-CLOSE (very similar / true duplicate)** — same root cause AND same repro AND
  near-identical symptom; one adds nothing actionable over the other. Pick the **canonical**
  (lowest #, or the better-written/more-evidenced one if clearly so). For each non-canonical:
  ```bash
  gh issue comment <DUP> -R $R --body "Duplicate of #<CANON> — closed by bug-bash dedup. Reopen if these are actually distinct."
  gh issue edit    <DUP> -R $R --add-label "duplicate"
  gh issue close   <DUP> -R $R --reason "not planned"
  ```
  Fold any unique repro detail or label from the dup into the canonical via a comment so nothing
  is lost. The closed dup drops out of the queue automatically.

- **PROPOSE (maybe related — needs your opinion)** — overlapping or adjacent but possibly
  distinct (same area, different symptom; one is a subset/superset of the other; unclear if a
  single fix covers both). **Do NOT close or relabel these.** Collect them as proposed merges.
  Surface them with **AskUserQuestion** when running interactively (one question per cluster:
  "Merge #A into #B / Keep both / Other"); when running unattended, leave them open, label them
  `needs-review`, and list them in the report's "Proposed merges" section. Leave proposed-but-
  undecided issues **in** the work-list (bashing a real bug is harmless even if it later merges).

Print a dedup summary line before continuing: `dedup · C clusters · X auto-closed · Y proposed`.
With `--dedup-only`, stop here after reporting. With `--report-only`, print the proposed
auto-closes + proposals and mutate nothing.

## Step 2 — Integration worktree (once)

A clean worktree off the latest `origin/master`, so your dirty main tree is never touched
(master can't be checked out twice, so start detached):
```bash
git -C "$S" fetch origin
git -C "$S" worktree add --detach /Users/benja/weftel--integrate origin/master
( cd /Users/benja/weftel--integrate && git switch -c bug-bash-integrate && bun install )
```

## Step 3 — Fan out workers

Read the sibling file **`worker-prompt.md`**. For each worker *i* in `1..W`, fill its
placeholders (`AGENT_ID=bash-i`, `DEV_PORT=4360+i`, `PW_PORT=4460+i`, `SCOPE=bug,gap`) and spawn
it with the **Agent tool**. Launch in **2 staggered waves** (ceil(W/2), then the rest) to avoid
a CPU/Ollama spike. Each worker is a drain-the-queue loop and returns a JSON batch of results.

## Step 4 — Integrate (serialized — the safety net that replaces PR review)

Collect every worker's results. For each `FIXED` record, **one at a time** (never in parallel),
in the integration worktree:
```bash
I=/Users/benja/weftel--integrate
git -C "$I" fetch origin
git -C "$I" merge --no-ff "origin/<branch>" -m "bug-bash: merge fix for #<N>"   # conflict? abort + escalate
( cd "$I" && bun test tests/unit && AI_OFFLINE=1 PW_PORT=4458 npx playwright test )
```
- **Green** → `git -C "$I" push origin bug-bash-integrate:master` (the `Fixes #N` commit lands
  on master → the issue closes → its card auto-moves to Done).
- **Conflict or red** → `git -C "$I" merge --abort` (or `reset --hard origin/master`), mark that
  issue **BLOCKED/REVERTED**, leave it open, and escalate. Continue with the rest.

## Step 5 — Report

Produce BOTH a rich HTML report (the durable artifact) and a terse in-session verdict block.

### (a) Rich HTML report

Write a single self-contained file to `/Users/benja/notes-editor-wiki/bug-bash-reports/bug-bash-report-$(date +%F).html`
(dark+light via `prefers-color-scheme`; house palette — zinc surfaces, purple accent,
green=landed / amber=stale / red=blocked+reverted; `ui-monospace` for ids/shas). Structure:
- **Intro** — a 1–2 sentence narrative ("7 workers drained N tickets in T min — X fixed and on
  master, Y need your eyes, Z backed out") + a compact stat row.
- **Triaged body**, in priority order, each issue a rich card (id chip, title, status+sev pill,
  a body line with the fix + evidence, a mono `worker · sha` source line):
  1. ⛔ **Blocked** — with reasons — FIRST and most prominent (red = couldn't fix, needs your
     call; the highest-stakes items).
  2. 🔍 **Needs your review** — stale + reverted (yellow = likely already resolved, just confirm).
  3. 🔗 **Proposed merges** — the "maybe related" clusters from Step 1.5 left for your call
     (yellow; each links both issues + a one-line "why they might be the same"). Include a
     condensed `<details>` list of the dups that were **auto-closed** (FYI, reversible).
  4. ✅ **Landed** — inside a native `<details><summary>` (condensed; FYI, already on master).

  Default order is severity-descending (red → yellow → green); only deviate if a particular run
  has a clear reason to surface something else first.
- **Outro** — an overall-reflection 💭 box.

Hard rules (these keep it renderable + Ben-annotatable):
- **JS-FREE** — no `<script>` anywhere; native `<details>` is the only collapse.
- **File-persisted 💭 notes** — each is a plain
  `<div class="tnote" contenteditable="true" data-tid="<issue#>" data-ph="your take…"></div>`
  with placeholder CSS and NO localStorage. One per Needs-review/Blocked card + one overall.
- **Hyperlink every issue** — `#N`/id → `https://github.com/weftel/weftel/issues/<N>`
  with `target="_blank"`.
- **Spacing** — always keep a visible separator between adjacent inline pieces: render
  `→ your call: Confirm…`, never `your callConfirm…`.
- Self-contained, opens from `file://`. Reference example:
  `notes-editor-wiki/bug-bash-reports/bug-bash-report-D-blend.html`.
- NOTE: the app currently renders only the first `<article>` of such multi-section docs
  (tracked as #78) — until that's fixed the report is best viewed in a browser.

### (b) Terse in-session verdict block

```
bug-bash · <N> issues · <W> workers
  dedup ......... X auto-closed (#a→#b …) · Y proposed (#c?#d …)   (skipped if --no-dedup)
  queue ......... drained (k claimed) | empty
  landed ........ #17 (sha) · #30 (sha) · …            (M fixed → master)
  stale ......... #41 → needs-review (left open)       (k flagged for you)
  blocked ....... #29 — <reason> (left open)           (k escalated)
  integration ... OK (suite green after each) | REVERTED #X — <red test>
  lost .......... #12 (claim race)                     (rare)
```
Then print the report's path + `file://` link, and list every `BLOCKED` / `REVERTED` / `stale`
row with one concrete next action.

## Step 6 — Cleanup

```bash
git -C "$S" worktree remove /Users/benja/weftel--integrate --force
git -C "$S" branch -D bug-bash-integrate 2>/dev/null
```
Leave the per-worker worktrees in place for inspection (note their paths in the report), or
remove them if the run was clean.

## What this skill deliberately does NOT do

- **No PRs, no human diff-review before landing** — by design (autonomous). The per-fix self-QA
  (`bun test` + Playwright + `/code-review` + `frontend-dogfood-qa`) plus the serialized
  post-merge suite plus per-commit revertability are the backstop.
- Never force-merges a red suite; never auto-closes a bug it couldn't reproduce; never edits the
  feature worktrees or your dirty main tree.
- Adds no infrastructure — reuses `scripts/claim`, `dev.sh`, the corpus, `/code-review`,
  `frontend-dogfood-qa`.
- Doesn't hunt for *new* bugs — it drains the existing board.
