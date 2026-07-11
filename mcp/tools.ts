// The tracer's tool pipeline — transport-free so tests drive it without a stdio client.
// Everything engine-shaped is computed HERE (headless, happy-dom via verifier/engine-io);
// the weftel server only relays proposals and the open editor tab is the single writer.
// Every rejection is an agent-readable sentence with retry guidance (sketch contract).
import "../verifier/engine-io"; // registers happy-dom BEFORE any engine call
// Bun's NATIVE fetch: happy-dom's GlobalRegistrator (above) replaces globalThis.fetch with
// a browser-policed one — OPTIONS preflight + same-origin policy — which silently breaks
// plain HTTP to the weftel server (GOTCHA; second occurrence after tests/unit/proposals).
import { fetch as bunFetch } from "bun";
import { readFileSync, existsSync } from "node:fs";
import { Node as PMNode, DOMSerializer } from "@tiptap/pm/model";
import { prepareDoc, serializeDoc, htmlToDoc, docToBody } from "../client/engine";
import { schema, mintIds, outline, findById, validateOp, applyOp, docVersionOf, fnv1a64, type OutlineBlock } from "../client/ops";
import { roundTrip } from "../verifier/engine-io";
import { checkRoundtrip } from "../verifier/checks/roundtrip";
import { checkValidity } from "../verifier/checks/validity";
import { checkIds } from "../verifier/checks/ids";

export interface ToolError { ok: false; code: string; error: string }
const err = (code: string, error: string): ToolError => ({ ok: false, code, error });

export interface ReadDocResult {
  ok: true;
  file: string;
  docVersion: string;
  blocks: OutlineBlock[];
}

const parse = (raw: string) => {
  const prep = prepareDoc(raw);
  return { prep, doc: PMNode.fromJSON(schema, htmlToDoc(prep.content)) };
};

export function readDoc(file: string): ReadDocResult | ToolError {
  if (/\.(md|markdown)$/i.test(file)) return err("md_not_supported", "the co-authoring tools cover .html notes for now — for .md files, ask the user to edit directly");
  if (!existsSync(file)) return err("no_such_file", `no note at ${file} — pass the note's absolute path`);
  const raw = readFileSync(file, "utf8");
  const { doc } = parse(raw);
  const docVersion = docVersionOf(raw);
  return { ok: true, file, docVersion, blocks: outline(doc, docVersion) };
}

export type SetTextResolution =
  | { ok: true; state: "approved"; newVersion?: string; message: string; advisory?: string[] }
  | ToolError;

export interface PipelineOpts { weftelUrl: string; timeoutMs: number; pollMs: number; fetchImpl?: typeof fetch }

export async function setText(file: string, nodeId: string, newText: string, expectedVersion: string | undefined, opts: PipelineOpts): Promise<SetTextResolution> {
  const f = opts.fetchImpl ?? (bunFetch as unknown as typeof fetch);
  if (/\.(md|markdown)$/i.test(file)) return err("md_not_supported", "the co-authoring tools cover .html notes for now");
  if (!existsSync(file)) return err("no_such_file", `no note at ${file} — pass the note's absolute path`);
  const raw = readFileSync(file, "utf8");
  const docVersion = docVersionOf(raw);
  if (expectedVersion && expectedVersion !== docVersion) {
    return err("stale_doc", `the file changed since you read it (version ${expectedVersion} vs ${docVersion}) — call weftel_read_doc again`);
  }
  const { prep, doc } = parse(raw);
  const minted = mintIds(doc, docVersion);
  const valid = validateOp(doc, { kind: "setText", nodeId, text: newText }, minted);
  if (!valid.ok) return err(valid.code, valid.message);
  const hit = findById(doc, nodeId, minted)!;

  // headless apply + serialize = the proposed save
  const after = applyOp(doc, { kind: "setText", nodeId, text: newText }, minted);
  const proposed = serializeDoc(docToBody(after.toJSON()), prep.template ? { template: prep.template, token: prep.token } : null);

  // verify-in-pipeline: the four fidelity checks on the proposed bytes, BEFORE any human
  // sees them. Any non-advisory fail rejects pre-gate — an engine-level rejection, not a
  // user decision. (Contrast is advisory here: setText never touches color — golden rule.)
  const rt = roundTrip(proposed);
  const results = [...checkRoundtrip(file, rt), ...checkValidity(file, proposed, rt.t2, rt.s1), ...checkIds(file, raw, proposed, [])];
  const fails = results.filter((r) => r.state === "fail");
  if (fails.length) {
    return err("verify_failed", "the proposed save fails fidelity checks — this is an engine-level rejection, not a user decision; try a smaller edit or report it: " + fails.map((x) => `${x.check}: ${x.detail || "failed"}`).join(" · "));
  }

  // proposal payload: node-scoped panes (fallback — the editor recomputes from its live doc)
  const ser = DOMSerializer.fromSchema(doc.type.schema);
  const beforeNodeHtml = (ser.serializeNode(hit.node) as HTMLElement).outerHTML || "";
  const afterHit = findById(after, nodeId);
  const afterNodeHtml = afterHit ? (ser.serializeNode(afterHit.node) as HTMLElement).outerHTML || "" : "";
  const blocks = outline(doc, docVersion);
  const entry = blocks.find((b) => b.id === nodeId);
  const preview = (hit.node.textContent || "").slice(0, 120);
  const payload = {
    file,
    op: { kind: "setText", nodeId, text: newText },
    baseVersion: docVersion,
    target: { nodeId, authorId: !!hit.node.attrs.id, nodeType: hit.node.type.name, path: entry?.path ?? [], textHash: fnv1a64(hit.node.textContent), preview },
    summary: `setText on <${hit.node.type.name} id="${nodeId}">: "${preview.slice(0, 40)}" → "${newText.slice(0, 40)}"`,
    beforeNodeHtml, afterNodeHtml,
    verify: results.map((r) => ({ check: r.check, state: r.state, detail: r.detail })),
  };

  let propose: any;
  try {
    const res = await f(opts.weftelUrl + "/api/propose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    propose = await res.json();
  } catch {
    return err("server_unreachable", `weftel isn't running at ${opts.weftelUrl} — ask the user to start it (./dev.sh), then retry`);
  }
  if (!propose.ok) return err(propose.code || "propose_rejected", propose.error || "proposal rejected");

  // block on the human decision: poll until terminal or timeout
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs));
    let state: any;
    try {
      const res = await f(opts.weftelUrl + "/api/proposal?id=" + propose.id);
      if (res.status === 404) return err("server_restarted", "weftel restarted mid-approval — re-issue the edit");
      state = (await res.json()).proposal;
    } catch {
      return err("server_restarted", "weftel became unreachable mid-approval — re-issue the edit once it's back");
    }
    if (!state || state.state === "pending") continue;
    if (state.state === "approved") return { ok: true, state: "approved", newVersion: state.newVersion, message: "Edit approved and saved." };
    if (state.state === "rejected") return err("human_rejected", state.reason || "the user declined this change — do not retry the same edit; ask what they'd prefer");
    if (state.state === "stale") return err("stale", (state.reason || "the target changed") + " — call weftel_read_doc and retry");
    if (state.state === "expired") return err("approval_timeout", state.reason || "no decision in time — the user may be away; ask them to look at the open weftel tab, then retry");
  }
  return err("approval_timeout", "no decision within the wait window — the user may be away; ask them to look at the open weftel tab, then retry");
}
