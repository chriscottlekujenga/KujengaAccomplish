import { defineConfig } from '@playwright/test';

/**
 * Gateway E2E suite (Phase 3 M5) — Playwright Chromium against the real
 * HTTP gateway + real daemon + real ollama tasks on an isolated data dir.
 *
 * Serial: one boot chain per run (worker fixture in e2e/fixtures/gateway.ts),
 * so specs share the persisted SQLite state exactly like a real session.
 */
export default defineConfig({
  testDir: './e2e/specs',
  outputDir: './e2e/test-results',

  workers: 1,
  fullyParallel: false,

  timeout: 90_000,
  expect: { timeout: 15_000 },

  retries: 0,

  reporter: [['list'], ['html', { outputFolder: './e2e/html-report', open: 'never' }]],

  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});
