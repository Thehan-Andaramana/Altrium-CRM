import { expect, test } from '@playwright/test'
import {
  apiAs,
  completeTask,
  confirmTask,
  contextAs,
  decideApproval,
  fetchProject,
  phaseCard,
  requestSignoff,
  unique,
} from './helpers.js'

// Four roles hand work to each other across four phases, so this one runs
// far past the 30s default -- it is the whole lifecycle in a single journey.
test.describe('phase lifecycle', () => {
  test('a lead runs from creation through all four sign-offs into maintenance', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    test.setTimeout(240_000)

    const contexts = await Promise.all(
      ['sales-manager', 'rep', 'project-manager', 'executive-manager'].map((role) => contextAs(browser, role)),
    )
    const [mgrContext, repContext, pmContext, execContext] = contexts
    const mgr = await mgrContext.newPage()
    const rep = await repContext.newPage()
    const pm = await pmContext.newPage()
    const exec = await execContext.newPage()

    try {
      const companyName = unique('Lifecycle Co')
      const leadName = unique('Lifecycle Lead')

      // --- the manager sets the work up -----------------------------------

      await mgr.goto('/companies')
      await mgr.getByRole('button', { name: 'New Company' }).click()
      const companyDialog = mgr.getByRole('dialog')
      await companyDialog.getByLabel('Name').fill(companyName)
      await companyDialog.getByLabel('Owner').selectOption({ label: 'rep1' })
      await companyDialog.getByRole('button', { name: 'Create' }).click()
      await expect(mgr.getByRole('link', { name: companyName })).toBeVisible()

      await mgr.goto('/leads')
      await mgr.getByRole('button', { name: 'New Lead' }).click()
      const leadDialog = mgr.getByRole('dialog')
      await leadDialog.getByLabel('Name').fill(leadName)
      await leadDialog.getByLabel('Company').selectOption({ label: companyName })
      await leadDialog.getByLabel('Assigned rep').selectOption({ label: 'rep1' })
      await leadDialog.getByRole('button', { name: 'Create' }).click()

      await mgr.getByRole('link', { name: leadName }).click()
      await expect(mgr.getByRole('heading', { name: leadName })).toBeVisible()
      const leadUrl = mgr.url()
      const leadId = Number(new URL(leadUrl).pathname.split('/').pop())

      // Phase 2 is PM-owned, so Phase 1 sign-off can't be approved until one
      // is assigned -- this has to happen before the approval below.
      await mgr.getByLabel('Project Manager').selectOption({ label: 'pm1' })
      await expect(mgr.getByLabel('Project Manager')).not.toHaveValue('')

      // --- phase 1: the rep's tasks ---------------------------------------

      await rep.goto(leadUrl)
      for (const task of ['Client Proposal Confirmation', 'Requirement Discussion', 'Contract Papers']) {
        await completeTask(rep, task)
      }
      await requestSignoff(rep, 1)

      await decideApproval(mgr, { leadName, requestType: 'Phase 1 Signoff' })

      await mgr.goto(leadUrl)
      await expect(phaseCard(mgr, 1).getByText('Complete', { exact: true })).toBeVisible()
      await expect(phaseCard(mgr, 2).getByText('In Progress', { exact: true })).toBeVisible()

      // --- phase 2: the PM's tasks, including the budget form -------------

      await pm.goto(leadUrl)
      for (const task of [
        'Detailed Requirements Analysis',
        'Budget Proposal',
        'Technical Analysis',
        'Feasibility Study',
        'Project Planning',
      ]) {
        await completeTask(pm, task)
        // PROJECT_MANAGER-authority tasks need confirming separately before
        // they count towards the phase.
        await confirmTask(pm, task)
      }

      // Completing Budget Proposal feeds its answers into the project panel.
      await pm.reload()
      await expect(pm.getByText('USD 18500.00')).toBeVisible()

      await requestSignoff(pm, 2)
      await decideApproval(mgr, { leadName, requestType: 'Phase 2 Signoff' })

      // --- phase 3: execution status drives the sign-off ------------------

      await pm.goto(leadUrl)
      for (const task of ['Technical Specification', 'Development Progress Review', 'QA Sign-off']) {
        await completeTask(pm, task)
        await confirmTask(pm, task)
      }

      await phaseCard(pm, 3).getByLabel('Execution status').selectOption('COMPLETED')
      // Reaching Completed raises the Phase 3 sign-off by itself -- the phase
      // goes to Awaiting Approval rather than straight to Complete.
      await expect(phaseCard(pm, 3).getByText('Awaiting Approval', { exact: true })).toBeVisible()

      await decideApproval(mgr, { leadName, requestType: 'Phase 3 Signoff' })

      // --- phase 4: the rep completes, the manager confirms ---------------

      await rep.goto(leadUrl)
      const phaseFourTasks = ['Client Acceptance', 'Final Proposal Signature', 'Handover Note']
      for (const task of phaseFourTasks) {
        await completeTask(rep, task)
      }

      await mgr.goto(leadUrl)
      for (const task of phaseFourTasks) {
        await confirmTask(mgr, task)
      }

      await rep.reload()
      await requestSignoff(rep, 4)

      // Only an executive manager may decide a Phase 4 sign-off.
      await decideApproval(exec, { leadName, requestType: 'Phase 4 Signoff' })

      // --- every phase complete, project in maintenance -------------------

      await mgr.goto(leadUrl)
      for (const phase of [1, 2, 3, 4]) {
        await expect(phaseCard(mgr, phase).getByText('Complete', { exact: true })).toBeVisible()
      }

      // maintenance isn't surfaced in the UI, so this is checked at the API.
      const api = await apiAs(playwright, baseURL, 'sales-manager')
      try {
        const project = await fetchProject(api, leadId)
        expect(project.maintenance).toBe(true)
      } finally {
        await api.dispose()
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
    }
  })
})
