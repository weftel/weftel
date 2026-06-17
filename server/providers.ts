// [AI:model-layer] Swappable AI provider seam.
//
// The editor makes exactly one AI call today — ⌘K → /rewrite — and it streams through a
// provider chosen by env. The goal of this module is to let that call target the user's
// own Claude (default), a local Ollama daemon, or (later) a hosted fill-in-the-middle
// model, WITHOUT changing default behavior.
//
// CloudProvider is the default and wraps the Agent SDK exactly as before — same
// model / systemPrompt / allowedTools / maxTurns, same streaming — so default behavior
// and the AI record/replay cache keys are byte-identical to the pre-seam server.
//
// Division of labor with server.ts:
//   - The AI cache (key / get / AI_OFFLINE / set / trim) stays in streamAI() in server.ts.
//   - Providers do the RAW model call only and stream RAW deltas through onChunk (no
//     trimming). streamAI() trims the accumulated text for the cache + return value,
//     which preserves the exact legacy behavior (live preview shows raw deltas; the
//     cached/returned value is trimmed).
//
// Config (read at call time so tests/process env can flip it):
//   PROVIDER     — "claude" (default) | "ollama" | "fim"   (alias: "cloud" → claude)
//   MODEL        — overrides the active provider's default model ("haiku" for cloud)
//   OLLAMA_HOST  — Ollama base URL (default http://localhost:11434)
//   OLLAMA_MODEL — Ollama default model when MODEL is unset (default "llama3.2")
//   FIM_MODEL    — FIM default model name (stub only)

import { query } from "@anthropic-ai/claude-agent-sdk";

export type AIResult = { ok: true; out: string } | { ok: false; error: string };
export type AIStreamOpts = { system?: string; model?: string; signal?: AbortSignal };
// [AI:ghost] Options for a raw completion / fill-in-the-middle call (inline ghost text).
export type AICompleteOpts = { model?: string; maxTokens?: number; stop?: string[]; signal?: AbortSignal };

export interface AIProvider {
  name: string;
  // Provider's default model when MODEL env is unset. For cloud this MUST be "haiku" so
  // cache keys match the legacy hardcoded model.
  defaultModel: string;
  stream(prompt: string, opts: AIStreamOpts, onChunk: (s: string) => void): Promise<AIResult>;
  // [AI:ghost] Raw completion / fill-in-the-middle for inline ghost text. `prefix` = the document
  // text before the cursor, `suffix` = the text after it (may be ""). Returns the MIDDLE text only —
  // NO chat framing, NO note-generation system prompt (which makes completion models emit junk like
  // "html"). Optional: providers without a completion endpoint (Cloud) omit it, and /ghost falls
  // back to the chat path. Models with a FIM template (qwen2.5-coder) infill using both sides; others
  // degrade to prefix-only continuation.
  complete?(prefix: string, suffix: string, opts: AICompleteOpts): Promise<AIResult>;
}

// ───────────────────────── CloudProvider (default) ─────────────────────────
// Wraps the EXISTING Agent SDK behavior EXACTLY: subscription auth, no tools, single turn.
// Streams each text delta verbatim through onChunk and returns the UNTRIMMED text — the
// streamAI() wrapper in server.ts trims + caches. Nothing here may change the query()
// options object (same keys, order, values) or the error handling: behavior is contractually
// byte-identical to the pre-seam streamAI(). Note: opts.signal is intentionally ignored here
// so the SDK call stays identical to legacy (cloud cancellation is a separate follow-up).
export const CloudProvider: AIProvider = {
  name: "claude",
  defaultModel: "haiku",
  async stream(prompt, opts, onChunk) {
    try {
      let text = "";
      for await (const m of query({ prompt, options: { model: opts.model, systemPrompt: opts.system, allowedTools: [], maxTurns: 1 } } as any)) {
        if (m.type === "assistant") for (const b of (m as any).message.content) { if (b.type === "text") { text += b.text; onChunk(b.text); } }
        if (m.type === "result" && (m as any).is_error) return { ok: false, error: String((m as any).subtype || "ai error") };
      }
      return { ok: true, out: text };
    } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
  },
};

// ───────────────────────── OllamaProvider (local) ─────────────────────────
// POSTs to a local Ollama daemon's /api/chat and streams its NDJSON response. If Ollama
// isn't running (connection refused) or returns a non-2xx, this returns {ok:false,error}
// GRACEFULLY — it never throws, so a missing local model degrades to a clean failure in the
// ⌘K hint instead of crashing the route.
export const OllamaProvider: AIProvider = {
  name: "ollama",
  defaultModel: process.env.OLLAMA_MODEL || "llama3.2",
  async stream(prompt, opts, onChunk) {
    const host = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");
    const messages: { role: string; content: string }[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });
    const body = JSON.stringify({ model: opts.model || OllamaProvider.defaultModel, messages, stream: true });

    let res: Response;
    try {
      res = await fetch(host + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body, signal: opts.signal });
    } catch (e) {
      return { ok: false, error: `ollama unreachable at ${host} — is it running? (${errMsg(e)})` };
    }
    if (!res.ok) return { ok: false, error: `ollama http ${res.status}` };
    if (!res.body) return { ok: false, error: "ollama: empty response body" };

    try {
      let out = "";
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const tok = parseOllamaLine(line);
          if (tok.error) return { ok: false, error: `ollama: ${tok.error}` };
          if (tok.content) { out += tok.content; onChunk(tok.content); }
        }
      }
      // flush a trailing line with no terminating newline
      const tok = parseOllamaLine(buf);
      if (tok.content) { out += tok.content; onChunk(tok.content); }
      return { ok: true, out };
    } catch (e) {
      return { ok: false, error: `ollama stream error: ${errMsg(e)}` };
    }
  },
  // [AI:ghost] Completion / fill-in-the-middle via Ollama /api/generate, with NO chat wrapper and
  // NO note-generation system prompt (that framing is what made the completion model emit garbage
  // like "html"). Non-streaming (a ghost is one short string), bounded by num_predict for latency,
  // low temperature for stable completions.
  //
  // For a FIM-capable model (qwen2.5-coder) we build the model's NATIVE FIM prompt ourselves and
  // send raw:true. This is deliberate: relying on Ollama's `suffix` param leaves qwen in plain
  // generate mode whenever the suffix is empty (end of the doc — the common ghost case), where the
  // INSTRUCT model chats ("I'm sorry, but I need more context…") instead of completing. The raw FIM
  // prompt always infills, even with an empty suffix. Models with no known FIM template (llama3.2)
  // fall back to Ollama's native suffix infill, then to prefix-only — they have no real FIM path.
  async complete(prefix, suffix, opts) {
    const model = opts.model || OllamaProvider.defaultModel;
    const fim = fimTemplate(model);
    if (fim) {
      const prompt = fim.pre + prefix + fim.suf + suffix + fim.mid;
      return ollamaGenerate({ model, prompt, raw: true, stop: [...FIM_STOPS, "\n\n"], opts });
    }
    const r = await ollamaGenerate({ model, prompt: prefix, suffix, stop: ["\n\n"], opts });
    if (!r.ok && suffix && /insert|suffix|does not support/i.test(r.error)) return ollamaGenerate({ model, prompt: prefix, stop: ["\n\n"], opts });
    return r;
  },
};

// Native FIM token templates by model family. qwen2.5-coder / codeqwen use the qwen sentinels;
// codellama uses <PRE>/<SUF>/<MID>. A model with no entry has no FIM template — it falls back to
// Ollama's native suffix infill (and likely can't do good inline completion; that's a sweep
// finding, not a crash). Kept conservative on purpose: a WRONG token set is worse than none.
function fimTemplate(model: string): { pre: string; suf: string; mid: string } | null {
  const m = model.toLowerCase();
  if (m.includes("qwen") || m.includes("codeqwen")) return { pre: "<|fim_prefix|>", suf: "<|fim_suffix|>", mid: "<|fim_middle|>" };
  if (m.includes("codellama") || m.includes("code-llama")) return { pre: "<PRE> ", suf: " <SUF>", mid: " <MID>" };
  return null;
}
// End/sentinel tokens to stop generation on in raw FIM mode (Ollama won't auto-stop on these when
// we send the prompt raw). cleanGhostCompletion strips any that still slip through.
const FIM_STOPS = ["<|fim_pad|>", "<|endoftext|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|im_end|>", "<|file_sep|>", "<EOT>"];

// One non-streaming POST to Ollama /api/generate. With `raw:true` the prompt is sent verbatim (we
// supply the FIM template); otherwise `suffix` (when set) triggers Ollama's own FIM template. Returns
// the model's raw `response` (uncleaned — cleanGhostCompletion trims it). Fails gracefully (never
// throws) so a missing daemon/model degrades to a clean error.
async function ollamaGenerate(a: { model: string; prompt: string; suffix?: string; raw?: boolean; stop?: string[]; opts: AICompleteOpts }): Promise<AIResult> {
  const host = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");
  const body: any = {
    model: a.model,
    prompt: a.prompt,
    stream: false,
    options: { temperature: 0.2, num_predict: a.opts.maxTokens ?? 48, stop: a.stop ?? ["\n\n"] },
  };
  if (a.suffix) body.suffix = a.suffix;
  if (a.raw) body.raw = true;
  let res: Response;
  try {
    res = await fetch(host + "/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: a.opts.signal });
  } catch (e) {
    return { ok: false, error: `ollama unreachable at ${host} — is it running? (${errMsg(e)})` };
  }
  if (!res.ok) { let detail = ""; try { detail = (await res.json())?.error || ""; } catch {} return { ok: false, error: `ollama http ${res.status}${detail ? ": " + detail : ""}` }; }
  try {
    const o: any = await res.json();
    if (o?.error) return { ok: false, error: `ollama: ${o.error}` };
    return { ok: true, out: String(o?.response ?? "") };
  } catch (e) { return { ok: false, error: `ollama generate parse error: ${errMsg(e)}` }; }
}

// Parse one NDJSON frame from Ollama's stream. /api/chat emits
// {"message":{"content":"…"},"done":false} per token and a final {"done":true}; /api/generate
// uses {"response":"…"} instead — accept both. Blank/keepalive/unparseable frames yield nothing.
export function parseOllamaLine(line: string): { content?: string; error?: string } {
  const s = line.trim();
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    if (o.error) return { error: String(o.error) };
    const content = o?.message?.content ?? o?.response ?? "";
    return content ? { content: String(content) } : {};
  } catch { return {}; }
}

// ───────────────────────── FimProvider (stub) ─────────────────────────
// STUB — hosted fill-in-the-middle (e.g. Mistral Codestral `/v1/fim/completions`).
// Interface-only placeholder so the seam is already provider-shaped for inline ghost-text
// completion. No keys, no network today; always fails cleanly.
// TODO(fim): implement against a hosted FIM endpoint — build a [prefix]<FIM>[suffix] prompt,
// read FIM_API_KEY/FIM_MODEL from env, POST and stream deltas through onChunk.
export const FimProvider: AIProvider = {
  name: "fim",
  defaultModel: process.env.FIM_MODEL || "codestral-latest",
  async stream() { return { ok: false, error: "FIM not implemented" }; },
};

// ───────────────────────── factory + config ─────────────────────────
const PROVIDERS: Record<string, AIProvider> = {
  claude: CloudProvider,
  cloud: CloudProvider, // alias
  ollama: OllamaProvider,
  fim: FimProvider,
};

// Select a provider by name (default from PROVIDER env, else "claude"). An unknown name
// falls back to the cloud default rather than throwing — a typo in PROVIDER must never
// silently disable AI in a hard-to-diagnose way.
export function getProvider(name: string = process.env.PROVIDER || "claude"): AIProvider {
  return PROVIDERS[name.trim().toLowerCase()] || CloudProvider;
}

// [AI:integration] PER-FEATURE model config. ⌘K (rewrite) and Tab ghost need DIFFERENT models at
// the SAME time — ⌘K wants a strong CLOUD model (quality), ghost wants a FAST LOCAL one (speed) —
// so a single PROVIDER/MODEL env can't serve both. modelInfo(scope) resolves each independently:
//   - "rewrite" (⌘K): PROVIDER || "claude", MODEL || provider-default.
//   - "ghost"   (Tab): GHOST_PROVIDER || PROVIDER || "claude", GHOST_MODEL || MODEL || default.
// With NO env set, BOTH resolve to {claude, haiku} — committed base byte-identical, cache keys
// unchanged. Set GHOST_PROVIDER=ollama GHOST_MODEL=qwen2.5-coder:1.5b → ghost goes local-fast while
// ⌘K stays cloud-strong, simultaneously. (/api/model reports both so the split is visible.)
export function modelInfo(scope: "rewrite" | "ghost" = "rewrite"): { provider: string; model: string } {
  const name = scope === "ghost"
    ? (process.env.GHOST_PROVIDER || process.env.PROVIDER || "claude")
    : (process.env.PROVIDER || "claude");
  const p = getProvider(name);
  const model = scope === "ghost"
    ? (process.env.GHOST_MODEL || process.env.MODEL || p.defaultModel)
    : (process.env.MODEL || p.defaultModel);
  return { provider: p.name, model };
}

function errMsg(e: unknown): string { return String((e as any)?.message ?? e).slice(0, 80); }
