// Unit tests for the deterministic file/folder command registry. Run: `bun test tests/unit/commands.test.ts`.
// No server needed — globalThis.fetch and navigator.clipboard are stubbed. We pin, per command:
//   - the RIGHT endpoint + RIGHT body shape,
//   - rename of a .md file preserves the extension,
//   - delete routes to /delete (file) vs /folder-delete (folder),
//   - copyPath writes ctx.entry.path to the stubbed clipboard,
//   - commandsFor("trash") === [restore], commandsFor("folder") excludes file-only commands,
//   - ctx.refresh() runs on success (and is skipped on failure).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FILE_COMMANDS, commandsFor, type CmdCtx, type Entry, type FileCommand } from "../../client/commands";

// ───────────────────────── fetch stub: capture url + parsed body ─────────────────────────
interface Call { url: string; body: any; }
let calls: Call[] = [];
let nextResponse: any = { ok: true, path: "/vault/_result.md" };
let failNetwork = false;
const realFetch = (globalThis as any).fetch;

beforeEach(() => {
  calls = [];
  nextResponse = { ok: true, path: "/vault/_result.md" };
  failNetwork = false;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    if (failNetwork) throw new Error("network down");
    let body: any;
    try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => nextResponse } as any;
  };
});

afterEach(() => { (globalThis as any).fetch = realFetch; });

// ───────────────────────── clipboard stub ─────────────────────────
let clipText: string | null = null;
function installClipboard() {
  clipText = null;
  const writeText = async (t: string) => { clipText = t; };
  const nav: any = (globalThis as any).navigator;
  if (nav && typeof nav === "object") {
    try { nav.clipboard = { writeText }; return; } catch { /* read-only navigator → replace below */ }
  }
  (globalThis as any).navigator = { clipboard: { writeText } };
}

// ───────────────────────── helpers ─────────────────────────
function cmd(id: string): FileCommand {
  const c = FILE_COMMANDS.find((x) => x.id === id);
  if (!c) throw new Error("no command with id " + id);
  return c;
}

function makeCtx(entry: Entry) {
  const state = { navigated: [] as string[], refreshed: 0 };
  const ctx: CmdCtx = {
    entry,
    vaultRoot: "/vault",
    refresh: async () => { state.refreshed++; },
    navigate: (p: string) => { state.navigated.push(p); },
  };
  return { ctx, state };
}

const fileEntry: Entry = { path: "/vault/notes/todo.md", rel: "notes/todo.md", name: "todo", kind: "file", fmt: "md" };
const folderEntry: Entry = { path: "/vault/notes", rel: "notes", name: "notes", kind: "folder" };
const trashEntry: Entry = { path: "/vault/.trash/old.md", rel: ".trash/old.md", name: "old", kind: "trash", fmt: "md" };

// ───────────────────────── open (client-only) ─────────────────────────
test("open navigates to the entry path with no server call", async () => {
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("open").run(ctx);
  expect(r.ok).toBe(true);
  expect(state.navigated).toEqual(["/vault/notes/todo.md"]);
  expect(calls.length).toBe(0);
});

// ───────────────────────── rename ─────────────────────────
test("rename of a .md file → POST /rename, preserves the extension, refreshes", async () => {
  nextResponse = { ok: true, path: "/vault/notes/grocery.md" };
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("rename").run(ctx, { newName: "grocery" });
  expect(r.ok).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("/rename");
  expect(calls[0].body).toEqual({ from: "/vault/notes/todo.md", to: "/vault/notes/grocery.md" });
  expect(r.path).toBe("/vault/notes/grocery.md");
  expect(state.refreshed).toBe(1);
});

test("rename does not double the extension if the user typed it", async () => {
  const { ctx } = makeCtx(fileEntry);
  await cmd("rename").run(ctx, { newName: "grocery.md" });
  expect(calls[0].body.to).toBe("/vault/notes/grocery.md");
});

test("rename of a FOLDER → POST /move with the new same-parent path", async () => {
  const { ctx, state } = makeCtx(folderEntry);
  const r = await cmd("rename").run(ctx, { newName: "tasks" });
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/move");
  expect(calls[0].body).toEqual({ from: "/vault/notes", to: "/vault/tasks" });
  expect(state.refreshed).toBe(1);
});

test("rename with an empty name errors and makes no request", async () => {
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("rename").run(ctx, { newName: "   " });
  expect(r.ok).toBe(false);
  expect(calls.length).toBe(0);
  expect(state.refreshed).toBe(0);
});

// ───────────────────────── duplicate ─────────────────────────
test("duplicate → POST /duplicate {file}, returns server path, refreshes", async () => {
  nextResponse = { ok: true, path: "/vault/notes/todo copy.md" };
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("duplicate").run(ctx);
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/duplicate");
  expect(calls[0].body).toEqual({ file: "/vault/notes/todo.md" });
  expect(r.path).toBe("/vault/notes/todo copy.md");
  expect(state.refreshed).toBe(1);
});

// ───────────────────────── move ─────────────────────────
test("move → POST /move {from,to} where to = toDir + '/' + basename", async () => {
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("move").run(ctx, { toDir: "/vault/archive" });
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/move");
  expect(calls[0].body).toEqual({ from: "/vault/notes/todo.md", to: "/vault/archive/todo.md" });
  expect(state.refreshed).toBe(1);
});

test("move tolerates a trailing slash on the destination dir", async () => {
  const { ctx } = makeCtx(fileEntry);
  await cmd("move").run(ctx, { toDir: "/vault/archive/" });
  expect(calls[0].body.to).toBe("/vault/archive/todo.md");
});

test("move of a FOLDER also routes to /move keeping the folder basename", async () => {
  const { ctx } = makeCtx(folderEntry);
  await cmd("move").run(ctx, { toDir: "/vault/archive" });
  expect(calls[0].url).toBe("/move");
  expect(calls[0].body).toEqual({ from: "/vault/notes", to: "/vault/archive/notes" });
});

// ───────────────────────── newNote ─────────────────────────
test("newNote → POST /create defaulting to .md, then navigate + refresh", async () => {
  nextResponse = { ok: true, path: "/vault/notes/ideas.md" };
  const { ctx, state } = makeCtx(folderEntry);
  const r = await cmd("newNote").run(ctx, { newName: "ideas" });
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/create");
  expect(calls[0].body).toEqual({ file: "/vault/notes/ideas.md", content: "" });
  expect(state.navigated).toEqual(["/vault/notes/ideas.md"]);
  expect(state.refreshed).toBe(1);
});

test("newNote keeps an explicit extension when one is given", async () => {
  const { ctx } = makeCtx(folderEntry);
  await cmd("newNote").run(ctx, { newName: "page.html" });
  expect(calls[0].body.file).toBe("/vault/notes/page.html");
});

// ───────────────────────── newFolder ─────────────────────────
test("newFolder → POST /folder-create {dir,name}, refreshes", async () => {
  const { ctx, state } = makeCtx(folderEntry);
  const r = await cmd("newFolder").run(ctx, { newName: "sub" });
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/folder-create");
  expect(calls[0].body).toEqual({ dir: "/vault/notes", name: "sub" });
  expect(state.refreshed).toBe(1);
});

// ───────────────────────── delete (routing) ─────────────────────────
test("delete of a FILE → POST /delete {file}", async () => {
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("delete").run(ctx);
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/delete");
  expect(calls[0].body).toEqual({ file: "/vault/notes/todo.md" });
  expect(state.refreshed).toBe(1);
});

test("delete of a FOLDER → POST /folder-delete {folder}", async () => {
  const { ctx, state } = makeCtx(folderEntry);
  const r = await cmd("delete").run(ctx);
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/folder-delete");
  expect(calls[0].body).toEqual({ folder: "/vault/notes" });
  expect(state.refreshed).toBe(1);
});

// ───────────────────────── restore ─────────────────────────
test("restore → POST /restore {path}, refreshes", async () => {
  nextResponse = { ok: true, path: "/vault/notes/old.md" };
  const { ctx, state } = makeCtx(trashEntry);
  const r = await cmd("restore").run(ctx);
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("/restore");
  expect(calls[0].body).toEqual({ path: "/vault/.trash/old.md" });
  expect(state.refreshed).toBe(1);
});

// ───────────────────────── copyPath (client-only) ─────────────────────────
test("copyPath writes ctx.entry.path to the clipboard, no server call", async () => {
  installClipboard();
  const { ctx } = makeCtx(fileEntry);
  const r = await cmd("copyPath").run(ctx);
  expect(r.ok).toBe(true);
  expect(clipText).toBe("/vault/notes/todo.md");
  expect(calls.length).toBe(0);
});

test("copyPath fails gracefully when no clipboard API is present", async () => {
  const saved = (globalThis as any).navigator;
  (globalThis as any).navigator = { /* no clipboard */ };
  try {
    const { ctx } = makeCtx(fileEntry);
    const r = await cmd("copyPath").run(ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  } finally {
    (globalThis as any).navigator = saved;
  }
});

// ───────────────────────── promoteHtml (deferred) ─────────────────────────
test("promoteHtml stays registered but returns 'coming soon'", async () => {
  const { ctx } = makeCtx(fileEntry);
  const r = await cmd("promoteHtml").run(ctx);
  expect(r.ok).toBe(false);
  expect(r.error).toBe("coming soon");
  expect(calls.length).toBe(0);
});

// ───────────────────────── failure handling ─────────────────────────
test("a server {ok:false} response surfaces the error and skips refresh", async () => {
  nextResponse = { ok: false, error: "a note with that name already exists" };
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("rename").run(ctx, { newName: "dupe" });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("a note with that name already exists");
  expect(state.refreshed).toBe(0);
});

test("a thrown network error is caught → {ok:false}, no refresh", async () => {
  failNetwork = true;
  const { ctx, state } = makeCtx(fileEntry);
  const r = await cmd("duplicate").run(ctx);
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
  expect(state.refreshed).toBe(0);
});

// ───────────────────────── commandsFor registry filtering ─────────────────────────
test("commandsFor('trash') returns [restore] only", () => {
  const ids = commandsFor("trash").map((c) => c.id);
  expect(ids).toEqual(["restore"]);
});

test("commandsFor('folder') excludes file-only commands (duplicate, open, promoteHtml)", () => {
  const ids = commandsFor("folder").map((c) => c.id);
  expect(ids).not.toContain("duplicate");
  expect(ids).not.toContain("open");
  expect(ids).not.toContain("promoteHtml");
  // folder-applicable ones it SHOULD include
  expect(ids).toEqual(expect.arrayContaining(["rename", "move", "newNote", "newFolder", "copyPath", "delete"]));
});

test("commandsFor('file') includes the file-scoped commands and excludes trash/folder-only", () => {
  const ids = commandsFor("file").map((c) => c.id);
  expect(ids).toEqual(expect.arrayContaining(["open", "rename", "duplicate", "move", "promoteHtml", "copyPath", "delete"]));
  expect(ids).not.toContain("restore");
  expect(ids).not.toContain("newNote");
  expect(ids).not.toContain("newFolder");
});
