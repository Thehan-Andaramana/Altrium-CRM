import { expect, test } from '@playwright/test'
import { apiAs, contextAs, seedLead } from './helpers.js'

// SYSTEM_ADMIN is the "sees everything, changes almost nothing" role: an
// unrestricted read across every rep's work, with the existing write
// restrictions untouched.
test.describe('system admin visibility', () => {
  test('sees another rep lead in the pipeline, on the board and on its own page', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    const api = await apiAs(playwright, baseURL, 'sales-manager')
    let seeded
    try {
      seeded = await seedLead(api, { rep: 'rep1', pm: 'pm1' })
    } finally {
      await api.dispose()
    }

    const context = await contextAs(browser, 'system-admin')
    try {
      const page = await context.newPage()

      await page.goto('/leads')
      await expect(page.getByRole('link', { name: seeded.lead.name })).toBeVisible()

      await page.goto('/board')
      await expect(
        page.getByRole('region', { name: 'Phase 1 Requirements' }).getByText(seeded.lead.name),
      ).toBeVisible()

      await page.goto(seeded.leadUrl)
      await expect(page.getByRole('heading', { name: seeded.lead.name })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('reaches the dashboard, companies, calendar, approvals and reports', async ({ browser }) => {
    const context = await contextAs(browser, 'system-admin')
    try {
      const page = await context.newPage()

      for (const [url, heading] of [
        ['/', 'Dashboard'],
        ['/companies', 'Companies'],
        ['/calendar', 'Calendar'],
        ['/approvals', 'Approvals'],
        ['/reports', 'Reports'],
      ]) {
        await page.goto(url)
        await expect(page.getByRole('heading', { name: heading })).toBeVisible()
      }

      // Reporting is one of the three roles that can read it, so the nav
      // offers it rather than the route bouncing back.
      await expect(page.getByRole('link', { name: 'Reports' })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('still cannot create records', async ({ browser }) => {
    const context = await contextAs(browser, 'system-admin')
    try {
      const page = await context.newPage()

      await page.goto('/leads')
      await expect(page.getByRole('button', { name: 'New Lead' })).toHaveCount(0)

      await page.goto('/companies')
      await expect(page.getByRole('button', { name: 'New Company' })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
