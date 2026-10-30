import { expect, it } from 'vitest'
import type { CommandRunner } from '../src/adapters/command.js'
import { conflictingFiles, failedCheckLogs, renderFleetFixBrief } from '../src/loop/fleet-fix.js'

const runner = (answer: (argv: readonly string[]) => { code: number; stdout: string }): CommandRunner => ({ run: async (argv: readonly string[]) => ({ stderr: '', ...answer(argv) }) }) as unknown as CommandRunner

it('lists the files git merge-tree reports as conflicting, deduplicated', async () => {
  const r = runner((argv) => argv.includes('merge-tree') ? { code: 1, stdout: 'treeid\na.ts\nb.ts\na.ts\n\ninfo' } : { code: 0, stdout: '' })
  expect(await conflictingFiles({ runner: r, root: '/r', base: 'main', head: 'h' })).toEqual(['a.ts', 'b.ts'])
})

it('returns null when merge-tree could not be asked', async () => {
  expect(await conflictingFiles({ runner: runner(() => ({ code: 128, stdout: '' })), root: '/r', base: 'main', head: 'h' })).toBeNull()
})

it('tails failing check logs and says so when no log is reachable', async () => {
  const r = runner(() => ({ code: 0, stdout: 'boom' }))
  const text = await failedCheckLogs({ runner: r, root: '/r', repo: 'o/r', checks: [{ name: 'ci', url: 'https://x/actions/runs/42/job/1' }, { name: 'lint' }] })
  expect(text).toContain('### ci\n```\nboom\n```')
  expect(text).toContain('### lint\n(no run log reachable)')
})

it('renders a brief that the fleet PM recognises, with or without a frozen contract', () => {
  const base = { config: { project: { repo: 'o/r' }, delivery: { verifyCommand: 'pnpm test' } } as never, issue: 'X-1', prNumber: 7, prUrl: 'u', headRef: 'h', baseRef: 'main', reason: 'why' }
  const brief = renderFleetFixBrief({ ...base, contract: null, kind: 'conflict' })
  expect(brief.startsWith('# Loop worker — o/r')).toBe(true)
  expect(brief).toContain('git merge origin/main')
  expect(brief).toContain('the frozen contract is not on file')
  expect(renderFleetFixBrief({ ...base, contract: null, kind: 'ci' })).toContain('failing check')
})
