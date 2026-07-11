# weftel co-authoring MCP — setup & contract

The agent surface of the co-authoring layer (phase-2 tracer). Your own Claude Code is the
brain; this server is the **safe body**: it exposes structured, human-gated node ops so an
agent can edit notes without the corruption classes raw file edits cause (id-stripping #83,
style mangling, autosave clobbering) and without unreadable HTML-source diffs.

## Setup (per vault)

1. Copy `examples/mcp.json` → `<vault>/.mcp.json` (fix the absolute path to this repo).
2. Copy `examples/vault-settings.json` → `<vault>/.claude/settings.json`.
3. Run weftel (`./dev.sh <vault>`), open the note you want co-authored in a tab.
4. Run `claude` inside the vault. It sees two tools: `weftel_read_doc`, `weftel_set_text`.

## The contract (why each piece exists)

- **Ops are the only mutation path — enforced, not offered.** The settings deny
  `Edit`/`Write` on note files, steering the agent to the tools (D2 in the co-authoring
  sketch: "otherwise 'ops are the only mutation path' is a hope, not a contract"). The
  deny rules also block legit non-note edits inside the vault — acceptable: the vault is
  notes. Upgrade path (documented, not built): a PreToolUse hook that *replies* "use the
  weftel tools instead", which steers instead of just refusing.
- **Single writer.** While a tab has the note open, only that tab writes: the approved op
  applies to the live ProseMirror doc and saves through the normal autosave path, so it
  composes with unsaved human edits instead of racing them. The MCP process never writes
  files. No tab open → `no_live_tab` (open the note and retry); headless direct-apply is
  deliberately not a thing — a human always approves, in the rendered doc.
- **Reading is free, addressing is not.** Agents may Read raw bytes to understand a doc,
  but `weftel_read_doc` is the only source of valid edit targets: blocks without author
  ids get deterministic provisional ids (`w-XXXX`, stable per docVersion) that persist to
  disk only when an approved edit touches that block (mint-on-touch — untouched docs stay
  byte-pristine).
- **Verify before the human.** Every proposal round-trips through the fidelity checks
  (round-trip, id survival, validity) before the gate shows; a failing proposal never
  reaches the user (`verify_failed` — an engine-level rejection).
- **Approved means saved.** The tool call blocks until the human decides (default 120s,
  `WEFTEL_APPROVAL_TIMEOUT_MS`); `approved` is only reported after the editor's save
  returns, and it carries the new `docVersion`.

## Error vocabulary (every error tells the agent what to do next)

| code | meaning / action |
|---|---|
| `no_live_tab` | no weftel tab has the note open — ask the user to open it, retry |
| `stale_doc` / `stale` | the file/block changed since read — `weftel_read_doc` again, retry |
| `node_not_found` | bad or expired block id — re-read for fresh ids |
| `kind_incompatible` | target is a container — address one of its inner text blocks |
| `verify_failed` | the proposed save fails fidelity checks — smaller edit, or report it |
| `human_rejected` | the user declined — do NOT retry the same edit; ask what they'd prefer |
| `approval_timeout` | no decision in time — the user may be away |
| `server_restarted` / `server_unreachable` | weftel restarted/not running — re-issue once it's back |

## Known limits (tracer scope)

- `setText` only: replaces one block's entire inline content with plain text (inline
  formatting inside the block is dropped by design — use on single-style blocks). The
  richer op vocabulary (insert/move/table/rich-block ops) is phase 3 (D1 tournament).
- `.html`/`.htm` notes only; `.md` returns `md_not_supported`.
- The proposal queue is in-memory: a weftel restart drops pending approvals (surfaced as
  `server_restarted`).
- Frozen rich-HTML blocks (`id: null` in the outline) aren't addressable yet.
