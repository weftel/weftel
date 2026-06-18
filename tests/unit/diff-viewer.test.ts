// Unit tests for the diff-approve gate's PURE, DOM-free logic (client/diff-viewer.ts).
// splitBlocks uses an inert <template> (happy-dom provides it); diffBlocks + composeAccepted
// are pure string transforms. The overlay (diffApprove) needs a real browser — see the
// integration report for the manual validation note; it is not exercised here.
import { test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import { splitBlocks, diffBlocks, composeAccepted, diffApprove, type Hunk } from "../../client/diff-viewer";

// ───────────────────────── splitBlocks ─────────────────────────
test("splitBlocks: splits top-level elements into blocks", () => {
  expect(splitBlocks("<p>a</p><p>b</p>")).toEqual(["<p>a</p>", "<p>b</p>"]);
});
test("splitBlocks: keeps nested children inside their top-level block", () => {
  expect(splitBlocks("<div><p>x</p><p>y</p></div>")).toEqual(["<div><p>x</p><p>y</p></div>"]);
});
test("splitBlocks: drops whitespace-only text between blocks", () => {
  expect(splitBlocks("<p>a</p>\n  \n<p>b</p>")).toEqual(["<p>a</p>", "<p>b</p>"]);
});
test("splitBlocks: a pure-text fragment is a single block, ampersands escaped", () => {
  expect(splitBlocks("plain words")).toEqual(["plain words"]);
  expect(splitBlocks("a & b")).toEqual(["a &amp; b"]);
});
test("splitBlocks: empty / whitespace input → no blocks", () => {
  expect(splitBlocks("")).toEqual([]);
  expect(splitBlocks("   \n ")).toEqual([]);
});
test("splitBlocks: preserves comment nodes", () => {
  expect(splitBlocks("<!-- banner --><p>a</p>")).toEqual(["<!-- banner -->", "<p>a</p>"]);
});

// ───────────────────────── diffBlocks ─────────────────────────
test("diffBlocks: identical input → one 'same' hunk, no changes", () => {
  const h = diffBlocks(["<p>a</p>", "<p>b</p>"], ["<p>a</p>", "<p>b</p>"]);
  expect(h).toEqual([{ kind: "same", blocks: ["<p>a</p>", "<p>b</p>"] }]);
});
test("diffBlocks: pure insertion at end → trailing 'add'", () => {
  const h = diffBlocks(["<p>a</p>"], ["<p>a</p>", "<p>b</p>"]);
  expect(h).toEqual([
    { kind: "same", blocks: ["<p>a</p>"] },
    { kind: "add", blocks: ["<p>b</p>"] },
  ]);
});
test("diffBlocks: pure deletion → 'del'", () => {
  const h = diffBlocks(["<p>a</p>", "<p>b</p>"], ["<p>a</p>"]);
  expect(h).toEqual([
    { kind: "same", blocks: ["<p>a</p>"] },
    { kind: "del", blocks: ["<p>b</p>"] },
  ]);
});
test("diffBlocks: replaced block → 'change' (old+new paired)", () => {
  const h = diffBlocks(["<p>old</p>"], ["<p>new</p>"]);
  expect(h).toEqual([{ kind: "change", oldBlocks: ["<p>old</p>"], newBlocks: ["<p>new</p>"] }]);
});
test("diffBlocks: change between two unchanged blocks keeps surrounding context", () => {
  const h = diffBlocks(["<h1>t</h1>", "<p>old</p>", "<p>z</p>"], ["<h1>t</h1>", "<p>new</p>", "<p>z</p>"]);
  expect(h).toEqual([
    { kind: "same", blocks: ["<h1>t</h1>"] },
    { kind: "change", oldBlocks: ["<p>old</p>"], newBlocks: ["<p>new</p>"] },
    { kind: "same", blocks: ["<p>z</p>"] },
  ]);
});
test("diffBlocks: cosmetic whitespace reflow is NOT a diff (normalized compare)", () => {
  const h = diffBlocks(["<div><p>a</p></div>"], ["<div>\n  <p>a</p>\n</div>"]);
  expect(h.every((x) => x.kind === "same")).toBe(true);
});
test("diffBlocks: insertion from empty (author mode) → single 'add'", () => {
  const h = diffBlocks([], ["<p>fresh</p>"]);
  expect(h).toEqual([{ kind: "add", blocks: ["<p>fresh</p>"] }]);
});

// ───────────────────────── composeAccepted ─────────────────────────
// Accept-all reproduces the proposed doc; reject-all reproduces the original — the core invariant.
function allTrue(h: Hunk[]) { return h.map(() => true); }
function allFalse(h: Hunk[]) { return h.map(() => false); }

test("composeAccepted: accept-all == proposed, reject-all == original (change)", () => {
  const oldB = ["<h1>t</h1>", "<p>old</p>"], newB = ["<h1>t</h1>", "<p>new</p>"];
  const h = diffBlocks(oldB, newB);
  expect(composeAccepted(h, allTrue(h))).toBe(newB.join(""));
  expect(composeAccepted(h, allFalse(h))).toBe(oldB.join(""));
});
test("composeAccepted: accept-all == proposed, reject-all == original (add + del mix)", () => {
  const oldB = ["<p>a</p>", "<p>drop</p>"], newB = ["<p>a</p>", "<p>ins</p>"];
  const h = diffBlocks(oldB, newB);
  expect(composeAccepted(h, allTrue(h))).toBe(newB.join(""));
  expect(composeAccepted(h, allFalse(h))).toBe(oldB.join(""));
});
test("composeAccepted: per-hunk — accept one change, reject another", () => {
  // two independent changes separated by context
  const oldB = ["<p>A1</p>", "<hr>", "<p>B1</p>"];
  const newB = ["<p>A2</p>", "<hr>", "<p>B2</p>"];
  const h = diffBlocks(oldB, newB);
  // h = [change(A1→A2), same(hr), change(B1→B2)]
  expect(h.length).toBe(3);
  const decisions = h.map((x) => x.kind !== "same"); // accept all changes
  decisions[0] = true;  // accept A
  decisions[2] = false; // reject B
  expect(composeAccepted(h, decisions)).toBe("<p>A2</p><hr><p>B1</p>");
});
test("composeAccepted: rejecting a deletion keeps the original block", () => {
  const h = diffBlocks(["<p>a</p>", "<p>b</p>"], ["<p>a</p>"]);
  // [same(a), del(b)]; reject the deletion → b stays
  expect(composeAccepted(h, [false, false])).toBe("<p>a</p><p>b</p>");
  // accept the deletion → b gone
  expect(composeAccepted(h, [true, true])).toBe("<p>a</p>");
});
test("composeAccepted: accepting an addition includes it; rejecting drops it", () => {
  const h = diffBlocks(["<p>a</p>"], ["<p>a</p>", "<p>b</p>"]);
  expect(composeAccepted(h, [true, true])).toBe("<p>a</p><p>b</p>");
  expect(composeAccepted(h, [true, false])).toBe("<p>a</p>");
});

// ───────────────────────── diffApprove overlay (F49) ─────────────────────────
// The overlay needs a DOM (happy-dom provides shadow roots). A ⌘K-GENERATED table reaches the
// gate in AUTHOR mode as a PLAIN <table> (no inline borders — the SYSTEM prompt asks for one).
// Regression: it must be rendered in the preview AND carry gate-owned gridline styling, or the
// human is asked to approve a borderless, invisible grid (the F49 report).
test("diffApprove: a generated plain table is previewed WITH baseline gridline styling (F49)", async () => {
  document.querySelectorAll(".dgate-root").forEach((n) => n.remove());
  const PLAIN_TABLE =
    "<table><tr><th>A</th><th>B</th><th>C</th></tr>" +
    "<tr><td>1</td><td>2</td><td>3</td></tr>" +
    "<tr><td>4</td><td>5</td><td>6</td></tr></table>";
  // author mode, empty original → a single "add" hunk. The Promise resolves on a decision; we
  // press Esc at the end (below) so the gate tears itself down — removing its document keydown
  // listener and root — instead of leaking them onto the shared happy-dom global document.
  const decided = diffApprove("", PLAIN_TABLE, "author");

  const host = document.querySelector(".dgate-add .dgate-render") as HTMLElement | null;
  expect(host).not.toBeNull();
  const shadow = (host as any).shadowRoot as ShadowRoot;
  // The table IS rendered into the preview (not dropped) — all 9 cells present.
  expect(shadow.querySelector("table")).not.toBeNull();
  expect(shadow.querySelectorAll("td, th").length).toBe(9);
  // ...and the baseline reset now gives table cells a border (the fix). Before it, the shadow's
  // stylesheet mentioned no table/border at all, so a plain table rendered as an invisible grid.
  const styleText = Array.from(shadow.querySelectorAll("style")).map((s) => s.textContent || "").join("\n");
  expect(styleText).toMatch(/table\s+td[^}]*border/);

  // Esc → finish({accepted:false}): real teardown (removes the keydown listener + root, resolves).
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await decided;
  expect(document.querySelector(".dgate-root")).toBeNull();
});
