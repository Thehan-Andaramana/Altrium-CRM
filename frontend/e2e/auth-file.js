import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The storage-state file path for a given role -- auth.setup.js writes
// these, specs read them via `test.use({ storageState: authFile('rep') })`.
// Kept in its own plain module (no `test`/`setup` calls) because Playwright
// refuses to let one test file import another.
export function authFile(role) {
  return path.join(__dirname, '.auth', `${role}.json`)
}
