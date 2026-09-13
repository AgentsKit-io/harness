import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendLoopEvent, readLoopEvents } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempStateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-events-rotation-')); cleanups.push(dir); return dir }

describe('events.ndjson rotation', () => {
  it('rotates the hot file to a timestamped archive once it grows past the threshold', () => {
    const stateDir = tempStateDir()
    // Seed the hot file past the rotation threshold directly, instead of appending millions of small events.
    writeFileSync(join(stateDir, 'events.ndjson'), `${'x'.repeat(11 * 1024 * 1024)}\n`, 'utf8')
    appendLoopEvent(stateDir, { at: '2026-09-13T00:00:00.000Z', type: 'worker.dispatched', issue: 'ENG-1' }, undefined, () => new Date('2026-09-13T00:00:00.000Z'))
    const entries = readdirSync(stateDir)
    expect(entries).toContain('events-archive-1789257600000.ndjson')
    // The hot file is fresh again, holding only what was appended after rotation.
    const hot = readFileSync(join(stateDir, 'events.ndjson'), 'utf8')
    expect(hot).not.toContain('x'.repeat(100))
    expect(JSON.parse(hot.trim())).toMatchObject({ issue: 'ENG-1' })
  })

  it('never rotates while under the threshold', () => {
    const stateDir = tempStateDir()
    appendLoopEvent(stateDir, { at: '2026-09-13T00:00:00.000Z', type: 'worker.dispatched', issue: 'ENG-1' })
    appendLoopEvent(stateDir, { at: '2026-09-13T00:01:00.000Z', type: 'pr.merged', issue: 'ENG-1' })
    expect(readdirSync(stateDir).filter((name) => name.startsWith('events-archive-'))).toHaveLength(0)
    expect(statSync(join(stateDir, 'events.ndjson')).size).toBeGreaterThan(0)
  })

  it('readLoopEvents merges archives with the hot file, oldest first, when no sinceMs is given', () => {
    const stateDir = tempStateDir()
    writeFileSync(join(stateDir, 'events-archive-1000.ndjson'), `${JSON.stringify({ at: '2026-09-01T00:00:00.000Z', type: 'worker.dispatched', issue: 'OLD-1' })}\n`, 'utf8')
    writeFileSync(join(stateDir, 'events-archive-2000.ndjson'), `${JSON.stringify({ at: '2026-09-05T00:00:00.000Z', type: 'worker.dispatched', issue: 'OLD-2' })}\n`, 'utf8')
    writeFileSync(join(stateDir, 'events.ndjson'), `${JSON.stringify({ at: '2026-09-13T00:00:00.000Z', type: 'worker.dispatched', issue: 'NEW-1' })}\n`, 'utf8')
    const events = readLoopEvents(stateDir)
    expect(events.map((event) => event.issue)).toEqual(['OLD-1', 'OLD-2', 'NEW-1'])
  })

  it('readLoopEvents skips an archive whose rotation time predates sinceMs, without reading it', () => {
    const stateDir = tempStateDir()
    const staleArchive = join(stateDir, 'events-archive-1000.ndjson')
    writeFileSync(staleArchive, 'not valid json {{{', 'utf8') // would throw if this file were ever parsed
    writeFileSync(join(stateDir, 'events-archive-9999999999999.ndjson'), `${JSON.stringify({ at: '2026-09-12T00:00:00.000Z', type: 'worker.dispatched', issue: 'RECENT-1' })}\n`, 'utf8')
    writeFileSync(join(stateDir, 'events.ndjson'), `${JSON.stringify({ at: '2026-09-13T00:00:00.000Z', type: 'worker.dispatched', issue: 'NEW-1' })}\n`, 'utf8')
    const events = readLoopEvents(stateDir, 5_000)
    expect(events.map((event) => event.issue)).toEqual(['RECENT-1', 'NEW-1'])
  })
})
