import { expect, test } from '@playwright/test'

// Signs in for real, so each test starts from a clean context rather than
// one of the saved sessions.
test.use({ storageState: { cookies: [], origins: [] } })

const DEMO_PASSWORD = 'testpass123'

async function signIn(page, { remember } = {}) {
  await page.goto('/login')
  // The same labels the auth setup resolves -- a floating label is still a
  // <label for>, so the redesign didn't move them.
  await page.getByLabel('Username').fill('mgr1')
  await page.getByLabel('Password').fill(DEMO_PASSWORD)
  if (remember === false) {
    await page.getByLabel('Remember me').uncheck()
  }
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

function sessionCookie(cookies) {
  return cookies.find((cookie) => cookie.name === 'sessionid')
}

test.describe('login', () => {
  test('signs in through the labelled fields', async ({ page }) => {
    await signIn(page)
    await expect(page).toHaveURL(/\/$/)
  })

  test('shows both halves of the split and the brand', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in to Altrium' })).toBeVisible()
    await expect(page.getByText('Altrium CRM')).toBeVisible()
  })

  test('the floating label stays the field label once it is filled', async ({ page }) => {
    await page.goto('/login')
    const username = page.getByLabel('Username')
    await username.fill('mgr1')
    // Still resolvable by its label after filling -- the label floats, it
    // doesn't get replaced by a placeholder.
    await expect(username).toHaveValue('mgr1')
    await expect(page.getByLabel('Username')).toBeVisible()
  })

  test('remember me is on by default and keeps the session past the browser', async ({ page, context }) => {
    await page.goto('/login')
    await expect(page.getByLabel('Remember me')).toBeChecked()

    await signIn(page)
    const cookie = sessionCookie(await context.cookies())
    expect(cookie, 'a session cookie should have been set').toBeTruthy()
    // A persistent cookie carries a real expiry; -1 means "until the
    // browser closes".
    expect(cookie.expires).toBeGreaterThan(0)
  })

  test('unchecking remember me makes it a browser-session cookie', async ({ page, context }) => {
    await signIn(page, { remember: false })
    const cookie = sessionCookie(await context.cookies())
    expect(cookie, 'a session cookie should have been set').toBeTruthy()
    expect(cookie.expires).toBe(-1)
  })

  test('a bad password is rejected in place', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Username').fill('mgr1')
    await page.getByLabel('Password').fill('not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('alert')).toContainText('Invalid username or password.')
    await expect(page).toHaveURL(/\/login$/)
  })
})
