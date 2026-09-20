import { expect, test } from '@playwright/test'
import { apiAs, contextAs, unique } from './helpers.js'

// These tests change the template set, and every new project is built from
// whatever is active -- so they work on templates they create themselves
// and clean up after, rather than moving the seeded ones the phase
// lifecycle spec depends on.
async function withTemplate(playwright, baseURL, run) {
  const api = await apiAs(playwright, baseURL, 'sales-manager')
  const labels = []
  try {
    const make = async (data) => {
      labels.push(data.label)
      const response = await api.post('/api/requirement-templates/', { data })
      expect(response.ok(), await response.text()).toBeTruthy()
      return response.json()
    }
    await run(make)
  } finally {
    // Swept by label, not by the ids the test collected: dragging a
    // template into a phase *copies* it server-side, so a run that fails
    // between the copy and the assertion would otherwise leave the copy
    // behind -- and a stray active template lands on every project created
    // afterwards.
    const all = await (await api.get('/api/requirement-templates/')).json()
    for (const template of all) {
      if (labels.includes(template.label)) {
        await api.delete(`/api/requirement-templates/${template.id}/`)
      }
    }
    await api.dispose()
  }
}

// dnd-kit needs real pointer movement with a beat between steps -- see the
// board spec for the same helper and the same reasoning. The handle is
// scrolled into view first: a phase low down the page has a bounding box
// outside the viewport, and the mouse never reaches it.
const DRAG_STEPS = 10
const DRAG_STEP_MS = 40

async function dragOnto(page, handle, target) {
  // The target first: it is the one that can be halfway down a long page.
  // The panel the handles live in is sticky, so bringing the target into
  // view leaves the handle on screen rather than scrolling it away.
  await target.scrollIntoViewIfNeeded()
  await handle.scrollIntoViewIfNeeded()
  const from = await handle.boundingBox()
  const to = await target.boundingBox()

  // A box outside the viewport means the pointer would land somewhere else
  // entirely -- and a drop on the wrong phase silently creates a template
  // nobody asked for. Better to fail here, saying so.
  const viewport = page.viewportSize()
  for (const [name, box] of [['handle', from], ['target', to]]) {
    expect(box, `${name} has no box`).toBeTruthy()
    expect(box.y, `${name} is off-screen vertically`).toBeGreaterThanOrEqual(0)
    expect(box.y, `${name} is below the fold`).toBeLessThan(viewport.height)
  }
  const startX = from.x + from.width / 2
  const startY = from.y + from.height / 2
  const endX = to.x + to.width / 2
  const endY = to.y + to.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.waitForTimeout(DRAG_STEP_MS)
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    await page.mouse.move(
      startX + ((endX - startX) * step) / DRAG_STEPS,
      startY + ((endY - startY) * step) / DRAG_STEPS,
    )
    await page.waitForTimeout(DRAG_STEP_MS)
  }
  await page.mouse.up()
}

function phase(page, number) {
  return page.getByRole('region', { name: `Phase ${number} templates` })
}

test.describe('settings', () => {
  test('has four tabs and keeps the chosen one in the address', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/settings')

      for (const name of ['General', 'Requirement Templates', 'Appearance', 'Notifications']) {
        await expect(page.getByRole('tab', { name })).toBeVisible()
      }
      await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')

      await page.getByRole('tab', { name: 'Appearance' }).click()
      await expect(page).toHaveURL(/tab=appearance/)
      await expect(page.getByRole('heading', { name: 'Theme' })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('Save Changes wakes up only when General has an edit', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/settings')

      const save = page.getByRole('button', { name: 'Save Changes' })
      await expect(save).toBeDisabled()

      const field = page.getByLabel('Cold lead threshold')
      const original = await field.inputValue()
      await field.fill(String(Number(original) + 1))
      await expect(save).toBeEnabled()

      await save.click()
      await expect(page.getByText('Settings saved.')).toBeVisible()
      await expect(save).toBeDisabled()

      // Put it back so the rest of the suite sees what it expects.
      await field.fill(original)
      await save.click()
      await expect(save).toBeDisabled()
    } finally {
      await context.close()
    }
  })

  test('the notification toggle is a switch that persists', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/settings?tab=notifications')

      const toggle = page.getByRole('switch', { name: 'Check for mentions' })
      await expect(toggle).toBeChecked()
      await toggle.uncheck()

      await page.reload()
      await expect(page.getByRole('switch', { name: 'Check for mentions' })).not.toBeChecked()

      // Left as it was found.
      await page.getByRole('switch', { name: 'Check for mentions' }).check()
    } finally {
      await context.close()
    }
  })
})

test.describe('requirement templates', () => {
  test('no template appears twice', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/settings?tab=templates')
      await expect(phase(page, 1)).toBeVisible()

      // The reseed left inactive twins of live templates; they are gone.
      const labels = await page.locator('.template-phase .list-group-item').allInnerTexts()
      const names = labels.map((text) => text.split('\n')[0].trim()).filter(Boolean)
      expect(new Set(names).size).toBe(names.length)
    } finally {
      await context.close()
    }
  })

  test('dragging a task to the panel retires it, and back into a phase revives it', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    await withTemplate(playwright, baseURL, async (make) => {
      const label = unique('Retire Me')
      await make({ phase: 4, label, order: 99, confirmation_authority: 'REP', is_active: true })

      const context = await contextAs(browser, 'sales-manager')
      try {
        const page = await context.newPage()
        await page.goto('/settings?tab=templates')

        const panel = page.getByRole('complementary', { name: 'Template library' })
        await expect(phase(page, 4).getByText(label)).toBeVisible()

        // The exact name: the row also has "Move X up"/"Move X down".
        const grip = page.getByRole('button', { name: `Move ${label} to another phase or retire it` })
        await dragOnto(page, grip, panel)

        await expect(phase(page, 4).getByText(label)).toHaveCount(0)
        await expect(panel.getByText(label)).toBeVisible()

        // ...and back again.
        await dragOnto(
          page,
          panel.getByRole('button', { name: `Drag ${label} into a phase` }),
          phase(page, 4),
        )
        await expect(phase(page, 4).getByText(label)).toBeVisible()

        await page.reload()
        await expect(phase(page, 4).getByText(label)).toBeVisible()
      } finally {
        await context.close()
      }
    })
  })

  test('the library copies a template into another phase, form and all', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    await withTemplate(playwright, baseURL, async (make) => {
      const label = unique('Copy Me')
      await make({
        phase: 1,
        label,
        order: 99,
        confirmation_authority: 'REP',
        is_active: true,
        form_fields: [{ label: 'Who attended', field_type: 'TEXT', required: true, order: 0 }],
      })

      const context = await contextAs(browser, 'sales-manager')
      try {
        const page = await context.newPage()
        await page.goto('/settings?tab=templates')

        const panel = page.getByRole('complementary', { name: 'Template library' })
        await panel.getByRole('tab', { name: /Library/ }).click()

        await dragOnto(
          page,
          panel.getByRole('button', { name: `Drag ${label} into a phase` }).first(),
          phase(page, 3),
        )

        await expect(phase(page, 3).getByText(label)).toBeVisible()
        // The original stays where it was -- this copies, it doesn't move.
        await expect(phase(page, 1).getByText(label)).toBeVisible()

        await page.reload()
        const copy = phase(page, 3).getByText(label)
        await expect(copy).toBeVisible()

        // The copy carries the original's form.
        const api = await apiAs(playwright, baseURL, 'sales-manager')
        try {
          const all = await (await api.get('/api/requirement-templates/')).json()
          const made = all.find((template) => template.label === label && template.phase === 3)
          expect(made.form_fields).toHaveLength(1)
          expect(made.form_fields[0].label).toBe('Who attended')
        } finally {
          await api.dispose()
        }
      } finally {
        await context.close()
      }
    })
  })
})
