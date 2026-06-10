// Behavioral smoke suite — drives the REAL editor in Chromium. Run: `npx playwright test`.
// AI paths (cmd+K) replay from tests/e2e/.ai-cache (populated once, then deterministic).
// ProseMirror ignores DOM injection, so we type via keyboard and set selections via the
// editor's own API (window.__editor) — the reliable pattern for contenteditable editors.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const VAULT = resolve("tests/e2e/.vault");
mkdirSync(VAULT, { recursive: true });

async function openNote(page: Page, name: string, content: string): Promise<string> {
  const path = join(VAULT, name);
  writeFileSync(path, content);
  await page.goto("/?file=" + encodeURIComponent(path));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor);
  return path;
}
// start from a clean empty doc with the cursor inside the editor
async function clearAndFocus(page: Page) {
  await page.evaluate(() => (window as any).__editor.chain().clearContent().focus("end").run());
  await page.locator(".ProseMirror").click();
}

test("markdown shortcut: '# ' makes a heading", async ({ page }) => {
  await openNote(page, "md.md", "seed\n");
  await clearAndFocus(page);
  await page.keyboard.type("# Hello world");
  await expect(page.locator(".ProseMirror h1")).toHaveText("Hello world");
});

test("'[] ' makes a checkbox to-do", async ({ page }) => {
  await openNote(page, "todo.md", "seed\n");
  await clearAndFocus(page);
  await page.keyboard.type("[] buy milk");
  await expect(page.locator('ul[data-type="taskList"] li')).toContainText("buy milk");
  await expect(page.locator('ul[data-type="taskList"] input[type="checkbox"]')).toHaveCount(1);
});

test("slash menu opens, filters, and inserts", async ({ page }) => {
  await openNote(page, "slash.md", "seed\n");
  await clearAndFocus(page);
  await page.keyboard.type("/");
  await expect(page.locator(".slash")).toBeVisible();
  await expect(page.locator(".slash-group")).toContainText(["Writing", "Embeds", "AI"]);
  await page.keyboard.type("table");
  await expect(page.locator(".slash .slash-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror table")).toBeVisible();
});

test("selection toolbar appears and bold applies + persists", async ({ page }) => {
  await openNote(page, "bubble.md", "# t\n\nThe quick brown fox jumps.\n");
  await page.evaluate(() => {
    const e = (window as any).__editor; let from = 0, to = 0;
    e.state.doc.descendants((n: any, pos: number) => { if (n.isText) { const i = n.text.indexOf("quick brown"); if (i >= 0) { from = pos + i; to = pos + i + "quick brown".length; } } });
    e.chain().focus().setTextSelection({ from, to }).run(); e.view.focus();
  });
  await expect(page.locator(".bubble.show")).toBeVisible();
  await page.locator('.bubble [data-a="bold"]').click();
  await expect(page.locator(".ProseMirror strong")).toContainText("quick brown");
  await page.waitForTimeout(900); // let autosave flush
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".ProseMirror strong")).toContainText("quick brown");
});

test("mission: colored text in a rich block unwraps to EDITABLE prose", async ({ page }) => {
  await openNote(page, "color.md", '# c\n\n<div data-rich-block>Roses are <span style="color:#e0245e">red</span></div>\n');
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(0); // not atomic
  const editable = await page.evaluate(() => { const s = document.querySelector(".ProseMirror span[style*=color]"); return !!s && !s.closest("[contenteditable=false]"); });
  expect(editable).toBe(true);
});

test("font-styled text is editable AND preserved (generic mark)", async ({ page }) => {
  await openNote(page, "font.md", '# f\n\n<div data-rich-block><span style="font-family:Georgia,serif">serif words</span></div>\n');
  await expect(page.locator(".ProseMirror [style*=font-family]")).toBeVisible();
  const editable = await page.evaluate(() => { const s = document.querySelector(".ProseMirror [style*=font-family]"); return !!s && !s.closest("[contenteditable=false]"); });
  expect(editable).toBe(true);
});

test("SVG diagram stays an atomic rich block (not destroyed)", async ({ page }) => {
  await openNote(page, "svg.md", '# s\n\n<div data-rich-block><svg width="40" height="40"><circle cx="20" cy="20" r="16" fill="#7c3aed"/></svg></div>\n');
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(1);
  await expect(page.locator(".ProseMirror svg circle")).toBeVisible();
});

test("data safety: opening an HTML note does not rewrite it on disk", async ({ page }) => {
  const html = '<!DOCTYPE html><html><head><title>x</title></head><body><article><h1>Doc</h1><p>hi</p></article></body></html>\n';
  const path = await openNote(page, "safe.html", html);
  await page.waitForTimeout(1300); // well past the 600ms autosave debounce
  expect(readFileSync(path, "utf8")).toBe(html);
});

test("'/callout' inserts an editable callout (not a rich block)", async ({ page }) => {
  await openNote(page, "callout.md", "seed\n");
  await clearAndFocus(page);
  await page.keyboard.type("/callout");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror .callout")).toBeVisible();
  await page.keyboard.type("a tip here");
  await expect(page.locator(".ProseMirror .callout")).toContainText("a tip here"); // typed inside it = editable
});

test("cmd+K 'a 2x2 table' yields a NATIVE EDITABLE table, not a frozen rich block", async ({ page }) => {
  await openNote(page, "aitable.md", "# t\n\n");
  await clearAndFocus(page);
  await page.keyboard.press("Meta+k");
  const input = page.locator(".cmdk input");
  await expect(input).toBeVisible();
  await input.fill("a 2x2 pros and cons table");
  await input.press("Enter");
  await expect(page.locator(".ProseMirror table")).toBeVisible({ timeout: 60_000 }); // a real table rendered
  // the table is NOT trapped inside an atomic rich block, and its cells are editable
  await expect(page.locator(".ProseMirror [data-rich-block] table")).toHaveCount(0);
  const cellEditable = await page.evaluate(() => { const c = document.querySelector(".ProseMirror table td, .ProseMirror table th"); return !!c && !c.closest("[contenteditable=false]"); });
  expect(cellEditable).toBe(true);
});

// FULL_PARSE: a class/<style>-driven bespoke doc (the cheat-sheet case) opens as EDITABLE
// nested nodes — not one frozen rich block — renders with its real design, edits in place,
// and round-trips (design + <style> intact, edit persisted) through save/reload.
const CHEATSHEET = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Cheat Sheet</title>
<style>
  :root{--bg:#0b0c10;--panel:#13151c;--line:#262b38;--ink:#e8eaf0;--muted:#9aa3b2;--accent:#7c7cf0;--radius:13px}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:34px 22px}
  h1{font-size:30px;margin:0 0 6px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:24px}
  h2{font-size:12px;text-transform:uppercase;color:var(--accent);font-weight:700;margin:32px 0 14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 18px;margin:10px 0}
  .card h3{font-size:15px;margin:0 0 8px;color:#fff}
  .card ul{margin:0;padding-left:18px}
  .card li{margin:6px 0;color:#d7dbe6}
  b{color:#fff;font-weight:650}
  strong.t{color:#bcc3ff;font-weight:700}
</style></head>
<body>
<div class="wrap">
  <h1>Technical Cheat Sheet</h1>
  <div class="sub">Glance-only reference for the deep-dive.</div>
  <h2>Questions to Expect</h2>
  <div class="card"><h3>Tell me about yourself</h3><ul><li>I <b>co-founded a startup</b> and shipped over <b>nineteen months</b>.</li><li>Before that, <strong class="t">data pipelines</strong> at scale.</li></ul></div>
  <div class="card"><h3>Why us</h3><ul><li>Mission-driven and <b>local to me</b>.</li></ul></div>
  <div class="card"><h3>Strengths</h3><ul><li>Ownership and <b>shipping fast</b>.</li></ul></div>
</div>
</body></html>
`;

test("FULL_PARSE: class/<style> cheat-sheet is editable, styled, and round-trips", async ({ page }) => {
  const path = await openNote(page, "cheatsheet.html", CHEATSHEET);
  // 1. parsed into editable nodes, NOT one frozen rich block
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(0);
  await expect(page.locator(".ProseMirror .card")).toHaveCount(3);
  await expect(page.locator(".ProseMirror .wrap")).toHaveCount(1);
  // 2. the doc's <style> is live and scoped
  await expect(page.locator("#note-scoped")).toHaveCount(1);
  // 3. design intact: .card h3 is white via the scoped class rule; --accent resolves on the scope
  const h3color = await page.evaluate(() => { const h = document.querySelector(".ProseMirror .card h3"); return h ? getComputedStyle(h).color : ""; });
  expect(h3color).toBe("rgb(255, 255, 255)");
  const accent = await page.evaluate(() => getComputedStyle(document.querySelector("#editor.note-scope") as Element).getPropertyValue("--accent").trim());
  expect(accent).toBe("#7c7cf0");
  // 4. the styled text is genuinely editable (not inside a contenteditable=false block)
  const editable = await page.evaluate(() => { const els = Array.from(document.querySelectorAll(".ProseMirror .card b")); const b = els.find((e) => (e.textContent || "").includes("nineteen")); return !!b && !b.closest("[contenteditable=false]"); });
  expect(editable).toBe(true);
  // 5. edit a word in place — via real keystrokes (beforeinput arms autosave; synthetic
  // transactions deliberately don't, so load-time normalization never writes to disk)
  await page.evaluate(() => {
    const e = (window as any).__editor; let from = 0, to = 0;
    e.state.doc.descendants((n: any, pos: number) => { if (n.isText) { const i = n.text.indexOf("nineteen"); if (i >= 0) { from = pos + i; to = pos + i + "nineteen".length; } } });
    e.chain().focus().setTextSelection({ from, to }).run(); e.view.focus();
  });
  await page.keyboard.type("twelve");
  await expect(page.locator(".ProseMirror .card").first()).toContainText("twelve months");
  // 6. round-trip: persist, reload, design + edit survive; saved file keeps <style> + classes verbatim, no editor-only hook
  await page.waitForTimeout(1300); // past the 600ms autosave debounce
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("<style>");
  expect(saved).toContain(":root{--bg:#0b0c10");
  expect(saved).toContain('class="wrap"');
  expect(saved).toContain('class="card"');
  expect(saved).toContain("twelve months");
  expect(saved).not.toContain("nineteen months");
  expect(saved).not.toContain("data-sbox");
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".ProseMirror .card")).toHaveCount(3);
  await expect(page.locator(".ProseMirror .card").first()).toContainText("twelve months");
  const h3color2 = await page.evaluate(() => { const h = document.querySelector(".ProseMirror .card h3"); return h ? getComputedStyle(h).color : ""; });
  expect(h3color2).toBe("rgb(255, 255, 255)");
});

// FULL_PARSE (the real transformer-block shape): everything wrapped in <main><div
// data-rich-block><article> — a STALE rich-block marker pinning the whole article atomic, with
// one SVG figure nested deep. The engine must (a) ignore the stale marker, (b) recursively
// isolate ONLY the figure, leaving prose + classed blocks editable. Asserted via page.evaluate
// (real querySelectorAll — does NOT pierce shadow DOM — so counts are genuinely light-DOM).
const NESTED = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nested</title>
<style>
  :root{--accent:#6d5cf0}
  body{color:#111;font:16px/1.6 sans-serif}
  .callout{border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0}
  .callout h3{color:var(--accent);margin:0 0 6px}
  figure{margin:16px 0}
</style></head>
<body>
<main class="page"><div data-rich-block=""><article>
  <h1>Doc Title</h1>
  <p class="lede">Intro with <strong>this number</strong>: 42.</p>
  <figure class="diagram"><svg width="40" height="40"><circle cx="20" cy="20" r="16" fill="#6d5cf0"/></svg><figcaption>a diagram</figcaption></figure>
  <div class="callout"><h3>Note</h3><p>An editable callout.</p></div>
  <div class="callout"><h3>Second</h3><p>Also editable.</p></div>
</article></div></main>
</body></html>
`;

test("FULL_PARSE: stale data-rich-block marker is ignored; only the nested SVG figure freezes", async ({ page }) => {
  await openNote(page, "nested.html", NESTED);
  const r = await page.evaluate(() => {
    const pm = document.querySelector(".ProseMirror")!;
    const host = pm.querySelector("[data-rich-block]") as HTMLElement | null;
    return {
      richHosts: pm.querySelectorAll("[data-rich-block]").length,           // light DOM (host count)
      lightProse: pm.querySelectorAll("p, h1, h3").length,                  // editable, light DOM only
      callouts: pm.querySelectorAll(".callout").length,                    // editable styled boxes
      scoped: document.querySelectorAll("#note-scoped").length,
      hostCE: host?.getAttribute("contenteditable") || null,
      svgFrozenInShadow: !!(host?.shadowRoot?.querySelector("svg")),       // svg lives inside the frozen block's shadow
      figureKeptWhole: !!(host?.shadowRoot?.querySelector("figure.diagram figcaption")),
    };
  });
  expect(r.richHosts).toBe(1);            // ONLY the figure, not the whole article
  expect(r.lightProse).toBeGreaterThan(3); // h1 + paragraphs + callout headings are editable
  expect(r.callouts).toBe(2);             // both classed callouts editable
  expect(r.scoped).toBe(1);
  expect(r.hostCE).toBe("false");
  expect(r.svgFrozenInShadow).toBe(true);
  expect(r.figureKeptWhole).toBe(true);   // figure + caption + styling frozen together
  // editable prose resolves the scoped accent color and is genuinely editable
  const accentH3 = await page.evaluate(() => { const h = document.querySelector(".ProseMirror .callout h3"); return h ? getComputedStyle(h).color : ""; });
  expect(accentH3).toBe("rgb(109, 92, 240)");
  const editable = await page.evaluate(() => { const els = Array.from(document.querySelectorAll(".ProseMirror strong")); const s = els.find((e) => (e.textContent || "").includes("this number")); return !!s && !s.closest("[contenteditable=false]"); });
  expect(editable).toBe(true);
});

// CLOSURE INVARIANT: anything the editor itself authors must round-trip to the same
// editable thing. The bug this guards: a checklist authored in an .html note serialized as
// <ul data-type=taskList> with <label><input>, which the classifier then FROZE on reload —
// the app failed to re-read its own writing. Author → save → reload → still native.
test("closure: app-authored checklist survives reload as an editable task list (html note)", async ({ page }) => {
  const path = await openNote(page, "closure.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>c</title></head><body><article><h1>Closure</h1><p>seed</p></article></body></html>\n');
  await page.evaluate(() => { const e = (window as any).__editor; e.chain().focus("end").run(); e.view.focus(); });
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] first todo");
  await expect(page.locator('.ProseMirror ul[data-type="taskList"] li')).toHaveCount(1);
  await page.waitForTimeout(1300); // autosave
  expect(readFileSync(path, "utf8")).toContain('data-type="taskList"'); // persisted as the app's construct
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  // still a NATIVE editable task list — not a frozen rich block, checkbox still functional
  await expect(page.locator('.ProseMirror [data-rich-block]')).toHaveCount(0);
  await expect(page.locator('.ProseMirror ul[data-type="taskList"] li')).toHaveCount(1);
  await expect(page.locator('.ProseMirror ul[data-type="taskList"] input[type="checkbox"]')).toHaveCount(1);
  const editable = await page.evaluate(() => { const li = document.querySelector('.ProseMirror ul[data-type="taskList"] li div'); return !!li && !li.closest("[contenteditable=false]"); });
  expect(editable).toBe(true);
});

// QUALITY: after the AI rebuild (format-contract system prompt + Agent SDK), a "2x2
// pros/cons table" is a clean 2-column table — no 5-column spacer mess.
test("cmd+K 2x2 table is a clean 2-column Pros/Cons", async ({ page }) => {
  await openNote(page, "aitableq.md", "# t\n\n");
  await clearAndFocus(page);
  await page.keyboard.press("Meta+k");
  const input = page.locator(".cmdk input");
  await expect(input).toBeVisible();
  await input.fill("a 2x2 pros and cons table");
  await input.press("Enter");
  await expect(page.locator(".ProseMirror table")).toBeVisible({ timeout: 60_000 });
  const cols = await page.evaluate(() => { const r = document.querySelector(".ProseMirror table tr"); return r ? r.children.length : 0; });
  expect(cols).toBeLessThanOrEqual(2); // a pros/cons table is 2 columns; today the AI emits ~5
  await expect(page.locator(".ProseMirror table")).toContainText("Pros");
  await expect(page.locator(".ProseMirror table")).toContainText("Cons");
});
