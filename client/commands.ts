// client/commands.ts — file/folder command registry (the deterministic command layer).
//
// One source of truth for what you can DO to a note/folder/trashed entry. Each command
// is a deterministic handler that calls a server endpoint (or a client-only action like
// copy-path). The sidebar UI renders context menus / actions FROM this registry instead of
// hardcoding buttons, and a future AI/command-palette layer can route to the same handlers.
//
// CONTRACT (do not break the exported shape — the sidebar depends on it):
//   - EntryKind, Entry, CmdCtx, CmdResult, FileCommand types
//   - FILE_COMMANDS: FileCommand[]
//   - commandsFor(kind): FileCommand[]
// Track B fills in the run() bodies + helpers against the server endpoints. Track C (sidebar)
// only reads ids/titles/group/appliesTo/needsArg and calls run().

export type EntryKind = "file" | "folder" | "trash";

export interface Entry {
  path: string; // absolute path on disk
  rel: string; // vault-relative path
  name: string; // display name (extension stripped for files)
  kind: EntryKind;
  fmt?: "md" | "html" | "txt";
  mtime?: number; // epoch ms, when known (from /list)
}

export interface CmdCtx {
  entry: Entry;
  vaultRoot: string; // absolute vault root
  refresh(): Promise<void>; // reload the sidebar list after a mutation
  navigate(path: string): void; // open a note by absolute path
}

export interface CmdResult {
  ok: boolean;
  error?: string;
  path?: string; // new path after the op, when relevant
}

export interface FileCommand {
  id: string; // stable id: open|rename|duplicate|move|newNote|newFolder|promoteHtml|copyPath|restore|delete
  title: string; // menu label
  group: "open" | "edit" | "meta" | "danger";
  appliesTo: EntryKind[];
  danger?: boolean;
  // tells the sidebar UI to gather input before calling run():
  //   "newName"     -> prompt/inline-edit for a name, pass as arg.newName
  //   "moveTarget"  -> show a folder picker, pass as arg.toDir (absolute dir)
  needsArg?: "newName" | "moveTarget" | null;
  run(ctx: CmdCtx, arg?: { newName?: string; toDir?: string }): Promise<CmdResult>;
}

// ───────────────────────── path helpers (pure string ops, browser-safe) ─────────────────────────
// These operate on the abs paths the server hands us in /list. No node `path` import: this file
// ships to the browser. Forward-slash POSIX paths only (the vault lives under the user's home).

function basename(p: string): string {
  const s = p.replace(/\/+$/, ""); // drop trailing slash(es)
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}

function dirname(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : s.slice(0, i);
}

// Extension INCLUDING the dot (".md"), or "" when there is none. A leading-dot name
// (".trash", ".hidden") is treated as having no extension (i must be > 0).
function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir.replace(/\/+$/, "") + "/" + name;
}

// ───────────────────────── fetch helper ─────────────────────────
// Single POST call-site. Normalizes any server reply to {ok,error,path} and turns a thrown
// network error (offline, server down) into {ok:false,error} rather than a rejected promise.
async function post(path: string, body: unknown): Promise<CmdResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.ok === false) {
      return { ok: false, error: (data && data.error) || `request failed (${res.status})` };
    }
    return { ok: true, path: data.path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Track B implements run() bodies (replace the stubs). These ids/titles/appliesTo are the
// stable contract the sidebar renders from; keep them.
export const FILE_COMMANDS: FileCommand[] = [
  {
    id: "open",
    title: "Open in new tab",
    group: "open",
    appliesTo: ["file"],
    // Client-only: just navigate to the note. No server round-trip, nothing to refresh.
    run: async (ctx) => {
      ctx.navigate(ctx.entry.path);
      return { ok: true, path: ctx.entry.path };
    },
  },
  {
    id: "rename",
    title: "Rename",
    group: "edit",
    appliesTo: ["file", "folder"],
    needsArg: "newName",
    // FILE  -> /rename (preserve the existing extension; the UI name has it stripped).
    // FOLDER -> /move  (dir-aware rename of the folder in place).
    run: async (ctx, arg) => {
      const newName = (arg?.newName || "").trim();
      if (!newName) return { ok: false, error: "a new name is required" };
      const parent = dirname(ctx.entry.path);
      let result: CmdResult;
      if (ctx.entry.kind === "folder") {
        const to = joinPath(parent, newName);
        result = await post("/move", { from: ctx.entry.path, to });
      } else {
        const ext = extname(ctx.entry.path);
        // keep the file's extension; don't double it if the user already typed it
        const base = ext && !newName.toLowerCase().endsWith(ext.toLowerCase()) ? newName + ext : newName;
        const to = joinPath(parent, base);
        result = await post("/rename", { from: ctx.entry.path, to });
      }
      if (result.ok) await ctx.refresh();
      return result;
    },
  },
  {
    id: "duplicate",
    title: "Duplicate",
    group: "edit",
    appliesTo: ["file"],
    run: async (ctx) => {
      const result = await post("/duplicate", { file: ctx.entry.path });
      if (result.ok) await ctx.refresh();
      return result;
    },
  },
  {
    id: "move",
    title: "Move to…",
    group: "edit",
    appliesTo: ["file", "folder"],
    needsArg: "moveTarget",
    // Move entry INTO toDir, keeping its basename. Works for a file or a folder (server /move
    // is dir-aware).
    run: async (ctx, arg) => {
      const toDir = (arg?.toDir || "").trim();
      if (!toDir) return { ok: false, error: "a destination folder is required" };
      const to = joinPath(toDir, basename(ctx.entry.path));
      const result = await post("/move", { from: ctx.entry.path, to });
      if (result.ok) await ctx.refresh();
      return result;
    },
  },
  {
    id: "newNote",
    title: "New note here",
    group: "edit",
    appliesTo: ["folder"],
    needsArg: "newName",
    // Create a note inside the folder, default to .md when no extension was typed, then open it.
    run: async (ctx, arg) => {
      const raw = (arg?.newName || "").trim();
      if (!raw) return { ok: false, error: "a note name is required" };
      const name = extname(raw) ? raw : raw + ".md";
      const file = joinPath(ctx.entry.path, name);
      const result = await post("/create", { file, content: "" });
      if (result.ok) {
        ctx.navigate(result.path || file);
        await ctx.refresh();
      }
      return result;
    },
  },
  {
    id: "newFolder",
    title: "New folder here",
    group: "edit",
    appliesTo: ["folder"],
    needsArg: "newName",
    run: async (ctx, arg) => {
      const name = (arg?.newName || "").trim();
      if (!name) return { ok: false, error: "a folder name is required" };
      const result = await post("/folder-create", { dir: ctx.entry.path, name });
      if (result.ok) await ctx.refresh();
      return result;
    },
  },
  {
    id: "promoteHtml",
    title: "Promote md → HTML",
    group: "edit",
    appliesTo: ["file"],
    // Deferred this round — kept registered so the sidebar still lists it.
    run: async () => ({ ok: false, error: "coming soon" }),
  },
  {
    id: "copyPath",
    title: "Copy path",
    group: "meta",
    appliesTo: ["file", "folder"],
    // Client-only: copy the abs path. Guard for environments without the async clipboard API.
    run: async (ctx) => {
      try {
        const clip = (globalThis as any).navigator?.clipboard;
        if (!clip || typeof clip.writeText !== "function") {
          return { ok: false, error: "clipboard unavailable" };
        }
        await clip.writeText(ctx.entry.path);
        return { ok: true, path: ctx.entry.path };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    id: "restore",
    title: "Restore",
    group: "edit",
    appliesTo: ["trash"],
    run: async (ctx) => {
      const result = await post("/restore", { path: ctx.entry.path });
      if (result.ok) await ctx.refresh();
      return result;
    },
  },
  {
    id: "delete",
    title: "Delete",
    group: "danger",
    appliesTo: ["file", "folder"],
    danger: true,
    // FILE -> /delete (→ .trash). FOLDER -> /folder-delete.
    run: async (ctx) => {
      const result =
        ctx.entry.kind === "folder"
          ? await post("/folder-delete", { folder: ctx.entry.path })
          : await post("/delete", { file: ctx.entry.path });
      if (result.ok) await ctx.refresh();
      return result;
    },
  },
];

export function commandsFor(kind: EntryKind): FileCommand[] {
  return FILE_COMMANDS.filter((c) => c.appliesTo.includes(kind));
}
