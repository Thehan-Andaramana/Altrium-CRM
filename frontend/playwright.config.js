import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { BACKEND_DIR, pythonPath } from './e2e/backend-python.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Playwright 1.63 runs webServer startup *before* globalSetup (the opposite
// of what the name suggests -- confirmed in
// node_modules/playwright/lib/runner/index.js's createGlobalSetupTasks,
// where plugin setup, which webServer registers itself as, precedes the
// globalSetup file in the task list). That makes globalSetup useless for
// preparing altrium_e2e: the backend webServer entry would already have
// failed to start against a nonexistent database by the time globalSetup
// ran. So this check runs synchronously here, at config-load time -- before
// Playwright starts anything -- and the database bootstrap itself is
// chained directly into the backend webServer command below.
for (const [dir, file] of [
  [BACKEND_DIR, '.env.test'],
  [__dirname, '.env.test'],
]) {
  if (!fs.existsSync(path.join(dir, file))) {
    const relative = path.relative(path.resolve(__dirname, '..'), path.join(dir, file))
    throw new Error(
      `${relative} is missing -- copy ${relative}.example to ${relative} ` +
        '(see the README\'s "End-to-end tests" section) before running the e2e suite.',
    )
  }
}

// Dedicated ports for the e2e stack, deliberately not 3000/9000 (the dev
// stack's ports) -- so this can never be mistaken for, or collide with, a
// dev server a developer already has running. Hardcoded here rather than
// read from the .env.test files: this project already duplicates DB_PORT
// between the root .env and backend/.env the same way (see the README's
// Troubleshooting section, "Both files, same port") rather than sharing a
// loader between the Node and Python halves, and a third file doing that
// just for these two numbers wouldn't be worth it. If you change either,
// change it in backend/.env.test's CSRF_TRUSTED_ORIGINS and
// frontend/.env.test too.
const E2E_FRONTEND_PORT = 3100
const E2E_BACKEND_PORT = 9100

// DJANGO_ENV_FILE (see backend/config/settings.py) is what makes this the
// e2e backend rather than the dev one: it loads backend/.env.test, which
// points DATABASE_URL at altrium_e2e instead of the dev database. The
// webServer command below (ensure_database/migrate/seed_demo/runserver)
// uses this same variable for every step, so the database it prepares is
// the one the server it then starts actually runs against.
//
// Spreading process.env is required, not cosmetic: Playwright's
// webServer.env *replaces* the child process's environment rather than
// merging it, so without this the spawned Python loses PATH, SystemRoot and
// everything else Windows needs just to start the interpreter -- it broke
// in a different, confusing way depending on how far it got before
// something it silently needed turned out to be missing.
const DJANGO_ENV = { ...process.env, DJANGO_ENV_FILE: '.env.test' }

// Chromium only, deliberately -- adding Firefox and WebKit here would triple
// run time for a small internal CRM with no cross-browser support burden.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  // Serial on purpose. Every test shares one e2e stack and one database, and
  // running two workers made Django's dev server refuse connections mid-run
  // (Vite logged `http proxy error ... ECONNREFUSED` and the page rendered
  // "Failed to load lead"), which showed up as flakes that had nothing to do
  // with the app.
  workers: 1,
  use: {
    baseURL: `http://localhost:${E2E_FRONTEND_PORT}`,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  // Both servers point at the isolated e2e database/ports, so `npm run
  // test:e2e` can never run against -- or leave records in -- the dev
  // database, whether or not a dev stack happens to already be running.
  //
  // reuseExistingServer stays on outside CI: because these ports are
  // e2e-only (never the dev stack's), anything already answering on them is
  // overwhelmingly likely to be an e2e stack left running from a previous
  // `npm run test:e2e:ui` session, not something that could point at the
  // wrong database -- so reusing it is a speed win, not a correctness risk.
  // CI always starts clean.
  webServer: [
    {
      // Chained rather than left to globalSetup (see the comment above):
      // ensure_database/migrate/seed_demo all run, in order, before
      // runserver ever binds the port -- so Playwright's health check can't
      // observe the backend as "up" until altrium_e2e is fully prepared.
      // All three are idempotent, so this is cheap on every run after the
      // first, and it never touches the dev database since .env.test (not
      // .env) is what DJANGO_ENV points at below.
      command: [
        'ensure_database',
        'migrate --noinput',
        'seed_demo',
        `runserver ${E2E_BACKEND_PORT} --noreload`,
      ]
        .map((args) => `"${pythonPath()}" manage.py ${args}`)
        .join(' && '),
      cwd: '../backend',
      port: E2E_BACKEND_PORT,
      env: DJANGO_ENV,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Bypasses the `dev` npm script (just `vite`) to pass --mode directly:
      // Vite's own convention is that --mode test layers .env.test over
      // .env, which is what points BACKEND_URL/FRONTEND_PORT at the e2e
      // backend and port instead of the dev ones.
      command: 'npx vite --mode test',
      port: E2E_FRONTEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
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
