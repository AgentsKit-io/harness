import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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

  it('skips rotation (but still appends) when another process holds a fresh lock, and cleans up its own lock afterward', () => {
    const stateDir = tempStateDir()
    writeFileSync(join(stateDir, 'events.ndjson'), `${'x'.repeat(11 * 1024 * 1024)}\n`, 'utf8')
    const lockPath = join(stateDir, 'events.ndjson.lock')
    const held = openSync(lockPath, 'wx') // simulate another process mid-rotation, lock freshly taken
    try {
      appendLoopEvent(stateDir, { at: '2026-09-13T00:00:00.000Z', type: 'worker.dispatched', issue: 'ENG-1' }, undefined, () => new Date('2026-09-13T00:00:00.000Z'))
    } finally { closeSync(held) }
    // No rotation happened — the held lock was never touched, only cleaned up by whoever created it.
    expect(readdirSync(stateDir).filter((name) => name.startsWith('events-archive-'))).toHaveLength(0)
    // The event still landed in the (still-oversized) hot file — appending is never blocked by lock contention.
    const hot = readFileSync(join(stateDir, 'events.ndjson'), 'utf8')
    expect(hot).toContain('"issue":"ENG-1"')
    expect(hot).toContain('x'.repeat(100)) // the pre-existing oversized content is still there, untouched
  })

  it('recovers a stale lock (from a crashed holder) instead of waiting on it forever, then rotates normally', () => {
    const stateDir = tempStateDir()
    writeFileSync(join(stateDir, 'events.ndjson'), `${'x'.repeat(11 * 1024 * 1024)}\n`, 'utf8')
    const lockPath = join(stateDir, 'events.ndjson.lock')
    closeSync(openSync(lockPath, 'wx'))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old) // backdate it well past the 5s staleness threshold
    appendLoopEvent(stateDir, { at: '2026-09-13T00:00:00.000Z', type: 'worker.dispatched', issue: 'ENG-2' }, undefined, () => new Date('2026-09-13T00:00:00.000Z'))
    expect(readdirSync(stateDir).some((name) => name.startsWith('events-archive-'))).toBe(true)
    const hot = readFileSync(join(stateDir, 'events.ndjson'), 'utf8')
    expect(JSON.parse(hot.trim())).toMatchObject({ issue: 'ENG-2' })
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

  it('prunes archives older than 30 days when rotation runs, keeping recent ones', () => {
    const stateDir = tempStateDir()
    const rotateAtMs = 1789257600000 // 2026-09-13T00:00:00.000Z, matches the rotation test above
    const oldArchive = join(stateDir, 'events-archive-1700000000000.ndjson') // ~34 days before rotateAtMs
    const recentArchive = join(stateDir, 'events-archive-1788000000000.ndjson') // ~14.5 days before rotateAtMs
    writeFileSync(oldArchive, `${JSON.stringify({ at: '2023-11-14T00:00:00.000Z', type: 'worker.dispatched', issue: 'OLD-1' })}\n`, 'utf8')
    writeFileSync(recentArchive, `${JSON.stringify({ at: '2026-08-29T00:00:00.000Z', type: 'worker.dispatched', issue: 'RECENT-1' })}\n`, 'utf8')
    writeFileSync(join(stateDir, 'events.ndjson'), `${'x'.repeat(11 * 1024 * 1024)}\n`, 'utf8')
    appendLoopEvent(stateDir, { at: '2026-09-13T00:00:00.000Z', type: 'worker.dispatched', issue: 'ENG-1' }, undefined, () => new Date(rotateAtMs))
    const entries = readdirSync(stateDir)
    expect(entries).not.toContain('events-archive-1700000000000.ndjson')
    expect(entries).toContain('events-archive-1788000000000.ndjson')
    expect(entries).toContain('events-archive-1789257600000.ndjson') // the one rotation just created
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
