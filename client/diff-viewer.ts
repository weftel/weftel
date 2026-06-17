// [AI:diff-gate] The shared "human is always the approver" gate.
//
// An AI edit is computed against HTML SOURCE, but the human must never have to read raw
// tags to approve it. diffApprove() renders BOTH the old and the proposed HTML as RENDERED
// content (inside shadow roots, mirroring the RichBlock nodeView so a doc's scoped CSS can
// still apply) and shows the difference visually: additions in green, removals in red /
// strikethrough, changed regions in amber. The user accepts or rejects — whole document
// (Enter / Esc) or per-hunk — and the Promise resolves with the composed result.
//
// Built for reuse: ⌘K, inline suggestions, and any future AI surface should route their
// proposed edit through diffApprove() rather than inserting blindly. The diff + compose
// logic is split into PURE, DOM-free functions (diffBlocks / composeAccepted) so the
// integrity-critical part is unit-testable without a browser; only the overlay needs the DOM.
//
// SECURITY: both sides are run through stripActive() (the client-side load-path sanitizer,
// same one the editor uses before any HTML reaches a live DOM) BEFORE we render or diff —
// so a malicious AI payload can never execute inside the gate's preview. The server's
// safeRichHtml() is the heavier allow-list sanitizer but it is server-only (it pulls in the
// `sanitize-html` node dep); stripActive is the established client equivalent and the same
// guarantee the RichBlock render path relies on.

import { stripActive } from "./lib";

export type DiffMode = "rich" | "prose" | "author";

// A hunk is one contiguous region of the block-level diff. "same" is unchanged context;
// "add"/"del" are pure insertions/removals; "change" pairs a removed run with the new run
// that replaced it (rendered old-over-new in amber). Only non-"same" hunks are decisions.
export type Hunk =
  | { kind: "same"; blocks: string[] }
  | { kind: "add"; blocks: string[] }
  | { kind: "del"; blocks: string[] }
  | { kind: "change"; oldBlocks: string[]; newBlocks: string[] };

export interface DiffApproveResult { accepted: boolean; html?: string }
export interface DiffApproveOpts {
  // Optional stylesheet (already scoped, e.g. the editor's RICH_STYLES) injected into each
  // preview shadow root so class-styled rich content renders with its real CSS. Reuse hook
  // for ⌘K, which has the doc's <style> available; AI fragments alone don't carry it.
  css?: string;
  // Overridable labels (the caller knows whether this is a rewrite, an insertion, …).
  title?: string;
  // Follow-up refine: when provided, the gate shows an input where the user can refine the
  // proposed change ("make the ocean bigger") without leaving the gate. The gate hands back the
  // CURRENT proposal + the instruction; the caller re-runs the model and returns the new proposed
  // content. The gate then re-diffs against the original and re-renders in place. Omit ⇒ no input.
  onRefine?: (instruction: string, currentProposal: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
}

// ───────────────────────── PURE: block split (inert template) ─────────────────────────
// Split an HTML string into its top-level "blocks" — the unit we diff against. Uses an inert
// <template> (never a live document; mirrors lib.ts's pure helpers and runs under happy-dom),
// so it parses but nothing executes/loads. Element → outerHTML; a non-whitespace top-level
// text run → itself; a comment → preserved. Whitespace-only text between blocks is dropped
// (insignificant to the rendered result and would create noise hunks).
export function splitBlocks(html: string): string[] {
  const t = document.createElement("template");
  t.innerHTML = html || "";
  const out: string[] = [];
  t.content.childNodes.forEach((n) => {
    if (n.nodeType === 1) out.push((n as Element).outerHTML);
    else if (n.nodeType === 8) out.push("<!--" + ((n as any).data || "") + "-->");
    else if (n.nodeType === 3) {
      const s = n.textContent || "";
      if (s.trim()) out.push(escapeText(s)); // re-escape so a stray "<" round-trips as text
    }
  });
  // A fragment that is pure inline text (no top-level element/comment) yields one block.
  return out.length ? out : (html || "").trim() ? [escapeText(html)] : [];
}

function escapeText(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Comparison key: collapse insignificant whitespace so a cosmetic reflow (added newline /
// indentation between tags) doesn't surface as a diff. The ORIGINAL block string is what we
// render and compose — normalization is only for equality.
function normKey(s: string): string {
  return s.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

// ───────────────────────── PURE: block-level LCS diff (no DOM) ─────────────────────────
// Classic longest-common-subsequence diff over the two block arrays, then coalesce the raw
// edit ops into hunks. A maximal run that contains BOTH removals and insertions becomes a
// single "change" hunk (the common "this block was rewritten" case → amber); a run of only
// removals is "del", only insertions is "add". Robust and order-stable, not character-perfect
// — exactly the "block/child level" granularity asked for.
export function diffBlocks(oldB: string[], newB: string[]): Hunk[] {
  const a = oldB, b = newB, n = a.length, m = b.length;
  const an = a.map(normKey), bn = b.map(normKey);
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = an[i] === bn[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  type Op = { t: "same" | "del" | "add"; s: string };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (an[i] === bn[j]) { ops.push({ t: "same", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", s: a[i] }); i++; }
    else { ops.push({ t: "add", s: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: "del", s: a[i++] });
  while (j < m) ops.push({ t: "add", s: b[j++] });

  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "same") {
      const blocks: string[] = [];
      while (k < ops.length && ops[k].t === "same") blocks.push(ops[k++].s);
      hunks.push({ kind: "same", blocks });
    } else {
      const dels: string[] = [], adds: string[] = [];
      while (k < ops.length && ops[k].t !== "same") { ops[k].t === "del" ? dels.push(ops[k].s) : adds.push(ops[k].s); k++; }
      if (dels.length && adds.length) hunks.push({ kind: "change", oldBlocks: dels, newBlocks: adds });
      else if (dels.length) hunks.push({ kind: "del", blocks: dels });
      else hunks.push({ kind: "add", blocks: adds });
    }
  }
  return hunks;
}

// ───────────────────────── PURE: compose the accepted HTML (no DOM) ─────────────────────────
// Given the hunks and a per-hunk accept array (true = take the proposed change, false = keep
// the original), reconstruct the resulting HTML. "same" context is always kept. Accepting an
// "add"/"change" takes the new blocks; accepting a "del" drops the old; rejecting any change
// leaves the original in place. accept[] is indexed 1:1 with hunks (the value is ignored for
// "same"). All-accept reproduces the proposed document; all-reject reproduces the original.
export function composeAccepted(hunks: Hunk[], accept: boolean[]): string {
  const out: string[] = [];
  hunks.forEach((h, idx) => {
    const ok = accept[idx];
    if (h.kind === "same") out.push(...h.blocks);
    else if (h.kind === "add") { if (ok) out.push(...h.blocks); }
    else if (h.kind === "del") { if (!ok) out.push(...h.blocks); }
    else out.push(...(ok ? h.newBlocks : h.oldBlocks));
  });
  return out.join("");
}

// ───────────────────────── DOM: the approval overlay ─────────────────────────
// Render the rendered visual diff in a modal and resolve once the human decides.
//   • Enter / "Accept all"  → resolve { accepted: true, html: <full proposed> }
//   • Esc   / "Reject all"  → resolve { accepted: false }
//   • per-hunk toggle + "Apply selected" → resolve { accepted: true, html: <composed> }
// A no-op edit (no visible change) resolves immediately without showing the modal.
export function diffApprove(
  oldHtml: string,
  newHtml: string,
  mode: DiffMode,
  opts: DiffApproveOpts = {},
): Promise<DiffApproveResult> {
  const oldClean = stripActive(oldHtml || "");
  const newClean = stripActive(newHtml || "");
  const hunks = diffBlocks(splitBlocks(oldClean), splitBlocks(newClean));
  const changeIdxs = hunks.map((h, i) => (h.kind === "same" ? -1 : i)).filter((i) => i >= 0);

  // Nothing visibly changed → no decision to make. Accept silently with the proposed HTML
  // (keeps the caller's flow identical to the no-gate path).
  if (!changeIdxs.length) return Promise.resolve({ accepted: true, html: newClean });

  injectStyle();

  return new Promise<DiffApproveResult>((resolve) => {
    // Mutable so a follow-up refine can swap the proposal in place: re-diff against the SAME
    // original (so we always show the net change vs the doc), re-render, reset per-hunk decisions.
    let proposal = newClean;
    let curHunks = hunks;
    let curChangeIdxs = changeIdxs;
    let accept: boolean[] = curHunks.map(() => true); // default: accept every proposed change
    const canRefine = typeof opts.onRefine === "function";

    const root = document.createElement("div");
    root.className = "dgate-root";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML =
      '<div class="dgate-panel">' +
        '<div class="dgate-head">' +
          '<span class="dgate-title"></span>' +
          '<span class="dgate-legend">' +
            '<span class="dgate-k dgate-k-add">added</span>' +
            '<span class="dgate-k dgate-k-del">removed</span>' +
            '<span class="dgate-k dgate-k-chg">changed</span>' +
          '</span>' +
        '</div>' +
        '<div class="dgate-body"></div>' +
        (canRefine
          ? '<div class="dgate-refine">' +
              '<input class="dgate-refine-input" type="text" autocomplete="off" ' +
                'placeholder="Refine this change — e.g. “make the ocean bigger”, then ↵" />' +
              '<span class="dgate-refine-status"></span>' +
            '</div>'
          : '') +
        '<div class="dgate-foot">' +
          '<button class="dgate-btn dgate-reject" type="button">Reject all <kbd>Esc</kbd></button>' +
          '<span class="dgate-spacer"></span>' +
          '<button class="dgate-btn dgate-apply" type="button">Apply selected</button>' +
          '<button class="dgate-btn dgate-accept dgate-primary" type="button">Accept all <kbd>↵</kbd></button>' +
        '</div>' +
      '</div>';

    const titleLabel = opts.title || (mode === "author" ? "Review insertion" : mode === "prose" ? "Review rewrite" : "Review change");
    (root.querySelector(".dgate-title") as HTMLElement).textContent = titleLabel;
    const body = root.querySelector(".dgate-body") as HTMLElement;
    const applyBtn = root.querySelector(".dgate-apply") as HTMLButtonElement;
    const refineInput = root.querySelector(".dgate-refine-input") as HTMLInputElement | null;
    const refineStatus = root.querySelector(".dgate-refine-status") as HTMLElement | null;

    // (Re)render every hunk from the current diff. "same" context renders dimmed; changes carry
    // their colored frame and a per-hunk toggle that flips its decision. Content goes into a shadow
    // root so the preview's own CSS (inline styles, classes + opts.css) can't leak to the chrome.
    const renderHunks = () => {
      body.innerHTML = "";
      if (!curChangeIdxs.length) {
        const note = document.createElement("div");
        note.className = "dgate-empty";
        note.textContent = "No differences from the original.";
        body.appendChild(note);
        return;
      }
      curHunks.forEach((h, idx) => {
        if (h.kind === "same") {
          if (!h.blocks.join("").trim()) return;
          const ctx = document.createElement("div"); ctx.className = "dgate-hunk dgate-ctx";
          ctx.appendChild(preview(h.blocks.join(""), opts.css));
          body.appendChild(ctx);
          return;
        }
        const hunk = document.createElement("div");
        hunk.className = "dgate-hunk dgate-" + h.kind;
        // toggle reflects accept[idx]; clicking flips it and restyles the hunk.
        const toggle = document.createElement("button");
        toggle.type = "button"; toggle.className = "dgate-toggle";
        const paint = () => {
          hunk.classList.toggle("dgate-rejected", !accept[idx]);
          toggle.textContent = accept[idx] ? "✓ keep" : "✕ skip";
          toggle.setAttribute("aria-pressed", String(accept[idx]));
        };
        toggle.addEventListener("click", () => { accept[idx] = !accept[idx]; paint(); });

        if (h.kind === "add") {
          hunk.appendChild(tag("added", "dgate-pill-add"));
          hunk.appendChild(preview(h.blocks.join(""), opts.css));
        } else if (h.kind === "del") {
          hunk.appendChild(tag("removed", "dgate-pill-del"));
          hunk.appendChild(preview(h.blocks.join(""), opts.css));
        } else {
          hunk.appendChild(tag("changed", "dgate-pill-chg"));
          const before = preview(h.oldBlocks.join(""), opts.css); before.classList.add("dgate-before");
          const after = preview(h.newBlocks.join(""), opts.css); after.classList.add("dgate-after");
          hunk.appendChild(before); hunk.appendChild(after);
        }
        hunk.appendChild(toggle);
        paint();
        body.appendChild(hunk);
      });
    };
    renderHunks();

    // ── resolution + teardown ──
    let done = false;
    let refining = false;
    const finish = (r: DiffApproveResult) => {
      if (done) return; done = true;
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      resolve(r);
    };
    const acceptAll = () => finish({ accepted: true, html: proposal });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        // Enter inside the refine input submits the refine; anywhere else accepts.
        if (refineInput && document.activeElement === refineInput) { e.preventDefault(); submitRefine(); return; }
        e.preventDefault(); acceptAll();
      } else if (e.key === "Escape") { e.preventDefault(); finish({ accepted: false }); }
    };

    // Follow-up refine: hand the CURRENT proposal + instruction to the caller (which re-runs the
    // model), then re-diff against the original and re-render in place. Disabled while in flight.
    const submitRefine = async () => {
      if (!refineInput || !opts.onRefine || refining) return;
      const instruction = refineInput.value.trim();
      if (!instruction) return;
      refining = true; refineInput.disabled = true;
      if (refineStatus) refineStatus.textContent = "refining…";
      let out: { ok: boolean; text?: string; error?: string };
      try { out = await opts.onRefine(instruction, proposal); }
      catch { out = { ok: false, error: "refine failed — try again" }; }
      if (done) return; // gate was closed mid-flight
      refining = false; refineInput.disabled = false;
      if (!out.ok || !out.text) { if (refineStatus) refineStatus.textContent = out.error || "couldn’t refine — try again"; refineInput.focus(); return; }
      proposal = stripActive(out.text);
      curHunks = diffBlocks(splitBlocks(oldClean), splitBlocks(proposal));
      curChangeIdxs = curHunks.map((h, i) => (h.kind === "same" ? -1 : i)).filter((i) => i >= 0);
      accept = curHunks.map(() => true);
      renderHunks();
      refineInput.value = ""; if (refineStatus) refineStatus.textContent = "";
      refineInput.focus();
    };

    root.querySelector(".dgate-accept")!.addEventListener("click", acceptAll);
    root.querySelector(".dgate-reject")!.addEventListener("click", () => finish({ accepted: false }));
    applyBtn.addEventListener("click", () => {
      const anyAccepted = curChangeIdxs.some((i) => accept[i]);
      // Composing with every change accepted is exactly "accept all" — hand back the verbatim
      // proposed HTML so the result is byte-identical to the no-gate path in that case.
      const allAccepted = curChangeIdxs.length > 0 && curChangeIdxs.every((i) => accept[i]);
      finish({ accepted: anyAccepted, html: allAccepted ? proposal : composeAccepted(curHunks, accept) });
    });
    // Click on the backdrop (outside the panel) rejects — same as Esc.
    root.addEventListener("mousedown", (e) => { if (e.target === root) finish({ accepted: false }); });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    (root.querySelector(".dgate-accept") as HTMLElement).focus();
  });
}

// A small colored caption pill for a hunk.
function tag(text: string, cls: string): HTMLElement {
  const s = document.createElement("span"); s.className = "dgate-pill " + cls; s.textContent = text; return s;
}

// Render an HTML fragment as RENDERED content inside a shadow root (mirrors the RichBlock
// nodeView, editor.ts ~l.450): styles first, content after. The host is contenteditable=false
// and the shadow encapsulates the fragment's CSS so it can neither leak out nor be clipped.
function preview(html: string, css?: string): HTMLElement {
  const host = document.createElement("div");
  host.className = "dgate-render";
  const shadow = host.attachShadow({ mode: "open" });
  // Reset FIRST so the doc's own styles (appended next) always win over our default font.
  const reset = document.createElement("style");
  // Default text color must follow the OS scheme: the gate chrome flips to light text in dark
  // mode (see @media block below), and the hunk backgrounds go dark — but that outer media query
  // can't reach into this shadow root, so it'd leave content near-black on a dark hunk. Re-declare
  // it here. The doc's own colors (appended after) still win; this only sets the default.
  reset.textContent = "*{box-sizing:border-box}:host{font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;color:#1c1c1e;line-height:1.55}@media(prefers-color-scheme:dark){:host{color:#ececef}}img,svg,video{max-width:100%;height:auto}";
  shadow.appendChild(reset);
  // opts.css may be either style-tag MARKUP (the editor's RICH_STYLES, which is what the
  // RichBlock nodeView injects verbatim) or raw CSS text — handle both.
  if (css) {
    if (/<style/i.test(css)) { const tpl = document.createElement("template"); tpl.innerHTML = css; shadow.appendChild(tpl.content); }
    else { const st = document.createElement("style"); st.textContent = css; shadow.appendChild(st); }
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = stripActive(html || ""); // already sanitized once; cheap belt-and-suspenders
  shadow.appendChild(tpl.content);
  return host;
}

// Inject the gate's own scoped stylesheet once (prefixed .dgate-*, no dependency on the
// editor's CSS or cmdk/ghost styling). Idempotent — guarded by id.
function injectStyle(): void {
  if (document.getElementById("dgate-style")) return;
  const st = document.createElement("style");
  st.id = "dgate-style";
  st.textContent = `
  .dgate-root{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
    background:rgba(20,20,28,.45);backdrop-filter:blur(2px);font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif}
  .dgate-panel{display:flex;flex-direction:column;width:min(760px,92vw);max-height:86vh;background:#fff;color:#1c1c1e;
    border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.4);overflow:hidden}
  .dgate-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #ececef}
  .dgate-title{font-weight:650;font-size:15px}
  .dgate-legend{margin-left:auto;display:flex;gap:10px;font-size:11px;color:#6b6b76}
  .dgate-k{display:inline-flex;align-items:center;gap:5px}
  .dgate-k::before{content:"";width:9px;height:9px;border-radius:2px;display:inline-block}
  .dgate-k-add::before{background:#1f9d57}.dgate-k-del::before{background:#d23b3b}.dgate-k-chg::before{background:#d99016}
  .dgate-body{padding:14px 18px;overflow:auto;display:flex;flex-direction:column;gap:10px}
  .dgate-hunk{position:relative;border-radius:10px;padding:12px 14px;border:1px solid transparent}
  .dgate-ctx{opacity:.5;border:1px dashed #e2e2e6;padding:8px 14px}
  .dgate-add{background:#eafaf0;border-color:#bfe9cf}
  .dgate-del{background:#fdecec;border-color:#f3c4c4}
  .dgate-change{background:#fdf4e3;border-color:#f0dab0}
  .dgate-del .dgate-render,.dgate-before{text-decoration:line-through;opacity:.7}
  .dgate-before{padding-bottom:8px;margin-bottom:8px;border-bottom:1px dashed #e6cfa0}
  .dgate-pill{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
    padding:2px 7px;border-radius:999px;margin-bottom:8px;color:#fff}
  .dgate-pill-add{background:#1f9d57}.dgate-pill-del{background:#d23b3b}.dgate-pill-chg{background:#d99016}
  .dgate-render{display:block}
  .dgate-toggle{position:absolute;top:10px;right:10px;font-size:11px;font-weight:600;border:1px solid #d4d4da;
    background:#fff;color:#444;border-radius:7px;padding:3px 9px;cursor:pointer}
  .dgate-toggle:hover{background:#f4f4f6}
  .dgate-rejected{opacity:.45;filter:grayscale(.6)}
  .dgate-rejected .dgate-toggle{opacity:1;filter:none}
  .dgate-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #ececef}
  .dgate-spacer{flex:1}
  .dgate-btn{font-size:13px;font-weight:600;border:1px solid #d4d4da;background:#fff;color:#1c1c1e;
    border-radius:9px;padding:8px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .dgate-btn:hover{background:#f4f4f6}
  .dgate-primary{background:#5a49d6;border-color:#5a49d6;color:#fff}
  .dgate-primary:hover{background:#4c3dc4}
  .dgate-btn kbd{font:inherit;font-size:11px;opacity:.75;border:1px solid currentColor;border-radius:4px;padding:0 4px;line-height:1.4}
  .dgate-empty{padding:18px;color:#6b6b76;font-size:13px;text-align:center}
  .dgate-refine{display:flex;align-items:center;gap:10px;padding:10px 18px;border-top:1px solid #ececef}
  .dgate-refine-input{flex:1;font:inherit;font-size:13px;border:1px solid #d4d4da;border-radius:9px;
    padding:8px 12px;background:#fff;color:#1c1c1e;outline:none}
  .dgate-refine-input:focus{border-color:#5a49d6;box-shadow:0 0 0 3px rgba(90,73,214,.16)}
  .dgate-refine-input:disabled{opacity:.6}
  .dgate-refine-status{font-size:12px;color:#6b6b76;white-space:nowrap}
  @media(prefers-color-scheme:dark){
    .dgate-panel{background:#1a1a1f;color:#ececef}
    .dgate-head,.dgate-foot{border-color:#2c2c33}
    .dgate-ctx{border-color:#33333a}
    .dgate-add{background:#0f2a1b;border-color:#1f5538}
    .dgate-del{background:#2e1414;border-color:#5e2727}
    .dgate-change{background:#2c2310;border-color:#5b4a20}
    .dgate-btn{background:#26262c;border-color:#3a3a42;color:#ececef}
    .dgate-btn:hover{background:#303039}
    .dgate-toggle{background:#26262c;border-color:#3a3a42;color:#cfcfd6}
    .dgate-primary{background:#6d5ce0;border-color:#6d5ce0;color:#fff}
    .dgate-refine{border-color:#2c2c33}
    .dgate-refine-input{background:#26262c;border-color:#3a3a42;color:#ececef}
    .dgate-refine-status{color:#a0a0aa}
    .dgate-empty{color:#a0a0aa}
  }`;
  document.head.appendChild(st);
}
