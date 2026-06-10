// CORPUS HARNESS — differential, trustworthy round-trip tests for full-parse editing.
//
// Why this exists: a single corpus proves "this shape works," not "the engine is robust."
// Different HTML stresses different parts of the pipeline, so the corpus is partitioned into
// themed sub-folders (tests/e2e/corpus/<subset>/*.html); each fixture is one test, grouped by
// subset, so a red result names the weak capability.
//
// Why it's trustworthy (the earlier e2e gave a FALSE PASS because Playwright locators pierce
// open shadow DOM and counted a frozen block's contents as editable):
//   • editability is proven BEHAVIORALLY through the ProseMirror document model — frozen content
//     isn't in the doc, so it can't be selected/typed; a frozen masquerade fails, not passes.
//   • round-trip is checked on the REAL saved bytes (window.__serialize), not the live DOM.
//   • a negative-control canary (pure SVG) must report NOT-editable, self-checking the detector.
//   • a screenshot per fixture lands in corpus/_shots/ for human spot-check.
//
// Per-fixture directive (HTML comment anywhere in the file), all optional:
//   <!--corpus stress="..." editable=true frozenMin=1 editTarget="word" neighbor="word" -->
//     editable   (default true)  — should there be human-editable light-DOM content?
//     frozenMin  (default 0)     — at least this many frozen [data-rich-block] hosts
//     editTarget                  — a word to edit in place (behavioral proof of editability)
//     neighbor                    — a word that MUST survive the edit (no collapse/replace-all)
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const VAULT = resolve("tests/e2e/.vault");
const CORPUS = resolve("tests/e2e/corpus");
const SHOTS = join(CORPUS, "_shots");
mkdirSync(VAULT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

type Dir = { stress: string; editable: boolean; frozenMin: number; editTarget?: string; neighbor?: string; mustContain?: string };
function parseDirective(html: string): Dir {
  const m = html.match(/<!--\s*corpus\b([\s\S]*?)-->/i);
  const a = m ? m[1] : "";
  const get = (k: string) => { const r = a.match(new RegExp(k + '\\s*=\\s*"([^"]*)"')); return r ? r[1] : undefined; };
  const getBare = (k: string) => { const r = a.match(new RegExp(k + "\\s*=\\s*([^\\s\"]+)")); return r ? r[1] : undefined; };
  return {
    stress: get("stress") || "",
    editable: (getBare("editable") ?? "true") !== "false",
    frozenMin: parseInt(getBare("frozenMin") || "0", 10),
    editTarget: get("editTarget"),
    neighbor: get("neighbor"),
    mustContain: get("mustContain"),
  };
}
// Visible-text normalization for the lossless round-trip check: drop comments + <style>/<script>
// bodies, strip tags, unescape entities, collapse whitespace. SVG/text content is kept (it's real
// content present on both sides).
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

async function openFixture(page: Page, vaultPath: string): Promise<string[]> {
  const errors: string[] = [];
  // Ignore benign external-resource 404s — real-world docs reference images/fonts that don't
  // exist in the test environment; that's not an editor error. Keep real JS exceptions (pageerror)
  // and any other console.error (CSP blocks, thrown code, etc.).
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|net::|favicon/i.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e)));
  await page.goto("/?file=" + encodeURIComponent(vaultPath));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
  return errors;
}

const subsets = existsSync(CORPUS) ? readdirSync(CORPUS).filter((d) => !d.startsWith("_") && !d.startsWith(".") && existsSync(join(CORPUS, d)) && statSync(join(CORPUS, d)).isDirectory() && readdirSync(join(CORPUS, d)).some((f) => f.endsWith(".html"))) : [];

for (const subset of subsets) {
  test.describe("corpus · " + subset, () => {
    const files = readdirSync(join(CORPUS, subset)).filter((f) => f.endsWith(".html"));
    for (const file of files) {
      test(file.replace(/\.html$/, ""), async ({ page }) => {
        const src = readFileSync(join(CORPUS, subset, file), "utf8");
        const d = parseDirective(src);
        const vpath = join(VAULT, "corpus__" + subset + "__" + file);
        writeFileSync(vpath, src);
        const errors = await openFixture(page, vpath);

        // screenshot for human spot-check
        await page.locator("#editor").screenshot({ path: join(SHOTS, subset + "__" + file.replace(/\.html$/, "") + ".png") }).catch(() => {});

        // 1) no console / page errors on load
        expect(errors, "console errors on load").toEqual([]);

        // 2) lossless load+save: NO CONTENT lost after a (no-edit) serialize. Compared with all
        // whitespace removed — re-serialization legitimately reflows spacing (and PM normalizes a
        // space adjacent to an inline <code>/mark), which is not content loss; a dropped word or
        // character still fails because the character sequence diverges.
        const preSave: string = await page.evaluate(() => (window as any).__serialize());
        const strip = (s: string) => visibleText(s).replace(/\s+/g, "");
        expect(strip(preSave), "characters/words lost on load+save (real content loss)").toBe(strip(src));

        // 3) safety — OWN-FILES model: we PRESERVE user content losslessly (a script is often
        //    Claude-Code-authored; deleting it is the worse failure), but the editor must never
        //    EXECUTE note content, and active content must stay out of the live editable surface.
        //    (Hardening against genuinely untrusted imported HTML is deferred.)
        const executed = await page.evaluate(() => (window as any).__corpusPwned === true || /pwned/i.test(document.title));
        expect(executed, "note content executed in the editor").toBe(false);
        const live = await page.evaluate(() => {
          const pm = document.querySelector(".ProseMirror") as HTMLElement; // light DOM = the editable surface
          return {
            scripts: pm.querySelectorAll("script").length,
            iframes: pm.querySelectorAll("iframe").length,
            onattr: Array.from(pm.querySelectorAll("*")).some((e) => Array.from((e as HTMLElement).attributes).some((a) => /^on[a-z]+/i.test(a.name))),
            jsurl: Array.from(pm.querySelectorAll("[href],[src]")).some((e) => /^\s*javascript:/i.test((e.getAttribute("href") || e.getAttribute("src") || ""))),
          };
        });
        expect(live.scripts, "live <script> on the editable surface").toBe(0);
        expect(live.iframes, "live <iframe> on the editable surface").toBe(0);
        expect(live.onattr, "live on* handler on the editable surface").toBe(false);
        expect(live.jsurl, "live javascript: URL on the editable surface").toBe(false);
        expect(preSave).not.toContain("data-sbox");
        // lossless preservation of intentional content (e.g. a user's <script> survives the save)
        if (d.mustContain) expect(preSave, `lossless: "${d.mustContain}" not preserved in saved bytes`).toContain(d.mustContain);

        // 3.5) SERIALIZATION SETTLES: re-loading our own save must reproduce itself (S2 == S1),
        // or at worst settle by the second pass (S3 == S2). A format that never settles churns
        // the file on every open — silent rot. (One settle pass is tolerated: a few real-world
        // docs normalize once — nested-span collapse, code-leading-space — then stabilize.)
        const vp2 = join(VAULT, "corpus_idem__" + subset + "__" + file);
        writeFileSync(vp2, preSave);
        await page.goto("/?file=" + encodeURIComponent(vp2));
        await page.waitForSelector(".ProseMirror");
        await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
        const s2: string = await page.evaluate(() => (window as any).__serialize());
        if (s2 !== preSave) {
          writeFileSync(vp2, s2);
          await page.goto("/?file=" + encodeURIComponent(vp2));
          await page.waitForSelector(".ProseMirror");
          await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
          const s3: string = await page.evaluate(() => (window as any).__serialize());
          expect(s3, "serialization never settles (file churns on every open)").toBe(s2);
        }
        // back to the original doc for the remaining checks
        await page.goto("/?file=" + encodeURIComponent(vpath));
        await page.waitForSelector(".ProseMirror");
        await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);

        // 4) unmodelable preservation vs security stripping
        const counts = await page.evaluate(() => {
          const pm = document.querySelector(".ProseMirror") as HTMLElement;
          const hosts = Array.from(pm.querySelectorAll("[data-rich-block]")) as HTMLElement[];
          const inShadow = (sel: string) => hosts.reduce((n, h) => n + (h.shadowRoot ? h.shadowRoot.querySelectorAll(sel).length : 0), 0);
          // editable light-DOM content NOT inside a frozen host (styled boxes count — AI cards
          // are all <div>, no <p>); shadow-DOM content of frozen blocks is invisible to this query.
          // Require real content: a trailing empty <p> (PM's cursor affordance after an atom) is
          // not "content the user would edit" — counting it would mask a fully-frozen doc.
          // Require real editable TEXT in light DOM. (An empty styled-box wrapper whose only
          // content is a frozen block — e.g. a Marp slide's text lives inside a frozen SVG — is
          // NOT editable prose; counting it would falsely report a fully-frozen doc as editable.)
          const prose = Array.from(pm.querySelectorAll("p,h1,h2,h3,h4,h5,li,blockquote,td,th,[data-sbox]"))
            .filter((e) => !(e as HTMLElement).closest("[contenteditable=false]"))
            .filter((e) => (e.textContent || "").trim().length > 0).length;
          // img is a NATIVE editable node now (paste support) — a light-DOM image outside any
          // frozen host counts as preserved too (querySelectorAll doesn't pierce shadow roots).
          const lightImg = Array.from(pm.querySelectorAll("img")).filter((e) => !(e as HTMLElement).closest("[contenteditable=false]")).length;
          return { richHosts: hosts.length, svg: inShadow("svg"), img: inShadow("img") + lightImg, canvas: inShadow("canvas"), editableProse: prose };
        });
        const srcCount = (re: RegExp) => (src.match(re) || []).length;
        // preservable unmodelables must all survive (frozen-in-shadow; img may be native)
        if (srcCount(/<svg\b/gi)) expect(counts.svg, "svg not preserved in a frozen block").toBeGreaterThanOrEqual(1);
        if (srcCount(/<img\b/gi)) expect(counts.img, "img lost (neither native node nor frozen)").toBeGreaterThanOrEqual(1);
        if (srcCount(/<canvas\b/gi)) expect(counts.canvas, "canvas not preserved in a frozen block").toBeGreaterThanOrEqual(1);
        // security-stripped elements must be gone entirely
        expect(preSave.toLowerCase()).not.toContain("<iframe");

        // 5) frozen / editable detection per directive
        expect(counts.richHosts, "fewer frozen blocks than expected").toBeGreaterThanOrEqual(d.frozenMin);
        if (d.editable) expect(counts.editableProse, "expected editable prose, found none (masquerading frozen?)").toBeGreaterThan(0);
        else expect(counts.editableProse, "expected NO editable prose (canary)").toBe(0);

        // 6) BEHAVIORAL edit through the document model — the trust core.
        // Real-world fixtures carry no directive, so auto-derive the target from the document
        // model: a word that occurs once in editor.getText() is provably editable (frozen text
        // isn't in the model), so the edit must succeed — no hand-picked target needed.
        let target = d.editTarget, neighbor = d.neighbor;
        if (!target && d.editable) {
          const auto = await page.evaluate(() => {
            const txt = ((window as any).__editor.getText() || "");
            const words = txt.match(/[A-Za-z]{5,}/g) || [];
            const freq: Record<string, number> = {}; words.forEach((w: string) => (freq[w] = (freq[w] || 0) + 1));
            const uniq = words.filter((w: string) => freq[w] === 1);
            const t = uniq[0] || null;
            return { target: t, neighbor: (uniq.find((w: string) => w !== t) || words.find((w: string) => w !== t) || null) };
          });
          target = auto.target || undefined; neighbor = neighbor || auto.neighbor || undefined;
        }
        if (target) {
          const before = await page.evaluate((t) => {
            const e = (window as any).__editor; let from = 0, to = 0, found = false;
            e.state.doc.descendants((n: any, pos: number) => { if (!found && n.isText) { const i = n.text.indexOf(t); if (i >= 0) { from = pos + i; to = pos + i + t.length; found = true; } } });
            if (found) { e.chain().focus().setTextSelection({ from, to }).run(); e.view.focus(); }
            return { found, childCount: e.state.doc.childCount };
          }, target);
          expect(before.found, `editTarget "${target}" not selectable in the document (content is frozen, not editable)`).toBe(true);
          await page.keyboard.type("XEDITX");
          const after = await page.evaluate(() => ({ childCount: (window as any).__editor.state.doc.childCount }));
          expect(after.childCount, "document collapsed on edit (atomic-block behaviour)").toBe(before.childCount);
          const postSave: string = await page.evaluate(() => (window as any).__serialize());
          expect(postSave, "edit did not persist to saved bytes").toContain("XEDITX");
          if (neighbor) expect(postSave, `neighbor "${neighbor}" lost on edit`).toContain(neighbor);
          expect(postSave).not.toContain("data-sbox");
        }
      });
    }
  });
}

if (!subsets.length) test("corpus has fixtures", () => { throw new Error("no corpus fixtures found under " + CORPUS); });
