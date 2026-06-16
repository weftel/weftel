import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PW_PORT) || 4399; // distinct from the dev server on 4321; PW_PORT overrides for collision-safe parallel runs

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false, // one server + one vault — keep serial to avoid file races
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, headless: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run server.ts tests/e2e/.vault",
    url: `http://localhost:${PORT}/`,
    timeout: 20_000,
    reuseExistingServer: false,
    // AI calls record/replay through this dir; AI_OFFLINE=1 (in CI) errors on a miss.
    // [AI:cmdk] forward AI_EDIT_ENABLED so the orchestrator can turn ⌘K on for a run with one env
    // var (server gates the /rewrite route + client UI on it): `AI_EDIT_ENABLED=1 bun run e2e`.
    env: { PORT: String(PORT), AI_CACHE: "tests/e2e/.ai-cache", AI_OFFLINE: process.env.AI_OFFLINE || "", AI_EDIT_ENABLED: process.env.AI_EDIT_ENABLED || "" },
  },
});
