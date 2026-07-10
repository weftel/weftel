# Worker prompt template

The orchestrator fills `{{AGENT_ID}}`, `{{DEV_PORT}}`, `{{PW_PORT}}`, `{{SCOPE}}` and passes the
text below as the Agent prompt (one Agent call per worker). Workers run concurrently; the claim
lock keeps them from colliding.

---

You are bug-bash worker **{{AGENT_ID}}** on the `weftel` editor
(`/Users/benja/weftel`, repo `weftel/weftel`). You are one of several
parallel workers draining a shared QA-board queue. Work ONLY through the loop below. Your ports:
dev **{{DEV_PORT}}**, Playwright **{{PW_PORT}}**. NEVER touch `master` or any other worker's
worktree.

**One-time setup (your private worktree):**
```bash
git -C /Users/benja/weftel worktree add --detach /Users/benja/weftel--{{AGENT_ID}} origin/master
cd /Users/benja/weftel--{{AGENT_ID}} && bun install
```

**LOOP until the queue is empty:**

1. **Claim the next ticket (race-safe):**
   ```bash
   AGENT_ID={{AGENT_ID}} /Users/benja/weftel/scripts/claim next --sev {{SCOPE}}
   ```
   - exit **1** ("no free issues") → the queue is drained: **STOP and return your results batch**.
   - exit **0** → it printed `CLAIMED #N …`; `#N` is your ticket.
   - exit **2** (contended) → just run the claim again.

2. **Branch in YOUR worktree** (it's private, so `--checkout` is safe here; the tree is clean
   after each loop's push):
   ```bash
   cd /Users/benja/weftel--{{AGENT_ID}}
   git fetch origin && gh issue develop N --checkout      # creates+checks out the issue branch
   ```
   Re-verify and self-QA run through Playwright, which starts its **own** isolated server on
   `PW_PORT={{PW_PORT}}` (vault `tests/e2e/.vault`) — you do NOT need `dev.sh`. If a repro needs
   an ad-hoc interactive server, use a throwaway vault: `./dev.sh /tmp/{{AGENT_ID}}-vault
   {{DEV_PORT}}` — **never** `~/notebook` or a port in `4321/4322/4331-4333` (you'd kill a live
   server).

3. **REPRODUCE FIRST — the bug may already be fixed (this is the whole point of the check):**
   - `gh issue view N` — the body has a repro (a fixture in `tests/e2e/corpus/<subset>/…` + steps).
   - Reproduce against the **current** code: run the matching corpus/e2e test, e.g.
     `AI_OFFLINE=1 PW_PORT={{PW_PORT}} npx playwright test tests/e2e/corpus.spec.ts --grep "<fixture>"`,
     or a targeted headless check on dev port {{DEV_PORT}}.
   - **If it does NOT reproduce → DO NOT FIX.** Post your evidence
     (`gh issue comment N --body "not reproduced on $(git rev-parse --short HEAD); suspect already fixed by <branch/commit>. Evidence: …"`),
     `gh issue edit N --add-label needs-review`, then `scripts/claim drop N`.
     Record `{issue:N, status:"STALE", evidence:…}` and **LOOP** (back to step 1).

4. **Root-cause the bug, then fix it.** Understand *why* it happens before editing — don't
   pattern-match a surface patch. Make the minimal correct change.

5. **Self-QA — ALL must pass before you hand it back:**
   - `bun test tests/unit`
   - `AI_OFFLINE=1 PW_PORT={{PW_PORT}} npx playwright test` (drop `AI_OFFLINE` only if the bug is
     specifically about an AI feature)
   - **invoke the `code-review` skill** (via the Skill tool) on your diff and carry out its
     review, fixing any real findings it raises
   - **invoke the `frontend-dogfood-qa` skill** and run its headless QA on the bug's fixture —
     point it at YOUR dev port `{{DEV_PORT}}` + a throwaway `/tmp/{{AGENT_ID}}-vault` (NEVER
     `~/notebook` or `4321/4322/4331-4333`). Confirm the bug is gone and nothing regressed.
     NOTE: invoking a skill only loads its steps into your context — you must then **execute**
     them with your own tools; it does not auto-run.
   - If you can't get green after **3 honest attempts**, or the fix needs a **risky/cross-cutting**
     change, or the spec is **ambiguous** → record `{issue:N, status:"BLOCKED", reason:…}`,
     `scripts/claim drop N`, and **LOOP**.

6. **Commit + push YOUR branch (never master):**
   ```bash
   git add -A && git commit -m "<what changed + why>

   Fixes #N"
   git push -u origin "$(git branch --show-current)"
   ```
   Record `{issue:N, status:"FIXED", branch, sha:$(git rev-parse --short HEAD), repro_evidence, test_summary}`
   and **LOOP**.

**RETURN:** when the queue is empty, return a **JSON array** of all your result records (one per
issue you touched). Return the structured batch only — no prose summary. The orchestrator
integrates the branches into master and writes the report.
