import type { IncomingMessage, ServerResponse } from 'node:http'

/** Small HTTP helpers shared by `server.ts` and the route modules under `routes-*.ts`. */

export const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/

export const json = (value: unknown): string => JSON.stringify(value)
export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = json(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}
export const sendText = (response: ServerResponse, status: number, body: string, contentType = 'text/html; charset=utf-8'): void => {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

export const readRequestBody = (request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> => new Promise((resolve, reject) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => { body += chunk; if (Buffer.byteLength(body) > maxBytes) reject(new Error('Request body is too large.')) })
  request.on('end', () => { if (!body.trim()) return resolve({}); try { resolve(JSON.parse(body) as unknown) } catch { reject(new Error('Request body must be valid JSON.')) } })
  request.on('error', reject)
})

export const recordOf = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const stringOf = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
