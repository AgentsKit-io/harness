import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUiSnapshot, renderUiHtml, startUiServer, type UiSnapshot } from '../src/ui/server.js'
import { markDispatchCancelled } from '../src/index.js'
import { createUiWizardStore } from '../src/ui/wizard.js'

const servers: { close: () => Promise<void> }[] = []

afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
})

const loaded = (stateDir: string) => ({
  root: stateDir,
  stateDir,
  configHash: 'config-hash',
  config: { project: { name: 'Harness fixture', repo: 'AgentsKit-io/harness', baseBranch: 'main' } },
}) as never

describe('local UI projection', () => {
  it('persists a wizard draft by issue and resumes it after reopening the store', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-wizard-'))
    const stateDir = join(root, '.ak-loop')
    const first = createUiWizardStore(stateDir, () => new Date('2026-09-23T10:00:00.000Z'))
    first.save('UI-7', { step: 3, configHash: 'hash-1', flow: 'safe', builder: 'codex/gpt-5', contractDigest: 'digest', contractError: 'orchestrator rejected the issue contract', maxFixRounds: 2, perIssueTokens: 1000, preflight: 'passed' })
    const reopened = createUiWizardStore(stateDir, () => new Date('2026-09-23T10:01:00.000Z'))
    expect(reopened.read('UI-7')).toMatchObject({ issue: 'UI-7', step: 3, flow: 'safe', builder: 'codex/gpt-5', contractError: 'orchestrator rejected the issue contract', preflight: 'passed' })
    rmSync(root, { recursive: true, force: true })
  })

  it('projects a bounded event window into task and timeline state', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-'))
    const stateDir = join(root, '.ak-loop')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'events.ndjson'), [
      JSON.stringify({ at: '2020-01-01T00:00:00.000Z', type: 'worker.dispatched', issue: 'OLD-1', provider: 'codex' }),
      JSON.stringify({ at: '2026-09-23T10:00:00.000Z', type: 'worker.dispatched', issue: 'UI-1', reason: 'started' }),
      JSON.stringify({ at: '2026-09-23T10:01:00.000Z', type: 'worker.blocked', issue: 'UI-1', reason: 'needs approval' }),
    ].join('\n'))
    const snapshot = createUiSnapshot({ loaded: loaded(stateDir), now: new Date('2026-09-23T10:02:00.000Z'), windowHours: 1 })
    expect(snapshot.summary).toMatchObject({ totalIssues: 1, inFlight: 0, eventCount: 2 })
    expect(snapshot.issues[0]).toMatchObject({ issue: 'UI-1', phase: 'observed', outcome: 'observed', lastEvent: 'worker.blocked' })
    expect(snapshot.events[0]).toMatchObject({ type: 'worker.blocked', issue: 'UI-1' })
  })

  it('does not count a cleaned dispatch record against available capacity', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ui-capacity-'))
    const stateDir = join(root, '.ak-loop')
    const issue = 'Dev4LifeV/mais-thopp-sistemas#217'
    mkdirSync(join(stateDir, 'issues', issue), { recursive: true })
    writeFileSync(join(stateDir, 'issues', issue, 'dispatch.json'), JSON.stringify({ issue, worktreeId: 'worktree-217', branch: 'vctud/mais-thopp-sistemas-217', provider: 'codex', model: 'gpt-5' }))
    markDispatchCancelled(stateDir, issue, new Date('2026-09-23T10:00:00.000Z'))
    const snapshot = createUiSnapshot({ loaded: loaded(stateDir), now: new Date('2026-09-23T10:02:00.000Z') })
    expect(snapshot.capacity).toMatchObject({ maxAgents: 1, running: 0, free: 1 })
    rmSync(root, { recursive: true, force: true })
  })

  it('serves a protected state endpoint and a same-origin UI shell', async () => {
    const sample: UiSnapshot = {
      schemaVersion: 2, generatedAt: '2026-09-23T10:00:00.000Z', windowHours: 24,
      project: { name: 'Harness', repo: 'AgentsKit-io/harness', baseBranch: 'main', root: 'C:/repo', stateDir: 'C:/repo/.ak-loop', configHash: 'abcdef1234567890' },
      summary: { totalIssues: 0, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 }, issues: [], events: [], board: null,
    }
    const server = await startUiServer({ port: 0, snapshot: () => sample })
    servers.push(server)
    const unauthorized = await fetch(`${server.url}api/v1/state`)
    expect(unauthorized.status).toBe(401)
    const authorized = await fetch(`${server.url}api/v1/state`, { headers: { 'x-harness-session': server.token } })
    expect(authorized.status).toBe(200)
    await expect(authorized.json()).resolves.toMatchObject({ schemaVersion: 2, project: { name: 'Harness' } })
    const stream = await fetch(`${server.url}api/v1/events?session=${encodeURIComponent(server.token)}`)
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()
    expect(new TextDecoder().decode(first.value)).toContain('event: snapshot')
    await reader!.cancel()
    const html = await fetch(server.url).then((response) => response.text())
    expect(html).toContain('AgentsKit Harness')
    expect(html).toContain('--ag-accent: #34d399')
    expect(html).toContain('Inbox')
    expect(html).toContain('Disponíveis')
    expect(html).toContain('Abrir wizard')
    expect(html).toContain('/api/v1/runs')
    expect(html).toContain('polled.job || polled')
    expect(html).toContain('Falha ao gerar o contrato')
    expect(html).toContain('Gerar novamente')
    expect(html).toContain('Abrir Inbox')
    expect(html).toContain('Limpar recursos')
    expect(html).toContain('Padrão do projeto')
    expect(html).toContain('Nenhum flow específico')
    expect(renderUiHtml(server.token)).toContain('window.__HARNESS_SESSION__')
  })

  it('renders the issue-first operation shell without redundant technical panels', async () => {
    let forced = 0
    const sample: UiSnapshot = {
      schemaVersion: 2, generatedAt: '2026-09-23T10:00:00.000Z', windowHours: 24,
      project: { name: 'Harness', repo: 'acme/app', baseBranch: 'main', root: 'C:/repo', stateDir: 'C:/repo/.ak-loop', configHash: 'hash' },
      summary: { totalIssues: 1, inFlight: 0, held: 0, completed: 0, blocked: 0, eventCount: 0 },
      issues: [{ issue: 'acme/app#7', phase: 'observed', outcome: 'observed', provider: null, model: null, branch: null, worktree: null, dispatchedAt: null, finishedAt: null, fixRounds: 0, pr: null, lastEvent: null, heldFor: null }],
      events: [],
      board: { provider: 'github', repo: 'acme/app', status: 'fresh', fetchedAt: '2026-09-23T10:00:00.000Z', truncated: false, error: null, issues: [{ identifier: 'acme/app#7', title: '<safe>', url: 'https://github.com/acme/app/issues/7', state: 'OPEN', labels: ['bug'], assignees: ['alice'], createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-23T10:00:00Z' }] },
    }
    const server = await startUiServer({ port: 0, snapshot: (force) => { if (force) forced += 1; return sample } })
    servers.push(server)
    const state = await fetch(`${server.url}api/v1/state`, { headers: { 'x-harness-session': server.token } })
    await expect(state.json()).resolves.toMatchObject({ board: { provider: 'github', issues: [{ identifier: 'acme/app#7' }] } })
    await fetch(`${server.url}api/v1/state?refresh=1`, { headers: { 'x-harness-session': server.token } })
    expect(forced).toBe(1)
    const html = await fetch(server.url).then((response) => response.text())
    expect(html).toContain('Operação')
    expect(html).toContain('Inbox')
    expect(html).toContain('Executando')
    expect(html).toContain('Disponíveis')
    expect(html).toContain('Aguardando decisão')
    expect(html).toContain('Bloqueadas')
    expect(html).toContain('Histórico')
    expect(html).toContain('/wizard/')
    expect(html).not.toContain('Board remoto')
    expect(html).not.toContain('Timeline de eventos')
    expect(html).not.toContain('Tasks em contexto')
    expect(html).not.toContain('Operações avançadas')
    expect(html).not.toContain('Jobs da UI')
    expect(html).not.toContain('id="issue-wizard"')
    await expect(fetch(`${server.url}inbox`)).resolves.toMatchObject({ status: 200 })
    await expect(fetch(`${server.url}wizard/ENG-1`)).resolves.toMatchObject({ status: 200 })
  })

  it('refuses non-loopback binds', async () => {
    await expect(startUiServer({ host: '0.0.0.0', snapshot: () => { throw new Error('unreachable') } })).rejects.toThrow('loopback')
  })
})
