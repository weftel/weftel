// LOCKED contracts for the golden co-authoring task set (mirrors experiments/cloud-vs-local
// discipline). A GoldenTask is: a real source doc + a human instruction (doubles as the
// phase-2 AI prompt) + a DETERMINISTIC scripted op standing in for the agent + graded
// expectations on the saved output. Every task also runs the four fidelity checks on its
// edited doc (ids with `deletes` exemptions; contrast hard-gates when `contrastGate`).

// NodeMatch/Op live in client/ops.ts since gate K (one semantics source for the golden
// runner AND the MCP tool layer); re-exported here so golden-internal imports don't churn.
export type { NodeMatch, Op } from "../../client/ops";
import type { NodeMatch, Op } from "../../client/ops";

export type Expectation =
  | { kind: "savedContains"; text: string }
  | { kind: "savedNotContains"; text: string }
  | { kind: "nodeText"; match: NodeMatch; equals: string }
  | { kind: "nodeAttr"; match: NodeMatch; attr: string; equals: any }
  | { kind: "tableDims"; rows: number; cols: number }
  | { kind: "columnOrder"; match: NodeMatch; column: number; values: string[] }
  | { kind: "countNodes"; type: string; equals: number }
  | { kind: "byteIdenticalRegion"; selector: string }   // e.g. frozen rich-block subtree, script
  | { kind: "markPreserved"; find: string; mark: string };

// Task tiers — the set serves two masters and the tier makes each task's master explicit:
//   substrate — corruption-class regression probes dressed as asks (nobody would delegate
//               "bold this word"; the task exists because marks-across-nested-spans is
//               where the engine historically corrupts). The safety floor.
//   assist    — small real asks a user might hand off mid-edit (sort this, re-theme this).
//   delegate  — multi-spot / representation-scale asks worth handing to the full agent
//               loop; the tier that differentiates D1/D4 tournament variants.
export type TaskTier = "substrate" | "assist" | "delegate";

export interface GoldenTask {
  id: string;
  title: string;
  tier?: TaskTier;                // default: substrate
  source: string;                 // path relative to repo root
  instruction: string;            // the human co-authoring ask
  op: Op;
  deletes?: string[];             // ids intentionally removed → exempt from the ids check
  contrastGate?: boolean;         // op touches color → contrast failures gate (not advisory)
  expect: Expectation[];
  expectFail?: { checks: ("ids" | "roundtrip" | "validity" | "contrast")[]; reason: string; issue?: string };
}

export interface TaskResult {
  id: string;
  ok: boolean;
  failures: string[];             // expectation + check failures (post expectFail accounting)
  xfails: string[];
}
