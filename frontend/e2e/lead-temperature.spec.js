import { expect, test } from '@playwright/test'
import { apiAs, contextAs, seedLead, topDialog } from './helpers.js'

async function seed(playwright, baseURL) {
  const api = await apiAs(playwright, baseURL, 'sales-manager')
  try {
    return await seedLead(api, { rep: 'rep1' })
  } finally {
    await api.dispose()
  }
}

async function asRole(browser, role, run) {
  const context = await contextAs(browser, role)
  try {
    await run(await context.newPage())
  } finally {
    await context.close()
  }
}

test.describe('lead temperature', () => {
  test('a RESPONDED interaction leaves a cold lead cold', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRole(browser, 'rep', async (page) => {
      await page.goto(leadUrl)
      await expect(page.getByRole('button', { name: 'COLD' })).toBeVisible()

      await page.getByRole('tab', { name: 'Activity' }).click()
      await page.getByLabel('Type').selectOption('CALL')
      await page.getByLabel('Outcome').selectOption('RESPONDED')
      await page.getByLabel('Notes').fill('Spoke to the sponsor about scope.')
      // "Save notes" in the project panel would also match a loose "Save".
      await page.getByRole('button', { name: 'Save', exact: true }).click()

      await expect(page.getByText('Spoke to the sponsor about scope.')).toBeVisible()

      // Client contact updates the timeline, but warming a lead is now a
      // deliberate act, not a side effect of logging a call.
      await expect(page.getByRole('button', { name: 'COLD' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'HOT' })).toHaveCount(0)
    })
  })

  test('a manager changing status directly must give a reason', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRole(browser, 'sales-manager', async (page) => {
      await page.goto(leadUrl)
      await page.getByRole('button', { name: 'Edit lead' }).click()

      const dialog = topDialog(page)
      await dialog.getByLabel('Status').selectOption('HOT')

      const reason = dialog.getByLabel('Reason for status change')
      await expect(reason).toBeVisible()

      // Saving with the reason blank gets us nowhere: the field is required,
      // so the modal stays put and the lead is untouched.
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeVisible()
      await expect(page.getByText('COLD', { exact: true })).toBeVisible()

      await reason.fill('Client re-engaged on the renewal.')
      await dialog.getByRole('button', { name: 'Save' }).click()

      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText('HOT', { exact: true })).toBeVisible()
    })
  })

  test('a rep clicking the status badge raises an approval request', async ({ browser, baseURL, playwright }) => {
    const { lead, leadUrl } = await seed(playwright, baseURL)

    await asRole(browser, 'rep', async (page) => {
      await page.goto(leadUrl)
      await page.getByRole('button', { name: 'COLD' }).click()

      const dialog = topDialog(page)
      await expect(dialog.getByRole('heading', { name: 'Request Status Change' })).toBeVisible()
      await dialog.getByLabel('New status').selectOption('HOT')
      await dialog.getByLabel('Reason').fill('Client called back to restart the project.')
      await dialog.getByRole('button', { name: 'Submit request' }).click()

      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText('Change to HOT pending')).toBeVisible()
      // Requested, not applied: the lead stays cold, and the badge stops
      // being a button so the same request can't be raised twice.
      await expect(page.getByText('COLD', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'COLD' })).toHaveCount(0)
    })

    await asRole(browser, 'sales-manager', async (page) => {
      await page.goto('/approvals')
      const row = page.getByRole('row').filter({ hasText: lead.name }).filter({ hasText: 'Lead Status Change' })
      await expect(row).toBeVisible()
      await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible()
    })
  })
})
