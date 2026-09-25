import { describe, expect, it } from 'vitest'
import { QUESTION_CLOSE, QUESTION_OPEN, extractOutputBlock, parseQuestionOutput, prdGaps } from '../src/index.js'

const fenced = (body: string): string => `Here is the next question.\n\n\`\`\`json\n${body}\n\`\`\`\n`

describe('extractOutputBlock', () => {
  it('prefers the markers, and strips a fence inside them', () => {
    expect(extractOutputBlock(`noise ${QUESTION_OPEN}\n\`\`\`json\n{"a":1}\n\`\`\`\n${QUESTION_CLOSE}`, QUESTION_OPEN, QUESTION_CLOSE)).toBe('{"a":1}')
  })

  it('falls back to the last fenced JSON block when a model drops the markers', () => {
    expect(extractOutputBlock(`${fenced('{"old":true}')}\n${fenced('{"new":true}')}`, QUESTION_OPEN, QUESTION_CLOSE)).toBe('{"new":true}')
  })

  it('finds nothing when there is neither a marker nor a fenced JSON value', () => {
    expect(extractOutputBlock('just prose', QUESTION_OPEN, QUESTION_CLOSE)).toBeNull()
    expect(extractOutputBlock('```bash\nls\n```', QUESTION_OPEN, QUESTION_CLOSE)).toBeNull()
  })
})

describe('mangled markers (observed shape: opened with two brackets, closed with the opening marker plus >>>)', () => {
  it('recovers the last complete JSON object instead of an empty slice between the wrong markers', () => {
    const object = { question: 'Who are the users?', field: 'users', options: ['a'], complete: false }
    const text = `<<LOOP_QUESTION\n${JSON.stringify({ draft: true })}\n<<LOOP_QUESTION>>\nWait, the markers were wrong. Re-emitting.\n<<LOOP_QUESTION\n${JSON.stringify(object, null, 2)}\n${QUESTION_OPEN}>>>`
    expect(JSON.parse(extractOutputBlock(text, QUESTION_OPEN, QUESTION_CLOSE) ?? 'null')).toEqual(object)
    expect(parseQuestionOutput(text).field).toBe('users')
  })
})

describe('a question answered without markers (observed shape: fenced JSON, every PRD field an empty string)', () => {
  it('parses, and the empty fields are gaps rather than a failed round', () => {
    const question = parseQuestionOutput(fenced(JSON.stringify({
      prd: { objective: '', users: '', inScope: '', successCriteria: '' },
      question: 'What is the primary objective?', field: 'objective', options: ['a', 'b'], recommendation: 'a', complete: false,
    })))
    expect(question.field).toBe('objective')
    expect(prdGaps(question.prd)).toEqual(['objective', 'users', 'inScope', 'successCriteria'])
  })
})
