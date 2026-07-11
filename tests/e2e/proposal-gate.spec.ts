// Gate-M spec: the editor-side proposal gate — poll → precondition ladder → diffApprove →
// ONE apply transaction → save → decision. Proposals are POSTed directly at the server
// (the request fixture sends no Origin header, which sameOrigin permits — exactly how the
// MCP process talks to it); the page under test is the REAL editor tab.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fnv1a64 } from "../../client/ops";

const VAULT = resolve("tests/e2e/.vault");
mkdirSync(VAULT, { recursive: true });

const DOC = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>p</title></head><body><article><h2 id="sec-1">Section one</h2><p>body text</p></article></body></html>\n';

async function openNote(page: Page, name: string): Promise<string> {
  const path = join(VAULT, name);
  writeFileSync(path, DOC);
  await page.goto("/?file=" + encodeURIComponent(path));
  await page.waitForSelector(".ProseMirror");
  await page.waitForFunction(() => (window as any).__editor && (window as any).__serialize);
  return path;
}

// The editor's 2s poll registers tab liveness server-side; propose 409s until then.
async function propose(request: any, baseURL: string, payload: any): Promise<any> {
  for (let i = 0; i < 20; i++) {
    const r = await request.post(baseURL + "/api/propose", { data: payload });
    if (r.status() === 200) return await r.json();
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("propose never accepted — editor poll (liveness) not observed");
}

const payloadFor = (file: string, text: string, textHash?: string) => ({
  file,
  op: { kind: "setText", nodeId: "sec-1", text },
  baseVersion: "test",
  target: { nodeId: "sec-1", authorId: true, nodeType: "heading", path: [0], textHash: textHash ?? fnv1a64("Section one"), preview: "Section one" },
  summary: `setText on <h2 id="sec-1">: "Section one" → "${text}"`,
  beforeNodeHtml: '<h2 id="sec-1">Section one</h2>',
  afterNodeHtml: `<h2 id="sec-1">${text}</h2>`,
  verify: [],
});

async function finalState(request: any, baseURL: string, id: string): Promise<any> {
  for (let i = 0; i < 30; i++) {
    const r = await (await request.get(baseURL + "/api/proposal?id=" + id)).json();
    if (r.proposal && r.proposal.state !== "pending") return r.proposal;
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new Error("proposal never reached a terminal state");
}

test("approve: gate shows summary, Accept applies + saves, decision carries newVersion", async ({ page, request, baseURL }) => {
  const path = await openNote(page, "prop-approve.html");
  const r = await propose(request, baseURL!, payloadFor(path, "Quarterly summary"));
  await expect(page.locator(".dgate-root")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".dgate-summary")).toContainText('setText on <h2 id="sec-1">');
  await page.locator(".dgate-accept").click();
  const final = await finalState(request, baseURL!, r.id);
  expect(final.state).toBe("approved");
  expect(final.newVersion).toBeTruthy();
  const bytes = readFileSync(path, "utf8");
  expect(bytes).toContain('id="sec-1"');
  expect(bytes).toContain("Quarterly summary");
  expect(bytes).not.toContain("Section one");
});

test("reject: Esc declines; file untouched; agent-readable reason", async ({ page, request, baseURL }) => {
  const path = await openNote(page, "prop-reject.html");
  const r = await propose(request, baseURL!, payloadFor(path, "Should not land"));
  await expect(page.locator(".dgate-root")).toBeVisible({ timeout: 10_000 });
  await page.locator(".dgate-reject").click();
  const final = await finalState(request, baseURL!, r.id);
  expect(final.state).toBe("rejected");
  expect(final.reason).toContain("human_rejected");
  expect(readFileSync(path, "utf8")).toContain("Section one");
});

test("stale: drifted textHash → gate never shows, text_drifted with re-read guidance", async ({ page, request, baseURL }) => {
  const path = await openNote(page, "prop-stale.html");
  const r = await propose(request, baseURL!, payloadFor(path, "x", fnv1a64("some OTHER text entirely")));
  const final = await finalState(request, baseURL!, r.id);
  expect(final.state).toBe("stale");
  expect(final.reason).toContain("text_drifted");
  await expect(page.locator(".dgate-root")).toHaveCount(0);
  expect(readFileSync(path, "utf8")).toContain("Section one");
});
