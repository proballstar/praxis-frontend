import { defineConfig } from "@playwright/test";

const PORT = 3101;
const DB = "/tmp/praxis-ui-test/timely.db";

// Runs against the production build with a throwaway database. Run `npm run build` first.
export default defineConfig({
  testDir: "tests",
  testMatch: "ui.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `rm -f ${DB} ${DB}-wal ${DB}-shm && npx next start --port ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    env: {
      PRAXIS_DB_FILE: DB,
      // A far-away zone proves the clock follows the restaurant, not the browser.
      PRAXIS_TIMEZONE: "Pacific/Auckland",
      // Nothing listens here except inside the assistant test, so other tests
      // exercise the same fallback as a failed AI call. No real key is used.
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: "http://127.0.0.1:3199",
    },
  },
});
