import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'playwright-report', 'test-results']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Tooling and e2e specs run in Node, not the browser -- without this
    // they're linted against browser globals only, so `process` (vite
    // config) and `Buffer` (an upload fixture) read as undefined.
    files: ['e2e/**/*.js', '*.config.js'],
    languageOptions: { globals: globals.node },
  },
])
