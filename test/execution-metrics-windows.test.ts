import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadBenchmarkManifest, recordBenchmarkObservation } from '../src/execution/metrics.js'

// Simulates a cross-volume rename the way Windows (`%TEMP%` on C:, repository on D:) and a Linux tmpfs `/tmp`
// both produce it: `rename` fails with EXDEV whenever source and destination live in different directories.
// An atomic write whose temporary file sits beside the destination never hits it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (dirname(String(from)) !== dirname(String(to))) throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${String(from)}' -> '${String(to)}'`), { code: 'EXDEV' })
      actual.renameSync(from, to)
    },
  }
})

const manifest = { type: 'agentskit-harness-benchmark-manifest', schemaVersion: 1, suiteId: 'suite', name: 'Fixture', tasks: [{ id: 'task', title: 'Task', acceptanceCriteria: ['criterion'] }], observations: [] }

it('records a baseline observation when the repository and the system temp directory sit on different volumes', () => {
  const manifestPath = join(mkdtempSync(join(tmpdir(), 'agentskit-harness-baseline-exdev-')), 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const recorded = recordBenchmarkObservation(manifestPath, { taskId: 'task', status: 'passed', source: 'manual-run-1', recordedAt: '2026-01-01T00:00:00.000Z' })
  expect(recorded.observations).toHaveLength(1)
  expect(loadBenchmarkManifest(manifestPath).observations[0]).toMatchObject({ taskId: 'task', source: 'manual-run-1' })
})
