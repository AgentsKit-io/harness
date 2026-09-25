import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { githubOpenIssues, type GitHubIssueSnapshot } from '../../adapters/github-cli.js'
import type { CommandRunner } from '../../adapters/command.js'
import { fetchLinearQueue, type LoopIssue } from '../../adapters/linear-orca.js'
import type { LoadedLoopConfig } from '../../loop/config.js'

export type BoardProvider = 'linear' | 'github'
export type BoardStatus = 'fresh' | 'stale' | 'error' | 'unavailable'
export type BoardLane = 'todo' | 'in-progress' | 'review' | 'done' | 'blocked' | 'unclassified'

export interface BoardIssue {
  readonly identifier: string
  readonly title: string
  readonly url: string
  readonly state: string
  readonly lane: BoardLane
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface BoardReadResult {
  readonly issues: readonly BoardIssue[]
  readonly truncated: boolean
}

export interface BoardSnapshot {
  readonly provider: BoardProvider
  readonly repo: string
  readonly status: BoardStatus
  readonly fetchedAt: string | null
  readonly issues: readonly BoardIssue[]
  readonly truncated: boolean
  readonly error: string | null
}

/** Small seam between the UI projection and a remote issue provider. Mutations stay in TrackerConnector. */
export interface IssueBoardReader {
  readonly provider: BoardProvider
  readonly read: () => Promise<BoardReadResult>
}

const CACHE_SCHEMA_VERSION = 1 as const
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringValue = (value: unknown): string => typeof value === 'string' ? value : ''

const boardIssue = (value: unknown): BoardIssue | null => {
  if (!isRecord(value)) return null
  const identifier = stringValue(value['identifier'])
  const title = stringValue(value['title'])
  const url = stringValue(value['url'])
  const state = stringValue(value['state'])
  const lane = ['todo', 'in-progress', 'review', 'done', 'blocked', 'unclassified'].includes(value['lane'] as string) ? value['lane'] as BoardLane : 'unclassified'
  const createdAt = stringValue(value['createdAt'])
  const updatedAt = stringValue(value['updatedAt'])
  if (!identifier || !title || !url || !state || !createdAt || !updatedAt) return null
  const labels = Array.isArray(value['labels']) ? value['labels'].filter((item): item is string => typeof item === 'string') : []
  const assignees = Array.isArray(value['assignees']) ? value['assignees'].filter((item): item is string => typeof item === 'string') : []
  return { identifier, title, url, state, lane, labels, assignees, createdAt, updatedAt }
}

const githubLane = (labels: readonly string[], config: LoadedLoopConfig['config']): BoardLane => {
  const lifecycle = config.github.issues.labels
  if (labels.includes(lifecycle.todo)) return 'todo'
  if (labels.includes(lifecycle.inProgress)) return 'in-progress'
  if (labels.includes(lifecycle.review)) return 'review'
  if (labels.includes(lifecycle.done)) return 'done'
  if (labels.includes(lifecycle.blocked)) return 'blocked'
  return 'unclassified'
}

const githubBoardIssue = (issue: GitHubIssueSnapshot, config: LoadedLoopConfig['config']): BoardIssue => ({
  identifier: issue.identifier, title: issue.title, url: issue.url, state: issue.state, lane: githubLane(issue.labels, config),
  labels: issue.labels, assignees: issue.assignees, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
})

const linearLane = (state: string): BoardLane => {
  const normalized = state.trim().toLowerCase()
  if (normalized === 'todo' || normalized === 'ready' || normalized === 'backlog') return 'todo'
  if (normalized === 'in progress' || normalized === 'in-progress' || normalized === 'started') return 'in-progress'
  if (normalized === 'in review' || normalized === 'review') return 'review'
  if (normalized === 'done' || normalized === 'completed' || normalized === 'cancelled') return 'done'
  if (normalized === 'blocked') return 'blocked'
  return 'unclassified'
}

const linearBoardIssue = (issue: LoopIssue): BoardIssue => ({
  identifier: issue.identifier, title: issue.title, url: issue.url, state: issue.state, lane: linearLane(issue.state),
  labels: issue.labels, assignees: issue.assignee ? [issue.assignee] : [], createdAt: issue.createdAt, updatedAt: issue.updatedAt,
})

/** The board reader follows the configured tracker; execution mutations use the TrackerConnector seam. */
export const createIssueBoardReader = (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner }): IssueBoardReader => {
  const { config } = input.loaded
  if (config.connectors.tracker === 'github') {
    return {
      provider: 'github',
      read: async () => {
        const limit = config.github.issues.maxIssues
        const issues = await githubOpenIssues(input.runner, { repo: config.project.repo, limit: limit + 1 }, { cwd: input.loaded.root })
        return { issues: issues.slice(0, limit).map((issue) => githubBoardIssue(issue, config)), truncated: issues.length > limit }
      },
    }
  }
  return {
    provider: 'linear',
    read: async () => {
      const issues = await fetchLinearQueue(input.runner, {
        bin: config.orca.bin, workspaceId: config.linear.workspaceId, teamKey: config.linear.teamKey,
        assignee: config.linear.person, filter: config.linear, orca: { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs },
      })
      return { issues: issues.map(linearBoardIssue), truncated: false }
    },
  }
}

export interface IssueBoardCache {
  readonly read: (force?: boolean) => Promise<BoardSnapshot>
}

export interface IssueBoardCacheOptions {
  readonly loaded: LoadedLoopConfig
  readonly reader: IssueBoardReader
  readonly now?: () => Date
  readonly path?: string
}

interface BoardCacheFile {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION
  readonly provider: BoardProvider
  readonly repo: string
  readonly fetchedAt: string
  readonly issues: readonly BoardIssue[]
  readonly truncated: boolean
}

const cacheFile = (value: unknown): BoardCacheFile | null => {
  if (!isRecord(value) || value['schemaVersion'] !== CACHE_SCHEMA_VERSION || (value['provider'] !== 'linear' && value['provider'] !== 'github') || typeof value['repo'] !== 'string' || typeof value['fetchedAt'] !== 'string' || !Array.isArray(value['issues']) || typeof value['truncated'] !== 'boolean') return null
  const issues = value['issues'].map(boardIssue)
  if (issues.some((issue): issue is null => issue === null)) return null
  return { schemaVersion: CACHE_SCHEMA_VERSION, provider: value['provider'], repo: value['repo'], fetchedAt: value['fetchedAt'], issues: issues as BoardIssue[], truncated: value['truncated'] }
}

const readCache = (path: string, provider: BoardProvider, repo: string): BoardCacheFile | null => {
  if (!existsSync(path)) return null
  try {
    const value = cacheFile(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    return value && value.provider === provider && value.repo === repo ? value : null
  } catch { return null }
}

const writeCache = (path: string, value: BoardCacheFile): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export const createIssueBoardCache = (input: IssueBoardCacheOptions): IssueBoardCache => {
  const loaded = input.loaded
  const provider = input.reader.provider
  const repo = loaded.config.project.repo
  const refreshMs = loaded.config.github.issues.refreshSeconds * 1_000
  const path = input.path ?? join(loaded.stateDir, 'ui', provider === 'github' ? 'github-issues.json' : 'linear-issues.json')
  const now = input.now ?? (() => new Date())
  let inFlight: Promise<BoardSnapshot> | null = null

  const read = async (force = false): Promise<BoardSnapshot> => {
    if (inFlight) return inFlight
    const cached = readCache(path, provider, repo)
    const age = cached ? now().getTime() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY
    if (!force && cached && Number.isFinite(age) && age <= refreshMs) return { provider, repo, status: 'fresh', fetchedAt: cached.fetchedAt, issues: cached.issues, truncated: cached.truncated, error: null }
    inFlight = (async () => {
      try {
        const result = await input.reader.read()
        const fetchedAt = now().toISOString()
        const file: BoardCacheFile = { schemaVersion: CACHE_SCHEMA_VERSION, provider, repo, fetchedAt, issues: result.issues, truncated: result.truncated }
        writeCache(path, file)
        return { provider, repo, status: 'fresh' as const, fetchedAt, issues: result.issues, truncated: result.truncated, error: null }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (cached) return { provider, repo, status: 'stale' as const, fetchedAt: cached.fetchedAt, issues: cached.issues, truncated: cached.truncated, error: message }
        return { provider, repo, status: 'unavailable' as const, fetchedAt: null, issues: [], truncated: false, error: message }
      } finally { inFlight = null }
    })()
    return inFlight
  }
  return { read }
}
