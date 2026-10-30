import { spawnNodeChild } from '@agentskit/cross-platform'
import { expect, it } from 'vitest'
import { detachedForTreeKill, killProcessTree, KILL_GRACE_MS } from '../src/kernel/process-tree.js'

it('detaches on POSIX only', () => {
  expect(detachedForTreeKill()).toBe(process.platform !== 'win32')
  expect(KILL_GRACE_MS).toBeGreaterThan(0)
})

it('does nothing for a child that never spawned', () => {
  expect(() => killProcessTree({ pid: undefined } as never)).not.toThrow()
})

it('kills a child process', async () => {
  const child = spawnNodeChild('node', ['-e', 'setTimeout(() => {}, 30000)'], { detached: detachedForTreeKill(), stdio: 'ignore' })
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  killProcessTree(child)
  await closed
  expect(child.killed || child.signalCode !== null).toBe(true)
}, 15_000)
