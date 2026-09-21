import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    // `apps/**` is the documentation site: its own package, its own dependencies, and Next ships test files
    // of its own inside them. The harness suite has no business running those.
    // `apps/**` is the documentation site (its own package; Next ships test files inside its dependencies) and
    // `scripts/*.test.mjs` are `node --test` contract checks with their own npm scripts.
    exclude: ['tests/e2e/**', 'packages/playbook/test/**', 'node_modules/**', '**/node_modules/**', 'apps/**', 'scripts/**', '.next/**'],
  },
})
