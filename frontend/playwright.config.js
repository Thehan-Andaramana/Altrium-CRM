import { defineConfig, devices } from '@playwright/test'

// Chromium only, deliberately -- adding Firefox and WebKit here would triple
// run time for a small internal CRM with no cross-browser support burden.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  // Serial on purpose. Every test shares one dev stack and one database, and
  // running two workers made Django's dev server refuse connections mid-run
  // (Vite logged `http proxy error ... ECONNREFUSED` and the page rendered
  // "Failed to load lead"), which showed up as flakes that had nothing to do
  // with the app.
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Logs in as each demo role once and saves its storage state to
      // e2e/.auth/*.json -- runs before the chromium project (see
      // `dependencies` below) so every real spec can reuse a session
      // instead of logging in itself. Matched by file name, not the
      // default *.spec.js pattern, so it never runs as an ordinary test.
      name: 'setup',
      testMatch: /auth\.setup\.js/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
})
