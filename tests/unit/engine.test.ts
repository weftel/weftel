// Gate-B spike for the extracted round-trip engine (client/engine.ts): prove the ENGINE
// runs headless — prepareDoc → generateJSON → generateHTML → serializeDoc under happy-dom —
// and that its output settles and matches the real browser's saved bytes.
// Run: `bun test tests/unit/engine.test.ts`.
//
// Parity test: `corpus_idem__<subset>__<file>` artifacts in tests/e2e/.vault are the exact
// bytes the LIVE editor's window.__serialize() produced for the same fixture source (written
// by tests/e2e/corpus.spec.ts step 3.5). Engine output vs that artifact = headless-vs-browser
// differential. Skipped when the artifact is absent (corpus e2e not run on this machine).
import { test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prepareDoc, serializeDoc, htmlToDoc, docToBody } from "../../client/engine";

const CORPUS = join(import.meta.dir, "../e2e/corpus");
const VAULT = join(import.meta.dir, "../e2e/.vault");

// one full engine round-trip: raw file bytes → saved file bytes
function engineSave(src: string): string {
  const prep = prepareDoc(src);
  return serializeDoc(docToBody(htmlToDoc(prep.content)), prep);
}

// visible-text normalization (verbatim from corpus.spec.ts): drop comments + style/script
// bodies, strip tags, unescape entities, collapse whitespace — content loss shows as a
// character-sequence divergence.
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}
const strip = (s: string) => visibleText(s).replace(/\s+/g, "");

const FIXTURES = [
  "schema/table.html",
  "styling-source/class-and-style.html",
  "real-published/adamw.html",
];

for (const rel of FIXTURES) {
  const src = readFileSync(join(CORPUS, rel), "utf8");

  test(`engine headless round-trip runs: ${rel}`, () => {
    const s1 = engineSave(src);
    expect(s1.length).toBeGreaterThan(0);
    expect(s1).toContain("<!DOCTYPE html>");
    // no content lost (same standard as corpus e2e step 2)
    expect(strip(s1)).toBe(strip(src));
  });

  test(`engine serialization settles: ${rel}`, () => {
    const s1 = engineSave(src);
    const s2 = engineSave(s1);
    if (s2 !== s1) {
      const s3 = engineSave(s2);
      expect(s3, "engine serialization never settles").toBe(s2);
    }
  });
}

// headless-vs-browser parity: engine bytes vs the live editor's saved bytes for the SAME source.
// KNOWN DIVERGENCES (characterized 2026-07-10, gate-B spike; will be pinned in verifier/expectations.ts):
//   • trailing <p></p>: the LIVE editor appends an empty escape paragraph after a doc-final
//     non-paragraph block; headless generateJSON doesn't. Normalized below on both sides.
//   • nested styled spans + modern CSS fns (real-published/adamw.html badge spans): TipTap
//     TextStyle defaults mergeNestedSpanStyles:true, which MUTATES the child span's style attr
//     at parse. Chromium's CSSOM keeps color-mix(); happy-dom's CSS parser rejects the whole
//     declaration block (cssText === ""), so the merged style loses it. (The browser side is
//     itself a save-mutation — the child span gains the parent's color — an F40-class issue
//     to file on the board.) adamw is therefore expected-divergent here.
const dropTrailingEmptyP = (s: string) => s.replace(/<p><\/p>(\s*<\/(?:article|main|section|div|body)>)/, "$1");
const PARITY_XFAIL = new Set(["real-published/adamw.html"]); // mergeNestedSpanStyles × color-mix, see above
for (const rel of FIXTURES) {
  const artifact = join(VAULT, "corpus_idem__" + rel.replace("/", "__"));
  const t = !existsSync(artifact) || PARITY_XFAIL.has(rel) ? test.skip : test;
  t(`engine output matches browser __serialize: ${rel}`, () => {
    const src = readFileSync(join(CORPUS, rel), "utf8");
    const browserSave = readFileSync(artifact, "utf8");
    expect(dropTrailingEmptyP(engineSave(src))).toBe(dropTrailingEmptyP(browserSave));
  });
}
