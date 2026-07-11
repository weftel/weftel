// Proposal queue for the co-authoring tracer (phase 2, gate L). In-memory by design:
// a pending proposal is a human-approval window, and approval state should never outlive
// the humans-eyes-on-it moment — a server restart drops the queue and the blocked MCP
// call maps the resulting 404 to an agent-readable "server_restarted, re-issue the edit".
// This module never touches the filesystem; server.ts owns path validation and routes.

export interface ProposalTarget {
  nodeId: string;     // author, persisted-minted, or provisional-minted id
  authorId: boolean;  // true = the id was already in the file bytes at propose time
  nodeType: string;   // PM node type name — re-validated against the live doc
  path: number[];     // child indices from the doc root (relocation fallback)
  textHash: string;   // fnv1a64 of the node's FULL textContent at propose time
  preview: string;    // ≤120 chars of the node's text (for stale-reason messages)
}

export interface VerifyEntry { check: "roundtrip" | "validity" | "ids" | "contrast"; state: "pass" | "fail" | "skip"; detail?: string }

export type ProposalState = "pending" | "approved" | "rejected" | "stale" | "expired";

export interface Proposal {
  id: string;
  file: string;                 // absolute vault path (validated by the route, not here)
  op: { kind: "setText"; nodeId: string; text: string };
  baseVersion: string;          // docVersionOf(file bytes) at propose time
  target: ProposalTarget;
  summary: string;              // one line for the gate header
  beforeNodeHtml: string;       // node-scoped panes computed headless (editor recomputes from live doc; these are fallback)
  afterNodeHtml: string;
  verify: VerifyEntry[];        // the four fidelity checks' results on the proposed save
  state: ProposalState;
  reason?: string;              // terminal states carry an agent-readable sentence
  newVersion?: string;          // set on approve: docVersion of the bytes the editor saved
  createdAt: number;
  decidedAt?: number;
  ttlMs: number;
}

const LIVENESS_MS = 65_000;     // 2s editor poll + background-tab timer-throttling headroom
const PRUNE_MS = 10 * 60_000;   // decided records linger briefly for late MCP polls, then go

export class ProposalQueue {
  private items = new Map<string, Proposal>();
  private lastPoll = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}   // injectable clock (tests)

  // A tab is "live" for a file iff it polled recently; the bye-beacon clears it eagerly.
  isLive(file: string): boolean {
    const t = this.lastPoll.get(file);
    return t !== undefined && this.now() - t < LIVENESS_MS;
  }

  propose(p: Omit<Proposal, "id" | "state" | "createdAt" | "decidedAt" | "reason" | "newVersion"> & { ttlMs?: number }):
    { ok: true; id: string } | { ok: false; code: "no_live_tab"; error: string } {
    this.sweep();
    if (!this.isLive(p.file)) {
      return { ok: false, code: "no_live_tab", error: `no_live_tab: no weftel tab has ${p.file} open — ask the user to open it (in the running weftel app) and retry` };
    }
    const id = "prop-" + crypto.randomUUID();
    this.items.set(id, { ...p, id, ttlMs: p.ttlMs ?? 120_000, state: "pending", createdAt: this.now() });
    return { ok: true, id };
  }

  // The editor's poll — records liveness as a side effect.
  forFile(file: string): Proposal[] {
    this.lastPoll.set(file, this.now());
    this.sweep();
    return [...this.items.values()].filter((p) => p.file === file && p.state === "pending");
  }

  get(id: string): Proposal | undefined { this.sweep(); return this.items.get(id); }

  // First decision wins; anything but pending → false (the MCP poll sees the first outcome).
  decide(id: string, state: "approved" | "rejected" | "stale", reason?: string, newVersion?: string): boolean {
    const p = this.items.get(id);
    if (!p || p.state !== "pending") return false;
    p.state = state; p.reason = reason; p.decidedAt = this.now();
    if (newVersion) p.newVersion = newVersion;
    return true;
  }

  bye(file: string): void { this.lastPoll.delete(file); }

  // ttl expiry + decided-record pruning; runs on every route hit (no timers to leak).
  sweep(): void {
    const t = this.now();
    for (const [id, p] of this.items) {
      if (p.state === "pending" && t - p.createdAt > p.ttlMs) {
        p.state = "expired";
        p.reason = `approval_timeout: no decision within ${Math.round(p.ttlMs / 1000)}s — the user may be away; ask them to look at the open weftel tab, then retry`;
        p.decidedAt = t;
      }
      if (p.state !== "pending" && p.decidedAt && t - p.decidedAt > PRUNE_MS) this.items.delete(id);
    }
  }
}

export const proposals = new ProposalQueue();
