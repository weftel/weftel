// K1 — editable SVG text. An <svg> still freezes whole (frozen-in-shadow rich block, byte-
// faithful), but its native <text>/<tspan> runs are click-to-edit: clicking a text leaf opens
// a floating input; committing writes the new text straight back into the verbatim SVG string,
// leaving every surrounding byte (geometry, fills, the <figure> wrapper) untouched.
//
// contentEditable does NOT work on SVG text in Chromium, so editing is driven through the
// overlay input (we trigger it with a real mousedown on the shadow-DOM leaf).
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
  await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
  return path;
}

// A <figure>-wrapped SVG (F4: figure freezes whole) with surrounding geometry to prove the
// rest of the SVG round-trips byte-faithfully when only the label text is edited.
const SVG_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>svgedit</title></head><body>
<article><h1>Diagram</h1>
<figure><svg viewBox="0 0 200 100" width="200"><rect x="10" y="10" width="180" height="80" fill="#eef" stroke="#6d5cf0"/><text x="100" y="55" text-anchor="middle" fill="#333">OLDLABEL</text></svg></figure>
<p>A caption below.</p></article>
</body></html>
`;

// open the overlay on the first SVG text leaf inside the frozen rich block's shadow root,
// via a real dblclick (the affordance's trigger). Returns the leaf's current text.
async function openSvgTextOverlay(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    const leaf = host.shadowRoot!.querySelector("text") as Element;
    leaf.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return leaf.textContent || "";
  });
}

test("SVG text is click-to-edit; the SVG stays a frozen-in-shadow rich block", async ({ page }) => {
  await openNote(page, "svgedit.html", SVG_DOC);
  // F4 preserved: the <figure>+<svg> froze whole into ONE rich block, svg lives in its shadow
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(1);
  const r = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return {
      svgEditable: host.hasAttribute("data-svg-editable"),
      svgInShadow: !!host.shadowRoot?.querySelector("svg"),
      figureKeptWhole: !!host.shadowRoot?.querySelector("figure svg"),
      ce: host.getAttribute("contenteditable"),
    };
  });
  expect(r.svgInShadow).toBe(true);
  expect(r.figureKeptWhole).toBe(true);     // F4: figure not regressed
  expect(r.ce).toBe("false");
  expect(r.svgEditable).toBe(true);         // the editing affordance is advertised
});

test("editing SVG text: overlay pre-fills, commit persists, surrounding SVG is byte-faithful", async ({ page }) => {
  const path = await openNote(page, "svgedit2.html", SVG_DOC);
  const before = await openSvgTextOverlay(page);
  expect(before).toBe("OLDLABEL");
  const overlay = page.locator("input.svgtext-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveValue("OLDLABEL");          // pre-filled with the current text
  await overlay.fill("NEWLABEL");
  await overlay.press("Enter");
  await expect(overlay).toHaveCount(0);                   // committed + closed
  // live shadow now shows the new text
  const liveText = await page.evaluate(() => (document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement).shadowRoot!.querySelector("text")!.textContent);
  expect(liveText).toBe("NEWLABEL");

  await page.waitForTimeout(1300);                        // past the 600ms autosave debounce
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("NEWLABEL");
  expect(saved).not.toContain("OLDLABEL");
  // surrounding SVG bytes untouched — geometry, fills, anchor, the <figure> wrapper all intact
  expect(saved).toContain('<rect x="10" y="10" width="180" height="80" fill="#eef" stroke="#6d5cf0">');
  expect(saved).toContain('text-anchor="middle"');
  expect(saved).toContain('fill="#333"');
  expect(saved).toContain('viewBox="0 0 200 100"');
  expect(saved).toContain("<figure>");
  expect(saved).toContain("A caption below.");           // neighbor content survives
  expect(saved).not.toContain("data-svg-editable");      // affordance hook never leaks to disk
  expect(saved).not.toContain("svgtext-overlay");
});

test("closure + idempotence: edited SVG text survives reload, still editable, round-trip settles", async ({ page }) => {
  const path = await openNote(page, "svgedit3.html", SVG_DOC);
  await openSvgTextOverlay(page);
  const overlay = page.locator("input.svgtext-overlay");
  await overlay.fill("PERSISTED");
  await overlay.press("Enter");
  await page.waitForTimeout(1300);
  const s1 = readFileSync(path, "utf8");

  // CLOSURE: reload our own save — text persists AND the leaf is still click-to-edit
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__serialize);
  const r = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return { text: host.shadowRoot!.querySelector("text")!.textContent, editable: host.hasAttribute("data-svg-editable") };
  });
  expect(r.text).toBe("PERSISTED");
  expect(r.editable).toBe(true);                         // re-reads as editable (closure)
  // it re-edits too
  const after = await openSvgTextOverlay(page);
  expect(after).toBe("PERSISTED");
  await page.locator("input.svgtext-overlay").press("Escape"); // cancel — no change

  // IDEMPOTENCE: serializing the reloaded doc reproduces the saved bytes (settles immediately)
  const s2 = await page.evaluate(() => (window as any).__serialize());
  expect(s2).toBe(s1);
});

test("single click still node-selects the whole block (⌘K rewrite/drag preserved); blur without typing never churns", async ({ page }) => {
  const path = await openNote(page, "svgselect.html", SVG_DOC);
  const s0: string = await page.evaluate(() => (window as any).__serialize());
  // a SINGLE real click on the SVG text selects the rich block (NodeSelection) — only dblclick edits
  const box = await page.evaluate(() => {
    const leaf = (document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement).shadowRoot!.querySelector("text") as Element;
    const r = (leaf as any).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  const selNode = await page.evaluate(() => (window as any).__editor.state.selection.node?.type.name || null);
  expect(selNode).toBe("richBlock");                     // block selectable → cmd+K rewrite still reachable
  // open the overlay, then blur WITHOUT typing → must not write or change a single byte
  await openSvgTextOverlay(page);
  await expect(page.locator("input.svgtext-overlay")).toBeVisible();
  await page.locator(".ProseMirror h1").click();         // genuine blur (focus leaves the overlay)
  await expect(page.locator("input.svgtext-overlay")).toHaveCount(0);
  await page.waitForTimeout(900);
  expect(readFileSync(path, "utf8")).toBe(SVG_DOC);      // never written (no edit armed) → byte-identical to original
  expect(await page.evaluate(() => (window as any).__serialize())).toBe(s0); // editor state unchanged too
});

// CANARY: a pure-shape SVG (no <text>) must NOT advertise the editing affordance — proves the
// detector is text-driven, not "any SVG".
test("canary: a pure-shape SVG exposes no text-editing affordance", async ({ page }) => {
  await openNote(page, "svgcanary.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>c</title></head><body><svg viewBox="0 0 50 50" width="50"><circle cx="25" cy="25" r="20" fill="#6d5cf0"/></svg></body></html>\n');
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(1);
  const editable = await page.evaluate(() => (document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement).hasAttribute("data-svg-editable"));
  expect(editable).toBe(false);
});

// dblclick a leaf in the frozen shadow by CSS selector (+ optional text match), at its box center
// (so a mixed <text>'s direct-run hit-test resolves to the right run). Returns the prefilled text.
async function dblclickLeaf(page: Page, selector: string, matchText?: string): Promise<string> {
  return await page.evaluate(({ selector, matchText }) => {
    const sr = (document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement).shadowRoot!;
    const els = Array.from(sr.querySelectorAll(selector));
    const el = (matchText ? els.find((e) => (e.textContent || "").trim() === matchText) : els[0])!;
    const r = (el as any).getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return el.textContent || "";
  }, { selector, matchText });
}

// GAP FIX: <textPath> (curved text on a path). The whole diagram was previously non-editable —
// the text only lives inside the <textPath>, which the detector didn't reach.
const TEXTPATH_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>tp</title></head><body>
<article><h1>Curved</h1>
<figure><svg viewBox="0 0 300 100" width="300"><defs><path id="curve" d="M10,50 Q150,10 290,50"/></defs><text font-size="14" fill="#333"><textPath href="#curve">OLDCURVE</textPath></text></svg></figure>
<p>Caption.</p></article>
</body></html>
`;
test("textPath: curved text is editable; its <path>/<defs> round-trip byte-faithfully", async ({ page }) => {
  const path = await openNote(page, "svgtextpath.html", TEXTPATH_DOC);
  const host = page.locator(".ProseMirror [data-rich-block]");
  await expect(host).toHaveAttribute("data-svg-editable", ""); // affordance now advertised (was missing)
  const before = await dblclickLeaf(page, "textPath, textpath");
  expect(before).toBe("OLDCURVE");
  const overlay = page.locator("input.svgtext-overlay");
  await expect(overlay).toHaveValue("OLDCURVE");
  await overlay.fill("NEWCURVE");
  await overlay.press("Enter");
  await page.waitForTimeout(1300);
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain(">NEWCURVE</textPath>");
  expect(saved).not.toContain("OLDCURVE");
  expect(saved).toContain('<path id="curve" d="M10,50 Q150,10 290,50">'); // the path geometry untouched
  expect(saved).toContain('<textPath href="#curve">');                    // href + camelCase tag preserved
  expect(saved).toContain("Caption.");
});

// GAP FIX (F26): a direct text run mixed alongside <tspan> children. Each run is editable in place
// without disturbing the sibling element runs.
const MIXED_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>f26</title></head><body>
<article><h1>Mixed</h1>
<figure><svg viewBox="0 0 320 60" width="320"><text x="10" y="35" font-size="14" fill="#333">LEADRUN <tspan fill="#6d5cf0" font-weight="bold">KEEPSPAN</tspan> TAILRUN</text></svg></figure>
<p>Caption.</p></article>
</body></html>
`;
test("F26: a direct run mixed with a <tspan> is editable; the sibling tspan + other run survive", async ({ page }) => {
  const path = await openNote(page, "svgmixed.html", MIXED_DOC);
  // edit the LEADING direct run (dblclick on the <text>, hit-test resolves to the left run)
  await page.evaluate(() => {
    const sr = (document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement).shadowRoot!;
    const text = sr.querySelector("text")!;
    const lead = Array.from(text.childNodes).find((n) => n.nodeType === 3 && (n.textContent || "").trim() === "LEADRUN")!;
    const rng = document.createRange(); rng.selectNode(lead); const r = rng.getBoundingClientRect();
    text.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  const overlay = page.locator("input.svgtext-overlay");
  await expect(overlay).toHaveValue("LEADRUN ");          // prefilled with the run's own text (trailing space kept)
  await overlay.fill("NEWLEAD");
  await overlay.press("Enter");
  await page.waitForTimeout(1300);
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("NEWLEAD");
  expect(saved).not.toContain("LEADRUN");
  expect(saved).toContain('<tspan fill="#6d5cf0" font-weight="bold">KEEPSPAN</tspan>'); // sibling element run byte-intact
  expect(saved).toContain("TAILRUN");                                                    // the other direct run survives

  // CLOSURE: reload our own save — still editable, both runs intact
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__serialize);
  const r = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return { editable: host.hasAttribute("data-svg-editable"), text: host.shadowRoot!.querySelector("text")!.textContent };
  });
  expect(r.editable).toBe(true);
  expect(r.text).toContain("NEWLEAD");
  expect(r.text).toContain("KEEPSPAN");
  expect(r.text).toContain("TAILRUN");
});

// BY DESIGN: text inside <defs>/<symbol> is a non-rendered template (paints only via <use>, no
// geometry to click) — it must NOT advertise an (unreachable) editing affordance. Half-editable
// zero-rect phantoms are the bug we're avoiding.
test("by design: <symbol>/<defs> template text exposes no editing affordance", async ({ page }) => {
  await openNote(page, "svgsymbol.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>sym</title></head><body>'
    + '<figure><svg viewBox="0 0 200 80" width="200"><defs><symbol id="badge"><rect width="80" height="30" fill="#eef"/><text x="40" y="20" text-anchor="middle">SYMTEXT</text></symbol></defs><use href="#badge" x="10" y="10"/></svg></figure>'
    + '</body></html>\n');
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(1);
  const editable = await page.evaluate(() => (document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement).hasAttribute("data-svg-editable"));
  expect(editable).toBe(false); // template text in <symbol> is not a directly-editable leaf
});
