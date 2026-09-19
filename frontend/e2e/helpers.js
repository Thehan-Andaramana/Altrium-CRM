import { expect } from '@playwright/test'
import fs from 'node:fs'
import { authFile } from './auth-file.js'

// --- identity -------------------------------------------------------------

// A fresh browser context per role, so a single test can act as several
// people (the phase lifecycle runs through four) without logging in again.
export function contextAs(browser, role) {
  return browser.newContext({ storageState: authFile(role) })
}

// Django rejects unsafe methods without the CSRF header. The token is in the
// cookie jar the saved session brought with it, so read it straight off the
// stored state and set it for every request this context makes.
function csrfToken(role) {
  const state = JSON.parse(fs.readFileSync(authFile(role), 'utf8'))
  return state.cookies.find((cookie) => cookie.name === 'csrftoken')?.value ?? ''
}

// An API context acting as `role` -- used to set a test's starting data up
// directly, so specs that are about something else don't spend half their
// run clicking through record creation first.
export function apiAs(playwright, baseURL, role) {
  return playwright.request.newContext({
    baseURL,
    storageState: authFile(role),
    extraHTTPHeaders: { 'X-CSRFToken': csrfToken(role) },
  })
}

async function body(response) {
  expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBeTruthy()
  return response.json()
}

// --- data -----------------------------------------------------------------

// Unique per call, so a re-run (or the configured retry) never trips over
// records an earlier attempt left behind.
export function unique(prefix) {
  return `${prefix} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// Seeds an isolated company + lead (and optionally assigns the PM) through
// the API as a manager. The phase-lifecycle spec deliberately does this
// through the UI instead -- creating records *is* what it's testing.
export async function seedLead(api, { rep = 'rep1', pm = null } = {}) {
  const users = await body(await api.get('/api/users/'))
  const idFor = (username) => {
    const match = users.find((user) => user.username === username)
    expect(match, `seeded demo user "${username}" is missing -- run seed_demo`).toBeTruthy()
    return match.id
  }

  const company = await body(
    await api.post('/api/companies/', { data: { name: unique('E2E Co'), owner: idFor(rep) } }),
  )
  const lead = await body(
    await api.post('/api/leads/', {
      data: { name: unique('E2E Lead'), company: company.id, assigned_to: idFor(rep) },
    }),
  )
  const [project] = await body(await api.get(`/api/projects/?lead=${lead.id}`))
  if (pm) {
    await body(await api.patch(`/api/projects/${project.id}/`, { data: { project_manager: idFor(pm) } }))
  }

  return { company, lead, project, leadUrl: `/leads/${lead.id}` }
}

export async function fetchProject(api, leadId) {
  const [project] = await body(await api.get(`/api/projects/?lead=${leadId}`))
  return project
}

// --- tasks ----------------------------------------------------------------

// Answers for the seeded template forms (migration 0022), keyed by task.
// Only the required fields -- the optional ones are left blank on purpose,
// since a task must complete without them.
export const TASK_FORM_ANSWERS = {
  'Requirement Discussion': {
    'Meeting date': '2026-03-02',
    Attendees: 'Client sponsor, technical lead',
    'Key requirements captured': 'SSO integration and quarterly reporting.',
  },
  'Budget Proposal': {
    'Proposed budget': '18500',
    Currency: 'USD',
  },
  'Technical Analysis': {
    'Estimated effort in days': '20',
    'Technology stack': 'Django REST + React',
    'Risk level': 'Low',
  },
  'Feasibility Study': {
    'Technically feasible': 'Yes',
    Recommendation: 'Proceed as scoped.',
  },
  'Client Acceptance': {
    'Accepted by': 'Jane Doe',
    'Acceptance date': '2026-04-01',
  },
}

// The task form mixes text, date and select inputs -- fill whichever this
// field turns out to be rather than making every caller say which it is.
async function setField(scope, label, value) {
  const field = scope.getByLabel(label)
  const tagName = await field.evaluate((element) => element.tagName.toLowerCase())
  if (tagName === 'select') {
    await field.selectOption({ label: value })
  } else {
    await field.fill(value)
  }
}

export function openTask(page, taskLabel) {
  return page.getByRole('button', { name: taskLabel }).click()
}

// The topmost modal: the full-screen task form opens over the task detail
// modal, and both are dialogs.
export function topDialog(page) {
  return page.getByRole('dialog').last()
}

export async function fillTaskForm(page, answers) {
  await topDialog(page).getByRole('button', { name: 'Fill form' }).click()
  const form = topDialog(page)
  for (const [label, value] of Object.entries(answers)) {
    await setField(form, label, value)
  }
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
}

// Opens the task, answers its form if the template has one, marks it
// Completed and saves. Leaves no dialog open -- a save that the server
// rejects keeps the modal up, which fails the assertion here rather than
// somewhere confusing later.
export async function completeTask(page, taskLabel) {
  await openTask(page, taskLabel)
  const answers = TASK_FORM_ANSWERS[taskLabel]
  if (answers) {
    await fillTaskForm(page, answers)
  }
  const task = topDialog(page)
  await task.getByLabel('Status').selectOption('COMPLETED')
  await task.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

// A MANAGER/PROJECT_MANAGER-authority task needs a second, separate action
// after completion before it counts towards phase progress.
export async function confirmTask(page, taskLabel) {
  await openTask(page, taskLabel)
  await topDialog(page).getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

export function phaseCard(page, phaseNumber) {
  return page.getByRole('region', { name: `Phase ${phaseNumber}` })
}

export async function requestSignoff(page, phaseNumber) {
  await phaseCard(page, phaseNumber).getByRole('button', { name: 'Request sign-off' }).click()
  await expect(phaseCard(page, phaseNumber).getByRole('button', { name: 'Sign-off requested' })).toBeVisible()
}

// --- approvals ------------------------------------------------------------

export function approvalRow(page, { leadName, requestType }) {
  return page
    .getByRole('row')
    .filter({ hasText: leadName })
    .filter({ hasText: requestType })
}

export async function decideApproval(page, { leadName, requestType, decision = 'Approve' }) {
  await page.goto('/approvals')
  await approvalRow(page, { leadName, requestType }).getByRole('button', { name: decision }).click()
  const dialog = topDialog(page)
  if (decision === 'Reject') {
    await dialog.getByLabel('Decision note').fill('Needs rework.')
  }
  await dialog.getByRole('button', { name: decision, exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
