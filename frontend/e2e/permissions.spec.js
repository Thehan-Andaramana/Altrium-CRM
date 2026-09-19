import { expect, test } from '@playwright/test'
import { apiAs, contextAs, openTask, seedLead, topDialog } from './helpers.js'

const REP_OWNS_IT = 'Only the sales rep assigned to this lead can mark this task complete.'
const PM_OWNS_IT = 'Only the project manager assigned to this project can mark this task complete.'

// Each test seeds its own company/lead/project, so nothing here depends on
// another test having run (or on the demo data's current state).
async function seed(playwright, baseURL) {
  const api = await apiAs(playwright, baseURL, 'sales-manager')
  try {
    return await seedLead(api, { rep: 'rep1', pm: 'pm1' })
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

// Completion is phase-based: phases 1 and 4 belong to the assigned rep,
// phases 2 and 3 to the assigned PM, and no management role can complete
// anything. Whoever can't gets a read-only status and a line saying whose
// job it is -- the server rejects the call regardless (see
// PhaseRequirementSerializer), this is the UI half of the same rule.
test.describe('task completion permissions', () => {
  test('a sales manager cannot complete a task', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRole(browser, 'sales-manager', async (page) => {
      await page.goto(leadUrl)
      await openTask(page, 'Client Proposal Confirmation')

      const dialog = topDialog(page)
      await expect(dialog.getByText(REP_OWNS_IT)).toBeVisible()
      await expect(dialog.getByRole('combobox', { name: 'Status' })).toHaveCount(0)
    })
  })

  test('a project manager cannot complete a Phase 1 task', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRole(browser, 'project-manager', async (page) => {
      await page.goto(leadUrl)
      await openTask(page, 'Client Proposal Confirmation')

      const dialog = topDialog(page)
      await expect(dialog.getByText(REP_OWNS_IT)).toBeVisible()
      await expect(dialog.getByRole('combobox', { name: 'Status' })).toHaveCount(0)
    })
  })

  test('a rep cannot complete a Phase 2 task', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRole(browser, 'rep', async (page) => {
      await page.goto(leadUrl)
      await openTask(page, 'Detailed Requirements Analysis')

      const dialog = topDialog(page)
      await expect(dialog.getByText(PM_OWNS_IT)).toBeVisible()
      await expect(dialog.getByRole('combobox', { name: 'Status' })).toHaveCount(0)

      // The rep's own Phase 1 task still offers the control, so the absence
      // above is about this task, not about the rep seeing a read-only page.
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await openTask(page, 'Client Proposal Confirmation')
      await expect(topDialog(page).getByRole('combobox', { name: 'Status' })).toBeVisible()
    })
  })
})

test.describe('approval permissions', () => {
  test('a sales manager cannot approve a Phase 4 sign-off, but an executive can', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    const { lead, project } = await seed(playwright, baseURL)

    // Raised by the rep, so a manager withholding approval below is the
    // Phase 4 rule and not merely the "nobody decides their own" rule.
    const repApi = await apiAs(playwright, baseURL, 'rep')
    try {
      const response = await repApi.post('/api/approvals/', {
        data: { request_type: 'PHASE_4_SIGNOFF', project: project.id },
      })
      expect(response.ok(), await response.text()).toBeTruthy()
    } finally {
      await repApi.dispose()
    }

    await asRole(browser, 'sales-manager', async (page) => {
      await page.goto('/approvals')
      const row = page.getByRole('row').filter({ hasText: lead.name })
      await expect(row).toBeVisible()
      await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    })

    await asRole(browser, 'executive-manager', async (page) => {
      await page.goto('/approvals')
      const row = page.getByRole('row').filter({ hasText: lead.name })
      await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible()
    })
  })
})

test.describe('company ownership permissions', () => {
  test('a rep cannot reassign company ownership', async ({ browser, baseURL, playwright }) => {
    const { company } = await seed(playwright, baseURL)

    await asRole(browser, 'rep', async (page) => {
      await page.goto('/companies')
      const row = page.getByRole('row').filter({ hasText: company.name })
      await expect(row).toBeVisible()

      // A manager gets a clickable owner cell that swaps in a dropdown; for
      // a rep it is plain text, and there's no way to create one either.
      await expect(row.getByRole('button')).toHaveCount(0)
      await expect(row.getByRole('combobox')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'New Company' })).toHaveCount(0)
    })

    await asRole(browser, 'sales-manager', async (page) => {
      await page.goto('/companies')
      const row = page.getByRole('row').filter({ hasText: company.name })
      await expect(row.getByRole('button', { name: 'rep1' })).toBeVisible()
    })
  })
})
