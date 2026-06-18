// F49 regression — a ⌘K-GENERATED table must be visible in the approval gate's preview.
//
// Bug: ⌘K "create a table 3x3" routes to AUTHOR mode (a generative insert), whose proposal
// reaches diffApprove() with no `css`. The gate renders the fragment inside a shadow root whose
// baseline reset styled only font/color/media — NOT tables. The live editor draws every table's
// gridlines via `.ProseMirror table td,th{border…}` (server.ts), and the SYSTEM prompt tells the
// model to emit a PLAIN <table> (no inline borders). So the generated table rendered borderless
// and padding-less in the gate — a 3x3 mostly-empty grid you literally cannot see — and you were
// asked to approve a change you couldn't see. (Cousin of F45/S11: the gate DID render SVG rich-
// block rewrites, which carry their own styling, so "the gate renders the change" held for one
// path and silently failed for table generation.)
//
// Deterministic by intercepting /rewrite (no live model / cache-key coupling): the gate render
// path is purely client-side, so a stubbed plain-table proposal faithfully reproduces what the
// human saw. We assert the table is present in the preview AND that its cells render with a
// visible border (the gridlines that make it recognizable as a table).
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const AI_EDIT_ENABLED = process.env.AI_EDIT_ENABLED === "1";
const VAULT = resolve("tests/e2e/.vault");
mkdirSync(VAULT, { recursive: true });

// A PLAIN table — exactly the shape the SYSTEM prompt asks the model for ("a plain <table>"):
// no inline border/padding styles, so its visibility in the gate depends entirely on the gate's
// own baseline styling.
const PLAIN_TABLE =
  "<table><tr><th>A</th><th>B</th><th>C</th></tr>" +
  "<tr><td>1</td><td>2</td><td>3</td></tr>" +
  "<tr><td>4</td><td>5</td><td>6</td></tr></table>";

async function openNote(page: Page, name: string, content: string): Promise<string> {
  const path = join(VAULT, name);
  writeFileSync(path, content);
  await page.goto("/?file=" + encodeURIComponent(path));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor);
  return path;
}

test("F49: a ⌘K-generated table is rendered WITH gridlines in the approval gate preview", async ({ page }) => {
  test.skip(!AI_EDIT_ENABLED, "in-app AI edit (⌘K) + diff-gate are env-gated (AI_EDIT_ENABLED=1)");

  // Stub the model: return the plain table as the /rewrite SSE `done` payload.
  await page.route("**/rewrite", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      body: "data: " + JSON.stringify({ done: { ok: true, text: PLAIN_TABLE, html: true } }) + "\n\n",
    }),
  );

  await openNote(page, "f49-gate-table.md", "# t\n\n");
  await page.evaluate(() => (window as any).__editor.chain().clearContent().focus("end").run());
  await page.locator(".ProseMirror").click();

  await page.keyboard.press("Meta+k");
  const input = page.locator(".cmdk input");
  await expect(input).toBeVisible();
  await input.fill("create a table 3x3");
  await input.press("Enter");

  // The approval gate appears with the generated table as an "added" hunk.
  await expect(page.locator(".dgate-root")).toBeVisible({ timeout: 15_000 });
  const renderHost = page.locator(".dgate-add .dgate-render");
  await expect(renderHost).toHaveCount(1);

  // Reach into the preview shadow root: the table is present AND its cells have a visible border.
  const probe = await page.evaluate(() => {
    const host = document.querySelector(".dgate-add .dgate-render") as HTMLElement | null;
    const shadow = host && (host as any).shadowRoot;
    if (!shadow) return { hasTable: false, cells: 0, borderTopWidth: "n/a" };
    const cell = shadow.querySelector("td, th") as HTMLElement | null;
    const cs = cell ? getComputedStyle(cell) : null;
    return {
      hasTable: !!shadow.querySelector("table"),
      cells: shadow.querySelectorAll("td, th").length,
      borderTopWidth: cs ? cs.borderTopWidth : "n/a",
    };
  });

  expect(probe.hasTable).toBe(true);
  expect(probe.cells).toBe(9);
  // The crux: before the fix the cell border computed to 0px (an invisible grid). After, it's a
  // real gridline the human can actually see before approving.
  expect(parseFloat(probe.borderTopWidth)).toBeGreaterThan(0);
});
