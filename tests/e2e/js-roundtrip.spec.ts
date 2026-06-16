// F32 — JS-DOC ROUND-TRIP / IDEMPOTENCE. The regression guard for silent save corruption of a
// hand-authored interactive HTML doc.
//
// Shape under test (mirrors ~/career/project-deep-dives.html): a doc whose interactivity is driven
// by an end-of-<body> <script> that reads data-* attributes — clickable tabs (.tab[data-t]) toggle
// a "hidden" class on content panels (.panel[data-p]). Before the fix the save pipeline:
//   • relocated the end-of-body <script> into <head> (so it ran before its DOM existed), and
//   • dropped every data-* off the panels (they round-tripped through a styled-box node that only
//     carried class/style),
// which SILENTLY broke the file on disk — the saved copy's tabs no longer switched, in the editor
// AND in any plain browser. The test proves the saved bytes keep the <script> in <body>, keep the
// data-* hooks, change only the edited text, settle on re-open, and — the real proof — that the
// SAVED file still WORKS when opened directly via file:// (no editor): clicking a tab switches panels.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const VAULT = resolve("tests/e2e/.vault");

const JS_DOC = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Interview Talking Points</title>
<style>
  body{font-family:system-ui;margin:0;background:#0b0c10;color:#e8eaf0}
  .wrap{max-width:820px;margin:0 auto;padding:0 20px}
  nav.tabs{display:flex;gap:8px;padding:14px 0;border-bottom:1px solid #262b38}
  .tab{cursor:pointer;border:1px solid #262b38;background:#13151c;color:#9aa3b2;padding:8px 14px;border-radius:999px;font-weight:600}
  .tab.active{background:#1c1f4a;color:#fff;border-color:#3a4a86}
  .panel{padding:24px 0;border-top:1px solid #262b38}
  .panel.hidden{display:none}
  h1{font-size:30px}
  h2{color:#7c7cf0}
</style>
</head>
<body>

<header class="hero"><div class="wrap"><h1>Interview Talking Points</h1></div></header>

<nav class="tabs"><div class="wrap" style="display:flex;gap:8px">
  <div class="tab active" data-t="alpha">Project Alpha</div>
  <div class="tab" data-t="beta">Project Beta</div>
  <div class="tab" data-t="gamma">Project Gamma</div>
</div></nav>

<main class="wrap">
  <div class="panel" data-p="alpha">
    <h2>Project Alpha</h2>
    <p>Alpha is the agent that traverses reference chains automatically across the document store.</p>
    <p>The multi-step retrieval loop iterates until the relevance signal drops off entirely.</p>
  </div>
  <div class="panel hidden" data-p="beta">
    <h2>Project Beta</h2>
    <p>Beta validated the digital twin quantitatively before any downstream fine-tuning began.</p>
  </div>
  <div class="panel hidden" data-p="gamma">
    <h2>Project Gamma</h2>
    <p>Gamma profiled the perception pipeline and removed the synchronization bottleneck.</p>
  </div>
</main>

<script>
(function(){
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.panel'));
  function show(key){
    panels.forEach(function(p){ p.classList.toggle('hidden', p.getAttribute('data-p')!==key); });
    tabs.forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-t')===key); });
  }
  tabs.forEach(function(t){ t.addEventListener('click', function(){ show(t.getAttribute('data-t')); }); });
})();
</script>
</body>
</html>
`;

// Body-rooted variant: NO <article>/<main> wrapper, content + an end-of-<body> wiring script sit
// directly in <body> (a very common Claude-authored one-pager shape). Here the editable container
// falls back to <body>, so the script is "in container" — the fix detaches it and re-attaches it at
// the end of <body> (never <head>) so it still runs after its DOM. Guards the regression the first
// cut missed (container===body still relocated the script to <head>).
const JS_DOC_BODY_ROOTED = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Body Rooted</title>
<style>.tab{cursor:pointer}.tab.active{font-weight:700}.panel.hidden{display:none}</style></head>
<body>
<div class="wrap">
  <div class="tab active" data-t="a">Tab A</div>
  <div class="tab" data-t="b">Tab B</div>
  <div class="panel" data-p="a"><h2>Panel A</h2><p>Alpha content uniquely written for editing.</p></div>
  <div class="panel hidden" data-p="b"><h2>Panel B</h2><p>Beta content uniquely written for editing.</p></div>
</div>
<script>
(function(){
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.panel'));
  function show(k){
    panels.forEach(function(p){ p.classList.toggle('hidden', p.getAttribute('data-p')!==k); });
    tabs.forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-t')===k); });
  }
  tabs.forEach(function(t){ t.addEventListener('click', function(){ show(t.getAttribute('data-t')); }); });
})();
</script>
</body>
</html>
`;

// Same visible-text normalization the corpus harness uses: drop comments + <style>/<script>
// bodies, strip tags, unescape, collapse whitespace. A dropped word/char still diverges.
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

async function openDoc(page: Page, path: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|net::|favicon/i.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e)));
  await page.goto("/?file=" + encodeURIComponent(path));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
  return errors;
}
const serialize = (page: Page) => page.evaluate(() => (window as any).__serialize() as string);

test.describe("F32 · JS-doc round-trip", () => {
  test("load+save keeps <script> in <body>, data-* on panels, no relocation, no content loss", async ({ page }) => {
    const path = join(VAULT, "f32-load-save.html");
    writeFileSync(path, JS_DOC);
    const errors = await openDoc(page, path);
    const s1 = await serialize(page);

    // no console / page errors on load
    expect(errors, "console/page errors on load").toEqual([]);

    // data-* hooks preserved (3 panels w/ data-p, 3 tabs w/ data-t) — the dropped-attr corruption
    expect(count(s1, /data-p=/g), "panel data-p hooks dropped on save").toBe(3);
    expect(count(s1, /data-t=/g), "tab data-t hooks dropped on save").toBe(3);
    for (const k of ["alpha", "beta", "gamma"]) {
      expect(s1, `data-p="${k}" lost`).toContain(`data-p="${k}"`);
      expect(s1, `data-t="${k}" lost`).toContain(`data-t="${k}"`);
    }

    // the end-of-body <script> stays in <body>, AFTER </main> — never relocated into <head>
    expect(s1, "wiring script lost on save").toContain("addEventListener");
    const headEnd = s1.indexOf("</head>");
    const mainEnd = s1.indexOf("</main>");
    const scriptAt = s1.indexOf("addEventListener");
    expect(headEnd, "no </head>").toBeGreaterThan(-1);
    expect(scriptAt, "<script> relocated into <head> (F32)").toBeGreaterThan(headEnd);
    expect(scriptAt, "<script> not after </main> where the author put it").toBeGreaterThan(mainEnd);

    // no visible content lost (whitespace-insensitive — re-serialization legitimately reflows)
    const stripWs = (s: string) => visibleText(s).replace(/\s+/g, "");
    expect(stripWs(s1), "visible content lost on load+save").toBe(stripWs(JS_DOC));

    // SECURITY UNCHANGED: the doc's JS is preserved but NEVER executed / never reaches the live
    // editable surface (the <script> rides in the head-template, not the ProseMirror light DOM).
    const live = await page.evaluate(() => {
      const pm = document.querySelector(".ProseMirror") as HTMLElement;
      return {
        scripts: pm.querySelectorAll("script").length,
        onattr: Array.from(pm.querySelectorAll("*")).some((e) => Array.from((e as HTMLElement).attributes).some((a) => /^on[a-z]+/i.test(a.name))),
      };
    });
    expect(live.scripts, "live <script> on the editable surface").toBe(0);
    expect(live.onattr, "live on* handler on the editable surface").toBe(false);
  });

  test("edit is surgical: save is byte-identical except the one intended text change", async ({ page }) => {
    const path = join(VAULT, "f32-surgical.html");
    writeFileSync(path, JS_DOC);
    await openDoc(page, path);
    const s1 = await serialize(page);

    // select the unique word "traverses" and replace it — a trivial, single edit
    const WORD = "traverses", REPL = "ROUNDTRIPX";
    expect(count(s1, new RegExp(WORD, "g")), "fixture word not unique in serialized bytes").toBe(1);
    const found = await page.evaluate((w) => {
      const e = (window as any).__editor; let from = 0, to = 0, ok = false;
      e.state.doc.descendants((n: any, pos: number) => { if (!ok && n.isText) { const i = n.text.indexOf(w); if (i >= 0) { from = pos + i; to = pos + i + w.length; ok = true; } } });
      if (ok) { e.chain().focus().setTextSelection({ from, to }).run(); e.view.focus(); }
      return ok;
    }, WORD);
    expect(found, "edit target not selectable (content frozen, not editable)").toBe(true);
    await page.keyboard.type(REPL);

    const s2 = await serialize(page);
    // the ONLY difference vs the no-edit save is the one word — proves nothing else churns
    expect(s2, "save changed more than the intended text edit").toBe(s1.replace(WORD, REPL));
    // and the structural invariants still hold after the edit
    expect(count(s2, /data-p=/g)).toBe(3);
    expect(s2.indexOf("addEventListener")).toBeGreaterThan(s2.indexOf("</head>"));
  });

  test("idempotent: re-opening our own save reproduces it (file doesn't churn)", async ({ page }) => {
    const path = join(VAULT, "f32-idem.html");
    writeFileSync(path, JS_DOC);
    await openDoc(page, path);
    const s1 = await serialize(page);

    writeFileSync(path, s1);
    await openDoc(page, path);
    let s2 = await serialize(page);
    if (s2 !== s1) { // tolerate at most one settle pass (corpus convention)
      writeFileSync(path, s2);
      await openDoc(page, path);
      const s3 = await serialize(page);
      expect(s3, "serialization never settles (file churns on every open)").toBe(s2);
      s2 = s3;
    }
    expect(s2).toBe(s1);
  });

  test("the SAVED doc still WORKS — tabs switch panels via file:// (no editor)", async ({ page }) => {
    // round-trip the doc through the editor (open → trivial edit → save), then prove the saved
    // bytes are a working interactive document on their own, in a plain browser.
    const path = join(VAULT, "f32-proof.html");
    writeFileSync(path, JS_DOC);
    await openDoc(page, path);
    await page.evaluate(() => {
      const e = (window as any).__editor; let from = 0, to = 0, ok = false;
      e.state.doc.descendants((n: any, pos: number) => { if (!ok && n.isText) { const i = n.text.indexOf("Alpha"); if (i >= 0) { from = pos + i; to = pos + i; ok = true; } } });
      if (ok) { e.chain().focus().setTextSelection({ from, to }).run(); e.view.focus(); }
    });
    await page.keyboard.type(" ");          // a trivial edit, then let the save serialize
    const saved = await serialize(page);

    const out = join(VAULT, "f32-saved-out.html");
    writeFileSync(out, saved);

    // open the SAVED file directly — no editor, no toggle, just a browser
    await page.goto("file://" + out);
    await page.waitForSelector(".tab");

    const visibleKeys = () => page.evaluate(() =>
      Array.from(document.querySelectorAll(".panel")).filter((p) => !p.classList.contains("hidden")).map((p) => p.getAttribute("data-p")));

    expect(await visibleKeys(), "saved doc: wrong initial panel").toEqual(["alpha"]);

    await page.click('.tab[data-t="beta"]');
    expect(await visibleKeys(), "saved doc: clicking the Beta tab did not switch panels (corruption)").toEqual(["beta"]);

    await page.click('.tab[data-t="gamma"]');
    expect(await visibleKeys(), "saved doc: clicking the Gamma tab did not switch panels").toEqual(["gamma"]);
  });

  test("body-rooted doc (no <main>): end-of-body <script> stays in <body>, and the saved file still works", async ({ page }) => {
    const path = join(VAULT, "f32-body-rooted.html");
    writeFileSync(path, JS_DOC_BODY_ROOTED);
    const errors = await openDoc(page, path);
    const s1 = await serialize(page);

    expect(errors, "console/page errors on load").toEqual([]);
    expect(count(s1, /data-p=/g), "panel data-p dropped (body-rooted)").toBe(2);
    // the script must NOT be hoisted into <head> just because the doc has no <main>/<article>
    expect(s1, "wiring script lost").toContain("addEventListener");
    expect(s1.indexOf("addEventListener"), "<script> relocated into <head> for a body-rooted doc (F32 gap)").toBeGreaterThan(s1.indexOf("</head>"));

    // and the round-tripped bytes are a working interactive document on their own
    const out = join(VAULT, "f32-body-rooted-out.html");
    writeFileSync(out, s1);
    await page.goto("file://" + out);
    await page.waitForSelector(".tab");
    const visibleKeys = () => page.evaluate(() =>
      Array.from(document.querySelectorAll(".panel")).filter((p) => !p.classList.contains("hidden")).map((p) => p.getAttribute("data-p")));
    expect(await visibleKeys(), "saved body-rooted doc: wrong initial panel").toEqual(["a"]);
    await page.click('.tab[data-t="b"]');
    expect(await visibleKeys(), "saved body-rooted doc: tab B did not switch panels").toEqual(["b"]);
  });
});
