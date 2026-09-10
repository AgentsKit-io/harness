import { fail } from './errors.js'

export interface WorkflowNode<T> {
  readonly id: string
  readonly dependsOn?: readonly string[]
  /** Nodes sharing a mutation key are serialized even when otherwise independent. */
  readonly mutationKey?: string
  readonly run: () => Promise<T>
}

export interface WorkflowResult<T> {
  readonly results: Readonly<Record<string, T>>
  readonly order: readonly string[]
  readonly peakConcurrency: number
  readonly criticalPathMs: number
}

const validId = (id: string): string => {
  if (typeof id !== 'string' || !id.trim()) fail('Workflow node id must be non-empty.', 'INVALID_INPUT')
  return id.trim()
}

const levels = <T>(nodes: readonly WorkflowNode<T>[]): readonly WorkflowNode<T>[][] => {
  const byId = new Map(nodes.map((node) => [validId(node.id), node]))
  if (byId.size !== nodes.length) fail('Workflow node ids must be unique.', 'INVALID_INPUT')
  const remaining = new Set(byId.keys())
  const completed = new Set<string>()
  const result: WorkflowNode<T>[][] = []
  while (remaining.size) {
    const ready = [...remaining].sort().map((id) => byId.get(id)!).filter((node) => (node.dependsOn ?? []).every((dependency) => completed.has(dependency)))
    if (!ready.length) fail('Workflow contains an unknown dependency or cycle.', 'INVALID_INPUT')
    result.push(ready)
    for (const node of ready) { remaining.delete(node.id); completed.add(node.id) }
  }
  return result
}

export const runWorkflow = async <T>(nodes: readonly WorkflowNode<T>[], options: { readonly maxConcurrency: number; readonly currentConcurrency?: () => number }): Promise<WorkflowResult<T>> => {
  if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) fail('maxConcurrency must be a positive integer.', 'INVALID_INPUT')
  const started = Date.now()
  const results: Record<string, T> = {}
  const order: string[] = []
  let peakConcurrency = 0
  for (const level of levels(nodes)) {
    const remaining = [...level]
    while (remaining.length) {
      const batch: WorkflowNode<T>[] = []
      const keys = new Set<string>()
      const limit = options.currentConcurrency ? options.currentConcurrency() : options.maxConcurrency
      if (!Number.isInteger(limit) || limit < 1) fail('currentConcurrency must return a positive integer.', 'INVALID_INPUT')
      for (const node of remaining) {
        const key = node.mutationKey?.trim()
        if (batch.length >= limit || (key && keys.has(key))) continue
        batch.push(node)
        if (key) keys.add(key)
      }
      if (!batch.length) fail('Workflow could not schedule a mutation batch.', 'INVALID_INPUT')
      peakConcurrency = Math.max(peakConcurrency, batch.length)
      const values = await Promise.all(batch.map((node) => node.run()))
      batch.forEach((node, index) => { results[node.id] = values[index]!; order.push(node.id) })
      for (const node of batch) remaining.splice(remaining.indexOf(node), 1)
    }
  }
  return { results, order, peakConcurrency, criticalPathMs: Date.now() - started }
}
