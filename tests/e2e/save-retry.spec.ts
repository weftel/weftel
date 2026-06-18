// F50: a transient /save failure (server unreachable/restarting/non-2xx) used to leave the
// status pill stuck on "Save failed" forever — nothing retried until the user typed again,
// which then silently saved. The save system now schedules a bounded backoff auto-retry that
// flips the pill back to "Saved" once the server is reachable, with NO extra keystroke.
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

const lbl = (page: Page) => page.locator("#savestatus .lbl");

test("F50: a save that fails then recovers auto-retries back to Saved — no keystroke", async ({ page }) => {
  const path = await openNote(page, "save-retry.md", "# r\n\nseed line\n");

  // The /save POST fails while the flag is up (simulates the server being down / restarting),
  // then succeeds once it's flipped (server back). The closure lives in the Node test process,
  // so flipping it mid-test changes what later /save attempts see.
  let failSave = true;
  await page.route("**/save", async (route) => {
    if (failSave) return route.abort();
    return route.continue();
  });

  // a real keystroke arms + schedules the autosave (600ms debounce)
  await page.evaluate(() => { const e = (window as any).__editor; e.chain().focus("end").run(); e.view.focus(); });
  await page.keyboard.type(" edited-while-down");

  // the save fires, fails, and the pill shows the error
  await expect(lbl(page)).toContainText("Save failed", { timeout: 5000 });

  // server comes back — but we DO NOT type again
  failSave = false;

  // the pill recovers on its own via the bounded backoff retry…
  await expect(lbl(page)).toHaveText("Saved", { timeout: 15000 });
  // …and the edit that failed mid-blip is now actually on disk, with no keystroke
  expect(readFileSync(path, "utf8")).toContain("edited-while-down");
});

test("F50: repeated keystrokes during an outage don't stack runaway retries; one recovery", async ({ page }) => {
  const path = await openNote(page, "save-retry2.md", "# r\n\nseed\n");
  let failSave = true;
  let saveHits = 0;
  await page.route("**/save", async (route) => {
    if (failSave) return route.abort();
    saveHits++;
    return route.continue();
  });

  await page.evaluate(() => { const e = (window as any).__editor; e.chain().focus("end").run(); e.view.focus(); });
  await page.keyboard.type(" aaa");
  await expect(lbl(page)).toContainText("Save failed", { timeout: 5000 });
  // keep editing while it's down — each edit reschedules, none should leak an unbounded timer
  await page.keyboard.type(" bbb ccc");
  await expect(lbl(page)).toContainText("Save failed", { timeout: 5000 });

  failSave = false;
  await expect(lbl(page)).toHaveText("Saved", { timeout: 15000 });
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("aaa bbb ccc");
  // recovery converged: the success path didn't fire a storm of writes
  expect(saveHits).toBeLessThanOrEqual(6);
});
