import { expect, test } from '@playwright/test'
import { contextAs } from './helpers.js'

function isoDaysAgo(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

test.describe('reports', () => {
  test('a rep has no reports link and is sent away from the route', async ({ browser }) => {
    const context = await contextAs(browser, 'rep')
    try {
      const page = await context.newPage()
      await page.goto('/')
      await expect(page.getByRole('link', { name: 'Reports' })).toHaveCount(0)

      // Reaching for the URL directly lands back on the dashboard -- and the
      // API refuses it too (see ReportingPermission).
      await page.goto('/reports')
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('a project manager is sent away from the route too', async ({ browser }) => {
    const context = await contextAs(browser, 'project-manager')
    try {
      const page = await context.newPage()
      await page.goto('/reports')
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('a manager sees the report, defaulting to the last 30 days', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/reports')

      await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible()
      await expect(page.getByLabel('From date')).toHaveValue(isoDaysAgo(29))
      await expect(page.getByLabel('To date')).toHaveValue(isoDaysAgo(0))

      await expect(page.getByRole('img', { name: 'Projects per phase' })).toBeVisible()
      await expect(page.getByRole('img', { name: 'Average days per phase' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Per sales rep' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Per project manager' })).toBeVisible()

      // The seeded rep has a row in the per-rep table.
      await expect(page.getByRole('row').filter({ hasText: 'rep1' }).first()).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('changing the range refetches the report', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/reports')
      await expect(page.getByRole('img', { name: 'Projects per phase' })).toBeVisible()

      const request = page.waitForRequest((r) => r.url().includes('/api/reports/?start=2026-01-01'))
      await page.getByLabel('From date').fill('2026-01-01')
      await request

      await expect(page.getByLabel('From date')).toHaveValue('2026-01-01')
    } finally {
      await context.close()
    }
  })

  test('the per-rep table sorts on a column', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/reports')

      const header = page.getByRole('columnheader', { name: 'Leads owned' })
      await expect(header).toHaveAttribute('aria-sort', 'none')

      await header.getByRole('button').click()
      await expect(header).toHaveAttribute('aria-sort', 'ascending')

      await header.getByRole('button').click()
      await expect(header).toHaveAttribute('aria-sort', 'descending')
    } finally {
      await context.close()
    }
  })

  test('the report exports as CSV', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/reports')
      await expect(page.getByRole('img', { name: 'Projects per phase' })).toBeVisible()

      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export CSV' }).click()
      const file = await download

      expect(file.suggestedFilename()).toMatch(/^altrium-report-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/)
    } finally {
      await context.close()
    }
  })
})
