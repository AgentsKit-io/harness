import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLoopConfigText } from '../src/index.js'
import type { LoadedLoopConfig, LoopConfig, TaskContract } from '../src/index.js'
import type { RunnerConnector } from '../src/loop/runner-connector.js'
import { generateVerifierCommands, judgeVerdict, parseVerdict, renderVerifierBrief, verifierItems, verifyIndependently, type VerifierItem } from '../src/loop/verifier.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-verifier-')); cleanups.push(dir); return dir }

const HEAD = 'a'.repeat(40)
const contract = { intent: 'x', scope: { inScope: ['a'], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'subtract works', check: { kind: 'test', command: 'node -e 0' } }], ambiguities: [], touchpoints: [], risks: [] } as unknown as TaskContract
const config = (extra = ''): LoopConfig => parseLoopConfigText(`${exampleYaml}\nverifier:\n  enabled: true\n  commands:\n    - [node, -e, "0"]\n${extra}`)
const items: readonly VerifierItem[] = [{ id: 'cmd-1', what: 'run node' }, { id: 'o1', what: 'subtract works' }]
const verdictLine = (nonce: string, over: Record<string, unknown> = {}): string => `LOOP-VERDICT: ${JSON.stringify({ verdict: 'proven', head: HEAD, nonce, items: [{ id: 'cmd-1', status: 'passed', evidence: 'exit 0' }, { id: 'o1', status: 'passed', evidence: '3 tests ok' }], ...over })}`

describe('generated starting verifier', () => {
  it('reads the stack: only package scripts that exist, by the lockfile in use', () => {
    const root = tmp()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', dev: 'vite' } }))
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    expect(generateVerifierCommands(root)).toEqual([['pnpm', 'run', 'lint'], ['pnpm', 'run', 'test']])
  })

  it('knows pytest, cargo and go, and produces nothing for an unknown stack', () => {
    const root = tmp()
    expect(generateVerifierCommands(root)).toEqual([])
    writeFileSync(join(root, 'Cargo.toml'), ''); writeFileSync(join(root, 'go.mod'), '')
    expect(generateVerifierCommands(root)).toEqual([['cargo', 'test'], ['go', 'test', './...']])
  })

  it('is the fallback when verifier.commands is empty, and asks for contract outcomes and live checks too', () => {
    const root = tmp()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
    const cfg = parseLoopConfigText(`${exampleYaml}\nverifier:\n  enabled: true\n  liveChecks: ["GET /health answers 200"]\n`)
    expect(verifierItems(cfg, root, contract).map((item) => item.id)).toEqual(['cmd-1', 'live-1', 'o1'])
  })
})

describe('the verdict', () => {
  it('is read from the last parseable line; the brief echoed back is not a verdict', () => {
    const brief = renderVerifierBrief({ issue: 'X-1', pr: 7, head: HEAD, nonce: 'n'.repeat(8), items })
    expect(parseVerdict(brief)).toBeNull()
    expect(parseVerdict(`${brief}\nworking…\n${verdictLine('n'.repeat(8))}\n`)?.verdict).toBe('proven')
  })

  it('is proven only when this head, this submission, and every asked item passed with evidence', () => {
    const nonce = 'n'.repeat(8)
    const judge = (over: Record<string, unknown>) => judgeVerdict({ verdict: parseVerdict(verdictLine(nonce, over))!, head: HEAD, nonce, items })
    expect(judge({}).status).toBe('proven')
    expect(judge({ head: 'b'.repeat(40) }).detail).toMatch(/not aaaaaaaaaaaa/)
    expect(judge({ items: [{ id: 'cmd-1', status: 'passed', evidence: 'ok' }] }).detail).toMatch(/no answer for o1/)
    expect(judge({ items: [{ id: 'cmd-1', status: 'passed', evidence: 'ok' }, { id: 'o1', status: 'passed', evidence: '  ' }] }).detail).toMatch(/o1 passed without evidence/)
    expect(judge({ items: [{ id: 'cmd-1', status: 'failed', evidence: 'boom' }, { id: 'o1', status: 'passed', evidence: 'ok' }] }).status).toBe('failed')
    // A verifier that calls it failed is not overruled by passing items.
    expect(judge({ verdict: 'failed' }).status).toBe('failed')
    expect(judgeVerdict({ verdict: parseVerdict(verdictLine('other-nonce'))!, head: HEAD, nonce, items }).detail).toMatch(/different submission/)
  })

  it('is never proven when nothing was asked', () => {
    const verdict = parseVerdict(verdictLine('n'.repeat(8), { items: [] }))!
    expect(judgeVerdict({ verdict, head: HEAD, nonce: 'n'.repeat(8), items: [] }).status).toBe('failed')
  })
})

/** A runner connector whose verifier workspace is scripted: what it prints, and what the queue says about it. */
const fakeConnector = (id = 'fleet') => {
  const log: string[] = []
  const state = { screen: '', task: undefined as 'queued' | 'running' | 'done' | 'failed' | undefined, delivered: true, brief: '', removed: [] as string[] }
  const connector: RunnerConnector = {
    id,
    createWorkspace: async ({ name }) => { log.push(`create ${name}`); return { id: `ws-${name}`, path: '', branch: name, terminal: null } },
    removeWorkspace: async ({ id: workspace }) => { state.removed.push(workspace) },
    launchAgent: async ({ workspace, command }) => { log.push(`launch ${workspace.id} [${command}]`); return workspace.id },
    send: async ({ text }) => { state.brief = text; return { delivered: state.delivered, detail: 'submitted q-1' } },
    readScreen: async () => state.screen,
    schedule: async () => [],
    observeWorkspaces: async () => state.task ? [{ id: [...log].pop() ? `ws-verify-X-1-${HEAD.slice(0, 7)}` : '', pullRequest: null, state: state.task }] : [],
  }
  return { connector, state, log }
}

const loadedOf = (cfg: LoopConfig): LoadedLoopConfig => { const root = tmp(); mkdirSync(join(root, '.loop-state'), { recursive: true }); return { config: cfg, root, stateDir: join(root, '.loop-state'), path: join(root, 'loop.config.yaml') } as unknown as LoadedLoopConfig }
const step = (loaded: LoadedLoopConfig, connector: RunnerConnector, now = new Date('2026-10-20T10:00:00Z'), head = HEAD) => verifyIndependently({ loaded, connector, issue: 'X-1', pr: 7, head, contract, now, dryRun: false })
const nonceOf = (brief: string): string => /exactly `([^`]+)`/.exec(brief)![1]!

describe('verifyIndependently', () => {
  it('submits a separate verify task, waits, then proves from the verdict it returns', async () => {
    const loaded = loadedOf(config())
    const { connector, state, log } = fakeConnector()
    expect((await step(loaded, connector)).status).toBe('waiting')
    expect(log[0]).toBe(`create verify-X-1-${HEAD.slice(0, 7)}`)
    expect(state.brief).toContain(HEAD)
    expect(state.brief).toContain('did **not** write this change')
    expect(state.brief).toContain('`o1`')
    // Still running: no verdict, still waiting, nothing removed.
    state.task = 'running'
    expect((await step(loaded, connector)).status).toBe('waiting')
    state.screen = `${state.brief}\n${verdictLine(nonceOf(state.brief))}`
    const done = await step(loaded, connector)
    expect(done).toMatchObject({ status: 'proven' })
    expect(done.proofs.map((proof) => proof.id)).toEqual(['cmd-1', 'o1'])
    expect(state.removed).toHaveLength(1)
    // The same head is not verified again.
    state.screen = ''
    expect((await step(loaded, connector)).status).toBe('proven')
    expect(log.filter((line) => line.startsWith('create'))).toHaveLength(1)
  })

  it('fails closed: a failing verdict, a run that ends silent, and a blown budget are all "failed"', async () => {
    const failing = loadedOf(config())
    const a = fakeConnector()
    await step(failing, a.connector)
    a.state.screen = verdictLine(nonceOf(a.state.brief), { verdict: 'failed', items: [{ id: 'cmd-1', status: 'failed', evidence: 'exit 1' }, { id: 'o1', status: 'passed', evidence: 'ok' }] })
    expect(await step(failing, a.connector)).toMatchObject({ status: 'failed', detail: expect.stringContaining('cmd-1 failed: exit 1') })

    const silent = loadedOf(config())
    const b = fakeConnector()
    await step(silent, b.connector)
    b.state.task = 'done'
    expect(await step(silent, b.connector)).toMatchObject({ status: 'failed', detail: expect.stringContaining('without a verdict') })

    const slow = loadedOf(config('  budget:\n    timeoutMs: 60000\n'))
    const c = fakeConnector()
    await step(slow, c.connector)
    expect((await step(slow, c.connector, new Date('2026-10-20T10:00:30Z'))).status).toBe('waiting')
    expect(await step(slow, c.connector, new Date('2026-10-20T10:05:00Z'))).toMatchObject({ status: 'failed', detail: expect.stringContaining('verifier budget') })
  })

  it('is unavailable — never proven — when the verifier cannot be launched or dies', async () => {
    const dead = loadedOf(config())
    const a = fakeConnector()
    a.state.delivered = false
    expect((await step(dead, a.connector)).status).toBe('unavailable')
    const b = fakeConnector()
    await step(dead, b.connector)
    b.state.task = 'failed'
    expect(await step(dead, b.connector)).toMatchObject({ status: 'unavailable', detail: expect.stringContaining('failed before it returned') })
  })

  it('needs verifier.agentCommand on a runner that launches a terminal, and passes it through', async () => {
    const loaded = loadedOf(config())
    expect(await step(loaded, fakeConnector('orca').connector)).toMatchObject({ status: 'unavailable', detail: expect.stringContaining('verifier.agentCommand') })
    const withCommand = loadedOf(config('  agentCommand: claude --print\n'))
    const { connector, log } = fakeConnector('orca')
    expect((await step(withCommand, connector)).status).toBe('waiting')
    expect(log[1]).toContain('[claude --print]')
  })

  it('verifies a new head from scratch and removes the old head\'s workspace', async () => {
    const loaded = loadedOf(config())
    const { connector, state, log } = fakeConnector()
    await step(loaded, connector)
    await step(loaded, connector, new Date('2026-10-20T10:01:00Z'), 'b'.repeat(40))
    expect(state.removed).toHaveLength(1)
    expect(log.filter((line) => line.startsWith('create'))).toHaveLength(2)
  })

  it('does not submit on a dry run', async () => {
    const { connector, log } = fakeConnector()
    const result = await verifyIndependently({ loaded: loadedOf(config()), connector, issue: 'X-1', pr: 7, head: HEAD, contract, now: new Date(), dryRun: true })
    expect(result.status).toBe('waiting')
    expect(log).toEqual([])
  })
})
