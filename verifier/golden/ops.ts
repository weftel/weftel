// Deterministic op executor: applies a scripted Op to a doc as headless ProseMirror
// transactions (EditorState.create({doc}) — no view). These ops STAND IN for the phase-2
// agent so the graded outcomes are stable; the same vocabulary later becomes the
// structured-operation tool layer's reference semantics.
import { EditorState } from "@tiptap/pm/state";
import { Node as PMNode, Fragment, Slice } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/core";
import { engineExtensions, htmlToDoc } from "../../client/engine";
import type { NodeMatch, Op } from "./types";

export const schema = getSchema(engineExtensions());

interface Found { node: PMNode; pos: number }

export function findNode(doc: PMNode, m: NodeMatch): Found {
  const hits: Found[] = [];
  doc.descendants((node, pos) => {
    if (m.type && node.type.name !== m.type) return true;
    if (m.textContains && !node.textContent.includes(m.textContains)) return true;
    hits.push({ node, pos });
    return true;
  });
  // prefer the SHALLOWEST/most specific: for type matches keep order; index selects
  const hit = hits[m.index ?? 0];
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

export function applyOp(doc: PMNode, op: Op): PMNode {
  let state = EditorState.create({ schema, doc });
  const run = (o: Op) => {
    const d = state.doc;
    const tr = state.tr;
    switch (o.kind) {
      case "replaceText": {
        const { from, to } = findText(d, o.find);
        tr.replaceWith(from, to, o.replace ? schema.text(o.replace, d.resolve(from).marks()) : Fragment.empty);
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
        const nodes = (frag.content || []).map((n: any) => PMNode.fromJSON(schema, n));
        tr.insert(f.pos + f.node.nodeSize, nodes);
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
        const mt = schema.marks[o.mark];
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
