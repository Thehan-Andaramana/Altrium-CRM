import { expect, test } from '@playwright/test'
import { apiAs, contextAs, seedLead } from './helpers.js'

async function seed(playwright, baseURL) {
  const api = await apiAs(playwright, baseURL, 'sales-manager')
  try {
    return await seedLead(api, { rep: 'rep1', pm: 'pm1' })
  } finally {
    await api.dispose()
  }
}

test.describe('lead detail layout', () => {
  test('shows the phase stepper, contact panel and summary rail', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    const { leadUrl } = await seed(playwright, baseURL)
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto(leadUrl)

      // A new lead sits in Phase 1, so that step is the current one and
      // the rest are still ahead.
      const stepper = page.getByRole('list', { name: 'Phase progress' })
      await expect(stepper.getByText('Phase 1')).toBeVisible()
      await expect(stepper.getByText('Maintenance')).toBeVisible()
      await expect(stepper.locator('li').first()).toContainText('in progress')

      // The rail carries the summary, and the phases live in the middle.
      await expect(page.getByText('Current phase')).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Phases' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Phase 1' })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('the summary rail lists what is due next', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto(leadUrl)

      // Phase 1 starts on lead creation, which dates its tasks.
      await expect(page.getByText('Due next')).toBeVisible()
      await expect(page.getByRole('link', { name: 'Requirement Discussion' })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('timeline entries render as cards with an author and a time', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    const { leadUrl } = await seed(playwright, baseURL)
    const context = await contextAs(browser, 'rep')
    try {
      const page = await context.newPage()
      await page.goto(leadUrl)
      await page.getByRole('tab', { name: 'Activity' }).click()

      const activity = page.getByRole('tabpanel')
      await activity.getByLabel('Type').selectOption('CALL')
      await activity.getByLabel('Outcome').selectOption('RESPONDED')
      await activity.getByLabel('Notes').fill('Talked through the scope.')
      await activity.getByRole('button', { name: 'Save', exact: true }).click()

      const entry = page.locator('.timeline__entry').first()
      await expect(entry).toContainText('Call')
      await expect(entry).toContainText('Logged by rep1')
      await expect(entry).toContainText('Talked through the scope.')
    } finally {
      await context.close()
    }
  })
})

test.describe('pipeline filters', () => {
  test('a sort chip reorders the list and shows as pressed', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/leads')

      const chip = page.getByRole('button', { name: 'Name A–Z' })
      await expect(chip).toHaveAttribute('aria-pressed', 'false')
      await chip.click()
      await expect(chip).toHaveAttribute('aria-pressed', 'true')

      // The chips and the column headers drive one sort between them.
      await expect(page.getByRole('columnheader', { name: 'Project' })).toHaveAttribute(
        'aria-sort',
        'ascending',
      )
    } finally {
      await context.close()
    }
  })

  test('filter groups collapse and narrow the list', async ({ browser, baseURL, playwright }) => {
    const { lead } = await seed(playwright, baseURL)
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/leads')
      await expect(page.getByRole('link', { name: lead.name })).toBeVisible()

      // Scoped to the rail: the table's own sortable "Phase" header is a
      // button by that name too.
      const rail = page.getByRole('complementary', { name: 'Filter' })

      // The seeded lead is COLD and in Phase 1, so filtering to hot hides
      // it and filtering to Phase 1 brings it back.
      await rail.getByRole('checkbox', { name: 'Hot' }).check()
      await expect(page.getByRole('link', { name: lead.name })).toHaveCount(0)

      await rail.getByRole('button', { name: 'Reset' }).click()
      await expect(page.getByRole('link', { name: lead.name })).toBeVisible()

      await rail.getByRole('checkbox', { name: 'Phase 1 Requirements' }).check()
      await expect(page.getByRole('link', { name: lead.name })).toBeVisible()

      // A group collapses to get out of the way.
      const group = rail.getByRole('button', { name: 'Phase', exact: true })
      await expect(group).toHaveAttribute('aria-expanded', 'true')
      await group.click()
      await expect(group).toHaveAttribute('aria-expanded', 'false')
    } finally {
      await context.close()
    }
  })

  test('a status deep link from the dashboard seeds the filter', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/leads?status=HOT')
      const rail = page.getByRole('complementary', { name: 'Filter' })
      await expect(rail.getByRole('checkbox', { name: 'Hot' })).toBeChecked()
    } finally {
      await context.close()
    }
  })
})
