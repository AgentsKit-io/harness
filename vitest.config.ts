import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // `@/…` is the UI app's own alias (see src/ui/app/vite.config.ts), so its components can be rendered in tests;
    // a bare `@` keeps pointing at the repo root.
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL('./src/ui/app/src/', import.meta.url)) },
      { find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) },
    ],
  },
  test: {
    // `apps/**` is the documentation site: its own package, its own dependencies, and Next ships test files
    // of its own inside them. The harness suite has no business running those.
    // `apps/**` is the documentation site (its own package; Next ships test files inside its dependencies) and
    // `scripts/*.test.mjs` are `node --test` contract checks with their own npm scripts.
    exclude: ['tests/e2e/**', 'packages/playbook/test/**', 'node_modules/**', '**/node_modules/**', 'apps/**', 'scripts/**', '.next/**'],
  },
})
