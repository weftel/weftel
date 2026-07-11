// Gate-J spike (#93): what does the REAL browser do to authored inline-style strings on
// save? Three answers, each pinned as a spec so drift is loud:
//   1. mergeNestedSpanStyles:false holds — a nested span never GAINS its parent's color
//      (the #93 value-level mutation, fixed at gate J).
//   2. Modern CSS functions (color-mix, var()) survive verbatim in Chromium saved bytes —
//      the headless verifier LOSES them (happy-dom CSSOM, see fidelity-verify GOTCHAS);
//      this spec is the browser-truth backstop for that verifier limitation.
//   3. KNOWN RED (#102): the styled-box family's style STRING is rewritten on first save
//      (hex→rgb, spacing) by some CSSOM pass — value-preserving but byte-mutating.
//      test.fail() keeps the suite green until #102 is fixed, then flips loudly.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const VAULT = resolve("tests/e2e/.vault");
mkdirSync(VAULT, { recursive: true });

async function openNote(page: Page, name: string, content: string): Promise<void> {
  const path = join(VAULT, name);
  writeFileSync(path, content);
  await page.goto("/?file=" + encodeURIComponent(path));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
}
const doc = (body: string) => '<!DOCTYPE html><html><head><meta charset="utf-8"><title>s</title></head><body><article>' + body + "</article></body></html>\n";

test("#93 flip guard: a nested span never gains its parent's color on save", async ({ page }) => {
  await openNote(page, "style-nested.html", doc('<p><span style="color:#c9302c">outer <span class="badge" style="background:#eeeeee">inner</span> text</span></p>'));
  const out: string = await page.evaluate(() => (window as any).__serialize());
  const badge = out.match(/<span[^>]*class="badge"[^>]*>/)?.[0] || "";
  expect(badge, "badge span must exist in saved bytes").not.toBe("");
  expect(badge, "nested span GAINED the parent color — mergeNestedSpanStyles regressed").not.toContain("color:");
});

test("modern CSS fns (color-mix, var) survive in browser saved bytes", async ({ page }) => {
  await openNote(page, "style-modern.html", doc('<p><span class="badge" style="background: color-mix(in srgb, var(--bad) 10%, #ffffff)">chip</span></p>'));
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).toContain("color-mix(in srgb, var(--bad) 10%,");
});

// KNOWN RED — #102. The authored string should survive BYTE-verbatim; today some CSSOM
// pass rewrites it (hex→rgb, spacing) on first save. test.fail(): when #102 is fixed this
// test "unexpectedly passes" and forces removing the marker — xpass semantics, playwright-style.
test("#102 (expected fail): authored shorthand + hex style survives byte-verbatim on a styled box", async ({ page }) => {
  test.fail(true, "#102: first browser save rewrites styled-box style strings (hex→rgb, spacing)");
  await openNote(page, "style-shorthand.html", doc('<div style="border-top:4px solid #c9302c;flex:1"><p>content line</p></div>'));
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).toContain('style="border-top:4px solid #c9302c;flex:1"');
});
