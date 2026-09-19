import { expect, test } from '@playwright/test'
import { authFile } from './auth-file.js'

// Proves the harness itself works: a saved session (from auth.setup.js, not
// a login performed here) reaches a real page and renders real content.
test.use({ storageState: authFile('sales-manager') })

test('mgr1 sees the dashboard', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})
