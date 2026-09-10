import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findDependencyViolations } from '../scripts/verify-dependency-directions.mjs'

it('keeps the current source within the declared dependency directions', () => {
  expect(findDependencyViolations(join(process.cwd(), 'src'))).toEqual([])
})

it('reports a kernel import of an adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-boundary-'))
  try {
    mkdirSync(join(root, 'kernel'), { recursive: true })
    mkdirSync(join(root, 'adapters'), { recursive: true })
    writeFileSync(join(root, 'kernel', 'bad.ts'), "import { adapter } from '../adapters/provider.js'\nexport { adapter }\n")
    writeFileSync(join(root, 'adapters', 'provider.ts'), 'export const adapter = true\n')
    expect(findDependencyViolations(root)).toEqual([{ source: 'kernel/bad.ts', target: 'adapters/provider.ts', typeOnly: false }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
