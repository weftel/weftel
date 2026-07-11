// Structured-operation substrate (phase 2 — the co-authoring layer's Layer 1).
// This module is PURE: it imports only ./engine + @tiptap/* — NEVER ./editor, never the
// DOM at import time — so it runs identically in the browser bundle, the verifier, and
// the MCP server process. It is the ONE semantics source for ops: the golden runner
// (verifier/golden/ops.ts is a re-export shim) and the MCP tool layer both execute
// through applyOp, so the grader and the product cannot drift.
import { EditorState } from "@tiptap/pm/state";
import { Node as PMNode, Fragment } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/core";
import { engineExtensions, htmlToDoc } from "./engine";

export const schema = getSchema(engineExtensions());

// ————— addressing —————

export interface NodeMatch {
  type?: string;          // PM node type name (e.g. "heading", "table", "callout")
  textContains?: string;  // node whose text content contains this
  index?: number;         // nth match (default 0)
}

export type Op =
  | { kind: "setText"; nodeId: string; text: string }       // id-addressed: replace a block's inline content with plain text
  | { kind: "replaceText"; find: string; replace: string }
  | { kind: "setNodeAttr"; match: NodeMatch; attrs: Record<string, any> }
  | { kind: "insertBlock"; after: NodeMatch; html: string }
  | { kind: "appendItem"; list: NodeMatch; text: string }   // append a real <li> INSIDE a list
  | { kind: "deleteBlock"; match: NodeMatch }
  | { kind: "moveBlock"; match: NodeMatch; to: "before" | "after"; anchor: NodeMatch }
  | { kind: "sortTable"; match: NodeMatch; column: number; order: "asc" | "desc"; numeric?: boolean }
  | { kind: "wrapMark"; find: string; mark: string; attrs?: Record<string, any> }
  | { kind: "sequence"; ops: Op[] };

interface Found { node: PMNode; pos: number }

export function findNode(doc: PMNode, m: NodeMatch): Found {
  const hits: Found[] = [];
  doc.descendants((node, pos) => {
    if (m.type && node.type.name !== m.type) return true;
    if (m.textContains && !node.textContent.includes(m.textContains)) return true;
    hits.push({ node, pos });
    return true;
  });
  // Ambiguity rule (gate-F catch): a textContains match resolves to the INNERMOST hit —
  // "the box containing 'Revenue'" means the Revenue card, not the flex wrapper that also
  // contains that text. document-order-first picked the wrapper and the grader, querying
  // through the same resolver, agreed with the wrong answer. Explicit `index` still
  // selects in document order. (The id-addressed layer below sidesteps this whole class.)
  const ordered = m.textContains && m.index == null ? [...hits].sort((a, b) => a.node.nodeSize - b.node.nodeSize) : hits;
  const hit = ordered[m.index ?? 0];
  if (!hit) throw new Error("findNode: no match for " + JSON.stringify(m));
  return hit;
}

function findText(doc: PMNode, find: string): { from: number; to: number } {
  let out: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (out || !node.isText) return !out;
    const i = (node.text || "").indexOf(find);
    if (i >= 0) out = { from: pos + i, to: pos + i + find.length };
    return !out;
  });
  if (!out) throw new Error(`findText: "${find}" not found`);
  return out;
}

const topLevelBlock = (doc: PMNode, m: NodeMatch): Found => {
  // resolve to the OUTERMOST block containing the match (for insert/move/delete)
  const inner = findNode(doc, m);
  const $pos = doc.resolve(inner.pos + 1);
  const depth = 1;
  const pos = $pos.before(depth);
  return { node: $pos.node(depth), pos };
};

// Resolve a nodeId — persisted author/minted id in attrs first, then the provisional
// minted map (an id the doc hasn't been touched with yet).
export function findById(doc: PMNode, id: string, minted?: Map<number, string>): Found | null {
  let out: Found | null = null;
  doc.descendants((n: any, pos: number) => {
    if (out) return false;
    if (n.attrs && n.attrs.id === id) { out = { node: n, pos }; return false; }
    return true;
  });
  if (!out && minted) {
    for (const [pos, mid] of minted) {
      if (mid === id) { const n = doc.nodeAt(pos); if (n) return { node: n, pos }; }
    }
  }
  return out;
}

// Pre-flight validation with agent-readable rejections (sketch contract: "invalid op →
// rejected with a reason the agent can read and retry").
export function validateOp(doc: PMNode, op: Op, minted?: Map<number, string>): { ok: true } | { ok: false; code: string; message: string } {
  if (op.kind === "setText") {
    const hit = findById(doc, op.nodeId, minted);
    if (!hit) return { ok: false, code: "node_not_found", message: `no block with id "${op.nodeId}" — call weftel_read_doc for fresh ids and retry` };
    if (!hit.node.isTextblock) return { ok: false, code: "kind_incompatible", message: `block "${op.nodeId}" is a ${hit.node.type.name} (a container, not a text block) — setText targets text-bearing blocks; address one of its inner blocks instead` };
    return { ok: true };
  }
  if (op.kind === "sequence") {
    for (const s of op.ops) { const v = validateOp(doc, s, minted); if (!v.ok) return v; }
    return { ok: true };
  }
  try {
    if ("match" in op) findNode(doc, op.match);
    if ("after" in op) findNode(doc, op.after);
    if ("list" in op) findNode(doc, { type: "bulletList", ...op.list });
    if ("anchor" in op) findNode(doc, op.anchor);
    if ("find" in op) findText(doc, op.find);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, code: "target_not_found", message: String(e?.message || e) + " — call weftel_read_doc and retry with a fresh target" };
  }
}

export function applyOp(doc: PMNode, op: Op, minted?: Map<number, string>): PMNode {
  // Always create content through the DOC's own schema instance — a caller may hold a doc
  // built by a different getSchema(engineExtensions()) call, and ProseMirror silently drops
  // cross-schema-instance content on replace (same extensions ≠ same instance).
  const s = doc.type.schema;
  let state = EditorState.create({ schema: s, doc });
  const run = (o: Op) => {
    const d = state.doc;
    const tr = state.tr;
    switch (o.kind) {
      case "setText": {
        const hit = findById(d, o.nodeId, minted);
        if (!hit) throw new Error("setText: no block with id " + o.nodeId);
        // persist-on-touch: a provisional id becomes real in the SAME transaction as the
        // edit (setNodeMarkup first — it changes no sizes, so the content positions hold)
        if ("id" in hit.node.attrs && hit.node.attrs.id == null) tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, id: o.nodeId });
        tr.replaceWith(hit.pos + 1, hit.pos + 1 + hit.node.content.size, o.text ? s.text(o.text) : Fragment.empty);
        break;
      }
      case "replaceText": {
        const { from, to } = findText(d, o.find);
        tr.replaceWith(from, to, o.replace ? s.text(o.replace, d.resolve(from).marks()) : Fragment.empty);
        break;
      }
      case "setNodeAttr": {
        const f = findNode(d, o.match);
        tr.setNodeMarkup(f.pos, undefined, { ...f.node.attrs, ...o.attrs });
        break;
      }
      case "insertBlock": {
        const f = topLevelBlock(d, o.after);
        const frag = htmlToDoc(o.html);
        const nodes = (frag.content || []).map((n: any) => PMNode.fromJSON(s, n));
        tr.insert(f.pos + f.node.nodeSize, nodes);
        break;
      }
      case "appendItem": {
        // insertBlock adds SIBLINGS; a list addition must land INSIDE the list as a real
        // item (gate-F review caught the paragraph-after-the-list failure mode).
        const f = findNode(d, { type: "bulletList", ...o.list });
        const itemType = f.node.type.name === "taskList" ? "taskItem" : "listItem";
        const item = s.nodes[itemType].createChecked(
          itemType === "taskItem" ? { checked: false } : null,
          s.nodes.paragraph.createChecked(null, s.text(o.text)),
        );
        tr.insert(f.pos + f.node.nodeSize - 1, item);
        break;
      }
      case "deleteBlock": {
        const f = topLevelBlock(d, o.match);
        tr.delete(f.pos, f.pos + f.node.nodeSize);
        break;
      }
      case "moveBlock": {
        const f = topLevelBlock(d, o.match);
        const slice = d.slice(f.pos, f.pos + f.node.nodeSize);
        tr.delete(f.pos, f.pos + f.node.nodeSize);
        const anchor = topLevelBlock(tr.doc, o.anchor);
        const at = o.to === "before" ? anchor.pos : anchor.pos + anchor.node.nodeSize;
        tr.replace(at, at, slice);
        break;
      }
      case "sortTable": {
        const f = findNode(d, { ...o.match, type: o.match.type || "table" });
        const rows: PMNode[] = [];
        f.node.forEach((r) => rows.push(r));
        const header = rows.filter((r) => r.child(0)?.type.name === "tableHeader");
        const body = rows.filter((r) => r.child(0)?.type.name !== "tableHeader");
        const key = (r: PMNode) => r.child(Math.min(o.column, r.childCount - 1)).textContent.trim();
        body.sort((a, b) => {
          const ka = key(a), kb = key(b);
          const cmp = o.numeric ? parseFloat(ka) - parseFloat(kb) : ka.localeCompare(kb);
          return o.order === "asc" ? cmp : -cmp;
        });
        const table = f.node.type.create(f.node.attrs, Fragment.from([...header, ...body]));
        tr.replaceWith(f.pos, f.pos + f.node.nodeSize, table);
        break;
      }
      case "wrapMark": {
        const { from, to } = findText(d, o.find);
        const mt = s.marks[o.mark];
        if (!mt) throw new Error("no such mark: " + o.mark);
        tr.addMark(from, to, mt.create(o.attrs || {}));
        break;
      }
      case "sequence":
        o.ops.forEach((s) => run(s));
        return;
    }
    state = state.apply(tr);
  };
  run(op);
  return state.doc;
}

// ————— fnv1a64: the one hash everything id-shaped derives from —————
// Sync, pure-TS, byte-for-byte identical in the browser and Bun (no async crypto.subtle).
// Output is fixed-width base36 (13 chars) so 4-char windows are well-defined.
const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK64 = 0xffffffffffffffffn;
export function fnv1a64(s: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * FNV_PRIME) & MASK64; }
  return h.toString(36).padStart(13, "0");
}

// The doc version IS the hash of the file bytes: any process holding the same bytes derives
// the same version, so provisional ids agree across processes with no map to exchange.
export const docVersionOf = (rawBytes: string): string => fnv1a64(rawBytes);

// ————— provisional id minting (policy: mint on co-authoring touch) —————
// Deterministic: id for the Nth block of a given docVersion is a pure function of
// (docVersion, N) — the MCP read and a later set_text over the same bytes mint identical
// ids. Ids persist to disk ONLY when an approved edit touches that node (the apply
// transaction writes the one touched id); everything else stays byte-pristine.
// Format: "w-" + 4 base36 chars, collision-bumped against every id already in the doc
// (author or minted) by extending the hash seed — never by scanning windows, so a bump
// is itself deterministic.
export function mintIds(doc: PMNode, docVersion: string): Map<number, string> {
  const taken = new Set<string>();
  doc.descendants((n: any) => { if (n.attrs && n.attrs.id) taken.add(String(n.attrs.id)); return true; });
  const out = new Map<number, string>();
  let ordinal = 0;
  doc.descendants((n: any, pos: number) => {
    if (!n.isBlock) return true;
    const mintable = n.attrs && "id" in n.attrs;   // type carries an id attr (richBlock etc. don't)
    if (mintable && n.attrs.id == null) {
      let id = "", attempt = 0;
      do { id = "w-" + fnv1a64(docVersion + ":" + ordinal + (attempt ? ":" + attempt : "")).slice(0, 4); attempt++; } while (taken.has(id));
      taken.add(id); out.set(pos, id);
    }
    ordinal++;                                      // count EVERY block so ordinals are stable
    return true;
  });
  return out;
}

// ————— outline: the agent's view of a doc (weftel_read_doc payload) —————
export interface OutlineBlock {
  id: string | null;      // author id, persisted minted id, or provisional minted id; null = unaddressable (e.g. frozen richBlock)
  authorId: boolean;      // true = the id was already in the file bytes
  kind: string;           // PM node type name
  depth: number;          // 0 = top-level block
  path: number[];         // child indices from the doc root (structural fallback address)
  text: string;           // preview, ≤120 chars
  textHash: string;       // fnv1a64 of the FULL textContent — the op precondition
  pristine: boolean;      // true = this block carries no persisted id yet
}

export function outline(doc: PMNode, docVersion: string): OutlineBlock[] {
  const minted = mintIds(doc, docVersion);
  const out: OutlineBlock[] = [];
  const walk = (parent: PMNode, base: number, depth: number, path: number[]) => {
    parent.forEach((child: any, offset: number, index: number) => {
      if (!child.isBlock) return;
      const pos = base + offset;
      const authorId = !!(child.attrs && child.attrs.id);
      const id = authorId ? String(child.attrs.id) : (minted.get(pos) ?? null);
      out.push({ id, authorId, kind: child.type.name, depth, path: [...path, index], text: child.textContent.slice(0, 120), textHash: fnv1a64(child.textContent), pristine: !authorId });
      walk(child, pos + 1, depth + 1, [...path, index]);
    });
  };
  walk(doc, 0, 0, []);
  return out;
}

// ————— id dedupe (editor-side policy, pure core) —————
// A human paste/duplicate must not clone identity: when a transaction INCREASES an id's
// count, every occurrence after the first (document order) loses its id — nulled, never
// re-minted (a paste is not a co-authoring touch, and a duplicated w-* id would silently
// misdirect future ops). Pre-existing author duplicates loaded from disk are the author's
// content: count unchanged ⇒ untouched. Returns the positions to null.
export function idDupePositions(oldDoc: PMNode, newDoc: PMNode): number[] {
  const count = (d: PMNode) => {
    const m = new Map<string, number>();
    d.descendants((n: any) => { const id = n.attrs && n.attrs.id; if (id) m.set(id, (m.get(id) || 0) + 1); return true; });
    return m;
  };
  const before = count(oldDoc), after = count(newDoc);
  const seen = new Set<string>(), out: number[] = [];
  newDoc.descendants((n: any, pos: number) => {
    const id = n.attrs && n.attrs.id; if (!id) return true;
    if (seen.has(id)) {
      if ((after.get(id) || 0) > (before.get(id) || 0) && (before.get(id) || 0) <= 1) out.push(pos);
    } else seen.add(id);
    return true;
  });
  return out;
}
