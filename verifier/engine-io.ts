// DOM bootstrap + engine round-trip primitives for the verifier.
// IMPORTANT: happy-dom registration must precede any engine CALL (module-scope is safe —
// the engine touches no DOM at import time; proven by tests/unit/engine.test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import { prepareDoc, serializeDoc, htmlToDoc, docToBody, type PreparedDoc } from "../client/engine";

export interface RoundTrip {
  prep: PreparedDoc;
  t1: any;        // tree parsed from the source content
  s1: string;     // engine save of t1 (full doc bytes)
  t2: any;        // tree re-parsed from s1 — roundtrip compares canon(t1) vs canon(t2)
  s2: string;     // save of t2
  s3: string;     // save of the re-parse of s2 — settle requires s3 === s2
}

export function engineSave(raw: string): { prep: PreparedDoc; t1: any; s1: string } {
  const prep = prepareDoc(raw);
  const t1 = htmlToDoc(prep.content);
  return { prep, t1, s1: serializeDoc(docToBody(t1), prep) };
}

export function roundTrip(raw: string): RoundTrip {
  const a = engineSave(raw);
  const b = engineSave(a.s1);
  const c = engineSave(b.s1);
  return { prep: a.prep, t1: a.t1, s1: a.s1, t2: b.t1, s2: b.s1, s3: c.s1 };
}

// canonical tree form for tree-identity comparison: attr keys sorted, null/absent attrs
// dropped, text + marks kept verbatim. Tree identity, not byte identity.
export function canon(node: any): any {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(canon);
  const out: any = {};
  for (const k of Object.keys(node).sort()) {
    const v = (node as any)[k];
    if (k === "attrs" && v && typeof v === "object") {
      const attrs: any = {};
      for (const ak of Object.keys(v).sort()) if (v[ak] != null) attrs[ak] = v[ak];
      if (Object.keys(attrs).length) out.attrs = attrs;
    } else if (v != null) out[k] = canon(v);
  }
  return out;
}

export const canonEq = (a: any, b: any) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// parse an HTML string into a detached fragment for DOM queries
export function frag(html: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}
