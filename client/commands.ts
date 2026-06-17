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

// Track B implements run() bodies (replace the stubs). These ids/titles/appliesTo are the
// stable contract the sidebar renders from; keep them.
export const FILE_COMMANDS: FileCommand[] = [
  { id: "open", title: "Open in new tab", group: "open", appliesTo: ["file"], run: async () => ({ ok: false, error: "stub" }) },
  { id: "rename", title: "Rename", group: "edit", appliesTo: ["file", "folder"], needsArg: "newName", run: async () => ({ ok: false, error: "stub" }) },
  { id: "duplicate", title: "Duplicate", group: "edit", appliesTo: ["file"], run: async () => ({ ok: false, error: "stub" }) },
  { id: "move", title: "Move to…", group: "edit", appliesTo: ["file", "folder"], needsArg: "moveTarget", run: async () => ({ ok: false, error: "stub" }) },
  { id: "newNote", title: "New note here", group: "edit", appliesTo: ["folder"], needsArg: "newName", run: async () => ({ ok: false, error: "stub" }) },
  { id: "newFolder", title: "New folder here", group: "edit", appliesTo: ["folder"], needsArg: "newName", run: async () => ({ ok: false, error: "stub" }) },
  { id: "promoteHtml", title: "Promote md → HTML", group: "edit", appliesTo: ["file"], run: async () => ({ ok: false, error: "coming soon" }) },
  { id: "copyPath", title: "Copy path", group: "meta", appliesTo: ["file", "folder"], run: async () => ({ ok: false, error: "stub" }) },
  { id: "restore", title: "Restore", group: "edit", appliesTo: ["trash"], run: async () => ({ ok: false, error: "stub" }) },
  { id: "delete", title: "Delete", group: "danger", appliesTo: ["file", "folder"], danger: true, run: async () => ({ ok: false, error: "stub" }) },
];

export function commandsFor(kind: EntryKind): FileCommand[] {
  return FILE_COMMANDS.filter((c) => c.appliesTo.includes(kind));
}
