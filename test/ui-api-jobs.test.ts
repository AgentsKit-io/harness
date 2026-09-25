import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUiJobManager, UiJobConflictError } from '../src/ui/api/jobs.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const stateDirFor = (): string => { const root = mkdtempSync(join(tmpdir(), 'harness-ui-jobs-')); roots.push(root); return root }
const waitFor = async (read: () => { readonly status: string } | null): Promise<{ readonly status: string }> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read()
    if (value && !['running', 'cancel-pending'].includes(value.status)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle')
}

describe('the generic UI job queue', () => {
  it('runs a closure to completion and records its output tail', async () => {
    const manager = createUiJobManager({ stateDir: stateDirFor() })
    const job = manager.submit({ kind: 'contract:ENG-1', issue: 'ENG-1', actor: 'alice', reason: 'wizard', run: async ({ emit }) => { emit({ phase: 'generating', detail: 'calling provider', output: 'line one' }); return { status: 'valid' } } })
    const settled = await waitFor(() => manager.get(job.id))
    expect(settled.status).toBe('succeeded')
    expect(manager.get(job.id)?.outputTail).toContain('line one')
    manager.close()
  })

  it('maps a needs-input/blocked result to that status instead of succeeded', async () => {
    const manager = createUiJobManager({ stateDir: stateDirFor() })
    const job = manager.submit({ kind: 'contract:ENG-2', issue: 'ENG-2', actor: 'alice', reason: 'wizard', run: async () => ({ status: 'needs-input' }) })
    expect((await waitFor(() => manager.get(job.id))).status).toBe('needs-input')
    manager.close()
  })

  it('rejects a second submit for the same issue while one is active, and allows it once the first settles', async () => {
    const manager = createUiJobManager({ stateDir: stateDirFor() })
    let release: (() => void) | null = null
    const job = manager.submit({ kind: 'contract:ENG-3', issue: 'ENG-3', actor: 'alice', reason: 'wizard', run: () => new Promise((resolve) => { release = () => resolve({ status: 'valid' }) }) })
    expect(() => manager.submit({ kind: 'contract:ENG-3', issue: 'ENG-3', actor: 'alice', reason: 'wizard again', run: async () => ({ status: 'valid' }) })).toThrow(UiJobConflictError)
    release?.()
    await waitFor(() => manager.get(job.id))
    expect(() => manager.submit({ kind: 'contract:ENG-3', issue: 'ENG-3', actor: 'alice', reason: 'wizard again', run: async () => ({ status: 'valid' }) })).not.toThrow()
    manager.close()
  })

  it('a job left running when the manager closes reopens as interrupted, not stuck running forever', async () => {
    const stateDir = stateDirFor()
    const first = createUiJobManager({ stateDir })
    first.submit({ kind: 'contract:ENG-4', issue: 'ENG-4', actor: 'alice', reason: 'wizard', run: () => new Promise(() => { /* never resolves — simulates a crash */ }) })
    first.close()
    const second = createUiJobManager({ stateDir })
    expect(second.list().map((job) => job.status)).toEqual(['interrupted'])
    second.close()
  })

  it('cancelling stops a future settle from overriding the cancelled status', async () => {
    const manager = createUiJobManager({ stateDir: stateDirFor() })
    let release: (() => void) | null = null
    const job = manager.submit({ kind: 'contract:ENG-5', issue: 'ENG-5', actor: 'alice', reason: 'wizard', run: () => new Promise((resolve) => { release = () => resolve({ status: 'valid' }) }) })
    manager.cancel(job.id)
    expect(manager.get(job.id)?.status).toBe('cancel-pending')
    release?.()
    expect((await waitFor(() => manager.get(job.id))).status).toBe('cancelled')
    manager.close()
  })
})
