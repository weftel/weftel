// Behavioral smoke suite — drives the REAL editor in Chromium. Run: `npx playwright test`.
// AI paths (cmd+K) replay from tests/e2e/.ai-cache (populated once, then deterministic).
// ProseMirror ignores DOM injection, so we type via keyboard and set selections via the
// editor's own API (window.__editor) — the reliable pattern for contenteditable editors.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
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

// IMAGE PASTE + CLOSURE: pasting an image writes a sidecar file (<note-dir>/assets/) and
// inserts a NATIVE image node with the portable relative src; on reload it must still be
// the editable node (the closure rule — a freshly pasted image that froze would be the
// taskList bug all over again).
test("closure: pasted image → sidecar asset + native node, survives reload", async ({ page }) => {
  const path = await openNote(page, "imgpaste.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>i</title></head><body><article><h1>Img</h1><p>seed text</p></article></body></html>\n');
  await page.evaluate(() => { const e = (window as any).__editor; e.chain().focus("end").run(); e.view.focus(); });
  // dispatch a real paste event carrying a tiny PNG file (Chromium supports constructing this)
  await page.evaluate(() => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPIjfkAAALzAbqUxO1lAAAAAElFTkSuQmCC";
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], "shot.png", { type: "image/png" });
    const dt = new DataTransfer(); dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".ProseMirror")!.dispatchEvent(ev);
  });
  // node appears, displayed through /raw, saved src is the portable relative path
  await expect(page.locator(".ProseMirror img.note-img")).toHaveCount(1, { timeout: 5000 });
  const disp = await page.evaluate(() => (document.querySelector(".ProseMirror img.note-img") as HTMLImageElement).getAttribute("src") || "");
  expect(disp).toContain("/raw?file=");
  await page.waitForTimeout(1300); // autosave
  const saved = readFileSync(path, "utf8");
  const m = saved.match(/<img[^>]*src="(assets\/img-[^"]+\.png)"/);
  expect(m, "saved file should reference the relative sidecar src").toBeTruthy();
  // the sidecar file actually exists in the vault
  expect(existsSync(join(VAULT, m![1]))).toBe(true);
  // closure: reload → still a native editable image node, not frozen
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(0);
  await expect(page.locator(".ProseMirror img.note-img")).toHaveCount(1);
});

// F12: empty decorative spans (CSS dots) and nested span wrappers used to be SILENTLY
// DROPPED from the saved file (PM drops empty inlines; same-type marks can't nest, so the
// outer wrapper vanished). Empty spans are now an inline atom; nested-span subtrees freeze
// as a minimal leaf. Either way: bytes preserved.
test("spans: empty decorative spans and nested span wrappers survive save", async ({ page }) => {
  await openNote(page, "spans.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>s</title><style>.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#15803d}.meter .on{color:#15803d}</style></head><body><article><div class="box"><div class="t"><span class="dot"></span>server.ts</div><p>level <span class="meter"><span class="on">●●</span><span class="off">○</span></span> done</p></div></article></body></html>\n');
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).toContain('class="dot"');    // empty span survives (was silently dropped)
  // nested spans round-trip EXACTLY as nested editable nodes — no freeze, no merge/split
  expect(out).toContain('<span class="meter"><span class="on">●●</span><span class="off">○</span></span>');
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(0);
  // and the dot is visible in the editor, styled by the scoped sheet
  const dotBg = await page.evaluate(() => { const d = document.querySelector(".ProseMirror .dot"); return d ? getComputedStyle(d).backgroundColor : null; });
  expect(dotBg).toBe("rgb(21, 128, 61)");
});

// The table extension leaked editor defaults into saved files (colspan="1" everywhere, a
// min-width <colgroup> scaffold, every cell's text wrapped in <p> — which renders with
// default margins outside the editor). Found by the authoring agent diffing its own file.
test("table: save carries no editor scaffolding, cells stay unwrapped", async ({ page }) => {
  await openNote(page, "tbl.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body><article><table class="kv"><tbody><tr><td>alpha</td><td>has <code>code</code></td></tr></tbody></table></article></body></html>\n');
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).not.toContain('colspan="1"');
  expect(out).not.toContain("min-width");
  expect(out).not.toContain("<colgroup");
  expect(out).toContain("<td>alpha</td>");                  // no <p> wrapper in simple cells
  expect(out).toContain('class="kv"');
});

// Enter at the end of a classed paragraph starts a CLEAN paragraph — fresh typing used
// to inherit the previous line's class (p.lead) and look mysteriously styled.
test("enter after a classed paragraph yields an unclassed paragraph", async ({ page }) => {
  await openNote(page, "cls.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>c</title><style>.lead{color:#888}</style></head><body><article><p class="lead">lede line</p></article></body></html>\n');
  await page.evaluate(() => { const e = (window as any).__editor; e.chain().focus("end").run(); e.view.focus(); });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("fresh line");
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).toContain('<p class="lead">lede line</p>');
  expect(out).toMatch(/<p>fresh line<\/p>/);                // no inherited class
});

// Classed spans are inline NODES, not marks: as marks, adjacent same-class spans MERGED
// (two pills → one) and a span containing bold/code SPLIT into fragments (breaking flex
// layouts). Element identity must survive the round-trip exactly.
test("spans: adjacent classed spans don't merge, marked-up classed spans don't split", async ({ page }) => {
  await openNote(page, "pills.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>p</title><style>.pill{border:1px solid #ccc;border-radius:5px;padding:1px 7px}.what{color:#555}</style></head><body><article><div style="margin-top:8px"><span class="pill">GET /</span><span class="pill">GET /list</span><span class="pill">POST /save</span></div><p><span class="what"><b>Native node.</b> Pasted <code>src</code> stays portable.</span></p></article></body></html>\n');
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect((out.match(/class="pill"/g) || []).length).toBe(3);  // three pills stay three
  expect((out.match(/class="what"/g) || []).length).toBe(1);  // one wrapper stays one
  expect(out).toContain("<b>Native node.</b>");               // inner marks intact inside it
});

// F13: Tab indents/outdents lists and never throws focus out of the editor.
test("tab: indents list items, focus stays in the editor", async ({ page }) => {
  await openNote(page, "tab.md", "seed\n");
  await clearAndFocus(page);
  await page.keyboard.type("- one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Tab");
  await expect(page.locator(".ProseMirror ul ul li")).toContainText("two"); // nested, not focus-jumped
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".ProseMirror ul ul")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).__editor.chain().focus("end").run());
  await page.keyboard.press("Tab"); // in plain prose: consumed
  const focusInEditor = await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));
  expect(focusInEditor).toBe(true);
});

// K4/F15: a doc whose top-level wrapper sets its own max-width keeps its OWN page frame —
// the editor's 760px column steps aside ("left aligned in app, centered in browser").
test("page frame: self-framed doc keeps its own width and centering", async ({ page }) => {
  await openNote(page, "frame.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>f</title><style>body{margin:0;background:#fbfbfa}.page{max-width:860px;margin:0 auto;padding:48px 28px}</style></head><body><div class="page"><h1>Framed</h1><p>content</p></div></body></html>\n');
  await expect(page.locator(".doc.own-frame")).toHaveCount(1);
  const w = await page.evaluate(() => { const el = document.querySelector('.ProseMirror [class~="page"]'); return el ? Math.round(el.getBoundingClientRect().width) : 0; });
  expect(w).toBeGreaterThan(770); // not capped by the editor's 760px column
  // typing at doc end continues INSIDE the page frame, not in the escape paragraph
  // after it ("my words start at the very left with no spacing")
  await page.keyboard.type("XYZ continues");
  await expect(page.locator('.ProseMirror [class~="page"]')).toContainText("XYZ continues");
  // even a CLICK below the page (the escape slot) redirects inside — the slot is a trap
  const pm = (await page.locator(".ProseMirror").boundingBox())!;
  await page.mouse.click(pm.x + pm.width / 2, pm.y + pm.height - 5);
  await page.keyboard.type(" and below-click too");
  await expect(page.locator('.ProseMirror [class~="page"]')).toContainText("and below-click too");
  // and a click in the DEAD SPACE below the editable area (the pane padding) must
  // continue the note too — it used to blur the editor and typing went nowhere
  await page.mouse.click(pm.x + pm.width / 2, pm.y + pm.height + 40);
  await page.keyboard.type(" dead-space too");
  await expect(page.locator('.ProseMirror [class~="page"]')).toContainText("dead-space too");
});

// A tab from before a server restart silently keeps editing with old code (it produced
// two phantom bug reports in one day). On focus/poll the client compares bundle versions
// and shows a reload banner on mismatch.
test("stale tab: version mismatch shows the reload banner", async ({ page }) => {
  await openNote(page, "stale.md", "hello\n");
  await page.route("**/version", (r) => r.fulfill({ json: { v: "different-build" } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".stale-bar")).toContainText("running old code");
});

// Strays already saved AFTER the wrapper (typed before the caret fix existed) render
// hard-left outside the frame, in the editor and the browser alike. On load they're
// absorbed into the page: non-empty paragraphs move inside the wrapper, empties drop.
test("page frame: stranded paragraphs after the wrapper are absorbed into the page", async ({ page }) => {
  await openNote(page, "strays.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>s</title><style>body{margin:0}.page{max-width:860px;margin:0 auto;padding:48px 28px}</style></head><body><div class="page"><h1>Doc</h1><p>inside</p></div><p class="lead">stranded words</p><p class="lead"></p><p></p></body></html>\n');
  await expect(page.locator('.ProseMirror [class~="page"]')).toContainText("stranded words"); // absorbed
  const out: string = await page.evaluate(() => (window as any).__serialize());
  const afterPage = out.slice(out.indexOf("</div>"));
  expect(afterPage).not.toContain("stranded words");          // nothing left outside the wrapper
  // the classed empty strays are gone; at most the bare trailing escape <p></p> remains
  expect((out.match(/<p class="lead">\s*<\/p>/g) || []).length).toBe(0);
  expect((out.match(/<p[^>]*>\s*<\/p>/g) || []).length).toBeLessThanOrEqual(1);
});

// own-frame must NOT fire for docs that merely cap element widths (p{max-width}) without
// self-centering — those rely on an outer layout the editor doesn't carry, and dropping
// the editor column pinned them hard-left (regression found on attention.html).
test("page frame: width-capped-but-not-self-centered doc keeps the editor column", async ({ page }) => {
  await openNote(page, "capped.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>c</title><style>body{min-height:100vh}p{max-width:680px}h1{letter-spacing:-.02em}</style></head><body><article><p class="lede">A capped lede paragraph.</p><h1>Title</h1><p>content</p></article></body></html>\n');
  await expect(page.locator(".ProseMirror")).toBeVisible();
  const r = await page.evaluate(() => { const d = document.querySelector(".doc")!; return { own: d.classList.contains("own-frame"), w: Math.round(d.getBoundingClientRect().width) }; });
  expect(r.own).toBe(false);
  expect(r.w).toBeLessThanOrEqual(760); // the centered editor column stays
});

// F14: the app's md-note code theme (purple ink) must not paint over a styled html note.
test("fidelity: styled note's code is not repainted by the app theme", async ({ page }) => {
  await openNote(page, "codefid.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>c</title><style>code{background:#f0f0ed}</style></head><body><article><p>use <code>foo()</code> here</p></article></body></html>\n');
  const c = await page.evaluate(() => { const el = document.querySelector(".ProseMirror code"); const cs = getComputedStyle(el!); return { color: cs.color, bg: cs.backgroundColor }; });
  expect(c.bg).toBe("rgb(240, 240, 237)");      // the note's own rule applies
  expect(c.color).not.toBe("rgb(90, 73, 214)"); // the app's purple ink does not
});

// F11: images are resizable by dragging the corner handle; the committed width persists
// in the saved file and survives reload as the same editable node (closure rule).
test("image resize: drag handle commits width, persists, survives reload", async ({ page }) => {
  const path = await openNote(page, "imgresize.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>r</title></head><body><article><h1>R</h1><p>seed</p></article></body></html>\n');
  await page.evaluate(() => { const e = (window as any).__editor; e.chain().focus("end").run(); e.view.focus(); });
  await page.evaluate(() => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPIjfkAAALzAbqUxO1lAAAAAElFTkSuQmCC";
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], "shot.png", { type: "image/png" });
    const dt = new DataTransfer(); dt.items.add(file);
    document.querySelector(".ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".ProseMirror img.note-img")).toHaveCount(1, { timeout: 5000 });
  const handle = page.locator(".note-img-handle");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".ProseMirror img.note-img")).toHaveAttribute("width", /^\d+$/);
  await page.waitForTimeout(1300); // autosave (resize alone must arm it)
  expect(readFileSync(path, "utf8")).toMatch(/<img[^>]*width="\d+"/);
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(0); // still native, not frozen
  await expect(page.locator(".ProseMirror img.note-img")).toHaveAttribute("width", /^\d+$/);
});

test("image resize: width round-trips through markdown as raw <img>", async ({ page }) => {
  await openNote(page, "imgwidth.md", 'before\n\n<img src="assets/pic.png" alt="pic" width="120">\n\nafter\n');
  await expect(page.locator('.ProseMirror img.note-img[width="120"]')).toHaveCount(1); // native node, width applied
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).toMatch(/<img src="assets\/pic\.png" alt="pic" width="120">/); // not downgraded to ![pic](…)
});

// LINKS (F3): the editor must not rewrite a file's link attrs on save (the stock Link mark
// injected target=_blank rel=noopener… into every link), and links must WORK: relative
// note links navigate the app to the sibling note; web links open outside.
test("links: file's link attrs round-trip verbatim — no target/rel injection", async ({ page }) => {
  await openNote(page, "links.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>l</title></head><body><article><p>See <a href="other.html">other</a> and <a href="https://x.example/y" target="_self" rel="me">ext</a>.</p></article></body></html>\n');
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).toContain('<a href="other.html">other</a>');                      // untouched — nothing injected
  expect(out).toContain('target="_self"');                                       // the file's OWN attrs survive
  expect(out).toContain('rel="me"');
  expect(out).not.toContain("noopener noreferrer nofollow");                     // the old injection
});

test("links: clicking a relative note link navigates the app to that note", async ({ page }) => {
  writeFileSync(join(VAULT, "linktarget.html"), '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body><article><h1>Target note</h1><p>arrived</p></article></body></html>\n');
  await openNote(page, "linksrc.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>s</title></head><body><article><p>Go to <a href="linktarget.html">the target</a> now.</p></article></body></html>\n');
  await page.locator('.ProseMirror a[href="linktarget.html"]').click();
  await page.waitForURL(/linktarget\.html/);
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".ProseMirror h1")).toContainText("Target note");
});

// F9: a link to a missing note used to silently land on the welcome screen ("hyperlinks
// are broken"). Now the click preflights /exists, explains in place, and stays on the doc;
// a bad direct ?file= URL gets a reason on the welcome screen.
test("links: dead relative link explains itself and stays on the doc", async ({ page }) => {
  await openNote(page, "deadlink.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>d</title></head><body><article><p>See <a href="missing-note.html">ghost</a>.</p></article></body></html>\n');
  await page.locator('.ProseMirror a[href="missing-note.html"]').click();
  await expect(page.locator(".toast")).toContainText("doesn't exist");
  expect(page.url()).toContain("deadlink.html");                                 // didn't navigate away
  await expect(page.locator(".ProseMirror")).toContainText("See");
});

test("direct URL to a nonexistent file shows a reason, not a bare welcome screen", async ({ page }) => {
  await page.goto("/?file=" + encodeURIComponent(join(VAULT, "nope-not-here.html")));
  await expect(page.locator(".onboard .notice")).toContainText("No such note");
});

// F10: "Open folder" used to repoint ONE global vault — another tab's open-folder made
// this tab's saves fail 403 ("files failed to save" while dogfooding in a second tab).
// Every root opened in a session stays live; each tab keeps working against its own.
test("multi-vault: opening another folder doesn't break the first tab", async ({ page, request }) => {
  const path = await openNote(page, "tab-a.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>a</title></head><body><article><p>alpha</p></article></body></html>\n');
  const vault2 = resolve("tests/e2e/.vault2");
  mkdirSync(vault2, { recursive: true });
  writeFileSync(join(vault2, "b.md"), "beta\n");
  const r = await (await request.post("/open-folder", { data: { dir: vault2 } })).json();
  expect(r.ok).toBe(true);                                                       // tab B's switch succeeded…
  await page.evaluate(() => { const e = (window as any).__editor; e.chain().focus("end").run(); e.view.focus(); });
  await page.keyboard.type(" still-saving");
  await page.waitForTimeout(1300); // autosave
  expect(readFileSync(path, "utf8")).toContain("still-saving");                  // …and tab A still saves
  await page.goto("/?file=" + encodeURIComponent(path));                         // and still re-opens
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator(".ProseMirror")).toContainText("still-saving");
});

test("links: web links open externally, app stays put", async ({ page }) => {
  await openNote(page, "linkweb.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>w</title></head><body><article><p>Visit <a href="https://example.com/page">example</a>.</p></article></body></html>\n');
  await page.evaluate(() => { (window as any).__opened = null; window.open = ((u: string) => { (window as any).__opened = u; return null; }) as any; });
  await page.locator('.ProseMirror a[href="https://example.com/page"]').click();
  expect(await page.evaluate(() => (window as any).__opened)).toBe("https://example.com/page");
  await expect(page.locator(".ProseMirror")).toContainText("Visit"); // didn't navigate away
});

// F6: a doc's body background must paint the whole note pane, not just the 760px column
// (the "skinny black strip on dark gray" feel from dogfooding adamw).
test("note background extends across the note pane", async ({ page }) => {
  await openNote(page, "darkbg.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>d</title><style>:root{--bg:#0b0c10}body{background:var(--bg);color:#e8eaf0}.card{padding:8px}</style></head><body><article><div class="card"><p>dark note</p></div></article></body></html>\n');
  const r = await page.evaluate(() => ({
    mount: getComputedStyle(document.getElementById("editor")!).backgroundColor,
    pane: getComputedStyle(document.querySelector(".layout .main")!).backgroundColor,
  }));
  expect(r.mount).toBe("rgb(11, 12, 16)");  // the doc's --bg resolved
  expect(r.pane).toBe(r.mount);             // pane matches — no strip
});

// MD INTEGRITY: a bullet list adjacent to a task list must NOT spawn a phantom "- [ ]"
// (markdown-it merges them into one mixed <ul>; PM then fabricates an empty taskItem that
// degrades into escaped junk on every save). Also: the md round-trip must settle.
test("md: bullet list + task list round-trips with no phantom item, idempotent", async ({ page }) => {
  const src = "- one\n- two\n\n- [ ] todo\n- [x] done\n";
  const path = await openNote(page, "mdmix.md", src);
  const s1: string = await page.evaluate(() => (window as any).__serialize());
  expect(s1).not.toMatch(/- \[ \]\s*\n\s*\n- one/);   // no phantom empty task before the bullets
  expect(s1).toContain("- one");
  expect(s1).toContain("- [ ] todo");
  expect(s1).toContain("- [x] done");
  expect(s1).not.toMatch(/\\\[/);                       // no escaped-bracket junk
  // settles: reload our own save → identical
  writeFileSync(path, s1);
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__serialize);
  const s2: string = await page.evaluate(() => (window as any).__serialize());
  expect(s2).toBe(s1);
});

// QUALITY: after the AI rebuild (format-contract system prompt + Agent SDK), a "2x2
// pros/cons table" is a clean 2-column table — no 5-column spacer mess.
// An EMPTY "- [ ]" to-do used to round-trip into an escaped bullet ("- \[ \]") because
// markdown-it's task plugin requires trailing text — the checkbox was lost and junk
// accumulated in the file (found in Ben's bug-findings.md).
test("md: empty to-do round-trips as a to-do, not escaped junk", async ({ page }) => {
  const path = await openNote(page, "emptytask.md", "- [ ] one\n- [ ]\n");
  await expect(page.locator('.ProseMirror ul[data-type="taskList"] li')).toHaveCount(2); // both are to-dos
  const out: string = await page.evaluate(() => (window as any).__serialize());
  expect(out).not.toContain("\\[");                       // no escaped junk
  // closure: re-load our own save → still two to-dos
  writeFileSync(path, out);
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await expect(page.locator('.ProseMirror ul[data-type="taskList"] li')).toHaveCount(2);
  const out2: string = await page.evaluate(() => (window as any).__serialize());
  expect(out2).toBe(out);                                  // settled
});

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
