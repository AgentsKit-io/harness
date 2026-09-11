import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { fail } from '../kernel/errors.js'

export const AGENT_REGISTRY_SCHEMA_VERSION = 1 as const

const nonEmpty = z.string().trim().min(1)

export const AgentRegistryEntrySchema = z.object({
  role: nonEmpty.optional(),
  provider: nonEmpty,
  model: nonEmpty.optional(),
  tui: nonEmpty.optional(),
  headless: z.array(nonEmpty).min(1).optional(),
})

export const AgentRegistrySchema = z.object({
  schemaVersion: z.literal(AGENT_REGISTRY_SCHEMA_VERSION),
  agents: z.record(nonEmpty, AgentRegistryEntrySchema),
  /** Optional role → agentId map used by routing when present. */
  roles: z.record(nonEmpty, nonEmpty).optional(),
})

export type AgentRegistryEntry = z.output<typeof AgentRegistryEntrySchema>
export type AgentRegistry = z.output<typeof AgentRegistrySchema>

export interface ResolvedAgent {
  readonly agentId: string
  readonly entry: AgentRegistryEntry
  readonly role: string
}

const formatZod = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')

/** Parse and validate an agents.registry.yaml document. Fail closed on schema drift. */
export const parseAgentRegistryText = (text: string, label = 'agents.registry.yaml'): AgentRegistry => {
  let raw: unknown
  try { raw = parseYaml(text) } catch (error) { return fail(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_CONFIG') }
  const parsed = AgentRegistrySchema.safeParse(raw)
  if (!parsed.success) return fail(`Invalid ${label}: ${formatZod(parsed.error)}`, 'INVALID_CONFIG')
  return parsed.data
}

/** Load agents.registry.yaml from disk. Missing file fails closed. */
export const loadAgentRegistry = (path: string): AgentRegistry => {
  if (typeof path !== 'string' || !path.trim()) fail('Agent registry path is required.', 'INVALID_INPUT')
  const absolute = resolve(path)
  if (!existsSync(absolute)) fail(`Agent registry not found: ${absolute}.`, 'INVALID_CONFIG')
  return parseAgentRegistryText(readFileSync(absolute, 'utf8'), absolute)
}

/**
 * Resolve a role to a registry agent. Prefer `roles[role]` → `agents[id]`, else the first agent
 * whose `role` field matches. Fail closed when neither mapping exists.
 */
export const resolveAgentForRole = (registry: AgentRegistry, role: string): ResolvedAgent => {
  if (!registry || typeof registry !== 'object') fail('Agent registry is required.', 'INVALID_INPUT')
  const normalizedRole = typeof role === 'string' ? role.trim() : ''
  if (!normalizedRole) fail('Agent role is required.', 'INVALID_INPUT')

  const mappedId = registry.roles?.[normalizedRole]
  if (mappedId) {
    const entry = registry.agents[mappedId]
    if (!entry) return fail(`Agent registry role "${normalizedRole}" points to unknown agent "${mappedId}".`, 'INVALID_CONFIG')
    return { agentId: mappedId, entry, role: normalizedRole }
  }

  const match = Object.entries(registry.agents).find(([, entry]) => entry.role === normalizedRole)
  if (!match) return fail(`No agent registry entry for role: ${normalizedRole}.`, 'INVALID_CONFIG')
  const [agentId, entry] = match
  return { agentId, entry, role: normalizedRole }
}
