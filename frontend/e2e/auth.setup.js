import { test as setup } from '@playwright/test'
import { authFile } from './auth-file.js'

// Matches seed_demo.py's DEMO_PASSWORD -- every seeded demo user shares it.
const DEMO_PASSWORD = 'testpass123'

// One of seed_demo.py's named users per role this app cares about. Add a
// role here (and re-run) rather than logging in ad hoc inside a spec.
const ROLES = [
  { role: 'rep', username: 'rep1' },
  { role: 'project-manager', username: 'pm1' },
  { role: 'sales-manager', username: 'mgr1' },
  { role: 'executive-manager', username: 'ex1' },
  { role: 'system-admin', username: 'admin' },
]

for (const { role, username } of ROLES) {
  setup(`authenticate as ${role} (${username})`, async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Username').fill(username)
    await page.getByLabel('Password').fill(DEMO_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Confirms the login actually succeeded (redirected past /login and the
    // dashboard rendered) before saving state -- a failed login would
    // otherwise still write out an "authenticated" file with no session.
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()

    await page.context().storageState({ path: authFile(role) })
  })
}
