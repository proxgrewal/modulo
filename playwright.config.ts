import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the editor. They run against their own API server
 * (port 4100, data in .modulo-data-e2e) and Vite dev server (port 5194), so a
 * developer's servers on 4000/5173 and their .modulo-data are never touched.
 *
 * Order: webServer start → globalSetup → tests → globalTeardown → webServer stop.
 * The data dir is wiped by the API webServer command before the server boots
 * (globalSetup runs after it is already up), and by globalTeardown once the
 * servers have exited.
 */
// 5174 is often taken by other local Vite apps; override with E2E_API_PORT / E2E_WEB_PORT.
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5194);
export const E2E_DATA = '.modulo-data-e2e';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.results',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${WEB_PORT}`,
    headless: true,
    viewport: { width: 1480, height: 940 },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `node e2e/clean-data.mjs && node --import tsx packages/server/src/main.ts`,
      url: `http://localhost:${API_PORT}/api/health`,
      env: { PORT: String(API_PORT), MODULO_DATA: E2E_DATA, MODULO_OPEN_SIGNUP: '1' },
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `pnpm --dir apps/editor exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { MODULO_API: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
