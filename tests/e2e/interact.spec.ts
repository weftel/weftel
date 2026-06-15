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

test("a no-JS doc renders in interact mode", async ({ page }) => {
  await open(page, "nojs.html", NOJS);
  await enterInteract(page);
  const fl = page.frameLocator("iframe.interact-frame");
  await expect(fl.locator("h1")).toHaveText("Static dashboard");
  await expect(fl.locator("p")).toContainText("No script here");
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
