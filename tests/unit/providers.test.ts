// Unit tests for the swappable AI provider seam (server/providers.ts). Run: `bun test`.
// No DOM and NO live model calls: CloudProvider.stream() is never invoked (it would hit the
// subscription); Ollama is exercised with a MOCKED fetch (no live daemon required).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getProvider, modelInfo, parseOllamaLine, CloudProvider, OllamaProvider, FimProvider } from "../../server/providers";

// ── env isolation: provider config is read at call time, so save/clear/restore around each test ──
const ENV_KEYS = ["PROVIDER", "MODEL", "OLLAMA_HOST", "GHOST_PROVIDER", "GHOST_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// A self-contained mock Response — avoids depending on whichever global Response/ReadableStream
// implementation is active. `chunks` are decoded one read() at a time so cross-read NDJSON
// buffering is exercised; lines may be split mid-frame between chunks.
function mockRes(chunks: string[], status = 200) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) },
  } as any;
}

// ───────────────────────── factory selection ─────────────────────────
describe("getProvider factory", () => {
  test("default (no PROVIDER env) is CloudProvider", () => {
    expect(getProvider()).toBe(CloudProvider);
    expect(getProvider().name).toBe("claude");
  });
  test("explicit names map to providers (case- and whitespace-insensitive)", () => {
    expect(getProvider("claude")).toBe(CloudProvider);
    expect(getProvider("cloud")).toBe(CloudProvider);   // alias
    expect(getProvider(" Ollama ")).toBe(OllamaProvider);
    expect(getProvider("FIM")).toBe(FimProvider);
  });
  test("an unknown name falls back to CloudProvider (a typo must never disable AI)", () => {
    expect(getProvider("gpt-9000")).toBe(CloudProvider);
  });
  test("PROVIDER env chooses the default selection", () => {
    process.env.PROVIDER = "ollama";
    expect(getProvider()).toBe(OllamaProvider);
  });
});

// ───────────────────────── modelInfo (provider + resolved model) ─────────────────────────
describe("modelInfo", () => {
  test("default is {provider:'claude', model:'haiku'} — matches the legacy hardcoded model (cache keys unchanged)", () => {
    expect(modelInfo()).toEqual({ provider: "claude", model: "haiku" });
  });
  test("MODEL env overrides the provider's default model", () => {
    process.env.MODEL = "sonnet";
    expect(modelInfo()).toEqual({ provider: "claude", model: "sonnet" });
  });
  test("PROVIDER=ollama reports the ollama provider + its default model", () => {
    process.env.PROVIDER = "ollama";
    expect(modelInfo()).toEqual({ provider: "ollama", model: OllamaProvider.defaultModel });
  });
});

// [AI:integration] per-feature model split: ⌘K (rewrite) and ghost resolve independently so a strong
// cloud ⌘K can run alongside a fast local ghost. With no env BOTH are claude/haiku (cache unchanged).
describe("modelInfo per-feature scope (rewrite vs ghost)", () => {
  test("no env → BOTH scopes resolve to claude/haiku (committed default, cache keys unchanged)", () => {
    expect(modelInfo("rewrite")).toEqual({ provider: "claude", model: "haiku" });
    expect(modelInfo("ghost")).toEqual({ provider: "claude", model: "haiku" });
    expect(modelInfo()).toEqual(modelInfo("rewrite")); // default scope is rewrite
  });
  test("GHOST_PROVIDER/GHOST_MODEL split ghost LOCAL while ⌘K stays CLOUD — simultaneously", () => {
    process.env.GHOST_PROVIDER = "ollama";
    process.env.GHOST_MODEL = "qwen2.5-coder:1.5b";
    expect(modelInfo("rewrite")).toEqual({ provider: "claude", model: "haiku" });        // ⌘K unaffected
    expect(modelInfo("ghost")).toEqual({ provider: "ollama", model: "qwen2.5-coder:1.5b" }); // ghost local
  });
  test("ghost inherits PROVIDER/MODEL when GHOST_* unset; PROVIDER drives both", () => {
    process.env.PROVIDER = "ollama";
    process.env.MODEL = "llama3.2";
    expect(modelInfo("rewrite")).toEqual({ provider: "ollama", model: "llama3.2" });
    expect(modelInfo("ghost")).toEqual({ provider: "ollama", model: "llama3.2" }); // inherits PROVIDER/MODEL
  });
  test("GHOST_* overrides an inherited PROVIDER for ghost only", () => {
    process.env.PROVIDER = "ollama"; process.env.MODEL = "llama3.2";
    process.env.GHOST_MODEL = "qwen2.5-coder:1.5b";
    expect(modelInfo("rewrite")).toEqual({ provider: "ollama", model: "llama3.2" });
    expect(modelInfo("ghost")).toEqual({ provider: "ollama", model: "qwen2.5-coder:1.5b" }); // GHOST_MODEL wins
  });
});

// ───────────────────────── parseOllamaLine (NDJSON frame parsing) ─────────────────────────
describe("parseOllamaLine", () => {
  test("extracts /api/chat token frames", () => {
    expect(parseOllamaLine('{"message":{"role":"assistant","content":"Hel"},"done":false}')).toEqual({ content: "Hel" });
  });
  test("extracts /api/generate response frames", () => {
    expect(parseOllamaLine('{"response":"lo","done":false}')).toEqual({ content: "lo" });
  });
  test("surfaces an error frame", () => {
    expect(parseOllamaLine('{"error":"model not found"}')).toEqual({ error: "model not found" });
  });
  test("blank / whitespace / final-done / unparseable frames yield nothing", () => {
    expect(parseOllamaLine("")).toEqual({});
    expect(parseOllamaLine("   ")).toEqual({});
    expect(parseOllamaLine('{"done":true}')).toEqual({});  // no content field
    expect(parseOllamaLine("not json")).toEqual({});
  });
});

// ───────────────────────── FimProvider stub ─────────────────────────
test("FimProvider.stream is a clean stub failure (never streams, never throws)", async () => {
  const chunks: string[] = [];
  const r = await FimProvider.stream("anything", {}, (s) => chunks.push(s));
  expect(r).toEqual({ ok: false, error: "FIM not implemented" });
  expect(chunks).toEqual([]);
});

// ───────────────────────── OllamaProvider request shaping (mocked fetch) ─────────────────────────
describe("OllamaProvider (mocked fetch — no live daemon)", () => {
  test("POSTs /api/chat with system+user messages and stream:true, then concatenates the streamed tokens", async () => {
    let captured: { url: any; init: any } = { url: null, init: null };
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url, init };
      // split mid-frame across two reads to exercise the NDJSON line buffer
      return mockRes(['{"message":{"content":"Hel"},"done":false}\n{"mess', 'age":{"content":"lo"},"done":false}\n{"message":{"content":""},"done":true}\n']);
    }) as any;

    const chunks: string[] = [];
    const r = await OllamaProvider.stream("write hi", { system: "SYS", model: "llama3.2" }, (s) => chunks.push(s));

    expect(captured.url).toBe("http://localhost:11434/api/chat");
    expect(captured.init.method).toBe("POST");
    expect(captured.init.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(captured.init.body);
    expect(body.model).toBe("llama3.2");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "write hi" }]);

    expect(chunks).toEqual(["Hel", "lo"]);            // empty final frame contributes nothing
    expect(r).toEqual({ ok: true, out: "Hello" });
  });

  test("omits the system message when no system prompt is supplied", async () => {
    let body: any = null;
    globalThis.fetch = (async (_u: any, init: any) => { body = JSON.parse(init.body); return mockRes(['{"message":{"content":"x"},"done":true}\n']); }) as any;
    await OllamaProvider.stream("p", { model: "m" }, () => {});
    expect(body.messages).toEqual([{ role: "user", content: "p" }]);
  });

  test("honors OLLAMA_HOST and trims a trailing slash", async () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9999/";
    let url: any = null;
    globalThis.fetch = (async (u: any) => { url = u; return mockRes(['{"message":{"content":"x"},"done":true}\n']); }) as any;
    await OllamaProvider.stream("p", { model: "m" }, () => {});
    expect(url).toBe("http://127.0.0.1:9999/api/chat");
  });

  test("a connection failure returns {ok:false} gracefully (never throws)", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await OllamaProvider.stream("p", { model: "m" }, () => {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ollama unreachable");
  });

  test("a non-2xx response returns {ok:false} with the status", async () => {
    globalThis.fetch = (async () => mockRes(["nope"], 500)) as any;
    const r = await OllamaProvider.stream("p", { model: "m" }, () => {});
    expect(r).toEqual({ ok: false, error: "ollama http 500" });
  });

  test("a mid-stream ollama error frame surfaces as {ok:false}", async () => {
    globalThis.fetch = (async () => mockRes(['{"error":"model \\"m\\" not found"}\n'])) as any;
    const r = await OllamaProvider.stream("p", { model: "m" }, () => {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });
});

// ───────────────────────── probe() — first-run connection detection ─────────────────────────
// [AI:firstrun] Each provider's cheap reachability check (NO inference). Cloud reads env / local
// session; Ollama pings /api/tags (mocked). These power the "connect your Claude / point at Ollama"
// banner via /api/ai-status.

// A minimal JSON Response for the Ollama probe's `fetch(...).json()` (distinct from the streaming
// mockRes above, which has no .json()).
function jsonRes(obj: any, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj } as any;
}

describe("CloudProvider.probe (env auth — no keychain/network)", () => {
  test("an API key in env reports connected", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
    const p = await CloudProvider.probe!();
    expect(p.connected).toBe(true);
    expect(p.detail).toContain("env");
    expect(p.hint).toBeUndefined();
  });
  test("an OAuth token in env reports connected", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    expect((await CloudProvider.probe!()).connected).toBe(true);
  });
  // Note: the NOT-connected cloud path depends on the host's local Claude session (credentials file /
  // macOS keychain), so it's intentionally not asserted here — it's covered by the manual QA on a
  // provider forced to a not-running Ollama, where the connected state is deterministic.
});

describe("OllamaProvider.probe (mocked fetch — no live daemon)", () => {
  test("daemon up with the configured model → connected", async () => {
    process.env.MODEL = "llama3.2";
    let url: any = null;
    globalThis.fetch = (async (u: any) => { url = u; return jsonRes({ models: [{ name: "llama3.2:latest" }, { name: "qwen2.5-coder:3b" }] }); }) as any;
    const p = await OllamaProvider.probe!();
    expect(url).toBe("http://localhost:11434/api/tags");
    expect(p.connected).toBe(true);
    expect(p.hint).toBeUndefined();
    expect(p.detail).not.toContain("not pulled");
  });
  test("daemon up but the configured model isn't pulled → still connected, noted in detail", async () => {
    process.env.MODEL = "llama3.2";
    globalThis.fetch = (async () => jsonRes({ models: [{ name: "mistral:latest" }] })) as any;
    const p = await OllamaProvider.probe!();
    expect(p.connected).toBe(true);
    expect(p.detail).toContain("not pulled");
  });
  test("connection refused → not connected, with an actionable hint", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    const p = await OllamaProvider.probe!();
    expect(p.connected).toBe(false);
    expect(p.detail).toContain("unreachable");
    expect(p.hint).toContain("ollama");
  });
  test("a non-2xx from the daemon → not connected", async () => {
    globalThis.fetch = (async () => jsonRes({}, 500)) as any;
    const p = await OllamaProvider.probe!();
    expect(p.connected).toBe(false);
    expect(p.detail).toContain("500");
  });
  test("honors OLLAMA_HOST (trailing slash trimmed) for the probe endpoint", async () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9999/";
    let url: any = null;
    globalThis.fetch = (async (u: any) => { url = u; return jsonRes({ models: [] }); }) as any;
    await OllamaProvider.probe!();
    expect(url).toBe("http://127.0.0.1:9999/api/tags");
  });
});

test("FimProvider.probe reports not connected (stub) with a redirect hint", async () => {
  const p = await FimProvider.probe!();
  expect(p.connected).toBe(false);
  expect(p.hint).toBeTruthy();
});
