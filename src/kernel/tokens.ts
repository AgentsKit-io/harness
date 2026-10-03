import { approximateCounter } from '@agentskit/core'

/**
 * Estimate context tokens from serialized JSON using the existing JS string
 * length / 4 rule, rounded up with a minimum of one. Core's approximateCounter
 * adds two tokens per message and counts the four-character `user` role, so
 * remove those three tokens here (one from the role and two from overhead).
 */
export const estimateContextTokens = (serialized: string): number => {
  const count = approximateCounter.count([{ role: 'user', content: serialized }])
  if (typeof count !== 'number') throw new TypeError('The core approximate counter must be synchronous.')
  return Math.max(1, count - 3)
}
