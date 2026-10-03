import { expect, it } from 'vitest'
import { estimateContextTokens } from '../src/kernel/tokens.js'

it.each([
  'ASCII context references',
  '日本語のコンテキスト参照',
  'emoji 🙂 context',
])('preserves the existing serialized-string estimate for %s', (serialized) => {
  expect(estimateContextTokens(serialized)).toBe(Math.max(1, Math.ceil(serialized.length / 4)))
})
