// Gate-I tests for the structured-op substrate (client/ops.ts) + the #83 preservation
// behavior in the engine: id/data-* survive the round-trip on modeled nodes, minted ids
// are deterministic per (docVersion, ordinal), splits never clone identity, and the
// dedupe core nulls exactly the pasted duplicate.
import { test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { engineExtensions, htmlToDoc, docToBody } from "../../client/engine";
import { fnv1a64, docVersionOf, mintIds, idDupePositions, findById, applyOp, validateOp, outline } from "../../client/ops";

const schema = getSchema(engineExtensions());
const toDoc = (html: string) => PMNode.fromJSON(schema, htmlToDoc(html));

// ————— fnv1a64 —————

test("fnv1a64: deterministic, fixed-width base36, input-sensitive", () => {
  expect(fnv1a64("hello")).toBe(fnv1a64("hello"));
  expect(fnv1a64("hello")).toHaveLength(13);
  expect(fnv1a64("hello")).not.toBe(fnv1a64("hellp"));
  expect(fnv1a64("")).toHaveLength(13);
});

// ————— #83 preservation through the engine —————

test("id + data-* on modeled nodes survive htmlToDoc → docToBody", () => {
  const body = docToBody(htmlToDoc(
    '<h2 id="sec-1" class="head">Title</h2>' +
    '<p id="p-lead">Lead</p>' +
    '<table><tr><th data-sort="asc" id="col-a">A</th></tr><tr><td id="cell-1">x</td></tr></table>' +
    '<span class="dot" id="dot-api"></span>'
  ));
  expect(body).toContain('id="sec-1"');
  expect(body).toContain('id="p-lead"');
  expect(body).toContain('data-sort="asc"');
  expect(body).toContain('id="col-a"');
  expect(body).toContain('id="cell-1"');
  expect(body).toContain('id="dot-api"');      // decoSpan (empty styled span) keeps its id too
});

test("id on marks is deliberately NOT preserved (mark splitting would duplicate it)", () => {
  const body = docToBody(htmlToDoc('<p>before <strong id="never">bold <em>both</em> bold</strong> after</p>'));
  expect(body).not.toContain('id="never"');
});

// ————— minting —————

test("mintIds: deterministic across two independent parses of the same bytes", () => {
  const raw = '<h2 id="head">Title</h2><p>one</p><p>two</p><ul><li>a</li></ul>';
  const v = docVersionOf(raw);
  const a = mintIds(toDoc(raw), v), b = mintIds(toDoc(raw), v);
  expect(a.size).toBeGreaterThan(0);
  expect([...a.entries()]).toEqual([...b.entries()]);
  a.forEach((id) => expect(id).toMatch(/^w-[0-9a-z]{4}$/));
});

test("mintIds: different docVersion ⇒ different ids; author-id nodes never minted", () => {
  const raw = '<h2 id="head">Title</h2><p>one</p>';
  const doc = toDoc(raw);
  const a = mintIds(doc, docVersionOf(raw)), b = mintIds(doc, docVersionOf(raw + " "));
  const ids = (m: Map<number, string>) => [...m.values()];
  expect(ids(a)).not.toEqual(ids(b));
  // the h2 carries an author id — no position may resolve to it
  doc.descendants((n: any, pos: number) => { if (n.attrs?.id === "head") expect(a.has(pos)).toBe(false); return true; });
});

test("mintIds: collision with an author id bumps deterministically", () => {
  const raw = "<p>one</p><p>two</p>";
  const v = docVersionOf(raw);
  const first = [...mintIds(toDoc(raw), v).values()];
  // plant the would-be first minted id as an AUTHOR id; same docVersion forced on purpose
  const planted = `<p id="${first[0]}">zero</p><p>one</p><p>two</p>`;
  const minted = [...mintIds(toDoc(planted), v).values()];
  expect(minted).not.toContain(first[0]);
  expect(new Set(minted).size).toBe(minted.length);   // and no self-collision
});

// ————— split / dedupe —————

// keepOnSplit:false is honored by TipTap's splitBlock (the interactive Enter path — covered
// in smoke e2e); a RAW ProseMirror tr.split copies attrs wholesale, id included. The dedupe
// core is the backstop for every such path: the clone must be flagged, the original kept.
test("a raw split clones the id — and idDupePositions flags exactly the clone", () => {
  const doc = toDoc('<h2 id="sec-1" class="head">Hello world</h2>');
  let pos = -1;
  doc.descendants((n: any, p: number) => { if (n.type.name === "heading") pos = p; return true; });
  const state = EditorState.create({ schema, doc });
  const tr = state.tr.split(pos + 6); // "Hello|_world"
  const dupes = idDupePositions(doc, tr.doc);
  expect(dupes).toHaveLength(1);
  let firstPos = -1; tr.doc.descendants((n: any, p: number) => { if (n.attrs?.id === "sec-1" && firstPos < 0) firstPos = p; return true; });
  expect(dupes[0]).toBeGreaterThan(firstPos);
});

test("idDupePositions: a pasted duplicate loses its id, the original keeps it", () => {
  const oldDoc = toDoc('<p id="p-1">alpha</p><p>beta</p>');
  const newDoc = toDoc('<p id="p-1">alpha</p><p>beta</p><p id="p-1">alpha</p>');
  const dupes = idDupePositions(oldDoc, newDoc);
  expect(dupes).toHaveLength(1);
  const n = newDoc.nodeAt(dupes[0]);
  expect(n?.textContent).toBe("alpha");
  // it's the LATER occurrence
  let firstPos = -1; newDoc.descendants((node: any, p: number) => { if (node.attrs?.id === "p-1" && firstPos < 0) firstPos = p; return true; });
  expect(dupes[0]).toBeGreaterThan(firstPos);
});

test("idDupePositions: pre-existing author duplicates are untouched; distinct ids untouched", () => {
  const dupes = toDoc('<p id="x">a</p><p id="x">b</p>');
  expect(idDupePositions(dupes, dupes)).toHaveLength(0);           // load: count unchanged
  const clean = toDoc('<p id="a">a</p><p id="b">b</p>');
  expect(idDupePositions(clean, clean)).toHaveLength(0);
});

// ————— gate K: id-addressed layer (findById / setText / validateOp / outline) —————

const RAW = '<h2 id="sec-1">Title</h2><p>lead paragraph</p><p>second</p>';

test("findById: persisted id direct; provisional id via the minted map", () => {
  const doc = toDoc(RAW);
  expect(findById(doc, "sec-1")?.node.type.name).toBe("heading");
  expect(findById(doc, "w-zzzz")).toBeNull();
  const minted = mintIds(doc, docVersionOf(RAW));
  const [pos, mid] = [...minted.entries()][0];
  const hit = findById(doc, mid, minted);
  expect(hit?.pos).toBe(pos);
});

test("setText: replaces inline content; a provisional id persists in the SAME transaction", () => {
  const doc = toDoc(RAW);
  const minted = mintIds(doc, docVersionOf(RAW));
  const target = [...minted.values()][0];                          // first id-less block (the lead <p>)
  const after = applyOp(doc, { kind: "setText", nodeId: target, text: "rewritten" }, minted);
  const saved = docToBody(after.toJSON());
  expect(saved).toContain(`id="${target}"`);                       // persist-on-touch
  expect(saved).toContain(">rewritten</p>");
  expect(saved).toContain('id="sec-1"');                           // untouched author id intact
  expect((saved.match(/w-/g) || []).length).toBe(1);               // ONLY the touched node gained an id
});

test("setText: addressing an author id works without a minted map", () => {
  const after = applyOp(toDoc(RAW), { kind: "setText", nodeId: "sec-1", text: "New title" });
  expect(docToBody(after.toJSON())).toContain('<h2 id="sec-1">New title</h2>');
});

test("validateOp: agent-readable rejections — node_not_found and kind_incompatible", () => {
  const doc = toDoc('<div class="card" id="box"><p id="p1">inner</p></div>');
  const missing = validateOp(doc, { kind: "setText", nodeId: "nope", text: "x" });
  expect(missing).toMatchObject({ ok: false, code: "node_not_found" });
  const container = validateOp(doc, { kind: "setText", nodeId: "box", text: "x" });
  expect(container).toMatchObject({ ok: false, code: "kind_incompatible" });
  expect((container as any).message).toContain("styledBox");
  expect(validateOp(doc, { kind: "setText", nodeId: "p1", text: "x" })).toEqual({ ok: true });
});

test("outline: document-order blocks with paths, hashes, pristine flags", () => {
  const doc = toDoc(RAW);
  const o = outline(doc, docVersionOf(RAW));
  expect(o.map((b) => b.kind)).toEqual(["heading", "paragraph", "paragraph"]);
  expect(o[0]).toMatchObject({ id: "sec-1", authorId: true, pristine: false, depth: 0, path: [0] });
  expect(o[1].authorId).toBe(false);
  expect(o[1].id).toMatch(/^w-[0-9a-z]{4}$/);
  expect(o[1].textHash).toBe(fnv1a64("lead paragraph"));
  // deterministic across parses
  const o2 = outline(toDoc(RAW), docVersionOf(RAW));
  expect(o2.map((b) => b.id)).toEqual(o.map((b) => b.id));
});
