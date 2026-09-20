import type { CommandRunner } from '../adapters/command.js'
import type { LoopConfig } from './config.js'
import type { LoopEventBus, LoopEventPayload, LoopHookPayload } from './event-bus.js'

/** One call for a human, in the only shape both channels need. */
export interface Notification {
  readonly event: string
  readonly issue: string | null
  readonly project: string
  readonly summary: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface NotifyOutcome { readonly channel: 'webhook' | 'command'; readonly status: 'sent' | 'failed' | 'skipped'; readonly detail: string }

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

/** A one-line summary a phone notification can show without unfolding JSON. */
export const notificationSummary = (config: LoopConfig, event: string, payload: Readonly<Record<string, unknown>>): string => {
  const issue = text(payload['issue'])
  const reasons = Array.isArray(payload['reasons']) ? payload['reasons'].filter((reason): reason is string => typeof reason === 'string') : []
  const reason = text(payload['reason']) ?? (reasons.length ? reasons.join('; ') : null)
  return `${config.project.name} · ${event}${issue ? ` · ${issue}` : ''}${reason ? ` — ${reason}` : ''}`
}

export const buildNotification = (config: LoopConfig, event: string, payload: Readonly<Record<string, unknown>>): Notification => ({
  event,
  issue: text(payload['issue']),
  project: config.project.name,
  summary: notificationSummary(config, event, payload),
  payload,
})

const substitute = (argv: readonly string[], notification: Notification): readonly string[] => {
  const json = JSON.stringify(notification)
  return argv.map((argument) => argument
    .replaceAll('{summary}', notification.summary)
    .replaceAll('{event}', notification.event)
    .replaceAll('{issue}', notification.issue ?? '')
    .replaceAll('{json}', json))
}

export interface NotifyInput {
  readonly config: LoopConfig
  readonly notification: Notification
  readonly runner?: CommandRunner
  readonly env?: NodeJS.ProcessEnv
  /** Injected in tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Deliver one notification to every configured channel.
 *
 * Never throws and never blocks the loop: a channel that fails comes back as `failed` with its reason, because a
 * broken webhook must not cost a dispatch. The tracker comment is the record; this is the phone call on top of it.
 */
export const notifyHuman = async (input: NotifyInput): Promise<readonly NotifyOutcome[]> => {
  const { notifications } = input.config
  const env = input.env ?? process.env
  const outcomes: NotifyOutcome[] = []
  const webhook = notifications.webhook
  if (webhook) {
    const url = webhook.urlEnv ? text(env[webhook.urlEnv]) : text(webhook.url ?? null)
    if (!url) outcomes.push({ channel: 'webhook', status: 'skipped', detail: webhook.urlEnv ? `${webhook.urlEnv} is not set in this environment` : 'no url configured' })
    else {
      const send = input.fetchImpl ?? globalThis.fetch
      try {
        const response = await send(url, { method: webhook.method, headers: { 'content-type': 'application/json', ...webhook.headers }, body: JSON.stringify(input.notification), signal: AbortSignal.timeout(webhook.timeoutMs) })
        outcomes.push(response.ok ? { channel: 'webhook', status: 'sent', detail: `HTTP ${response.status}` } : { channel: 'webhook', status: 'failed', detail: `HTTP ${response.status}` })
      } catch (error) { outcomes.push({ channel: 'webhook', status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
    }
  }
  if (notifications.command) {
    if (!input.runner) outcomes.push({ channel: 'command', status: 'skipped', detail: 'no command runner available in this context' })
    else {
      const argv = substitute(notifications.command, input.notification)
      try {
        const result = await input.runner.run(argv, { timeoutMs: notifications.commandTimeoutMs })
        outcomes.push(result.code === 0 ? { channel: 'command', status: 'sent', detail: `${argv[0]} exited 0` } : { channel: 'command', status: 'failed', detail: `${argv[0]} exited ${result.code ?? 'null'}: ${(result.stderr || result.stdout).trim().slice(0, 160)}` })
      } catch (error) { outcomes.push({ channel: 'command', status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
    }
  }
  return outcomes
}

export const notificationsConfigured = (config: LoopConfig): boolean => Boolean(config.notifications.webhook ?? config.notifications.command)

/**
 * Subscribe the configured channels to the bus: the declared event types, plus `onEscalate` unconditionally —
 * an escalation is the definition of "a human has to know", so it is never subject to the event allowlist.
 *
 * Returns a function that waits for the sends still in flight, so a stage can finish without dropping them.
 */
export const attachNotifier = (bus: LoopEventBus, input: Omit<NotifyInput, 'notification'>): (() => Promise<void>) => {
  const pending = new Set<Promise<unknown>>()
  if (!notificationsConfigured(input.config)) return async () => { /* nothing configured: attach is a no-op */ }
  const wanted = new Set(input.config.notifications.events)
  const send = (event: string, payload: Readonly<Record<string, unknown>>): void => {
    const promise = notifyHuman({ ...input, notification: buildNotification(input.config, event, payload) }).finally(() => { pending.delete(promise) })
    pending.add(promise)
  }
  bus.on('*', (event: LoopEventPayload) => { if (wanted.has(event.type)) send(event.type, event) })
  bus.hook('onEscalate', (payload: LoopHookPayload) => { send('onEscalate', payload) })
  return async () => { await Promise.allSettled([...pending]) }
}
