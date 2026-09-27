import { afterEach, describe, expect, it } from 'vitest'
import { snapshotErrorText, sseNeedsPolling } from '../src/ui/app/src/lib/api.js'
import { startUiServer, type UiServerHandle } from '../src/ui/api/server.js'

const servers: UiServerHandle[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

/** Reads the SSE stream until the first complete message (blank-line terminated). */
const firstMessage = async (server: UiServerHandle): Promise<string> => {
  const controller = new AbortController()
  const response = await fetch(`${server.url}api/v1/events?session=${server.token}`, { signal: controller.signal })
  const reader = response.body!.getReader()
  let text = ''
  while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value) }
  controller.abort()
  return text
}

describe('SSE snapshot failures', () => {
  it('are sent as `snapshot-error`, never as `error` (which EventSource treats as a dropped connection)', async () => {
    const server = await startUiServer({ port: 0, snapshot: () => { throw new Error('orca exploded') } })
    servers.push(server)
    const message = await firstMessage(server)
    expect(message).toMatch(/^event: snapshot-error\n/)
    expect(message).not.toMatch(/^event: error\n/m)
    expect(snapshotErrorText(message.split('data: ')[1]!.trim())).toBe('orca exploded')
  })

  it('the client polls only when the source is not open, and shows the server error text', () => {
    // EventSource.CONNECTING = 0, OPEN = 1, CLOSED = 2.
    expect(sseNeedsPolling(1)).toBe(false)
    expect(sseNeedsPolling(0)).toBe(true)
    expect(sseNeedsPolling(2)).toBe(true)
    expect(snapshotErrorText('not json')).toBe('The server could not build a snapshot.')
  })
})
