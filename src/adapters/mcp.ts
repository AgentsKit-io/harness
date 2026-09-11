import { createHash } from 'node:crypto'
import { fail } from '../kernel/errors.js'
import type { PolicyDecision, PolicyGate, PolicyRequest } from '../kernel/policy.js'

export type McpPolicy = PolicyGate | { readonly evaluate: (request: PolicyRequest) => PolicyDecision }

export interface McpToolBridgeOptions {
  readonly policy: McpPolicy
  readonly allowTools: readonly string[]
  readonly call: (toolId: string, argsHash: string, args: unknown) => Promise<unknown>
}

export type McpToolCallResult =
  | { readonly status: 'ok'; readonly result: unknown }
  | { readonly status: 'blocked'; readonly reason: string }

export interface McpToolCallInput {
  readonly toolId: string
  readonly args?: unknown
  readonly argsHash?: string
  readonly actionId?: string
  readonly turnId?: string
}

export interface McpToolBridge {
  readonly invoke: (input: McpToolCallInput) => Promise<McpToolCallResult>
}

const required = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`, 'INVALID_INPUT')
  return value.trim()
}

export const hashMcpArgs = (args: unknown): string => createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex')

/**
 * Adapter-only MCP tool bridge: default-deny allowlist + policy gate before any call.
 * Not wired into loop tick/deliver in 0.6.0 (see ADR-0028).
 */
export const createMcpToolBridge = ({ policy, allowTools, call }: McpToolBridgeOptions): McpToolBridge => {
  if (!policy || typeof policy.evaluate !== 'function') return fail('MCP tool bridge requires policy.evaluate.', 'INVALID_INPUT')
  if (!Array.isArray(allowTools) || allowTools.some((toolId) => typeof toolId !== 'string' || !toolId.trim())) {
    return fail('MCP allowTools must be an array of non-empty strings.', 'INVALID_INPUT')
  }
  if (!call || typeof call !== 'function') return fail('MCP tool bridge requires a call function.', 'INVALID_INPUT')
  const allowed = new Set(allowTools.map((toolId) => toolId.trim()))

  return {
    invoke: async (input) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('MCP invoke input must be an object.', 'INVALID_INPUT')
      const toolId = required(input.toolId, 'toolId')
      if (!allowed.has(toolId)) {
        return { status: 'blocked', reason: `Tool is not in the MCP allowlist: ${toolId}.` }
      }
      const args = input.args ?? null
      const argsHash = input.argsHash === undefined ? hashMcpArgs(args) : required(input.argsHash, 'argsHash')
      const actionId = input.actionId === undefined ? `mcp:${toolId}` : required(input.actionId, 'actionId')
      const turnId = input.turnId === undefined ? 'mcp' : required(input.turnId, 'turnId')
      const decision = policy.evaluate({ actionId, turnId, toolId, argumentsHash: argsHash })
      if (!decision || (decision.decision !== 'allow' && decision.decision !== 'block' && decision.decision !== 'approve')) {
        return fail('MCP policy decision is invalid.', 'HARNESS_ERROR')
      }
      if (decision.decision !== 'allow') {
        return { status: 'blocked', reason: decision.reason || `MCP policy ${decision.decision}: ${decision.policyId}.` }
      }
      const result = await call(toolId, argsHash, args)
      return { status: 'ok', result }
    },
  }
}
