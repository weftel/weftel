// weftel MCP server — the co-authoring layer's agent surface (phase-2 tracer: setText).
// Thin by design: tools.ts computes everything; this file is transport + schemas.
// Run: `bun run mcp/server.ts` (or via a vault .mcp.json — see mcp/examples/).
// Env: WEFTEL_URL (default http://localhost:4321) · WEFTEL_APPROVAL_TIMEOUT_MS (default 120000).
import "../verifier/engine-io"; // happy-dom registration MUST precede any engine call
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readDoc, setText } from "./tools";

const WEFTEL_URL = process.env.WEFTEL_URL || "http://localhost:4321";
const TIMEOUT_MS = parseInt(process.env.WEFTEL_APPROVAL_TIMEOUT_MS || "120000", 10);

const asContent = (result: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 1) }], isError: result.ok === false });

const server = new McpServer({ name: "weftel", version: "0.1.0" });

server.registerTool(
  "weftel_read_doc",
  {
    title: "Read a weftel note's block outline",
    description:
      "Read an .html note as an addressable block outline — the ONLY source of valid edit targets. " +
      "Each block carries an id: author ids verbatim; blocks without one get a PROVISIONAL id " +
      "(w-XXXX) that is stable for the returned docVersion and persists to the file only when an " +
      "approved edit touches that block. Blocks with id:null (frozen rich-html blocks) are not " +
      "addressable in this version. Reading raw file bytes is fine for understanding a doc, but " +
      "edits must go through weftel_set_text — direct file writes corrupt id/style fidelity and " +
      "race the open editor tab's autosave.",
    inputSchema: { file: z.string().describe("absolute path to the .html note inside the vault") },
  },
  async ({ file }) => asContent(readDoc(file)),
);

server.registerTool(
  "weftel_set_text",
  {
    title: "Propose a text edit to one block (human-gated)",
    description:
      "Replace one block's ENTIRE inline content with plain unmarked text (inline formatting inside " +
      "the block is dropped by design — use it on single-style blocks; richer ops come later). The " +
      "proposal is validated against the canonical model, fidelity-verified (round-trip, ids, " +
      "validity), then shown to the user as a rendered diff in their open weftel tab; this call " +
      "BLOCKS until they decide (default 120s). Requires the note open in a weftel tab. Errors are " +
      "actionable: stale_doc/stale → re-read and retry; human_rejected → don't retry, ask the user; " +
      "no_live_tab → ask the user to open the note; verify_failed → engine-level rejection.",
    inputSchema: {
      file: z.string().describe("absolute path to the .html note"),
      nodeId: z.string().describe("target block id from weftel_read_doc (author or provisional w-XXXX)"),
      newText: z.string().describe("the block's new plain-text content"),
      expectedVersion: z.string().optional().describe("docVersion from weftel_read_doc — rejects with stale_doc if the file changed since"),
    },
  },
  async ({ file, nodeId, newText, expectedVersion }) => asContent(await setText(file, nodeId, newText, expectedVersion, { weftelUrl: WEFTEL_URL, timeoutMs: TIMEOUT_MS, pollMs: 500 })),
);

await server.connect(new StdioServerTransport());
