import type { ConfigField, FieldClass } from './contract.js'

/**
 * Which direction makes a `gate` weaker. `lower`/`higher` compare numbers (`higher-or-zero`: 0 means "no ceiling",
 * the weakest of all); `off` = true→false is weaker; `on` = false→true is weaker; `removed` / `added` = dropping / adding list
 * entries is weaker; a string list is an enum ordered strongest → weakest.
 */
export type Weakening = 'lower' | 'higher' | 'higher-or-zero' | 'off' | 'on' | 'removed' | 'added' | readonly string[]

export interface FieldMeta {
  readonly section: string
  readonly description: string
  readonly classification: FieldClass
  readonly editable: ConfigField['editable']
  readonly weaker?: Weakening
}

type Entry = Omit<FieldMeta, 'section' | 'editable'> & { readonly editable?: ConfigField['editable'] }
const safe = (description: string): Entry => ({ description, classification: 'safe' })
const sensitive = (description: string): Entry => ({ description, classification: 'sensitive' })
const gate = (description: string, weaker: Weakening): Entry => ({ description, classification: 'gate', weaker })

/** Exact paths win over `prefix.*` entries; the longest prefix wins among those. */
const FIELDS: Readonly<Record<string, Entry>> = {
  'schemaVersion': { ...safe('Config schema version.'), editable: 'readonly' },
  'project.stateDir': { ...sensitive('Where the loop keeps runtime state.'), editable: 'readonly' },
  'project.root': { ...sensitive('Project root, relative to the config file.'), editable: 'readonly' },
  'machine.*': safe('How much of this machine the loop may use.'),
  'machine.floor': safe('Minimum concurrent workers.'),
  'machine.ceiling': safe('Maximum concurrent workers (unset = cpus/2).'),
  'machine.minFreeRamGb': safe('GB of RAM always kept free.'),
  'models.routing.*': safe('How a model is picked for each role.'),
  'models.routing.mode': safe('Routing strategy: tiers, hybrid, dynamic or catalog.'),
  'models.routing.policy': safe('Order among allowed candidates: quality, usage or cost first.'),
  'models.routing.excludeProviders': safe('Providers never selected on this machine.'),
  'models.routing.includeProviders': safe('If set, only these providers may be selected.'),
  'models.routing.pinStrict': safe('Fail instead of falling through when a pinned model is unavailable.'),
  'delivery.maxFixRounds': gate('Fix rounds a worker gets after failed checks or review findings.', 'lower'),
  'delivery.workerIdleTimeoutMin': safe('Minutes of worker silence before it counts as stuck.'),
  'delivery.review.*': sensitive('Automated code review settings.'),
  'delivery.review.votes': gate('Independent review votes per PR.', 'lower'),
  'delivery.review.profile': gate('Review depth.', ['full', 'fast']),
  'delivery.review.minSeverity': gate('Lowest finding severity that blocks a merge.', ['nit', 'med', 'high', 'blocker']),
  'delivery.review.post': sensitive('Post review findings on the PR.'),
  'delivery.review.criticalPaths': gate('Paths that always get the full review.', 'removed'),
  'delivery.review.smallChangeLines': gate('Changes up to this many lines get a lighter review (0 = never).', 'higher'),
  'delivery.merge.*': sensitive('How a finished PR is merged.'),
  'delivery.merge.auto': gate('Merge automatically once every gate passes.', 'on'),
  'delivery.merge.method': safe('Merge method: squash, merge or rebase.'),
  'delivery.merge.requireChecks': gate('Require CI checks to pass before merging.', 'off'),
  'delivery.merge.requireHumanApproval': gate('Require a human approval before merging.', 'off'),
  'delivery.workerGuard.enabled': gate('Block workers from editing protected paths.', 'off'),
  'delivery.requiredChecks': gate('CI checks that must pass.', 'removed'),
  'delivery.selfEditPaths': gate('Paths workers may never edit.', 'removed'),
  'delivery.secretFilePatterns': gate('Files workers may never read or commit.', 'removed'),
  'delivery.ignoreChecks': gate('CI checks ignored when deciding a PR is green.', 'added'),
  'budget.*': sensitive('Spending ceilings.'),
  'budget.perProvider': gate('Percent of a provider window the loop may use.', 'higher'),
  'budget.perIssueTokens': gate('Tokens one issue may consume (0 = no ceiling).', 'higher-or-zero'),
  'dod.items': gate('Definition-of-done checks enforced at merge.', 'removed'),
  'contract.reuseHours': safe('Hours a generated contract is reused before regenerating.'),
  'memory.enabled': safe('Recall and store agent memory between issues.'),
  'security.*': sensitive('Security controls.'),
  'security.pii.enabled': gate('Scan text for PII before it reaches a prompt or comment.', 'off'),
  'security.pii.action': gate('What a PII match does.', ['block', 'redact', 'warn']),
  'flows.default': sensitive('Flow profile used when an issue selects none.'),
  'linear.person': safe('Whose queue this machine drains.'),
  'notifications.webhook.url': sensitive('Webhook URL for alerts (global or personal file only).'),
  'notifications.webhook.urlEnv': sensitive('Environment variable holding the alert webhook URL.'),
}

/** Metadata for one config path. Unlisted paths: section from the first segment, `sensitive`, team-only. */
export const fieldMeta = (path: string): FieldMeta => {
  const section = path.split('.')[0] ?? path
  const exact = FIELDS[path]
  const prefix = exact ? null : Object.keys(FIELDS).filter((key) => key.endsWith('.*') && path.startsWith(key.slice(0, -1))).sort((a, b) => b.length - a.length)[0]
  const entry = exact ?? (prefix ? FIELDS[prefix] : undefined)
  if (!entry) return { section, description: '', classification: 'sensitive', editable: 'propose' }
  return { section, editable: 'personal', ...entry }
}

const itemKey = (item: unknown): string => typeof item === 'object' && item !== null && 'id' in item ? String((item as { id: unknown }).id) : JSON.stringify(item)

const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []
/** Some entry of `from` is absent from `to` (entries with an `id` compare by id). */
const missing = (from: unknown, to: unknown): boolean => { const keys = new Set(list(to).map(itemKey)); return list(from).some((item) => !keys.has(itemKey(item))) }

/** True when `value` is a weaker setting than `baseline` for this gate. Same value is never weaker. */
export const isWeaker = (weaker: Weakening, baseline: unknown, value: unknown): boolean => {
  if (JSON.stringify(baseline) === JSON.stringify(value)) return false
  if (Array.isArray(weaker)) return weaker.indexOf(String(value)) > weaker.indexOf(String(baseline))
  switch (weaker) {
    case 'lower': return typeof value === 'number' && typeof baseline === 'number' && value < baseline
    case 'higher': return typeof value === 'number' && (typeof baseline !== 'number' || value > baseline)
    case 'higher-or-zero': {
      const unlimited = (n: unknown): number => n === 0 || n === undefined ? Number.POSITIVE_INFINITY : Number(n)
      return unlimited(value) > unlimited(baseline)
    }
    case 'off': return baseline === true && value !== true
    case 'on': return baseline !== true && value === true
    case 'removed': return missing(baseline, value)
    case 'added': return missing(value, baseline)
  }
  return false
}
