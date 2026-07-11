// Tab ghost-text controller — "Cursor-Tab for notes", v1. // [AI:ghost]
//
// Debounced inline completion: as you type at the end of a prose line / list item / table cell,
// a SHORT continuation is requested from /ghost and rendered as a faded inline ghost. Tab accepts
// it (inserts the text), Esc dismisses, and any other edit or caret move invalidates it.
//
// DESIGN (keep base behavior unchanged):
//   • The ghost lives as a ProseMirror WIDGET decoration, not a document node — it never enters the
//     doc, never serializes, never dirties the file or triggers a save. Accepting it is the only
//     thing that writes (a normal text insert).
//   • Mounted ONLY when window.__GHOST_TEXT_ENABLED (server flag, default off) via editor.ts. When
//     off, this module isn't loaded and TabKeys' ghostAcceptTab() stays a no-op — Tab/list-indent
//     is byte-identical to today.
//   • Tab arbitration is delegated, not hijacked: editor.ts calls acceptTab() at the TOP of the
//     existing TabKeys.Tab handler; it returns true (consume) only when a ghost is showing,
//     otherwise false so Tab falls through to list-indent / table / code-tab unchanged.
//   • The trigger gate, prompt, output-clean, and cursor-join are pure functions in lib.ts
//     (unit-tested). This file owns only the live wiring: debounce, ProseMirror context
//     extraction, the widget, and the fetch.
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { shouldRequestGhost, joinGhost } from "./lib";

// Ancestor node types that take the cursor OUT of scope for v1 — code (never predict code) and
// rich / class-styled / dynamic containers (a later gated expansion). If any of these is an
// ancestor of the cursor, no ghost is offered.
const SUPPRESS_ANCESTORS = new Set([
  "codeBlock", "richBlock", "styledBox", "styledInlineBox", "styledSpan", "decoSpan",
  "callout",
]);

// Map the cursor's ancestor chain to one supported block label (or null). Prefers the most
// specific CONTAINER (list item / table cell / blockquote) over the inner textblock, so the prompt
// reads naturally ("Continue this list item"). A bare "paragraph" is only the fallback when no such
// container is an ancestor — otherwise the inner paragraph (every list item / cell wraps one) would
// always win and the structure-specific labels would be dead.
function blockTypeAt($from: any): string | null {
  let fallback: string | null = null;
  for (let d = $from.depth; d >= 1; d--) {
    const name = $from.node(d).type.name;
    if (name === "tableCell" || name === "tableHeader") return name;
    if (name === "taskItem") return "taskItem";
    if (name === "listItem") return "listItem";
    if (name === "blockquote") return "blockquote";
    if (name === "heading") return "heading";
    if (name === "paragraph") fallback = "paragraph";
  }
  return fallback;
}

// [next-edit] Is the cursor in a list/table position where a REPEATING PATTERN already precedes it,
// so a completion is worth offering even though the current item is empty or short? This is the
// "type 'A', Enter, Tab → 'B'" moment that the basic gate's min-context rule (≥3 chars) blocks — yet
// the FIM model continues the pattern reliably (measured 8/8) once it sees the preceding items in the
// prefix. True when a preceding sibling list item, or the cell to the left / directly above in a
// table, already has text. Conservative: needs a non-empty precedent, so a fresh empty list never fires.
function hasPatternContext($from: any): boolean {
  for (let d = $from.depth; d >= 1; d--) {
    const name = $from.node(d).type.name;
    if (name === "listItem" || name === "taskItem") {
      const list = $from.node(d - 1), idx = $from.index(d - 1);
      for (let i = 0; i < idx; i++) if ((list.child(i).textContent || "").trim()) return true;
      return false;
    }
    if (name === "tableCell" || name === "tableHeader") {
      if (d < 2) return false;
      const row = $from.node(d - 1), cellIdx = $from.index(d - 1);
      const table = $from.node(d - 2), rowIdx = $from.index(d - 2);
      if (cellIdx > 0 && (row.child(cellIdx - 1).textContent || "").trim()) return true;        // cell to the left
      if (rowIdx > 0) { const above = table.child(rowIdx - 1); if (cellIdx < above.childCount && (above.child(cellIdx).textContent || "").trim()) return true; } // cell above (column fill-down)
      return false;
    }
  }
  return false;
}

// [AI:ghost] FIM context window: how much document text (around the cursor) to send as the
// fill-in-the-middle prefix/suffix. Bounded so a small local model stays fast and focused; the
// prefix is richer than the block alone (preceding paragraphs help the model continue coherently),
// and the suffix lets a FIM model infill toward what follows.
const FIM_PREFIX_CHARS = 600;
const FIM_SUFFIX_CHARS = 300;

type CursorCtx = {
  pos: number; blockType: string | null; textBefore: string; prefix: string; suffix: string;
  gate: Parameters<typeof shouldRequestGhost>[0];
};
// Read everything the gate + request need from current editor state. Pure w.r.t. the editor
// (no dispatch) so it's safe to call repeatedly (debounce + stale-guard).
function readCursor(editor: Editor): CursorCtx {
  const { state } = editor;
  const sel: any = state.selection;
  const $from = sel.$from;
  const parent = $from.parent;                              // the immediate textblock
  const inCodeBlock = parent.type.name === "codeBlock";
  let inRichBlock = false;
  for (let d = $from.depth; d >= 0; d--) { if (SUPPRESS_ANCESTORS.has($from.node(d).type.name)) { inRichBlock = true; break; } }
  const atTextEnd = $from.parentOffset === parent.content.size;
  const textBefore = parent.textBetween(0, $from.parentOffset, "\n", " "); // block-level: gate + cursor-join spacing
  const blockType = inCodeBlock || inRichBlock ? null : blockTypeAt($from);
  // Document-level FIM windows around the caret (bounded). Block separators render as "\n".
  const doc = state.doc;
  const at = sel.empty ? sel.from : 0;
  const prefix = doc.textBetween(Math.max(0, at - FIM_PREFIX_CHARS), at, "\n", " ");
  const suffix = doc.textBetween(at, Math.min(doc.content.size, at + FIM_SUFFIX_CHARS), "\n", " ");
  return {
    pos: sel.empty ? sel.from : -1,
    blockType, textBefore, prefix, suffix,
    gate: { selectionEmpty: !!sel.empty, atTextEnd, inCodeBlock, inRichBlock, blockType, textBefore, hasPatternContext: hasPatternContext($from) },
  };
}

// ── the widget-decoration plugin ─────────────────────────────────────────────
// State is { text, pos } | null. Set via a meta-only transaction (no doc/selection change, so it
// never dirties the file); cleared on the next docChange / caret move (so any edit invalidates it)
// or an explicit "clear" meta (Esc / accept).
const ghostKey = new PluginKey<GhostState>("ghostText");
type GhostState = { text: string; pos: number } | null;

function buildPlugin(): Plugin {
  return new Plugin<GhostState>({
    key: ghostKey,
    state: {
      init: () => null,
      apply(tr, value): GhostState {
        const meta = tr.getMeta(ghostKey);
        if (meta === "clear") return null;
        if (meta && typeof meta === "object") return { text: meta.text, pos: meta.pos };
        if (!value) return null;
        // a real edit or a caret move invalidates a showing ghost
        if (tr.docChanged || tr.selectionSet) return null;
        return value;
      },
    },
    props: {
      decorations(state): DecorationSet | undefined {
        const v = ghostKey.getState(state);
        if (!v || !v.text) return undefined;
        const pos = Math.min(v.pos, state.doc.content.size);
        const widget = Decoration.widget(pos, () => {
          const span = document.createElement("span");
          span.className = "ghost-text";
          span.textContent = v.text;
          span.style.opacity = "0.4";
          span.style.pointerEvents = "none";
          span.style.whiteSpace = "pre-wrap";
          span.setAttribute("aria-hidden", "true");
          return span;
        }, { side: 1, ignoreSelection: true, key: "ghost:" + v.text });
        return DecorationSet.create(state.doc, [widget]);
      },
    },
  });
}

export type GhostController = { acceptTab: () => boolean; destroy: () => void };

// Mount the controller on a live editor. Returns acceptTab (wired into TabKeys by editor.ts) and
// destroy (teardown). onAccept fires after a Tab-accept so the caller can arm autosave — accepting
// inserts text programmatically, which doesn't emit a beforeinput.
export function mountGhostCompletion(editor: Editor, opts: { onAccept?: () => void } = {}): GhostController {
  editor.registerPlugin(buildPlugin());

  const ghostNow = (): GhostState => ghostKey.getState(editor.state) || null;
  // Showing/clearing the ghost is a meta-only transaction: no doc/selection change, plus
  // addToHistory:false (never an undo step) and preventUpdate:true (don't emit the editor's
  // "update" event, so it can't re-arm this very debounce or flicker the save status).
  const setGhost = (pos: number, text: string) =>
    editor.view.dispatch(editor.state.tr.setMeta(ghostKey, { text, pos }).setMeta("addToHistory", false).setMeta("preventUpdate", true));
  const clearGhost = () => { if (ghostNow()) editor.view.dispatch(editor.state.tr.setMeta(ghostKey, "clear").setMeta("addToHistory", false).setMeta("preventUpdate", true)); };

  let seq = 0;                                   // request token — drop responses the user has moved past
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;                            // a request is scheduled or in flight

  // Cancel any scheduled OR in-flight request: clear the debounce timer and bump the request token
  // so a late /ghost response is DROPPED (its reqId !== seq) instead of popping a ghost the user has
  // already dismissed. The model round-trip can be seconds; without this, Esc/blur clear the CURRENT
  // ghost but a response already in flight would still show one afterward (real-latency bug).
  function cancelPending() { clearTimeout(timer); seq++; pending = false; }

  async function fire() {
    const reqId = ++seq;
    const ctx = readCursor(editor);
    if (!shouldRequestGhost(ctx.gate)) { pending = false; return; }
    let r: any;
    try {
      r = await fetch("/ghost", {
        method: "POST", headers: { "content-type": "application/json" },
        // context = block text before cursor (chat fallback + spacing); prefix/suffix = doc-level
        // fill-in-the-middle windows for the completion path. [AI:ghost]
        body: JSON.stringify({ blockType: ctx.blockType, context: ctx.textBefore, prefix: ctx.prefix, suffix: ctx.suffix }),
      }).then((x) => x.json());
    } catch { pending = false; return; }
    pending = false;
    if (reqId !== seq) return;                   // superseded by a newer edit, or cancelled (Esc/blur)
    if (!r || !r.ok || !r.text) return;
    if (!editor.view.hasFocus()) return;         // editor lost focus mid-flight — don't show a ghost into it
    // re-read: the cursor must still be at the exact point we requested for (no edit/move since)
    const now = readCursor(editor);
    if (now.pos !== ctx.pos || now.textBefore !== ctx.textBefore) return;
    const joined = joinGhost(ctx.textBefore, String(r.text));
    if (!joined.trim()) return;
    setGhost(ctx.pos, joined);
  }

  function schedule() {
    clearTimeout(timer);
    seq++;                                        // invalidate any in-flight request
    pending = true;
    timer = setTimeout(fire, 300);
  }
  // Trigger on document edits (typing). The plugin clears the ghost on the same docChange tx, so a
  // keystroke removes the old ghost instantly and a fresh one is requested 300ms later. We do NOT
  // trigger on bare caret moves (selectionUpdate) — that would fire a model call on every click.
  editor.on("update", schedule);

  // Esc dismisses a showing ghost AND cancels any pending/in-flight request, so a slow response can't
  // pop a ghost after the user dismissed it. Capture phase, so it pre-empts the editor's blur and the
  // app's global Escape handler. We only CONSUME the key (preventDefault/stop) when a ghost is visibly
  // shown — if nothing is visible we still cancel the pending request but let Esc propagate (so it can
  // close other UI). Tab acceptance is NOT here — it's delegated through TabKeys via acceptTab().
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const showing = !!ghostNow();
    if (showing || pending) cancelPending();
    if (showing) { clearGhost(); e.preventDefault(); e.stopPropagation(); }
  };
  editor.view.dom.addEventListener("keydown", onKeydown, true);

  // Leaving the editor cancels any pending request and clears the ghost — never show a completion
  // into an editor the user has clicked away from.
  const onBlur = () => { cancelPending(); clearGhost(); };
  editor.on("blur", onBlur);

  function acceptTab(): boolean {
    const g = ghostNow();
    if (!g || !g.text) return false;             // no ghost → Tab falls through to list-indent
    const at = Math.min(g.pos, editor.state.doc.content.size);
    // Insert the EXACT ghost string as literal text (insertText, not insertContent) so any leading
    // join-space survives and the completion is never re-parsed as markup/markdown (e.g. "- x"
    // stays text, not a new bullet). A real edit → dirties + saves; the docChange clears the
    // decoration via the plugin. Place the caret right after the inserted text.
    const tr = editor.state.tr.insertText(g.text, at);
    tr.setSelection(TextSelection.create(tr.doc, at + g.text.length));
    editor.view.dispatch(tr);
    editor.view.focus();
    opts.onAccept && opts.onAccept();
    return true;
  }

  return {
    acceptTab,
    destroy() {
      cancelPending();
      editor.off("update", schedule);
      editor.off("blur", onBlur);
      editor.view.dom.removeEventListener("keydown", onKeydown, true);
      clearGhost();
    },
  };
}
