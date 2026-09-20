import { expect, test } from '@playwright/test'
import { apiAs, contextAs, seedLead } from './helpers.js'

// dnd-kit's PointerSensor only starts a drag after a few pixels of real
// movement, and it settles collisions on an animation frame -- so each drag
// is walked across in steps with a beat between them, rather than jumping
// from A to B in one move that registers as no movement at all.
const DRAG_STEPS = 10
const DRAG_STEP_MS = 40

async function dragCardOnto(page, sourceHandle, target) {
  const from = await sourceHandle.boundingBox()
  const to = await target.boundingBox()
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

function column(page, name) {
  return page.getByRole('region', { name })
}

function card(page, leadName) {
  return page.getByRole('button', { name: leadName, exact: true })
}

test.describe('board', () => {
  test('a lead appears as a card in its phase column', async ({ browser, baseURL, playwright }) => {
    const api = await apiAs(playwright, baseURL, 'sales-manager')
    let lead
    try {
      ;({ lead } = await seedLead(api, { rep: 'rep1', pm: 'pm1' }))
    } finally {
      await api.dispose()
    }

    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/board')

      // A new lead's project starts in Phase 1, and nothing but an approved
      // sign-off can put it anywhere else.
      await expect(column(page, 'Phase 1 Requirements').getByText(lead.name)).toBeVisible()
      await expect(column(page, 'Phase 2 Analysis').getByText(lead.name)).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('dragging a card to another column is refused, with an explanation', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    const api = await apiAs(playwright, baseURL, 'sales-manager')
    let lead
    try {
      ;({ lead } = await seedLead(api, { rep: 'rep1', pm: 'pm1' }))
    } finally {
      await api.dispose()
    }

    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/board')
      await expect(card(page, lead.name)).toBeVisible()

      const handle = page.getByRole('button', { name: `Reorder ${lead.name}` })
      // The next column's header is the drop target -- there is no card in
      // it to aim at, which is the point: the phase is empty because no
      // sign-off has moved anything there.
      await dragCardOnto(page, handle, column(page, 'Phase 2 Analysis'))

      await expect(page.getByRole('status', { name: 'Board notice' })).toContainText('Phases advance through approval')
      // ...and the card has not moved.
      await expect(column(page, 'Phase 1 Requirements').getByText(lead.name)).toBeVisible()

      await page.reload()
      await expect(column(page, 'Phase 1 Requirements').getByText(lead.name)).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('the + on a later column explains that phases advance through approval', async ({ browser }) => {
    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/board')

      await page.getByRole('button', { name: 'Add to Phase 3 Execution' }).click()
      await expect(page.getByRole('status', { name: 'Board notice' })).toContainText('Phases advance through approval')
      await expect(page).toHaveURL(/\/board$/)
    } finally {
      await context.close()
    }
  })

  test('reordering within a column survives a reload', async ({ browser, baseURL, playwright }) => {
    const api = await apiAs(playwright, baseURL, 'sales-manager')
    let first
    let second
    try {
      first = (await seedLead(api, { rep: 'rep1', pm: 'pm1' })).lead
      second = (await seedLead(api, { rep: 'rep1', pm: 'pm1' })).lead
    } finally {
      await api.dispose()
    }

    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/board')

      const phaseOne = column(page, 'Phase 1 Requirements')
      // Newest first, so the second seed sits above the first.
      const titles = phaseOne.getByRole('button', { name: /^E2E Lead / })
      await expect(titles.first()).toHaveText(second.name)

      await dragCardOnto(
        page,
        page.getByRole('button', { name: `Reorder ${second.name}` }),
        card(page, first.name),
      )

      await expect(titles.first()).toHaveText(first.name)

      // Written through to board_order, not just moved on screen.
      await page.reload()
      await expect(phaseOne.getByRole('button', { name: /^E2E Lead / }).first()).toHaveText(first.name)
    } finally {
      await context.close()
    }
  })

  test('filters narrow the board without changing what the server returned', async ({
    browser,
    baseURL,
    playwright,
  }) => {
    const api = await apiAs(playwright, baseURL, 'sales-manager')
    let lead
    try {
      ;({ lead } = await seedLead(api, { rep: 'rep1', pm: 'pm1' }))
    } finally {
      await api.dispose()
    }

    const context = await contextAs(browser, 'sales-manager')
    try {
      const page = await context.newPage()
      await page.goto('/board')
      await expect(card(page, lead.name)).toBeVisible()

      // The seeded lead is COLD, so filtering to hot hides it.
      await page.getByLabel('Filter by status').selectOption('HOT')
      await expect(card(page, lead.name)).toHaveCount(0)

      await page.getByLabel('Filter by status').selectOption('')
      await expect(card(page, lead.name)).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
