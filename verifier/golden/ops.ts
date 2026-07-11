// Re-export shim — the op executor was HOISTED to client/ops.ts at phase-2 gate K so the
// golden runner and the MCP tool layer execute through ONE semantics source and cannot
// drift. Keep importing from here inside verifier/golden; product code imports client/ops.
export { schema, findNode, findById, applyOp, validateOp, mintIds, outline, docVersionOf, fnv1a64 } from "../../client/ops";
