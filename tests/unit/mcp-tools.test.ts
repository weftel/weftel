// Gate-N tests: the MCP tool pipeline (mcp/tools.ts) without a transport or a server —
// readDoc's outline contract, setText's rejection ladder, and the full propose→approve
// resolution against a mocked HTTP layer. The real stack rides tests/e2e/mcp-tracer.spec.ts.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDoc, setText, type PipelineOpts } from "../../mcp/tools";
import { fnv1a64 } from "../../client/ops";

const dir = mkdtempSync(join(tmpdir(), "weftel-mcp-"));
const note = join(dir, "note.html");
writeFileSync(note, '<!DOCTYPE html><html><head><meta charset="utf-8"><title>n</title></head><body><article><h2 id="sec-1">Title</h2><p>lead paragraph</p><div class="card"><p>inner</p></div></article></body></html>\n');
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

describe("weftel_read_doc", () => {
  test("outline: author ids verbatim, pristine blocks get provisional w- ids, version = byte hash", () => {
    const r = readDoc(note);
    if (!r.ok) throw new Error(r.error);
    expect(r.docVersion).toHaveLength(13);
    const h2 = r.blocks.find((b) => b.kind === "heading")!;
    expect(h2).toMatchObject({ id: "sec-1", authorId: true, pristine: false });
    const lead = r.blocks.find((b) => b.kind === "paragraph" && b.text === "lead paragraph")!;
    expect(lead.id).toMatch(/^w-[0-9a-z]{4}$/);
    expect(lead.pristine).toBe(true);
    expect(lead.textHash).toBe(fnv1a64("lead paragraph"));
    // two reads of the same bytes = identical ids (deterministic addressing)
    const again = readDoc(note);
    if (!again.ok) throw new Error(again.error);
    expect(again.blocks.map((b) => b.id)).toEqual(r.blocks.map((b) => b.id));
  });

  test("rejections: .md unsupported; missing file", () => {
    expect(readDoc(join(dir, "x.md"))).toMatchObject({ ok: false, code: "md_not_supported" });
    expect(readDoc(join(dir, "gone.html"))).toMatchObject({ ok: false, code: "no_such_file" });
  });
});

const mockOpts = (fetchImpl: any): PipelineOpts => ({ weftelUrl: "http://mock", timeoutMs: 2000, pollMs: 10, fetchImpl });
const jsonRes = (body: any, status = 200) => ({ status, json: async () => body }) as any;

describe("weftel_set_text pipeline", () => {
  test("pre-flight rejections never reach the server: stale_doc, node_not_found, kind_incompatible", async () => {
    const neverCalled = () => { throw new Error("HTTP must not be reached on pre-flight rejection"); };
    expect(await setText(note, "sec-1", "x", "wrong-version", mockOpts(neverCalled))).toMatchObject({ ok: false, code: "stale_doc" });
    expect(await setText(note, "w-none", "x", undefined, mockOpts(neverCalled))).toMatchObject({ ok: false, code: "node_not_found" });
    const r = readDoc(note); if (!r.ok) throw new Error(r.error);
    const card = r.blocks.find((b) => b.kind === "styledBox")!;   // container → incompatible
    expect(await setText(note, card.id!, "x", undefined, mockOpts(neverCalled))).toMatchObject({ ok: false, code: "kind_incompatible" });
  });

  test("full resolution: propose payload is complete; approve resolves with newVersion", async () => {
    const r = readDoc(note); if (!r.ok) throw new Error(r.error);
    const lead = r.blocks.find((b) => b.pristine && b.kind === "paragraph")!;
    let payload: any = null, polls = 0;
    const mock = async (url: string, init?: any) => {
      if (url.endsWith("/api/propose")) { payload = JSON.parse(init.body); return jsonRes({ ok: true, id: "prop-1" }); }
      polls++;
      return polls < 3 ? jsonRes({ proposal: { state: "pending" } }) : jsonRes({ proposal: { state: "approved", newVersion: "v2" } });
    };
    const res = await setText(note, lead.id!, "rewritten lead", r.docVersion, mockOpts(mock));
    expect(res).toMatchObject({ ok: true, state: "approved", newVersion: "v2" });
    // the payload the editor will re-validate against
    expect(payload.op).toEqual({ kind: "setText", nodeId: lead.id, text: "rewritten lead" });
    expect(payload.target).toMatchObject({ nodeId: lead.id, authorId: false, nodeType: "paragraph", textHash: fnv1a64("lead paragraph") });
    expect(payload.summary).toContain("setText on <paragraph");
    expect(payload.baseVersion).toBe(r.docVersion);
    expect(payload.verify.length).toBeGreaterThan(0);
    expect(payload.verify.every((v: any) => v.state !== "fail")).toBe(true);
    expect(payload.beforeNodeHtml).toContain("lead paragraph");
    expect(payload.afterNodeHtml).toContain("rewritten lead");
  });

  test("terminal mappings: human_rejected, stale, approval_timeout, no_live_tab, server_restarted", async () => {
    const r = readDoc(note); if (!r.ok) throw new Error(r.error);
    const lead = r.blocks.find((b) => b.pristine && b.kind === "paragraph")!;
    const run = (respond: (url: string) => any) => setText(note, lead.id!, "x", undefined, mockOpts(async (url: string) => respond(url)));

    expect(await run((u) => u.endsWith("/api/propose") ? jsonRes({ ok: false, code: "no_live_tab", error: "no_live_tab: open it" }, 409) : jsonRes({})))
      .toMatchObject({ ok: false, code: "no_live_tab" });
    expect(await run((u) => u.endsWith("/api/propose") ? jsonRes({ ok: true, id: "p" }) : jsonRes({ proposal: { state: "rejected", reason: "human_rejected: no" } })))
      .toMatchObject({ ok: false, code: "human_rejected" });
    expect(await run((u) => u.endsWith("/api/propose") ? jsonRes({ ok: true, id: "p" }) : jsonRes({ proposal: { state: "stale", reason: "text_drifted: moved" } })))
      .toMatchObject({ ok: false, code: "stale" });
    expect(await run((u) => u.endsWith("/api/propose") ? jsonRes({ ok: true, id: "p" }) : jsonRes({ proposal: { state: "expired", reason: "approval_timeout: away" } })))
      .toMatchObject({ ok: false, code: "approval_timeout" });
    expect(await run((u) => u.endsWith("/api/propose") ? jsonRes({ ok: true, id: "p" }) : jsonRes({}, 404)))
      .toMatchObject({ ok: false, code: "server_restarted" });
  });
});
