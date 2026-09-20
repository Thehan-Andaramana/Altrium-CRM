import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'backend')

/**
 * The backend venv's own interpreter, so this works whether or not the venv
 * happens to be activated in whatever shell started Playwright -- global
 * setup and the webServer commands both run through this rather than a bare
 * `python`, which could silently resolve to a different interpreter (or
 * none) depending on the caller's PATH.
 */
export function pythonPath() {
  const candidates = [
    path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe'),
    path.join(BACKEND_DIR, '.venv', 'bin', 'python'),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(
      `No virtualenv interpreter found under ${path.join(BACKEND_DIR, '.venv')} -- ` +
        'run setup.ps1 / setup.sh (or create the venv by hand) first.',
    )
  }
  return found
}
