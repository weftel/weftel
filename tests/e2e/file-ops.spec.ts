// File-ops data layer (Track A) — pins the move/folder/duplicate/trash/restore endpoints and the
// extended /list shape against the REAL server (Playwright's API-request fixture, no page needed).
// The webServer auto-starts `bun run server.ts tests/e2e/.vault` on PW_PORT.
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";

const VAULT = resolve("tests/e2e/.vault");

// give each run its own subtree so reruns / sibling specs don't collide
function freshDir(tag: string): string {
  const d = join(VAULT, `fileops-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

test("move + duplicate + folder-create + trash + restore round-trip", async ({ request }) => {
  const dir = freshDir("rt");
  // The server's actual vault ROOT (realpath'd; can be tests/e2e if .vault didn't exist at boot —
  // the webServer launches `server.ts tests/e2e/.vault`). Restore lands here, so read it, don't assume.
  const meta = await (await request.get(`/list?dir=${encodeURIComponent(dir)}`)).json();
  const root = meta.root as string;
  const notePath = join(dir, "alpha.md");
  writeFileSync(notePath, "# Alpha\n\nhello world\n");

  // /create a SECOND note via the endpoint (exercise the existing create path too)
  const createPath = join(dir, "beta.md");
  const created = await (await request.post("/create", { data: { file: createPath, content: "# Beta\n" } })).json();
  expect(created.ok).toBe(true);
  expect(created.path).toBe(createPath);

  // /folder-create an EMPTY folder, then /move alpha.md into it
  const fc = await (await request.post("/folder-create", { data: { dir, name: "moved" } })).json();
  expect(fc.ok).toBe(true);
  const folder = fc.path as string;
  expect(folder).toBe(join(dir, "moved"));
  expect(existsSync(folder)).toBe(true);

  const movedTo = join(folder, "alpha.md");
  const mv = await (await request.post("/move", { data: { from: notePath, to: movedTo } })).json();
  expect(mv.ok).toBe(true);
  expect(mv.path).toBe(movedTo);
  expect(existsSync(movedTo)).toBe(true);
  expect(existsSync(notePath)).toBe(false);
  expect(readFileSync(movedTo, "utf8")).toBe("# Alpha\n\nhello world\n"); // content preserved

  // no-clobber on /move
  writeFileSync(join(dir, "occupied.md"), "x");
  const clobber = await (await request.post("/move", { data: { from: movedTo, to: join(dir, "occupied.md") } })).json();
  expect(clobber.ok).toBe(false);

  // /duplicate the moved note → -copy, then -copy-2
  const dup1 = await (await request.post("/duplicate", { data: { file: movedTo } })).json();
  expect(dup1.ok).toBe(true);
  expect(dup1.path).toBe(join(folder, "alpha-copy.md"));
  expect(readFileSync(dup1.path, "utf8")).toBe("# Alpha\n\nhello world\n"); // exact copy
  const dup2 = await (await request.post("/duplicate", { data: { file: movedTo } })).json();
  expect(dup2.ok).toBe(true);
  expect(dup2.path).toBe(join(folder, "alpha-copy-2.md"));

  // /delete beta.md → it lands in .trash, GET /trash surfaces it parsed
  const del = await (await request.post("/delete", { data: { file: createPath } })).json();
  expect(del.ok).toBe(true);
  expect(existsSync(createPath)).toBe(false);

  const trash = await (await request.get(`/trash?dir=${encodeURIComponent(VAULT)}`)).json();
  expect(Array.isArray(trash.items)).toBe(true);
  const entry = trash.items.find((it: any) => it.origName === "beta.md");
  expect(entry, "trashed beta.md should appear in /trash").toBeTruthy();
  expect(typeof entry.trashedAt).toBe("number");
  expect(entry.trashedAt).toBeGreaterThan(0);
  expect(basename(dirname(entry.path))).toBe(".trash"); // lives directly in the vault's .trash (symlink-agnostic)

  // /restore brings beta.md back to the vault ROOT under its origName
  const restored = await (await request.post("/restore", { data: { path: entry.path } })).json();
  expect(restored.ok).toBe(true);
  expect(basename(restored.path)).toBe("beta.md");
  expect(existsSync(restored.path)).toBe(true);
  expect(restored.path.startsWith(dir)).toBe(false); // restored to the vault ROOT, not back into the subfolder
  expect(dirname(restored.path)).toBe(root); // its parent IS the server's vault root
  rmSync(restored.path, { force: true }); // tidy: it restored to the vault root, outside our subtree

  // restore no-clobber: a fresh delete + a same-named file at root → restored alongside (-restored)
  writeFileSync(join(dir, "gamma.md"), "g1");
  await (await request.post("/delete", { data: { file: join(dir, "gamma.md") } })).json();
  writeFileSync(join(root, "gamma.md"), "occupied"); // origin name now taken at the vault root
  const trash2 = await (await request.get(`/trash?dir=${encodeURIComponent(VAULT)}`)).json();
  const gEntry = trash2.items.find((it: any) => it.origName === "gamma.md");
  expect(gEntry).toBeTruthy();
  const rest2 = await (await request.post("/restore", { data: { path: gEntry.path } })).json();
  expect(rest2.ok).toBe(true);
  expect(basename(rest2.path)).toBe("gamma-restored.md"); // restored alongside, no clobber
  rmSync(join(root, "gamma.md"), { force: true });
  rmSync(rest2.path, { force: true });
});

test("/list returns mtime on files and dirs incl. an empty folder", async ({ request }) => {
  const dir = freshDir("list");
  writeFileSync(join(dir, "one.md"), "# one\n");
  // a NESTED note (proves nested dirs are enumerated) + an EMPTY folder (the key discoverability case)
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "two.html"), "<p>two</p>");
  const emptyFc = await (await request.post("/folder-create", { data: { dir, name: "empties" } })).json();
  expect(emptyFc.ok).toBe(true);

  const res = await (await request.get(`/list?dir=${encodeURIComponent(dir)}`)).json();
  expect(res.root).toBeTruthy();
  expect(Array.isArray(res.files)).toBe(true);
  expect(Array.isArray(res.dirs)).toBe(true);

  // every file carries a numeric mtime (epoch ms) and a fmt
  for (const f of res.files) {
    expect(typeof f.mtime).toBe("number");
    expect(f.mtime).toBeGreaterThan(0);
    expect(["md", "html", "txt"]).toContain(f.fmt);
  }
  const one = res.files.find((f: any) => f.name === "one.md");
  expect(one).toBeTruthy();
  expect(one.fmt).toBe("md");

  // dirs include BOTH the populated nested dir and the EMPTY folder (rel to the queried dir)
  expect(res.dirs).toContain("sub");
  expect(res.dirs).toContain("empties"); // the empty folder is discoverable
});

test("folder-delete moves a whole folder into .trash; restore brings it back", async ({ request }) => {
  const dir = freshDir("fdel");
  const fc = await (await request.post("/folder-create", { data: { dir, name: "doomed" } })).json();
  expect(fc.ok).toBe(true);
  const folder = fc.path as string;
  writeFileSync(join(folder, "kept.md"), "# kept\n"); // folder is non-empty — must move recursively

  const fdel = await (await request.post("/folder-delete", { data: { folder } })).json();
  expect(fdel.ok).toBe(true);
  expect(existsSync(folder)).toBe(false);

  const trash = await (await request.get(`/trash?dir=${encodeURIComponent(VAULT)}`)).json();
  const entry = trash.items.find((it: any) => it.origName === "doomed");
  expect(entry, "trashed folder should appear in /trash").toBeTruthy();
  expect(existsSync(join(entry.path, "kept.md"))).toBe(true); // contents moved as-is

  // restore the folder back to the vault root
  const restored = await (await request.post("/restore", { data: { path: entry.path } })).json();
  expect(restored.ok).toBe(true);
  expect(basename(restored.path)).toBe("doomed");
  expect(existsSync(join(restored.path, "kept.md"))).toBe(true);
  rmSync(restored.path, { recursive: true, force: true }); // restored to vault root — tidy up
});
