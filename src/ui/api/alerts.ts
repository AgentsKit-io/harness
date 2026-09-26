import { join } from 'node:path'
import { z } from 'zod'
import type { CommandRunner } from '../../adapters/command.js'
import { readJsonFile } from '../../kernel/json-file.js'
import type { LoadedLoopConfig } from '../../loop/config.js'
import { writeJsonAtomic } from '../../loop/fs-atomic.js'
import { buildNotification, notificationsConfigured, notifyHuman } from '../../loop/notify.js'
import type { AttentionItem } from './contract.js'

/**
 * Pushes an Attention item of group `human` or `failed` to the configured `notifications` channels the first time it
 * appears — through `notify.ts`, the same webhook/command the loop's own escalations use. The ids already alerted
 * are persisted so a restart does not resend them; `lastDelivery` is what the System page reports.
 */

const MAX_SEEN = 500

export interface AlertsState {
  readonly seen: readonly string[]
  readonly lastDelivery: { readonly at: string; readonly status: number | 'error' } | null
}

const schema = z.object({
  seen: z.array(z.string()).default([]),
  lastDelivery: z.object({ at: z.string(), status: z.union([z.number(), z.literal('error')]) }).nullable().default(null),
})

export const alertsStatePath = (stateDir: string): string => join(stateDir, 'ui', 'alerts-state.json')
export const readAlertsState = (stateDir: string): AlertsState => readJsonFile(alertsStatePath(stateDir), schema) ?? { seen: [], lastDelivery: null }

export interface AlertSender {
  /** Fire-and-forget: returns the sends it started so a caller (a test) can await them. */
  readonly observe: (items: readonly AttentionItem[]) => Promise<void>
}

export const createAlertSender = (loaded: LoadedLoopConfig, runner?: CommandRunner, fetchImpl?: typeof fetch): AlertSender => {
  const path = alertsStatePath(loaded.stateDir)
  let state: AlertsState | null = null
  const save = (next: AlertsState): void => { state = next; writeJsonAtomic(path, next) }
  return {
    observe: (items) => {
      if (!loaded.config.notifications || !notificationsConfigured(loaded.config)) return Promise.resolve()
      state ??= readAlertsState(loaded.stateDir)
      const current = items.filter((item) => item.group === 'human' || item.group === 'failed')
      const seen = new Set(state.seen)
      const entered = current.filter((item) => !seen.has(item.id))
      // Seen = what is present now: an item that clears and later comes back is news again.
      const nextSeen = current.map((item) => item.id).slice(-MAX_SEEN)
      if (!entered.length && nextSeen.length === state.seen.length && nextSeen.every((id) => seen.has(id))) return Promise.resolve()
      save({ ...state, seen: nextSeen })
      const sends = entered.map(async (item) => {
        const envelope = { type: 'attention.entered', at: new Date().toISOString(), issue: item.issue, group: item.group, kind: item.kind, title: item.title, reason: item.reason }
        const config = loaded.config.notifications.webhook ? { ...loaded.config, notifications: { ...loaded.config.notifications, webhook: { ...loaded.config.notifications.webhook, timeoutMs: Math.min(loaded.config.notifications.webhook.timeoutMs ?? 5_000, 5_000) } } } : loaded.config
        const outcomes = await notifyHuman({ config, notification: buildNotification(config, envelope.type, envelope), ...(runner ? { runner } : {}), ...(fetchImpl ? { fetchImpl } : {}) })
        const webhook = outcomes.find((outcome) => outcome.channel === 'webhook')
        if (!webhook || webhook.status === 'skipped') return
        const status = /^HTTP (\d+)$/.exec(webhook.detail)?.[1]
        save({ ...(state ?? { seen: nextSeen, lastDelivery: null }), lastDelivery: { at: envelope.at, status: status ? Number(status) : 'error' } })
      })
      return Promise.allSettled(sends).then(() => undefined)
    },
  }
}
