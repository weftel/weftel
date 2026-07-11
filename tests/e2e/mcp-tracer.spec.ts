// Gate-N spec — THE tracer bullet, full stack: a real MCP client speaks stdio to
// mcp/server.ts (spawned as a subprocess), which computes headless and proposes to the
// playwright-managed weftel server; the REAL editor tab polls, gates, applies, saves.
// setText → validate → verify → structural diff → human gate → surgical save, one run.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const VAULT = resolve("tests/e2e/.vault");
mkdirSync(VAULT, { recursive: true });

const DOC = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body><article><h2 id="sec-1">Quarterly report</h2><p>The results held steady across regions.</p><p>Wrap-up next week.</p></article></body></html>\n';

let client: Client;
test.beforeAll(async () => {
  client = new Client({ name: "tracer-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: ["run", "mcp/server.ts"],
    cwd: resolve("."),
    env: { ...process.env as Record<string, string>, WEFTEL_URL: "http://localhost:" + (Number(process.env.PW_PORT) || 4399), WEFTEL_APPROVAL_TIMEOUT_MS: "20000" },
  }));
});
test.afterAll(async () => { await client?.close(); });

const call = async (name: string, args: any): Promise<any> => {
  const r: any = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};
// A real agent follows no_live_tab's guidance ("open it and retry") — the tab IS open here,
// its liveness poll just may not have landed yet; retry briefly like the agent would.
const callRetryLiveness = async (name: string, args: any): Promise<any> => {
  for (let i = 0; i < 10; i++) {
    const r = await call(name, args);
    if (r.code !== "no_live_tab") return r;
    await new Promise((res) => setTimeout(res, 800));
  }
  throw new Error("tab liveness never registered");
};

async function openNote(page: Page, name: string): Promise<string> {
  const path = join(VAULT, name);
  writeFileSync(path, DOC);
  await page.goto("/?file=" + encodeURIComponent(path));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
  return path;
}

test("tracer: read_doc → set_text on a PRISTINE block → human approves → minted id on disk", async ({ page }) => {
  test.setTimeout(60_000);
  const path = await openNote(page, "tracer.html");

  const read = await call("weftel_read_doc", { file: path });
  expect(read.ok).toBe(true);
  const lead = read.blocks.find((b: any) => b.pristine && b.text.includes("held steady"));
  expect(lead.id).toMatch(/^w-[0-9a-z]{4}$/);

  // the MCP call blocks on the human; drive the gate from the page side in parallel
  const pending = callRetryLiveness("weftel_set_text", { file: path, nodeId: lead.id, newText: "The results held firm across all regions.", expectedVersion: read.docVersion });
  await expect(page.locator(".dgate-root")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".dgate-summary")).toContainText("setText on <paragraph");
  await page.locator(".dgate-accept").click();

  const res = await pending;
  expect(res).toMatchObject({ ok: true, state: "approved" });
  expect(res.newVersion).toBeTruthy();

  const bytes = readFileSync(path, "utf8");
  expect(bytes).toContain("held firm across all regions");
  expect(bytes).toContain(`id="${lead.id}"`);                       // persist-on-touch: minted id landed
  expect((bytes.match(/w-/g) || []).length).toBe(1);                // ONLY the touched block gained an id
  expect(bytes).toContain('id="sec-1"');                            // author id untouched

  // ...and the persisted id is now a first-class address: a re-read sees it as authorId
  const read2 = await call("weftel_read_doc", { file: path });
  const again = read2.blocks.find((b: any) => b.id === lead.id);
  expect(again).toMatchObject({ authorId: true, pristine: false });
});

test("tracer: human rejects → human_rejected, file untouched", async ({ page }) => {
  test.setTimeout(60_000);
  const path = await openNote(page, "tracer-reject.html");
  const read = await call("weftel_read_doc", { file: path });
  const pending = callRetryLiveness("weftel_set_text", { file: path, nodeId: "sec-1", newText: "Nope", expectedVersion: read.docVersion });
  await expect(page.locator(".dgate-root")).toBeVisible({ timeout: 15_000 });
  await page.locator(".dgate-reject").click();
  const res = await pending;
  expect(res).toMatchObject({ ok: false, code: "human_rejected" });
  expect(readFileSync(path, "utf8")).toContain("Quarterly report");
});

test("tracer error strings: no_live_tab, node_not_found, stale_doc", async ({ page }) => {
  test.setTimeout(60_000);
  const path = await openNote(page, "tracer-errors.html");

  // a second note that NO tab has open
  const closed = join(VAULT, "tracer-closed.html");
  writeFileSync(closed, DOC);
  const noTab = await call("weftel_set_text", { file: closed, nodeId: "sec-1", newText: "x" });
  expect(noTab).toMatchObject({ ok: false, code: "no_live_tab" });
  expect(noTab.error).toContain("open it");

  const bogus = await call("weftel_set_text", { file: path, nodeId: "w-zzzz", newText: "x" });
  expect(bogus).toMatchObject({ ok: false, code: "node_not_found" });
  expect(bogus.error).toContain("weftel_read_doc");

  const stale = await call("weftel_set_text", { file: path, nodeId: "sec-1", newText: "x", expectedVersion: "0000000000000" });
  expect(stale).toMatchObject({ ok: false, code: "stale_doc" });
});
