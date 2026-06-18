# CLAUDE.md

Guidance for Claude Code agents working in this repo (the local-first notes editor — Bun + TipTap).

## The quality board lives in GitHub Issues

The launch-readiness QA board is **GitHub Issues in this repo** (`Benzales/note-editor-spike`), migrated 2026-06-17 from the wiki's `quality-gaps.html` — a single HTML file that hit file-write races once multiple agents wrote to it. Issues carry `sev:{bug,gap,polish,known,sweep}` + `status:{open,fixed,deferred,accepted,clean}` + a `qa-board` label. Board view: https://github.com/users/Benzales/projects/1 (Board layout, grouped by the built-in **Status** field — Backlog / Active / In-progress / Done). Closed issues auto-move to Done via the project's "issue closed → Done" workflow.

Writes are race-free because GitHub serializes them server-side — **never coordinate work by hand-editing a shared board file.**

### Pulling work

- **See the active queue:** `gh issue list --search 'label:qa-board -label:status:deferred no:assignee' --state open` (or `scripts/claim board` for who's already working on what)
- **Claim a ticket (race-safe):** `AGENT_ID=<your-name> scripts/claim next` — atomically claims the next free issue and moves its board card to In-progress, printing the number. Variants: `scripts/claim <N>` (a specific issue), `scripts/claim drop <N>` (release it), `scripts/claim board` (status). The helper uses GitHub comment IDs as a lock, so it's safe even when every agent runs as the same account — **use it instead of a bare `gh issue edit --add-assignee` during bug bashes.**
- **Branch:** `gh issue develop <N> --checkout` — work in a dedicated git worktree so parallel agents don't collide on the working tree.
- **Report progress:** `gh issue comment <N> --body "..."`
- **Finish:** put `Fixes #<N>` in the PR body so the issue auto-closes on merge.
- **New finding:** `gh issue create --label qa-board --label sev:<x> --label status:open --title "[area] ..." --body "...repro..."` — the project's **Auto-add** workflow (filter `is:issue label:qa-board`) puts it on the board in **Active** automatically; no `item-add`/`item-edit` needed. Do not reopen the old HTML board.

### Claiming when many agents run at once

Self-assigning (`gh issue edit <N> --add-assignee @me`) only disambiguates agents if each authenticates as a **different GitHub account**. If every agent runs as `Benzales`, the assignee field can't tell them apart — claim via a unique per-agent label or comment, then re-read before starting work. GitHub has no cheap compare-and-swap, so the pattern is low-collision + detect + retry, not a hard lock.
