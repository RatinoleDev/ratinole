import { defineConfig } from "@playwright/test";

/**
 * Smoke tests against the production build (`pnpm build` first). The server is
 * pointed at a closed port for its own API calls, so server-rendered parts show
 * their empty states; browser calls to /api are mocked per test.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3100", trace: "off", reducedMotion: "reduce" },
  webServer: {
    command: "node node_modules/next/dist/bin/next start -p 3100",
    port: 3100,
    reuseExistingServer: false,
    env: { API_INTERNAL_URL: "http://127.0.0.1:9" },
  },
});
