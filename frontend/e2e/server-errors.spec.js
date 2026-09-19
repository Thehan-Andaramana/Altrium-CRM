import { expect, test } from '@playwright/test'
import { contextAs, topDialog, unique } from './helpers.js'

// The task modal's version of this is covered in forms-and-attachments; this
// checks a second, unrelated modal reaches the same behaviour through the
// shared errorMessage() helper, rather than the task modal being a one-off.
test.describe('server validation messages', () => {
  test('the template modal shows why the server rejected a form field', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/settings')
      await page.getByRole('tab', { name: 'Requirement Templates' }).click()

      // Any phase will do -- this is about the modal, not the phase.
      await page.getByRole('button', { name: '+ Add task' }).first().click()

      const dialog = topDialog(page)
      // The template's own Label field is the labelled one; the field row's
      // is the placeholder-only input the editor renders.
      await dialog.getByLabel('Label').fill(unique('E2E Template'))
      await dialog.getByRole('button', { name: '+ Add field' }).click()
      await dialog.getByPlaceholder('Label').fill('Risk level')
      // A SELECT with no options is what the server rejects.
      await dialog.getByRole('combobox').selectOption('SELECT')
      await dialog.getByRole('button', { name: 'Create' }).click()

      await expect(dialog.getByRole('alert')).toContainText('SELECT fields need at least one option.')
    } finally {
      await context.close()
    }
  })
})
