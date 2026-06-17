// Unit tests for the Tab ghost-text pure logic (the trigger GATE, prompt, output-clean, cursor
// join, and Tab arbitration). These are the integrity-critical decisions — scope discipline (never
// fire in code/rich blocks) and what-you-see-is-what-you-accept — proven without booting the
// editor or making a model call. The live wiring (debounce, widget, fetch) is browser-validated.
// Run: `bun test tests/unit`.
import { test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import {
  shouldRequestGhost, buildGhostPrompt, cleanGhostCompletion, joinGhost, ghostTabAction,
  GHOST_MIN_CONTEXT, GHOST_MAX_LEN,
} from "../../client/lib";

// A valid trigger context — each test overrides the one field under test.
const ok = () => ({
  selectionEmpty: true, atTextEnd: true, inCodeBlock: false, inRichBlock: false,
  blockType: "paragraph", textBefore: "The quick brown fox",
});

// ───────────────────────── shouldRequestGhost — the v1 scope gate ─────────────────────────
test("shouldRequestGhost: fires at end of a prose line with enough context", () => {
  expect(shouldRequestGhost(ok())).toBe(true);
});

test("shouldRequestGhost: supported simple-structure blocks all fire", () => {
  for (const blockType of ["paragraph", "heading", "listItem", "taskItem", "tableCell", "tableHeader", "blockquote"]) {
    expect(shouldRequestGhost({ ...ok(), blockType })).toBe(true);
  }
});

test("shouldRequestGhost: NEVER fires in a code block (out of scope)", () => {
  expect(shouldRequestGhost({ ...ok(), inCodeBlock: true, blockType: null })).toBe(false);
});

test("shouldRequestGhost: NEVER fires in a rich / class-styled block (out of scope)", () => {
  expect(shouldRequestGhost({ ...ok(), inRichBlock: true, blockType: null })).toBe(false);
});

test("shouldRequestGhost: refuses an unsupported block type", () => {
  expect(shouldRequestGhost({ ...ok(), blockType: "image" })).toBe(false);
  expect(shouldRequestGhost({ ...ok(), blockType: null })).toBe(false);
});

test("shouldRequestGhost: only at the end of the block's text (not mid-line)", () => {
  expect(shouldRequestGhost({ ...ok(), atTextEnd: false })).toBe(false);
});

test("shouldRequestGhost: not with a range selection", () => {
  expect(shouldRequestGhost({ ...ok(), selectionEmpty: false })).toBe(false);
});

test("shouldRequestGhost: needs at least GHOST_MIN_CONTEXT chars of real text", () => {
  expect(shouldRequestGhost({ ...ok(), textBefore: "" })).toBe(false);
  expect(shouldRequestGhost({ ...ok(), textBefore: "   " })).toBe(false);     // whitespace doesn't count
  expect(shouldRequestGhost({ ...ok(), textBefore: "a".repeat(GHOST_MIN_CONTEXT - 1) })).toBe(false);
  expect(shouldRequestGhost({ ...ok(), textBefore: "a".repeat(GHOST_MIN_CONTEXT) })).toBe(true);
});

// ───────────────────────── buildGhostPrompt — the server prompt ─────────────────────────
test("buildGhostPrompt: tight, embeds the context, and asks for continuation only", () => {
  const p = buildGhostPrompt("paragraph", "The meeting agenda is");
  expect(p).toContain("Continue this paragraph");
  expect(p).toContain("1-2 short clauses");
  expect(p).toContain("no preamble");
  expect(p).toContain("The meeting agenda is");
  expect(p.toLowerCase()).toContain("only");
});

test("buildGhostPrompt: maps block types to readable labels", () => {
  expect(buildGhostPrompt("listItem", "x")).toContain("Continue this list item");
  expect(buildGhostPrompt("tableCell", "x")).toContain("Continue this table cell");
  expect(buildGhostPrompt("taskItem", "x")).toContain("Continue this to-do item");
  expect(buildGhostPrompt("heading", "x")).toContain("Continue this heading");
  expect(buildGhostPrompt("nonsense", "x")).toContain("Continue this text"); // unknown → generic
});

// ───────────────────────── cleanGhostCompletion — taming the model output ─────────────────────────
test("cleanGhostCompletion: keeps a short single-clause continuation as-is", () => {
  expect(cleanGhostCompletion("jumps over the lazy dog")).toBe("jumps over the lazy dog");
});

test("cleanGhostCompletion: strips wrapping quotes/backticks a model adds", () => {
  expect(cleanGhostCompletion('"jumps over"')).toBe("jumps over");
  expect(cleanGhostCompletion("`jumps over`")).toBe("jumps over");
});

test("cleanGhostCompletion: collapses to the first line (a ghost is one segment)", () => {
  expect(cleanGhostCompletion("jumps over\nand then runs away")).toBe("jumps over");
});

test("cleanGhostCompletion: caps length at a word boundary, never mid-word", () => {
  const long = "word ".repeat(60).trim();          // ~300 chars
  const out = cleanGhostCompletion(long);
  expect(out.length).toBeLessThanOrEqual(GHOST_MAX_LEN);
  expect(out.endsWith("wor")).toBe(false);          // no severed word
  expect(out.startsWith("word word")).toBe(true);
});

test("cleanGhostCompletion: empty / whitespace input → empty", () => {
  expect(cleanGhostCompletion("")).toBe("");
  expect(cleanGhostCompletion("   \n  ")).toBe("");
});

test("cleanGhostCompletion: strips FIM / special sentinel tokens a completion model leaks", () => {
  expect(cleanGhostCompletion("and then we ship<|endoftext|>")).toBe("and then we ship");
  expect(cleanGhostCompletion("<|fim_middle|>and then we ship")).toBe("and then we ship");
  expect(cleanGhostCompletion("and then we ship<|im_end|>")).toBe("and then we ship");
  expect(cleanGhostCompletion("and then we ship</s>")).toBe("and then we ship");
  expect(cleanGhostCompletion("and then we ship<EOT>")).toBe("and then we ship");
});

test("cleanGhostCompletion: strips stray HTML tag fragments (the 1.5b trailing </p>)", () => {
  expect(cleanGhostCompletion("and then we ship</p>")).toBe("and then we ship");
  expect(cleanGhostCompletion("<p>and then we ship")).toBe("and then we ship");
  expect(cleanGhostCompletion("ship the <li>feature")).toBe("ship the feature");
});

test("cleanGhostCompletion: strips code-fence artifacts", () => {
  expect(cleanGhostCompletion("```html")).toBe("");
  expect(cleanGhostCompletion("```\nand then we ship")).toBe("and then we ship");
});

test("cleanGhostCompletion: a bare punctuation char (< 5) is NOT treated as a tag", () => {
  expect(cleanGhostCompletion("is less than 5 items")).toBe("is less than 5 items");
  expect(cleanGhostCompletion("x < 5 and y > 3")).toBe("x < 5 and y > 3");
});

// ───────────────────────── joinGhost — what-you-see-is-what-you-accept spacing ─────────────────────────
test("joinGhost: adds ONE leading space between a word and a word", () => {
  expect(joinGhost("The quick", "brown fox")).toBe(" brown fox");
});

test("joinGhost: no extra space when the line already ends in a space", () => {
  expect(joinGhost("The quick ", "brown fox")).toBe("brown fox");
});

test("joinGhost: no space before leading punctuation", () => {
  expect(joinGhost("the deadline", ", which is Friday")).toBe(", which is Friday");
});

test("joinGhost: empty completion → empty (nothing to show/accept)", () => {
  expect(joinGhost("anything", "")).toBe("");
});

// ───────────────────────── ghostTabAction — Tab arbitration contract ─────────────────────────
test("ghostTabAction: a showing ghost makes Tab accept; no ghost falls through to list-indent", () => {
  expect(ghostTabAction(true)).toBe("accept");
  expect(ghostTabAction(false)).toBe("fallthrough");
});
