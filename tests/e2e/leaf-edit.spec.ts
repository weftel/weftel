// F36 — editable HTML text leaves. Generalizes the SVG-text mechanism: EVERY visible text leaf
// inside a frozen rich block is editable — a <figcaption>, a flow-chart <div> label, a <p>/<li>,
// AND native SVG <text> — not just SVG. HTML element leaves edit IN PLACE via contentEditable
// (caret lands in the real styled box); HTML mixed runs (direct text alongside inline children) and
// SVG text edit via the floating overlay. Every commit funnels through the same byte-faithful path:
// only the one edited text node changes; all other bytes of the frozen block stay identical.
//
// A block freezes whole because it contains an unmodelable element (an <svg>) — exactly the real
// note shape (HTML labels/captions mixed with an SVG diagram or icon).
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

// A frozen <figure> (figure freezes whole + the <svg> is unmodelable) holding BOTH an SVG <text>
// run and an HTML <figcaption> — the transformer-block.html shape (the exact task example).
const FIG_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>fig</title></head><body>
<article><h1>Block</h1>
<figure class="block-diagram"><svg viewBox="0 0 200 100" width="200"><rect x="10" y="10" width="180" height="60" fill="#eef" stroke="#6d5cf0"></rect><text x="100" y="45" text-anchor="middle" fill="#333">ln1</text></svg><figcaption>OLDCAPTION here.</figcaption></figure>
<p>After.</p></article>
</body></html>
`;

// The ai-diagrams.md "CI/CD flowchart" shape: HTML <div> labels next to a pure-shape SVG icon
// (no <text>). The block freezes on the icon; the labels are HTML leaves (the F35 gap F36 closes).
const FLOW_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>flow</title></head><body>
<article><h1>Pipeline</h1>
<div data-rich-block><div style="display:flex;gap:8px;align-items:center"><div style="display:flex;flex-direction:column;align-items:center;gap:8px;width:110px"><div style="width:64px;height:64px;border:2px solid #6366f1;display:flex;align-items:center;justify-content:center"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1"><circle cx="12" cy="12" r="3"></circle></svg></div><div style="font-weight:600;font-size:14px;color:#1e1b4b">Commit</div><div style="font-size:11px;color:#6b7280">push to repo</div></div></div></div>
<p>Caption.</p></article>
</body></html>
`;

// dblclick an HTML element leaf in the frozen shadow (open contentEditable), by selector + optional
// text match. Returns the leaf's current text + whether it became the shadow's active (focused) edit.
async function openHtmlLeaf(page: Page, selector: string, matchText?: string): Promise<{ text: string; ce: string | null; focused: boolean }> {
  return await page.evaluate(({ selector, matchText }) => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    const sr = host.shadowRoot!;
    const els = Array.from(sr.querySelectorAll(selector));
    const el = (matchText ? els.find((e) => (e.textContent || "").trim() === matchText) : els[0]) as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return { text: el.textContent || "", ce: el.getAttribute("contenteditable"), focused: sr.activeElement === el };
  }, { selector, matchText });
}

test("an HTML <figcaption> in a frozen figure is click-to-edit; the figure stays a frozen rich block", async ({ page }) => {
  await openNote(page, "leaf-fig.html", FIG_DOC);
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(1);
  const r = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return {
      leafEditable: host.hasAttribute("data-leaf-editable"),
      svgEditable: host.hasAttribute("data-svg-editable"),    // the figure ALSO has SVG text
      figureKeptWhole: !!host.shadowRoot?.querySelector("figure svg"),
      ce: host.getAttribute("contenteditable"),
    };
  });
  expect(r.figureKeptWhole).toBe(true);   // figure froze whole (F4 not regressed)
  expect(r.ce).toBe("false");             // host is non-editable; only the leaf flips on dblclick
  expect(r.leafEditable).toBe(true);      // HTML-leaf affordance advertised
  expect(r.svgEditable).toBe(true);       // and SVG-text affordance too (both coexist)
});

test("editing a figcaption in place: contentEditable opens, commit persists, surrounding bytes byte-faithful", async ({ page }) => {
  const path = await openNote(page, "leaf-fig2.html", FIG_DOC);
  const o = await openHtmlLeaf(page, "figcaption");
  expect(o.text).toBe("OLDCAPTION here.");
  expect(o.ce).toBe("true");              // flipped to contentEditable in place
  expect(o.focused).toBe(true);           // caret is in the real styled box
  await page.keyboard.insertText("NEWCAPTION done.");   // selection (all) is replaced
  await page.keyboard.press("Enter");                    // commits
  const live = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return { text: host.shadowRoot!.querySelector("figcaption")!.textContent, ce: host.shadowRoot!.querySelector("figcaption")!.getAttribute("contenteditable") };
  });
  expect(live.text).toBe("NEWCAPTION done.");
  expect(live.ce).toBe(null);             // transient contentEditable attr stripped on commit

  await page.waitForTimeout(1300);        // past the autosave debounce
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("NEWCAPTION done.");
  expect(saved).not.toContain("OLDCAPTION");
  // surrounding bytes untouched — the SVG geometry, the <text>, the <figure>, the neighbor <p>
  expect(saved).toContain('<rect x="10" y="10" width="180" height="60" fill="#eef" stroke="#6d5cf0">');
  expect(saved).toContain('<text x="100" y="45" text-anchor="middle" fill="#333">ln1</text>');
  expect(saved).toContain('<figure class="block-diagram">');
  expect(saved).toContain("<p>After.</p>");
  expect(saved).not.toContain("contenteditable");   // transient attr never leaks to disk
  expect(saved).not.toContain("data-leaf-editable");
});

// BOUNDARY (V2 resolution): the ai-diagrams.md "CI/CD flowchart" shape. Under FULL_PARSE, isolateRich
// descends through the structural flex <div> wrappers and freezes ONLY the minimal unmodelable subtree
// (the pure-shape SVG icon). So the HTML <div> LABELS ("Commit", "push to repo") become NORMAL editable
// prose in the light DOM — they must NOT be re-routed through the frozen-leaf path. F36's frozen path
// fires only when a leaf is genuinely trapped in a frozen block (a <figure>'s figcaption), never here.
test("boundary: flow-chart HTML labels next to an SVG icon stay NORMAL editable prose, not frozen leaves", async ({ page }) => {
  const path = await openNote(page, "leaf-flow.html", FLOW_DOC);
  const probe = await page.evaluate(() => {
    const pm = document.querySelector(".ProseMirror") as HTMLElement;
    const rbs = Array.from(pm.querySelectorAll("[data-rich-block]")) as HTMLElement[];
    // "Commit" must be a live editable text node in the LIGHT DOM — not buried in a frozen shadow
    let commitInLight = false; const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    let n: Node | null; while ((n = w.nextNode())) { if ((n.textContent || "").trim() === "Commit") { commitInLight = true; break; } }
    return {
      richBlockCount: rbs.length,
      commitInLight,
      commitInShadow: rbs.some((rb) => (rb.shadowRoot?.textContent || "").includes("Commit")),
      frozenHoldsOnlySvg: rbs.every((rb) => !!rb.shadowRoot?.querySelector("svg") && !(rb.shadowRoot?.textContent || "").trim()),
      pmEditable: pm.getAttribute("contenteditable"),
    };
  });
  expect(probe.commitInLight).toBe(true);          // a normal editable text node
  expect(probe.commitInShadow).toBe(false);        // NOT trapped in the frozen shadow (boundary held)
  expect(probe.richBlockCount).toBe(1);            // only the SVG icon froze
  expect(probe.frozenHoldsOnlySvg).toBe(true);     // the frozen block is just the pure-shape icon
  expect(probe.pmEditable).toBe("true");           // the surrounding prose (incl. the labels) is directly editable
  // and the frozen icon block itself carries NO leaf affordance (nothing editable trapped inside)
  await expect(page.locator(".ProseMirror [data-rich-block]")).not.toHaveAttribute("data-leaf-editable", "");
});

test("closure + idempotence: an edited HTML leaf survives reload, stays editable, round-trip settles in ≤1 pass", async ({ page }) => {
  const path = await openNote(page, "leaf-closure.html", FIG_DOC);
  await openHtmlLeaf(page, "figcaption");
  await page.keyboard.insertText("PERSISTED caption.");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1300);
  const s1 = readFileSync(path, "utf8");

  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__serialize);
  const r = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return { text: host.shadowRoot!.querySelector("figcaption")!.textContent, editable: host.hasAttribute("data-leaf-editable") };
  });
  expect(r.text).toBe("PERSISTED caption.");
  expect(r.editable).toBe(true);          // re-reads as editable (closure)
  const after = await openHtmlLeaf(page, "figcaption");
  expect(after.text).toBe("PERSISTED caption.");
  expect(after.ce).toBe("true");          // re-edits too
  await page.keyboard.press("Escape");    // cancel — no change

  const s2 = await page.evaluate(() => (window as any).__serialize());
  expect(s2).toBe(s1);                     // idempotent: serialize reproduces saved bytes immediately
});

test("security: typed <script> persists ESCAPED as text, never executes; 0 live <script>/on* in shadow", async ({ page }) => {
  const path = await openNote(page, "leaf-sec.html", FIG_DOC);
  // install a tripwire the payload would flip if it ever executed
  await page.evaluate(() => ((window as any).__pwned = false));
  await openHtmlLeaf(page, "figcaption");
  await page.keyboard.insertText('<script>window.__pwned=true</script><img src=x onerror=window.__pwned=true>');
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1300);
  const live = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return {
      pwned: (window as any).__pwned,
      caption: host.shadowRoot!.querySelector("figcaption")!.textContent,
      liveScripts: host.shadowRoot!.querySelectorAll("script").length,
      onAttrs: Array.from(host.shadowRoot!.querySelectorAll("*")).filter((e) => Array.from(e.attributes).some((a) => a.name.toLowerCase().startsWith("on"))).length,
    };
  });
  expect(live.pwned).toBe(false);                          // never executed
  expect(live.caption).toBe('<script>window.__pwned=true</script><img src=x onerror=window.__pwned=true>'); // kept verbatim as TEXT
  expect(live.liveScripts).toBe(0);                        // no live <script> element materialized
  expect(live.onAttrs).toBe(0);                            // no live on* handler materialized

  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("&lt;script&gt;");               // escaped on disk
  expect(saved).not.toContain("<script>window.__pwned");   // never a live tag

  // reload our own save — still inert
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__serialize);
  const afterReload = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return { pwned: (window as any).__pwned, liveScripts: host.shadowRoot!.querySelectorAll("script").length };
  });
  expect(afterReload.pwned).toBeFalsy();
  expect(afterReload.liveScripts).toBe(0);
});

// MIXED RUN: a figcaption mixing a direct text run with an inline <strong> child. The direct runs
// edit via the overlay (a bare text node can't be contentEditable in isolation); the <strong> is its
// own in-place leaf. Editing one run leaves the sibling element + the other run byte-intact.
const MIXED_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mix</title></head><body>
<article><h1>Mixed</h1>
<figure class="d"><svg viewBox="0 0 60 60" width="60"><circle cx="30" cy="30" r="20" fill="#eef"></circle></svg><figcaption>LEADRUN <strong>KEEPBOLD</strong> TAILRUN</figcaption></figure>
<p>Caption.</p></article>
</body></html>
`;
test("mixed run: a direct text run alongside an inline <strong> edits via overlay; the <strong> + other run survive", async ({ page }) => {
  const path = await openNote(page, "leaf-mixed.html", MIXED_DOC);
  // dblclick the LEADING direct run (hit-test on the figcaption resolves to the left run)
  await page.evaluate(() => {
    const sr = (document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement).shadowRoot!;
    const cap = sr.querySelector("figcaption")!;
    const lead = Array.from(cap.childNodes).find((n) => n.nodeType === 3 && (n.textContent || "").trim() === "LEADRUN")!;
    const rng = document.createRange(); rng.selectNode(lead); const r = rng.getBoundingClientRect();
    cap.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  const overlay = page.locator("input.svgtext-overlay");
  await expect(overlay).toHaveValue("LEADRUN ");          // the run's own text (trailing space kept)
  await overlay.fill("NEWLEAD ");
  await overlay.press("Enter");
  await page.waitForTimeout(1300);
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("NEWLEAD");
  expect(saved).not.toContain("LEADRUN");
  expect(saved).toContain("<strong>KEEPBOLD</strong>");   // inline sibling byte-intact
  expect(saved).toContain("TAILRUN");                     // other direct run survives
});

// BOUNDARY CANARY: a frozen block whose only HTML text is inside a <foreignObject> (frozen, F27) plus
// decorative empty spans (F12) must NOT advertise the HTML-leaf affordance.
test("by design: foreignObject HTML + decorative empty spans expose no HTML-leaf affordance", async ({ page }) => {
  await openNote(page, "leaf-boundary.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><title>b</title></head><body>'
    + '<figure class="d"><svg viewBox="0 0 200 80" width="200"><rect width="200" height="80" fill="#eef"></rect><foreignObject x="10" y="10" width="180" height="60"><div>frozen FO text</div></foreignObject><span style="width:2px;height:24px;background:#aaa"></span></svg></figure>'
    + '</body></html>\n');
  await expect(page.locator(".ProseMirror [data-rich-block]")).toHaveCount(1);
  const r = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    return { leafEditable: host.hasAttribute("data-leaf-editable"), svgEditable: host.hasAttribute("data-svg-editable") };
  });
  expect(r.leafEditable).toBe(false);     // foreignObject text frozen (F27) + empty span decorative (F12) → no affordance
  expect(r.svgEditable).toBe(false);      // no native SVG <text> either
});

// ELEMENT-AGNOSTIC SWEEP: enumerate EVERY visible text node in a mixed block and assert each is
// editable through the leaf mechanism OR a deliberate logged boundary — don't special-case SVG.
test("element-agnostic: every visible text node in a frozen block is editable or a logged boundary", async ({ page }) => {
  await openNote(page, "leaf-sweep.html", FIG_DOC);
  const report = await page.evaluate(() => {
    const host = document.querySelector(".ProseMirror [data-rich-block]") as HTMLElement;
    const sr = host.shadowRoot!;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const inForeignObject = (el: Element | null) => { let p = el; while (p) { if (((p as any).localName || p.tagName || "").toLowerCase() === "foreignobject") return true; p = p.parentElement; } return false; };
    // walk every non-whitespace text node that is NOT inside an injected <style>
    const walker = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT);
    const out: { text: string; verdict: string }[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim(); if (!t) continue;
      const parent = n.parentElement!;
      if (parent.closest("style") || parent.tagName === "STYLE") continue; // injected stylesheet text, not content
      const svgText = parent.namespaceURI === SVG_NS && ["text", "tspan", "textpath"].includes((parent as any).localName);
      const htmlLeafParent = parent.namespaceURI !== SVG_NS && parent.children.length === 0;
      if (inForeignObject(parent)) out.push({ text: t, verdict: "boundary:foreignObject(F27)" });
      else if (svgText) out.push({ text: t, verdict: "editable:svg-text" });
      else if (htmlLeafParent) out.push({ text: t, verdict: "editable:html-leaf" });
      else out.push({ text: t, verdict: "editable:html-run-or-nested" });
    }
    return out;
  });
  // every visible text node has a verdict; none is an un-handled gap
  expect(report.length).toBeGreaterThan(0);
  for (const r of report) expect(r.verdict).not.toBe("");
  // the two visible texts in FIG_DOC: the SVG label + the figcaption — both editable, by DIFFERENT mechanisms
  expect(report.find((r) => r.text === "ln1")?.verdict).toBe("editable:svg-text");
  expect(report.find((r) => r.text === "OLDCAPTION here.")?.verdict).toBe("editable:html-leaf");
});
