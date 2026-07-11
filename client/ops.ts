// Structured-operation substrate (phase 2 — the co-authoring layer's Layer 1).
// This module is PURE: it imports only @tiptap/pm types and (later) ./engine — NEVER
// ./editor, never the DOM at import time — so it runs identically in the browser bundle,
// the verifier, and the MCP server process. The golden runner's op executor hoists here
// at gate K; gate I seeds the id scheme.
import type { Node as PMNode } from "@tiptap/pm/model";

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
