---
name: fidelity-verify
description: >
  Run the document-fidelity verifier (round-trip, id survival, validity, contrast) and the
  golden co-authoring tasks, diff against the committed baseline, and log every failure to
  the append-only memory. Invoke BEFORE claiming any change to client/engine.ts,
  client/editor.ts, client/lib.ts, safe-html.ts, or corpus fixtures is done, before landing
  AI-edit features, or when a corpus e2e goes red. Evidence, not assertion: nothing is
  "done" without a green run attached.
---

# fidelity-verify

## Memory protocol — read BEFORE running

1. `tail -30 .claude/skills/fidelity-verify/failures.log` — recent failure history.
2. Read the GOTCHAS section below. If a fresh failure matches a gotcha, run its fast
   diagnostic first instead of re-deriving the root cause.

## How to run

```
bun verifier/cli.ts                            # full corpus, all four checks
bun verifier/cli.ts tests/e2e/corpus/schema --check roundtrip,ids   # focused
bun verifier/cli.ts --json                     # machine-readable RunReport
bun verifier/cli.ts --update-baseline          # refresh verifier/baseline/baseline.json
bun verifier/golden/run.ts                     # 22 golden co-authoring tasks
bun verifier/golden/run.ts --review 5          # + HTML before/after sheet for human eyes
bun test tests/unit                            # engine spike + verifier unit tests ride along
```

No server needed — never `bun server.ts`. The browser-truth backstop is
`npx playwright test tests/e2e/corpus.spec.ts` (slower; run when engine/editor code changed).

## Reading results

- **pass / fail** — self-evident; any non-advisory fail = the change is NOT done.
- **xfail** — known-red, pinned in `verifier/expectations.ts` with reason + issue. Green.
- **xpass** — a pinned bug got FIXED. Required action, same commit: remove the stale pin
  from `verifier/expectations.ts` AND run `bun verifier/cli.ts --update-baseline`.
- **skip** — the check couldn't judge (reason attached). Normal for contrast on gradient/
  color-mix docs; investigate only if a previously-judged file starts skipping.
- **contrast (advisory)** — reported, non-gating on corpus runs; hard-gates inside golden
  tasks whose op touches color. `--strict-contrast` promotes globally.

## Failure protocol — append AFTER every failure, BEFORE fixing

One pipe-delimited line per failure occurrence; past lines are never edited:

```
2026-07-10 | check=ids | file=tests/e2e/corpus/identity/anchors-toc.html | op=roundtrip | state=fail | detail=lost 5 ids region=modeled | commit=060d4c8
```

For gitignored personal fixtures (`real-career/`): paths only, never content.

## Gotcha promotion rule

When the same (check × root cause) appears **≥2 times** in failures.log, or one diagnosis
cost more than ~15 minutes, promote it to a GOTCHAS bullet: root cause + fastest
diagnostic. The log is history; GOTCHAS is scar tissue.

## GOTCHAS

- **happy-dom CSSOM rejects whole style blocks containing modern CSS fns** (`color-mix()`,
  `oklch()`): `el.style.cssText === ""` even though `getAttribute("style")` is intact.
  Anything reading `el.style.*` headless silently loses values Chromium keeps. Fast
  diagnostic: `bun -e` probe reading both accessors on the failing span. Never resolve
  styles via CSSOM in verifier code — parse the raw attribute string (see checks/css.ts).
- **TipTap TextStyle defaults `mergeNestedSpanStyles: true`** — parse MUTATES a nested
  span's style attr (child gains parent's color). FIXED at phase-2 gate J
  (`StyledTextStyle.configure({ mergeNestedSpanStyles: false })` in engineExtensions;
  browser guard: tests/e2e/style-shorthand.spec.ts). The surviving first-save xfail class
  is style-STRING normalization only: headless happy-dom CSSOM reformats + drops modern
  fns; the browser rewrites styled-box strings hex→rgb once (#102). Fast diagnostic:
  word-diff engine save vs `tests/e2e/.vault/corpus_idem__*` artifact.
- **happy-dom drops whitespace-only text nodes in frozen (rich-block) subtrees** — frozen
  byte-identity holds only modulo `>\s+<` collapse headless; the browser path is
  byte-faithful (tests/e2e/js-roundtrip.spec.ts). Compare with the `norm()` helper in
  golden/run.ts, not raw bytes.
- **The live editor appends a trailing empty `<p></p>`** after a doc-final non-paragraph
  block; headless generateJSON does not. Normalize before headless↔browser byte parity.
- **Corpus directive comments poison hand-rolled regex normalizers** (`->` inside attrs,
  literal `<style>` in the stress string). Always strip comments FIRST — copy
  corpus.spec.ts `visibleText` verbatim, don't re-derive it.
- **Human-facing artifacts meant to be read IN WEFTEL must not rely on iframes** (or
  script/object/embed): `stripActive` removes them from the live render with no
  placeholder (#94), so an iframe-built page reads as empty panes in the app. Embed
  content as scoped divs via `scopeCss` instead — see the review-sheet generator in
  `verifier/golden/run.ts`.
- **Style-attr shorthands longhand-expand through the headless serialize path** (happy-dom
  CSSOM: `border-top:4px solid X` → three longhand decls; flex → flex-grow/shrink/basis).
  Never assert on shorthand strings in saved bytes — assert on stable VALUES (`#c9302c`).
  Also a suspected contributor to the #93 first-save-normalization class on inline-styled
  docs (T1 parses the authored string, T2 parses the expansion).
- **#83 xfail inventory lives in `verifier/expectations.ts`**, one explicit pin per
  fixture — never glob, never annotate fixtures themselves.
