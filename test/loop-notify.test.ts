import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachNotifier, buildNotification, createLoopEventBus, notificationsConfigured, notifyHuman, parseLoopConfigText } from '../src/index.js'
import type { CommandResult, CommandRunner, LoopConfig } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const config = (extra = ''): LoopConfig => parseLoopConfigText(`${exampleYaml}${extra}`)

const recordingRunner = (result: Partial<CommandResult> = {}): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (argv) => { calls.push([...argv]); return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1, ...result } } }
}

const WEBHOOK = '\nnotifications:\n  webhook:\n    urlEnv: LOOP_WEBHOOK\n    headers: { x-source: harness }\n'
const COMMAND = '\nnotifications:\n  command: [notify, "{event}", "{issue}", "{summary}"]\n'

describe('notification shape', () => {
  it('summarises an escalation in one line a phone can show', () => {
    const notification = buildNotification(config(), 'contract.escalated', { issue: 'ENG-7', reasons: ['no verifiable outcome', 'scope unclear'] })
    expect(notification.summary).toBe('my-project · contract.escalated · ENG-7 — no verifiable outcome; scope unclear')
    expect(notification.issue).toBe('ENG-7')
    expect(buildNotification(config(), 'stage.paused', { stage: 'tick', reason: 'orca unreachable' }).summary).toBe('my-project · stage.paused — orca unreachable')
    expect(buildNotification(config(), 'stage.paused', {}).summary).toBe('my-project · stage.paused')
  })

  it('knows when nothing is configured, so attaching is free', () => {
    expect(notificationsConfigured(config())).toBe(false)
    expect(notificationsConfigured(config(WEBHOOK))).toBe(true)
    expect(notificationsConfigured(config(COMMAND))).toBe(true)
  })
})

describe('delivering a notification', () => {
  const notification = buildNotification(config(), 'issue.paused', { issue: 'ENG-9', reason: 'three failures' })

  it('posts the JSON to the webhook url held in the environment', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { seen.url = String(url); seen.init = init; return new Response('', { status: 200 }) }) as typeof fetch
    const outcomes = await notifyHuman({ config: config(WEBHOOK), notification, env: { LOOP_WEBHOOK: 'https://hooks.example/abc' }, fetchImpl })
    expect(outcomes).toEqual([{ channel: 'webhook', status: 'sent', detail: 'HTTP 200' }])
    expect(seen.url).toBe('https://hooks.example/abc')
    expect((seen.init?.headers as Record<string, string>)['x-source']).toBe('harness')
    expect(JSON.parse(String(seen.init?.body)).summary).toContain('ENG-9')
  })

  it('reports — never throws — when the url is unset, the endpoint refuses, or the call fails', async () => {
    expect(await notifyHuman({ config: config(WEBHOOK), notification, env: {} })).toEqual([{ channel: 'webhook', status: 'skipped', detail: 'LOOP_WEBHOOK is not set in this environment' }])
    const refused = (async () => new Response('', { status: 500 })) as typeof fetch
    expect(await notifyHuman({ config: config(WEBHOOK), notification, env: { LOOP_WEBHOOK: 'https://hooks.example/abc' }, fetchImpl: refused })).toEqual([{ channel: 'webhook', status: 'failed', detail: 'HTTP 500' }])
    const broken = (async () => { throw new Error('network is down') }) as typeof fetch
    expect(await notifyHuman({ config: config(WEBHOOK), notification, env: { LOOP_WEBHOOK: 'https://hooks.example/abc' }, fetchImpl: broken })).toEqual([{ channel: 'webhook', status: 'failed', detail: 'network is down' }])
  })

  it('runs the local command with the placeholders substituted, and reports a non-zero exit', async () => {
    const runner = recordingRunner()
    expect(await notifyHuman({ config: config(COMMAND), notification, runner })).toEqual([{ channel: 'command', status: 'sent', detail: 'notify exited 0' }])
    expect(runner.calls[0]).toEqual(['notify', 'issue.paused', 'ENG-9', 'my-project · issue.paused · ENG-9 — three failures'])
    const failing = recordingRunner({ code: 3, stderr: 'no such notifier' })
    expect(await notifyHuman({ config: config(COMMAND), notification, runner: failing })).toEqual([{ channel: 'command', status: 'failed', detail: 'notify exited 3: no such notifier' }])
    expect(await notifyHuman({ config: config(COMMAND), notification })).toEqual([{ channel: 'command', status: 'skipped', detail: 'no command runner available in this context' }])
  })
})

describe('the notifier on the bus', () => {
  it('sends the declared event types and every escalation, and ignores the rest', async () => {
    const runner = recordingRunner()
    const bus = createLoopEventBus()
    const flush = attachNotifier(bus, { config: config(`${COMMAND}  events: [issue.paused]\n`), runner })
    bus.emit({ type: 'issue.paused', issue: 'ENG-1', reason: 'three failures' })
    bus.emit({ type: 'worker.dispatched', issue: 'ENG-2' })
    await bus.runHook('onEscalate', { issue: 'ENG-3', reasons: ['no verifiable outcome'] })
    await flush()
    expect(runner.calls.map((argv) => argv[1])).toEqual(['issue.paused', 'onEscalate'])
    expect(runner.calls[1]?.[2]).toBe('ENG-3')
  })

  it('is a no-op with no channel configured, and its flush still resolves', async () => {
    const runner = recordingRunner()
    const bus = createLoopEventBus()
    const flush = attachNotifier(bus, { config: config(), runner })
    bus.emit({ type: 'issue.paused', issue: 'ENG-1' })
    await expect(flush()).resolves.toBeUndefined()
    expect(runner.calls).toEqual([])
  })

  it('never lets a failing channel block the hook that triggered it', async () => {
    const bus = createLoopEventBus()
    const flush = attachNotifier(bus, { config: config(COMMAND), runner: { run: async () => { throw new Error('spawn failed') } } })
    const result = await bus.runHook('onEscalate', { issue: 'ENG-4' })
    expect(result.block).toBe(false)
    await expect(flush()).resolves.toBeUndefined()
  })
})
