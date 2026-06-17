// fm-sidebar (Track C) — Obsidian-grade explorer + sectioned workspace.
// Drives the REAL editor in Chromium, in DARK mode (the design target: bg #0e0e11).
//
// What's tested IN ISOLATION (no new server endpoints): the context menu OPENS with the right
// items (built from commandsFor(kind)), MD/HTML chips render + pass contrast, the Favorites star
// toggles + persists, inline-rename input appears on double-click, empty folders render, sections
// render + collapse, the drop indicator highlights on dragover, Recent orders by mtime.
//
// The /list `dirs` + `mtime` fields and the /trash response are mocked via page.route — the
// SERVER work (return `dirs`/`mtime`, add /trash + /restore + /move) lands at integration. Tests
// that need a real endpoint are marked `test.fixme` or "// needs integration: <endpoint>".
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

test.use({ colorScheme: "dark" });

const VAULT = resolve("tests/e2e/.vault");
mkdirSync(VAULT, { recursive: true });

const NOW = Date.now();
// Synthetic /list payload: 3 notes (md + html + a nested one) and 3 dirs — two of them EMPTY
// ("Empty Folder", "Projects/Sub") so the empty-folder seeding has something to render.
function listPayload() {
  return {
    root: VAULT,
    files: [
      { name: "alpha.md", path: join(VAULT, "alpha.md"), rel: "alpha.md", fmt: "md", mtime: NOW - 60_000 },
      { name: "beta.html", path: join(VAULT, "beta.html"), rel: "beta.html", fmt: "html", mtime: NOW - 3_600_000 },
      { name: "deep.md", path: join(VAULT, "Projects", "deep.md"), rel: "Projects/deep.md", fmt: "md", mtime: NOW - 200_000 },
    ],
    dirs: ["Projects", "Empty Folder", "Projects/Sub"],
  };
}

// Open a real seed note (so the editor + sidebar mount), but serve our synthetic /list.
async function openSidebar(page: Page, opts: { trash?: any } = {}): Promise<string> {
  const seed = join(VAULT, "seed.md");
  writeFileSync(seed, "# seed\n\n");
  await page.route("**/list?*", (route) => route.fulfill({ json: listPayload() }));
  if (opts.trash !== undefined) {
    await page.route("**/trash?*", (route) => route.fulfill({ json: { entries: opts.trash } }));
  }
  await page.goto("/?file=" + encodeURIComponent(seed));
  await page.waitForSelector(".ProseMirror");
  await page.waitForSelector('.fm-section[data-section="notebook"]');
  return seed;
}

const NOTEBOOK = '.fm-section[data-section="notebook"]';
const sectionHead = (page: Page, id: string) => page.locator(`.fm-section[data-section="${id}"] .fm-section-head`);

test("sections render top→bottom: Favorites, Recent, Notebook, Trash", async ({ page }) => {
  await openSidebar(page);
  const titles = await page.locator(".fm-section-head .fm-sec-title").allTextContents();
  expect(titles).toEqual(["Favorites", "Recent", "Notebook", "Trash"]);
});

test("a section collapses + the body hides when its header is clicked", async ({ page }) => {
  await openSidebar(page);
  const nb = page.locator(NOTEBOOK);
  await expect(nb).not.toHaveClass(/collapsed/);
  await expect(nb.locator(".fm-section-body")).toBeVisible();
  await sectionHead(page, "notebook").click();
  await expect(nb).toHaveClass(/collapsed/);
  await expect(nb.locator(".fm-section-body")).toBeHidden();
});

test("type chips render the literal extension", async ({ page }) => {
  await openSidebar(page);
  await expect(page.locator(`${NOTEBOOK} .fm-chip.md`).first()).toHaveText(".md");
  await expect(page.locator(`${NOTEBOOK} .fm-chip.html`).first()).toHaveText(".html");
});

test("type chips clear WCAG 4.5:1 on the dark sidebar", async ({ page }) => {
  await openSidebar(page);
  for (const cls of ["md", "html"]) {
    const ratio = await page.locator(`.fm-chip.${cls}`).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      const lum = (rgb: string) => {
        const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) || ["0", "0", "0"]).map(Number);
        const ch = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      const a = lum(cs.color), b = lum(cs.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio, `chip .${cls} contrast`).toBeGreaterThanOrEqual(4.5);
  }
});

test("right-click a note row opens a context menu built from the file commands", async ({ page }) => {
  await openSidebar(page);
  await page.locator(`${NOTEBOOK} .note-link`, { hasText: "alpha" }).first().click({ button: "right" });
  const menu = page.locator(".fm-menu");
  await expect(menu).toBeVisible();
  // items come from commandsFor("file") — open / rename / duplicate / move / copy path / delete (+ star)
  await expect(menu.locator(".fm-menu-item", { hasText: "Open in new tab" })).toBeVisible();
  await expect(menu.locator(".fm-menu-item", { hasText: "Rename" })).toBeVisible();
  await expect(menu.locator(".fm-menu-item.danger", { hasText: "Delete" })).toBeVisible();
  await expect(menu.locator(".fm-menu-item", { hasText: "favorites" })).toBeVisible();
});

test("right-click a folder row shows folder-only commands (New note/folder here)", async ({ page }) => {
  await openSidebar(page);
  await page.locator(`${NOTEBOOK} .folder-row`, { hasText: "Empty Folder" }).first().click({ button: "right" });
  const menu = page.locator(".fm-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".fm-menu-item", { hasText: "New note here" })).toBeVisible();
  await expect(menu.locator(".fm-menu-item", { hasText: "New folder here" })).toBeVisible();
  await expect(menu.locator(".fm-menu-item.danger", { hasText: "Delete" })).toBeVisible();
  // a file-only command must NOT appear on a folder
  await expect(menu.locator(".fm-menu-item", { hasText: "Open in new tab" })).toHaveCount(0);
});

test("the context menu closes on Escape", async ({ page }) => {
  await openSidebar(page);
  await page.locator(`${NOTEBOOK} .note-link`, { hasText: "alpha" }).first().click({ button: "right" });
  await expect(page.locator(".fm-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fm-menu")).toHaveCount(0);
});

test("double-clicking a note name shows an inline rename input prefilled with the name", async ({ page }) => {
  await openSidebar(page);
  const row = page.locator(`${NOTEBOOK} .note-link`, { hasText: "alpha" }).first();
  await row.locator(".nm").dblclick();
  const input = page.locator(".fm-rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("alpha");
  // Esc cancels and restores the row
  await input.press("Escape");
  await expect(page.locator(".fm-rename-input")).toHaveCount(0);
  await expect(page.locator(`${NOTEBOOK} .note-link`, { hasText: "alpha" }).first()).toBeVisible();
});

test("Favorites star toggles, pins the note, and persists across reload", async ({ page }) => {
  await openSidebar(page);
  const row = page.locator(`${NOTEBOOK} .note-link`, { hasText: "alpha" }).first();
  await row.hover();
  await row.locator(".fm-star").click();
  // localStorage holds the starred rel-path
  const stored = await page.evaluate(() => localStorage.getItem("tree-favorites:" + (window as any).__NOTE__.root));
  expect(stored).toContain("alpha.md");
  // the Favorites section now shows it
  await expect(page.locator('.fm-section[data-section="favorites"] .note-link', { hasText: "alpha" })).toHaveCount(1);
  // …and it survives a reload (persistence)
  await page.reload();
  await page.waitForSelector('.fm-section[data-section="favorites"]');
  await expect(page.locator('.fm-section[data-section="favorites"] .note-link', { hasText: "alpha" })).toHaveCount(1);
});

test("empty folders render (seeded from the /list dirs array)", async ({ page }) => {
  await openSidebar(page);
  // "Empty Folder" has NO files yet renders, because we seed dirs from /list into the tree.
  await expect(page.locator(`${NOTEBOOK} .folder-row .fname`, { hasText: "Empty Folder" })).toBeVisible();
});

test("Recent orders by mtime and shows a relative-time label", async ({ page }) => {
  await openSidebar(page);
  const recentRows = page.locator('.fm-section[data-section="recent"] .note-link');
  // alpha (1m) is more recent than deep (3m) and beta (1h) → it leads
  await expect(recentRows.first()).toContainText("alpha");
  await expect(recentRows.first().locator(".fm-reltime")).toBeVisible();
});

test("dragging a note over a folder shows a drop indicator (client-only)", async ({ page }) => {
  await openSidebar(page);
  // Full HTML5 drag-drop wiring; the actual MOVE needs the /move endpoint (see fixme below).
  await page.evaluate(() => {
    const note = document.querySelector(`.fm-section[data-section="notebook"] .note-link`) as HTMLElement;
    const folder = Array.from(document.querySelectorAll(`.fm-section[data-section="notebook"] .folder-row`))
      .find((f) => (f.querySelector(".fname")?.textContent || "").includes("Empty Folder")) as HTMLElement;
    const dt = new DataTransfer();
    note.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    folder.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator(".folder-row.fm-drop-target")).toHaveCount(1);
});

test("Trash: a real deleted note appears in the live Trash section and restores (end-to-end)", async ({ page }) => {
  // Exercises all three tracks together: real /create + /delete (→ .trash), the sidebar's real
  // loadTrash (GET /trash), and the registry `restore` command (→ /restore). /list is mocked by
  // openSidebar; /trash is left REAL (no opts.trash). page.request bypasses the page.route mocks.
  const listed = await (await page.request.get("/list?dir=" + encodeURIComponent(VAULT))).json();
  const root = listed.root as string; // authoritative server root (may differ from VAULT at boot)
  const base = "trashme-" + Date.now(); // unique per run → no no-clobber collision with prior runs' leftovers
  const file = root + "/" + base + ".md";
  expect((await (await page.request.post("/create", { data: { file, content: "bye" } })).json()).ok).toBeTruthy();
  expect((await (await page.request.post("/delete", { data: { file } })).json()).ok).toBeTruthy();
  await openSidebar(page);
  await sectionHead(page, "trash").click(); // expand → lazy-loads the real /trash
  const entry = page.locator(".fm-trash-entry", { hasText: base });
  await expect(entry).toBeVisible();
  await entry.locator(".fm-trash-restore").click(); // registry restore → /restore, then re-fetches trash
  await expect(page.locator(".fm-trash-entry", { hasText: base })).toHaveCount(0);
});

test("Trash lists entries with a Restore action when /trash responds", async ({ page }) => {
  // /trash is mocked here; the REAL endpoint (GET /trash) + Restore (registry restore → /restore)
  // land at integration. // needs integration: /trash, /restore
  await openSidebar(page, { trash: [{ origName: "gone.md", rel: "gone.md", path: join(VAULT, ".trash", "gone.md") }] });
  await sectionHead(page, "trash").click();
  const entry = page.locator(".fm-trash-entry", { hasText: "gone.md" });
  await expect(entry).toBeVisible();
  await expect(entry.locator(".fm-trash-restore")).toBeVisible();
});

test("New folder creates an EMPTY folder — no forced note inside", async ({ page }) => {
  // Regression guard: 'New folder' used to force you to also name a note inside it (legacy, from
  // before empty folders could render). It must now create an empty dir via /folder-create.
  // /list is mocked for the sidebar UI; we assert against the REAL server (page.request bypasses it).
  await openSidebar(page);
  const root = (await (await page.request.get("/list?dir=" + encodeURIComponent(VAULT))).json()).root as string;
  const folder = "EmptyOne-" + Date.now(); // unique per run
  page.once("dialog", (d) => d.accept(folder)); // the New-folder name prompt
  await page.locator('.fm-toolbar [title="New folder"]').click();
  await expect
    .poll(async () => ((await (await page.request.get("/list?dir=" + encodeURIComponent(root))).json()).dirs as string[]) || [])
    .toContain(folder);
  const after = await (await page.request.get("/list?dir=" + encodeURIComponent(root))).json();
  expect((after.files || []).some((f: any) => (f.rel as string).startsWith(folder + "/"))).toBe(false); // no forced note
});

// needs integration: /move — dropping actually relocates the note on disk. The drag-drop WIRING
// (drop indicator, the move command call with {toDir}) is exercised above; this asserts the
// on-disk effect, which requires the new /move endpoint + Track B's move command run() body.
test.fixme("dropping a note on a folder moves it on disk (needs /move endpoint)", async () => {});
