// Edit / Interact mode (K5) — behavioral e2e.
//
// EDIT = today's JS-free ProseMirror editor. INTERACT = the document's OWN JavaScript runs,
// rendered as the RAW file in a sandboxed iframe (`sandbox="allow-scripts"`, NO
// allow-same-origin). These tests prove: (1) the doc's JS actually runs in interact mode
// (tabs switch), (2) the same file stays editable in edit mode, (3) switching keeps unsaved
// edits, (4) a no-JS doc renders, and (5) the sandboxed frame is walled off from the vault,
// the server's file endpoints, and the parent page/app storage — the opaque-origin boundary.
import { test, expect, type Page, type Frame } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const VAULT = resolve("tests/e2e/.vault");
mkdirSync(VAULT, { recursive: true });

// A JS-driven tabbed doc mirroring ~/career/project-deep-dives.html: an end-of-body IIFE
// wires .tab clicks to toggle .hidden on .panel. With the script stripped (edit mode) only
// the first panel shows and tabs are dead; in interact mode the JS runs and tabs switch.
const TABBED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tabbed</title>
<style>body{font-family:sans-serif}.panel.hidden{display:none}.tab.active{font-weight:700}</style></head>
<body><article>
<h1>Tabbed doc</h1>
<div class="tabs">
  <button class="tab active" data-t="a">Tab A</button>
  <button class="tab" data-t="b">Tab B</button>
</div>
<div class="panel" data-p="a"><p>Panel A content</p></div>
<div class="panel hidden" data-p="b"><p>Panel B content</p></div>
<script>(function(){
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.panel'));
  function show(k){
    panels.forEach(function(p){ p.classList.toggle('hidden', p.getAttribute('data-p')!==k); });
    tabs.forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-t')===k); });
  }
  tabs.forEach(function(t){ t.addEventListener('click', function(){ show(t.getAttribute('data-t')); }); });
})();</script>
</article></body></html>`;

const NOJS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Static</title></head>
<body><article><h1>Static dashboard</h1><p>No script here — just content.</p></article></body></html>`;

// A no-JS but STYLED doc (like spacex-cheatsheet): own CSS, no <script> → no toggle (F31).
const STATIC_STYLED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cheatsheet</title>
<style>body{background:#101418;color:#eee;max-width:860px;margin:auto}</style></head>
<body><article><h1>Cheatsheet</h1><p>Static, styled, nothing to interact with.</p></article></body></html>`;

// A JS doc with NO styling of its own (the rare F30 case): interact must inject the app's base
// note CSS so it renders themed+centered, not bare white left-aligned.
const UNSTYLED_JS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live</title></head>
<body><article><h1>Live</h1><p id="out">pending</p><script>document.getElementById('out').textContent='ran '+(1+1);</script></article></body></html>`;

// A doc that routes via the History API (like saronic-slides) — in the opaque-origin sandbox
// pushState/replaceState throw SecurityError. The shim (F33) must swallow them so the script
// runs to completion and the console stays clean. It has its own <style> (no base-CSS inject).
const PUSHSTATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Routed</title><style>body{margin:0}</style></head>
<body><h1>Slides</h1><script>history.replaceState({s:0},'','#s0');history.pushState({s:1},'','#s1');document.body.setAttribute('data-routed','ok');</script></body></html>`;

async function open(page: Page, name: string, content: string): Promise<string> {
  const path = join(VAULT, name);
  writeFileSync(path, content);
  await page.goto("/?file=" + encodeURIComponent(path));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor && (window as any).__setMode);
  return path;
}

async function enterInteract(page: Page) {
  await page.click('#modeseg button[data-mode="interact"]');
  await page.waitForSelector("iframe.interact-frame");
  await expect.poll(() => page.frames().some((f) => f.url() === "about:srcdoc")).toBeTruthy();
}

function srcdocFrame(page: Page): Frame {
  const f = page.frames().find((fr) => fr.url() === "about:srcdoc");
  if (!f) throw new Error("sandboxed srcdoc frame not found");
  return f;
}

test("interact mode runs the doc's own JS — tabs actually switch", async ({ page }) => {
  await open(page, "tabbed.html", TABBED);
  await enterInteract(page);
  const fl = page.frameLocator("iframe.interact-frame");
  // initial: panel A shown, B hidden by the doc's .hidden CSS
  await expect(fl.locator('[data-p="a"]')).toBeVisible();
  await expect(fl.locator('[data-p="b"]')).toBeHidden();
  // click Tab B → the doc's JS swaps the active panel
  await fl.locator('.tab[data-t="b"]').click();
  await expect(fl.locator('[data-p="b"]')).toBeVisible();
  await expect(fl.locator('[data-p="a"]')).toBeHidden();
});

test("edit mode renders the same file as editable (no JS runs)", async ({ page }) => {
  await open(page, "tabbed-edit.html", TABBED);
  // default mode is edit: the ProseMirror editor, no iframe
  await expect(page.locator("iframe.interact-frame")).toHaveCount(0);
  // both panels' prose is in the editable document model (B is only visually hidden by CSS)
  const text = await page.evaluate(() => (window as any).__editor.getText());
  expect(text).toContain("Panel A content");
  expect(text).toContain("Panel B content");
  expect(await page.evaluate(() => (window as any).__editor.isEditable)).toBe(true);
  // prove it's genuinely editable
  await page.evaluate(() => (window as any).__editor.chain().focus("end").insertContent(" EDITPROOF").run());
  expect(await page.evaluate(() => (window as any).__editor.getText())).toContain("EDITPROOF");
});

test("switching modes preserves unsaved edits", async ({ page }) => {
  await open(page, "tabbed-preserve.html", TABBED);
  await page.evaluate(() => (window as any).__editor.chain().focus("end").insertContent(" SENTINEL_EDIT_42").run());
  expect(await page.evaluate(() => (window as any).__editor.getText())).toContain("SENTINEL_EDIT_42");
  await enterInteract(page);
  // back to edit
  await page.click('#modeseg button[data-mode="edit"]');
  await expect(page.locator("iframe.interact-frame")).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__editor.getText())).toContain("SENTINEL_EDIT_42");
});

test("edit/AI shortcuts are inert in interact mode; Escape exits", async ({ page }) => {
  await open(page, "tabbed-shortcuts.html", TABBED);
  await enterInteract(page);
  // ⌘K must NOT open the AI palette over the sandboxed preview (it would edit the hidden editor)
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".cmdk.show")).toHaveCount(0);
  // Escape returns to edit mode
  await page.keyboard.press("Escape");
  await expect(page.locator("iframe.interact-frame")).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toBeVisible();
});

// A no-JS doc no longer offers interact at all (F31) — see the F31 tests below. A doc with only
// a SMALL amount of JS still renders in interact mode (the toggle is gated on presence, not size).
test("a minimal-JS doc renders in interact mode", async ({ page }) => {
  await open(page, "minimal-js.html", UNSTYLED_JS);
  await enterInteract(page);
  const fl = page.frameLocator("iframe.interact-frame");
  await expect(fl.locator("h1")).toHaveText("Live");
  await expect(fl.locator("#out")).toHaveText("ran 2"); // its tiny script actually ran
});

// ───────────────────────── F29: every tab editable in edit mode ─────────────────────────
test("F29: edit mode reveals hidden panels — all are visible+editable, with a marker", async ({ page }) => {
  await open(page, "f29-reveal.html", TABBED);
  // panel B ships class="panel hidden" → display:none from the doc's own .hidden rule. The
  // reveal sheet (note-edit-reveal) must override it so the panel is visible and editable.
  await expect(page.locator("#note-edit-reveal")).toHaveCount(1);
  const panelB = page.locator(".ProseMirror .panel.hidden");
  await expect(panelB).toBeVisible();                       // was display:none before the fix
  const box = await panelB.boundingBox();
  expect(box && box.height).toBeGreaterThan(0);
  // the "hidden by default" marker badge is present (::after content)
  const marker = await panelB.evaluate((el) => getComputedStyle(el, "::after").content);
  expect(marker).toContain("hidden by default");
  // genuinely editable: place the caret inside panel B's text and type
  await panelB.locator("p").click();
  await page.keyboard.type(" EDITB");
  expect(await page.evaluate(() => (window as any).__editor.getText())).toContain("Panel B content EDITB");
  // markup preserved: the class stays in the model (so interact still hides/switches)
  expect(await page.evaluate(() => (window as any).__editor.getHTML())).toContain('class="panel hidden"');
});

test("F29: the doc's class attrs are preserved so interact still switches tabs after reveal", async ({ page }) => {
  await open(page, "f29-roundtrip.html", TABBED);
  await enterInteract(page);
  const fl = page.frameLocator("iframe.interact-frame");
  await expect(fl.locator('[data-p="a"]')).toBeVisible();
  await expect(fl.locator('[data-p="b"]')).toBeHidden();   // interact still honors .hidden
  await fl.locator('.tab[data-t="b"]').click();
  await expect(fl.locator('[data-p="b"]')).toBeVisible();
  await expect(fl.locator('[data-p="a"]')).toBeHidden();
});

// ───────────────────────── F31: gate the toggle on real JS ─────────────────────────
test("F31: a static no-JS doc shows NO interact toggle (hidden)", async ({ page }) => {
  await open(page, "f31-static.html", STATIC_STYLED);
  await expect(page.locator("#modeseg")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__NOTE__.interactive)).toBeFalsy();
  // ⌘E is a no-op (no mode to toggle) — no iframe appears
  await page.keyboard.press("Meta+e");
  await expect(page.locator("iframe.interact-frame")).toHaveCount(0);
});

test("F31: an unstyled no-JS doc also shows no toggle", async ({ page }) => {
  await open(page, "f31-nojs.html", NOJS);
  await expect(page.locator("#modeseg")).toHaveCount(0);
});

test("F31: a JS doc still shows the toggle and toggles", async ({ page }) => {
  await open(page, "f31-js.html", TABBED);
  await expect(page.locator("#modeseg")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__NOTE__.interactive)).toBe(true);
});

// ───────────────────────── F30: themed+centered interact for unstyled docs ─────────────────────────
test("F30: interact of an UNSTYLED js doc injects base note CSS (centered 760 column)", async ({ page }) => {
  await open(page, "f30-unstyled.html", UNSTYLED_JS);
  await enterInteract(page);
  const frame = srcdocFrame(page);
  // the doc's own JS still ran (sandbox intact)
  await expect(page.frameLocator("iframe.interact-frame").locator("#out")).toHaveText("ran 2");
  // base CSS is injected → body is a centered, capped reading column (matches edit mode)
  const maxW = await frame.evaluate(() => getComputedStyle(document.body).maxWidth);
  expect(maxW).toBe("760px");
  const centered = await frame.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return Math.abs((window.innerWidth - b.width) / 2 - b.left) < 2; // equal left/right margins
  });
  expect(centered).toBe(true);
});

test("F30: a self-styled doc keeps its OWN design (no base CSS injected)", async ({ page }) => {
  await open(page, "f30-styled.html", TABBED); // TABBED has its own <style>
  await enterInteract(page);
  await page.frameLocator("iframe.interact-frame").locator("h1").waitFor(); // frame loaded
  const frame = srcdocFrame(page);
  // TABBED sets no max-width on body → base CSS (which would) is NOT injected
  const maxW = await frame.evaluate(() => getComputedStyle(document.body).maxWidth);
  expect(maxW).toBe("none");
});

// ───────────────────────── F33: History-API shim silences SecurityError ─────────────────────────
test("F33: a pushState/replaceState doc throws 0 SecurityErrors in interact", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page, "f33-pushstate.html", PUSHSTATE);
  await enterInteract(page);
  const fl = page.frameLocator("iframe.interact-frame");
  // the shim swallowed the (sandbox-forbidden) history calls, so the script ran to completion
  await expect(fl.locator("body")).toHaveAttribute("data-routed", "ok");
  await page.waitForTimeout(150);
  const security = errors.filter((e) => /SecurityError/i.test(e));
  expect(security).toEqual([]);
});

// ───────────────────────── F34: interact view height = real bar height ─────────────────────────
test("F34: no bar/iframe overlap at 1280×900 (height derived from real bar height)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "f34-overlap.html", TABBED);
  // the client measures the bar into --bar-h (no magic 40)
  const barH = await page.evaluate(() => Math.round((document.querySelector(".bar") as HTMLElement).getBoundingClientRect().height));
  const varH = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bar-h").trim());
  expect(varH).toBe(barH + "px");
  await enterInteract(page);
  const m = await page.evaluate(() => {
    const bar = (document.querySelector(".bar") as HTMLElement).getBoundingClientRect();
    const view = (document.querySelector(".interact-view") as HTMLElement).getBoundingClientRect();
    return { barBottom: bar.bottom, viewTop: view.top, viewBottom: view.bottom, inner: window.innerHeight, scroll: document.documentElement.scrollHeight };
  });
  expect(m.viewTop).toBeGreaterThanOrEqual(m.barBottom - 1); // no overlap (sticky bar over iframe)
  expect(Math.abs(m.viewBottom - m.inner)).toBeLessThanOrEqual(1); // fills to the viewport bottom, no overflow
  expect(m.scroll).toBeLessThanOrEqual(m.inner + 1); // no scrollbar overflow (was 907 vs 900)
});

test("the sandboxed frame is walled off from the vault, server, and parent", async ({ page }) => {
  await open(page, "sandbox-probe.html", TABBED);
  await enterInteract(page);
  // the wall: allow-scripts WITHOUT allow-same-origin → opaque origin
  await expect(page.locator("iframe.interact-frame")).toHaveAttribute("sandbox", "allow-scripts");

  const frame = srcdocFrame(page);
  const probe = await frame.evaluate(async () => {
    const out: Record<string, string> = {};
    // (1) can't enumerate the vault — GET response has no CORS header, opaque origin can't read it
    try { const r = await fetch("/list"); await r.text(); out.list = "READ"; } catch { out.list = "BLOCKED"; }
    // (2a) can't write a note via a JSON POST — CORS preflight is unsatisfied → blocked
    try { const r = await fetch("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: "/tmp/pwn", content: "hacked" }) }); out.save = "READ-" + r.status; } catch { out.save = "BLOCKED"; }
    // (2b) can't write via a SIMPLE POST either (text/plain skips preflight) — this exercises the
    // server's sameOrigin() wall directly: the frame's Origin is `null` → 403, response unreadable.
    try { const r = await fetch("/save", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ file: "/tmp/pwn2", content: "hacked" }) }); out.saveSimple = "READ-" + r.status; } catch { out.saveSimple = "BLOCKED"; }
    // (3) can't read the parent page (other notes, the editor)
    try { void (parent as any).document.body.innerHTML; out.parentDom = "READ"; } catch { out.parentDom = "BLOCKED"; }
    // (4) can't read app-origin storage
    try { void (parent as any).localStorage.length; out.parentStorage = "READ"; } catch { out.parentStorage = "BLOCKED"; }
    return out;
  });
  expect(probe.list).toBe("BLOCKED");
  expect(probe.save).toBe("BLOCKED");
  expect(probe.saveSimple).toBe("BLOCKED");
  expect(probe.parentDom).toBe("BLOCKED");
  expect(probe.parentStorage).toBe("BLOCKED");
});
