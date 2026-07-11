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
import { fnv1a64, docVersionOf, mintIds, idDupePositions } from "../../client/ops";

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
