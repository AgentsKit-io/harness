import { describe, expect, it } from 'vitest'
import { collectMvpEvidence, ghApiGet, type GitHubGet } from '../src/adapters/github-mvp-evidence.js'
import { evaluateMvp, evidenceFromJson, loadMvp } from '../src/mvp.js'
import type { CommandRunner } from '../src/adapters/command.js'

const b64 = (s: string): unknown => ({ encoding: 'base64', content: Buffer.from(s).toString('base64') })
const workflow = (coe: string): string => `jobs:\n  ci:\n    steps:\n      - name: Test\n        run: x${coe}\n`
const manifest = `version: 1
repo: acme/widgets
requirements:
- id: RF-01
  title: A
  done_when: x
  prs: [1]
  acceptance:
  - test: docs/a.md
    ci:
      job: ci
      step: Test
  - run: runs/last.json
    max_age_days: 7
  homolog:
  - url: https://app.invalid/
    contains: hello
`

// Recorded responses, keyed by REST path; anything else is a 404.
const recorded = (coe: string, over: Record<string, unknown> = {}): GitHubGet => {
  const table: Record<string, unknown> = {
    'repos/acme/widgets': { default_branch: 'main' },
    'repos/acme/widgets/pulls/1': { merged: true, state: 'closed', merge_commit_sha: 'abcdef1234' },
    'repos/acme/widgets/commits/abcdef1234/check-runs?per_page=100': { check_runs: [{ name: 'ci', conclusion: 'success' }] },
    'repos/acme/widgets/commits/abcdef1234/status': { state: 'pending', statuses: [] },
    'repos/acme/widgets/actions/runs?branch=main&per_page=50': { workflow_runs: [{ id: 9, workflow_id: 1, name: 'CI', run_number: 5, status: 'completed', path: '.github/workflows/ci.yml', head_sha: 'f00' }] },
    'repos/acme/widgets/actions/runs/9/jobs?per_page=100&filter=latest': { jobs: [{ name: 'ci', conclusion: 'success', steps: [{ name: 'Test', conclusion: 'success' }] }] },
    'repos/acme/widgets/contents/.github/workflows/ci.yml?ref=f00': b64(workflow(coe)),
    'repos/acme/widgets/contents/docs/a.md?ref=main': b64('# a'),
    'repos/acme/widgets/contents/runs/last.json?ref=main': b64(JSON.stringify({ finished_at: '2026-10-30T00:00:00Z', ok: true })),
    ...over,
  }
  return async (path) => table[path] ?? null
}
const deps = (get: GitHubGet, probe = { status: 200, body: 'say hello' }) => ({ get, probe: async () => probe, now: new Date('2026-11-01T00:00:00Z') })

describe('collectMvpEvidence', () => {
  it('collects green evidence for every kind and feeds mvp report', async () => {
    const doc = loadMvp(manifest)
    const table = await collectMvpEvidence(doc, deps(recorded('')))
    expect(table.prs['1']?.ok).toBe(true)
    expect(table.ci['ci/Test']?.ok).toBe(true)
    expect(table.files['docs/a.md']?.ok).toBe(true)
    expect(table.urls['https://app.invalid/']?.ok).toBe(true)
    expect(table.runs['runs/last.json']?.ok).toBe(true)
    expect(() => evaluateMvp(doc, evidenceFromJson(table), [])).not.toThrow()
  })

  it('a step with continue-on-error does not count', async () => {
    const table = await collectMvpEvidence(loadMvp(manifest), deps(recorded('\n        continue-on-error: true')))
    expect(table.ci['ci/Test']).toMatchObject({ ok: false })
    expect(table.ci['ci/Test']?.detail).toMatch(/continue-on-error/)
  })

  it('red merge-commit CI, unmerged PR, missing file, wrong URL text and stale run are not green', async () => {
    const get = recorded('', {
      'repos/acme/widgets/commits/abcdef1234/check-runs?per_page=100': { check_runs: [{ name: 'ci', conclusion: 'failure' }] },
      'repos/acme/widgets/contents/docs/a.md?ref=main': null,
      'repos/acme/widgets/contents/runs/last.json?ref=main': b64(JSON.stringify({ finished_at: '2026-10-01T00:00:00Z' })),
    })
    const table = await collectMvpEvidence(loadMvp(manifest), deps(get, { status: 200, body: 'nope' }))
    expect(table.prs['1']?.ok).toBe(false)
    expect(table.files['docs/a.md']?.ok).toBe(false)
    expect(table.urls['https://app.invalid/']?.ok).toBe(false)
    expect(table.runs['runs/last.json']?.ok).toBe(false)
    const open = await collectMvpEvidence(loadMvp(manifest), deps(recorded('', { 'repos/acme/widgets/pulls/1': { merged: false, state: 'open' } })))
    expect(open.prs['1']?.ok).toBeNull()
  })

  it('a job that is still running is sem evidência; a lookup failure is never green', async () => {
    const running = recorded('', { 'repos/acme/widgets/actions/runs?branch=main&per_page=50': { workflow_runs: [{ id: 9, workflow_id: 1, status: 'in_progress' }] } })
    expect((await collectMvpEvidence(loadMvp(manifest), deps(running))).ci['ci/Test']?.ok).toBeNull()
    const broken: GitHubGet = async (p) => { if (p.includes('/pulls/')) throw new Error('boom'); return recorded('')(p) }
    expect((await collectMvpEvidence(loadMvp(manifest), deps(broken))).prs['1']?.ok).toBeNull()
  })

  it('needs repo in the manifest', async () => {
    await expect(collectMvpEvidence(loadMvp(manifest.replace('repo: acme/widgets\n', '')), deps(recorded('')))).rejects.toThrow(/repo/)
  })
})

describe('ghApiGet', () => {
  const runner = (code: number, stdout: string, stderr = ''): CommandRunner => ({ run: async () => ({ code, stdout, stderr, timedOut: false, durationMs: 1 }) })
  it('parses JSON, maps 404 to null, throws otherwise', async () => {
    expect(await ghApiGet(runner(0, '{"a":1}'))('x')).toEqual({ a: 1 })
    expect(await ghApiGet(runner(1, '', 'gh: Not Found (HTTP 404)'))('x')).toBeNull()
    await expect(ghApiGet(runner(1, '', 'HTTP 500'))('x')).rejects.toThrow(/exited 1/)
  })
})
