// Gate-L tests: the proposal queue's lifecycle (server/proposals.ts) with an injectable
// clock, plus a subprocess HTTP integration over the real routes (server.ts is NEVER
// imported — it boots Bun.serve; we spawn it like dev.sh does).
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProposalQueue } from "../../server/proposals";

const TARGET = { nodeId: "w-abcd", authorId: false, nodeType: "paragraph", path: [1], textHash: "x", preview: "lead" };
const draft = (file: string) => ({ file, op: { kind: "setText" as const, nodeId: "w-abcd", text: "new" }, baseVersion: "v1", target: TARGET, summary: "s", beforeNodeHtml: "<p>a</p>", afterNodeHtml: "<p>new</p>", verify: [] });

describe("ProposalQueue", () => {
  test("propose requires a live tab; forFile records liveness; bye clears it eagerly", () => {
    let t = 0;
    const q = new ProposalQueue(() => t);
    expect(q.propose(draft("/v/a.html"))).toMatchObject({ ok: false, code: "no_live_tab" });
    q.forFile("/v/a.html");                       // the editor polled → live
    expect(q.isLive("/v/a.html")).toBe(true);
    expect(q.propose(draft("/v/a.html")).ok).toBe(true);
    t += 64_000;                                  // within the 65s window
    expect(q.isLive("/v/a.html")).toBe(true);
    t += 2_000;                                   // beyond it
    expect(q.isLive("/v/a.html")).toBe(false);
    q.forFile("/v/a.html"); q.bye("/v/a.html");   // bye-beacon clears immediately
    expect(q.isLive("/v/a.html")).toBe(false);
  });

  test("first decision wins; late/double decisions are rejected", () => {
    let t = 0;
    const q = new ProposalQueue(() => t);
    q.forFile("/v/a.html");
    const r = q.propose(draft("/v/a.html")) as { ok: true; id: string };
    expect(q.decide(r.id, "approved", undefined, "v2")).toBe(true);
    expect(q.decide(r.id, "rejected")).toBe(false);               // already decided
    expect(q.get(r.id)).toMatchObject({ state: "approved", newVersion: "v2" });
    expect(q.decide("prop-nope", "approved")).toBe(false);        // unknown id
  });

  test("ttl expiry surfaces approval_timeout; decided records prune after 10min", () => {
    let t = 0;
    const q = new ProposalQueue(() => t);
    q.forFile("/v/a.html");
    const r = q.propose(draft("/v/a.html")) as { ok: true; id: string };
    t += 121_000;                                 // past the 120s default ttl
    expect(q.get(r.id)).toMatchObject({ state: "expired" });
    expect(q.get(r.id)!.reason).toContain("approval_timeout");
    expect(q.decide(r.id, "approved")).toBe(false);               // expiry is terminal
    t += 11 * 60_000;                             // past the prune window
    expect(q.get(r.id)).toBeUndefined();
  });

  test("forFile returns only pending proposals for that file", () => {
    let t = 0;
    const q = new ProposalQueue(() => t);
    q.forFile("/v/a.html"); q.forFile("/v/b.html");
    const a = q.propose(draft("/v/a.html")) as { ok: true; id: string };
    q.propose(draft("/v/b.html"));
    q.decide(a.id, "rejected", "human_rejected");
    expect(q.forFile("/v/a.html")).toHaveLength(0);
    expect(q.forFile("/v/b.html")).toHaveLength(1);
  });
});

// ————— subprocess HTTP integration: the real routes on a temp vault —————

describe("proposal routes (spawned server)", () => {
  const PORT = 4517;
  const BASE = `http://localhost:${PORT}`;
  const vault = mkdtempSync(join(tmpdir(), "weftel-prop-"));
  const note = join(vault, "note.html");
  writeFileSync(note, "<!DOCTYPE html><html><head><title>n</title></head><body><p>hello</p></body></html>");
  let proc: any;
  afterAll(() => { try { proc?.kill(); } catch {} rmSync(vault, { recursive: true, force: true }); });

  const post = (path: string, body: any) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("propose → poll → decide over HTTP; vault confinement holds", async () => {
    proc = Bun.spawn(["bun", "run", "server.ts", vault], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, PORT: String(PORT) }, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + "/version"); if (r.ok) break; } catch {} await Bun.sleep(200); }

    // no live tab yet → 409 with agent-readable code
    const cold = await post("/api/propose", { file: note, op: { kind: "setText", nodeId: "w-1", text: "x" }, target: TARGET, baseVersion: "v", summary: "s" });
    expect(cold.status).toBe(409);
    expect((await cold.json()).code).toBe("no_live_tab");

    // an "editor tab" polls → liveness; propose succeeds
    const poll0 = await fetch(BASE + "/api/proposals?file=" + encodeURIComponent(note));
    expect((await poll0.json()).proposals).toEqual([]);
    const prop = await (await post("/api/propose", { file: note, op: { kind: "setText", nodeId: "w-1", text: "x" }, target: TARGET, baseVersion: "v", summary: "s" })).json();
    expect(prop.ok).toBe(true);

    // the tab sees it pending, decides; the MCP-side poll observes the terminal state
    const pending = (await (await fetch(BASE + "/api/proposals?file=" + encodeURIComponent(note))).json()).proposals;
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(prop.id);
    expect((await (await post("/api/proposal-decision", { id: prop.id, state: "approved", newVersion: "v2" })).json()).ok).toBe(true);
    const final = await (await fetch(BASE + "/api/proposal?id=" + prop.id)).json();
    expect(final.proposal).toMatchObject({ state: "approved", newVersion: "v2" });

    // out-of-vault file → confined
    const out = await post("/api/propose", { file: "/etc/hosts", op: { kind: "setText", nodeId: "w-1", text: "x" } });
    expect(out.status).toBe(403);
    // unsupported op kind → 400
    const badOp = await post("/api/propose", { file: note, op: { kind: "deleteBlock" } });
    expect(badOp.status).toBe(400);
    // unknown proposal id → 404 (the MCP maps this to server_restarted after a restart)
    expect((await fetch(BASE + "/api/proposal?id=prop-nope")).status).toBe(404);
  }, 30_000);
});
