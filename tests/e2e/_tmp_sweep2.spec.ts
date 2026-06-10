import { test } from "@playwright/test";
import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const VAULT = resolve("tests/e2e/.vault");
const CORPUS = resolve("tests/e2e/corpus");

// PART 1 — serialization idempotence across the corpus: S1 = serialize(load(file));
// S2 = serialize(load(S1)). If S1 !== S2 the format never settles (file churn on every open).
test("idempotence sweep", async ({ page }) => {
  test.setTimeout(120_000);
  const subsets = readdirSync(CORPUS).filter((d) => !d.startsWith("_") && !d.startsWith(".") && statSync(join(CORPUS, d)).isDirectory());
  const results: string[] = [];
  for (const sub of subsets) {
    for (const f of readdirSync(join(CORPUS, sub)).filter((x) => x.endsWith(".html"))) {
      const src = readFileSync(join(CORPUS, sub, f), "utf8");
      const vp = join(VAULT, "idem__" + sub + "__" + f);
      writeFileSync(vp, src);
      await page.goto("/?file=" + encodeURIComponent(vp));
      await page.waitForSelector(".ProseMirror"); await page.waitForFunction(() => (window as any).__serialize);
      const s1: string = await page.evaluate(() => (window as any).__serialize());
      writeFileSync(vp, s1);
      await page.goto("/?file=" + encodeURIComponent(vp));
      await page.waitForSelector(".ProseMirror"); await page.waitForFunction(() => (window as any).__serialize);
      const s2: string = await page.evaluate(() => (window as any).__serialize());
      if (s1 === s2) results.push("OK    " + sub + "/" + f);
      else {
        // find first divergence for the report
        let i = 0; while (i < Math.min(s1.length, s2.length) && s1[i] === s2[i]) i++;
        results.push("CHURN " + sub + "/" + f + "  (len " + s1.length + "→" + s2.length + ", first diff @" + i + ": …" + JSON.stringify(s1.slice(Math.max(0, i - 30), i + 40)) + " vs …" + JSON.stringify(s2.slice(Math.max(0, i - 30), i + 40)) + ")");
      }
    }
  }
  console.log("\nIDEMPOTENCE:\n" + results.join("\n"));
});

// PART 2 — edge ops on a styled doc: undo/redo, backspace-merge at a styled-box boundary,
// select-all-type-undo. Looking for crashes, content loss, console errors.
test("edge ops sweep", async ({ page }) => {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR " + e));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  const src = readFileSync(join(CORPUS, "styling-source/class-and-style.html"), "utf8");
  const vp = join(VAULT, "edgeops.html"); writeFileSync(vp, src);
  await page.goto("/?file=" + encodeURIComponent(vp));
  await page.waitForSelector(".ProseMirror"); await page.waitForFunction(() => (window as any).__editor);
  const out: string[] = [];
  const text0: string = await page.evaluate(() => (window as any).__editor.getText());

  // undo/redo round-trip
  await page.evaluate(() => { const e = (window as any).__editor; let from = 0; e.state.doc.descendants((n: any, p: number) => { if (!from && n.isText) from = p; }); e.chain().focus().setTextSelection({ from, to: from + 2 }).run(); e.view.focus(); });
  await page.keyboard.type("ZZ");
  const t1: string = await page.evaluate(() => (window as any).__editor.getText());
  await page.keyboard.press("Meta+z");
  const t2: string = await page.evaluate(() => (window as any).__editor.getText());
  out.push("undo restores: " + (t2 === text0 ? "PASS" : "ISSUE (text differs after undo)") + "; edit applied: " + (t1 !== text0 ? "PASS" : "ISSUE"));
  await page.keyboard.press("Meta+Shift+z");
  const t3: string = await page.evaluate(() => (window as any).__editor.getText());
  out.push("redo reapplies: " + (t3 === t1 ? "PASS" : "ISSUE"));
  await page.keyboard.press("Meta+z"); // back to original

  // select-all + type + undo (the scary one)
  await page.keyboard.press("Meta+a"); await page.keyboard.type("X");
  const t4: string = await page.evaluate(() => (window as any).__editor.getText());
  await page.keyboard.press("Meta+z");
  const t5: string = await page.evaluate(() => (window as any).__editor.getText());
  out.push("select-all replace: " + (t4.trim() === "X" ? "PASS" : "noted(" + t4.slice(0, 20) + ")") + "; undo restores: " + (t5 === text0 ? "PASS" : "ISSUE — CONTENT NOT RESTORED"));

  out.push("console/page errors: " + (errs.length ? "ISSUE — " + errs.slice(0, 2).join(" | ") : "none"));
  console.log("\nEDGEOPS:\n" + out.join("\n"));
});
