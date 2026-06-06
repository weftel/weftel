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

test("chat returns a reply and 'Insert into note' works (AI replayed)", async ({ page }) => {
  await openNote(page, "chat.md", "# Roadmap\n\nWe ship the editor in June.\n");
  await page.locator("#chatchip").click();
  const input = page.locator(".chat-input");
  await expect(input).toBeVisible();
  await input.fill("In one short sentence, what is this note about?");
  await input.press("Enter");
  await expect(page.locator(".chat-msg.assistant").last()).toContainText(/.{8,}/, { timeout: 60_000 }); // a real reply
  await page.locator(".chat-msg.assistant .insert").last().click();
  await expect(page.locator(".ProseMirror")).toContainText(/.{8,}/); // reply landed in the note
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
