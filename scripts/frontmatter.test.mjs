import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseDocument } from './lib/frontmatter.mjs'

test('frontmatter handles folded descriptions, CRLF, BOM, and block lists', () => {
  const markdown = '\uFEFF---\r\ntitle: Guide\r\ndescription: >\r\n  First line\r\n  second line\r\ntags:\r\n  - one\r\n  - two\r\n---\r\n# Body\r\n'
  const { fields, body } = parseDocument(markdown)

  assert.equal(fields.title, 'Guide')
  assert.equal(fields.description, 'First line second line\n')
  assert.deepEqual(fields.tags, ['one', 'two'])
  assert.equal(body, '# Body\n')
})
