import { expect, test } from '@playwright/test'
import { apiAs, contextAs, openTask, seedLead, topDialog, TASK_FORM_ANSWERS } from './helpers.js'

// Phase 1, so the assigned rep is the one who may complete it, and it is one
// of the seeded templates carrying a form with required fields.
const TASK = 'Requirement Discussion'
const ANSWERS = TASK_FORM_ANSWERS[TASK]

async function seed(playwright, baseURL) {
  const api = await apiAs(playwright, baseURL, 'sales-manager')
  try {
    return await seedLead(api, { rep: 'rep1' })
  } finally {
    await api.dispose()
  }
}

async function asRep(browser, run) {
  const context = await contextAs(browser, 'rep')
  try {
    await run(await context.newPage())
  } finally {
    await context.close()
  }
}

async function fillForm(page) {
  await topDialog(page).getByRole('button', { name: 'Fill form' }).click()
  const form = topDialog(page)
  for (const [label, value] of Object.entries(ANSWERS)) {
    await form.getByLabel(label).fill(value)
  }
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
}

test.describe('task forms', () => {
  test('completing a task with required fields blank is rejected', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRep(browser, async (page) => {
      // The row advertises the outstanding form before anything is opened.
      await page.goto(leadUrl)
      await expect(page.getByRole('button', { name: TASK }).getByText('Form')).toBeVisible()

      await openTask(page, TASK)
      const dialog = topDialog(page)
      await dialog.getByLabel('Status').selectOption('COMPLETED')
      await dialog.getByRole('button', { name: 'Save' }).click()

      // The server refuses while required answers are missing, so the modal
      // stays open and the task is left alone.
      await expect(dialog.getByText('Failed to save the task.')).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()

      await page.reload()
      await expect(page.getByRole('button', { name: TASK }).getByText('Form')).toBeVisible()
    })
  })

  test('answers filled in the form modal persist', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRep(browser, async (page) => {
      await page.goto(leadUrl)
      await openTask(page, TASK)
      await fillForm(page)

      // Saved answers survive closing the task and coming back to it.
      await topDialog(page).getByRole('button', { name: 'Cancel' }).click()
      await page.reload()
      await expect(page.getByRole('button', { name: TASK }).getByText('Form')).toHaveCount(0)

      await openTask(page, TASK)
      await topDialog(page).getByRole('button', { name: 'Fill form' }).click()
      const form = topDialog(page)
      for (const [label, value] of Object.entries(ANSWERS)) {
        await expect(form.getByLabel(label)).toHaveValue(value)
      }
    })
  })

  test('a completed form lets the task be completed', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRep(browser, async (page) => {
      await page.goto(leadUrl)
      await openTask(page, TASK)
      await fillForm(page)

      const dialog = topDialog(page)
      await dialog.getByLabel('Status').selectOption('COMPLETED')
      await dialog.getByRole('button', { name: 'Save' }).click()

      await expect(page.getByRole('dialog')).toHaveCount(0)
      await openTask(page, TASK)
      await expect(topDialog(page).getByText('Completed')).toBeVisible()
    })
  })
})

test.describe('task attachments', () => {
  const FILE = { name: 'brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e test fixture') }

  test('an uploaded file is listed on the task', async ({ browser, baseURL, playwright }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRep(browser, async (page) => {
      await page.goto(leadUrl)
      await openTask(page, TASK)

      const dialog = topDialog(page)
      await expect(dialog.getByText('No attachments yet.')).toBeVisible()

      await dialog.getByRole('button', { name: '+ File' }).click()
      await dialog.getByLabel('Attachment file').setInputFiles(FILE)
      await dialog.getByRole('button', { name: 'Upload' }).click()

      await expect(dialog.getByRole('button', { name: FILE.name })).toBeVisible()
    })
  })

  test('previewing an attachment opens in place, without leaving the lead', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    const { leadUrl } = await seed(playwright, baseURL)

    await asRep(browser, async (page) => {
      await page.goto(leadUrl)
      const urlBefore = page.url()

      await openTask(page, TASK)
      const dialog = topDialog(page)
      await dialog.getByRole('button', { name: '+ File' }).click()
      await dialog.getByLabel('Attachment file').setInputFiles(FILE)
      await dialog.getByRole('button', { name: 'Upload' }).click()
      await expect(dialog.getByRole('button', { name: FILE.name })).toBeVisible()

      await dialog.getByRole('button', { name: FILE.name }).click()

      // The preview is a modal over the task, not a navigation away from it.
      await expect(topDialog(page).getByRole('heading', { name: FILE.name })).toBeVisible()
      await expect(page).toHaveURL(urlBefore)
    })
  })
})
