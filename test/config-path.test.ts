import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH, resolveConfigPath } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const project = (files: readonly string[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-config-path-')); cleanups.push(root)
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '{}')
  }
  return root
}

describe('where the contract lives', () => {
  it('is the harness own folder, not one provider name', () => {
    expect(DEFAULT_CONFIG_PATH).toBe('.ak-harness/verification.json')
    expect(LEGACY_CONFIG_PATH).toBe('.codex/verification.json')
  })

  it('prefers the new folder, falls back to the legacy one, and leaves an explicit path alone', () => {
    expect(resolveConfigPath(undefined, project([DEFAULT_CONFIG_PATH]))).toBe(DEFAULT_CONFIG_PATH)

    // A repository written before the harness had a folder of its own keeps working untouched.
    expect(resolveConfigPath(undefined, project([LEGACY_CONFIG_PATH]))).toBe(LEGACY_CONFIG_PATH)

    // With both, the new one wins: the legacy path is a fallback, not an alias.
    expect(resolveConfigPath(undefined, project([DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH]))).toBe(DEFAULT_CONFIG_PATH)

    // With neither, the answer is the new default — the error a caller then gets names the file to create.
    expect(resolveConfigPath(undefined, project([]))).toBe(DEFAULT_CONFIG_PATH)

    // `-c` always wins, wherever it points.
    expect(resolveConfigPath('somewhere/else.json', project([DEFAULT_CONFIG_PATH]))).toBe('somewhere/else.json')
  })
})
