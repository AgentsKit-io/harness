import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findExecutable, parseJsonEnvelope } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const binDir = (files: Record<string, boolean>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-command-bin-')); cleanups.push(dir)
  for (const [name, isExecutable] of Object.entries(files)) { writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(dir, name), isExecutable ? 0o755 : 0o644) }
  return dir
}

describe('findExecutable', () => {
  it('returns null for a blank or non-string name', () => {
    expect(findExecutable('')).toBeNull()
    expect(findExecutable('   ')).toBeNull()
    expect(findExecutable(undefined as never)).toBeNull()
  })

  it('resolves an absolute path directly, without consulting PATH', () => {
    const dir = binDir({ tool: true })
    const absolute = join(dir, 'tool')
    expect(findExecutable(absolute, { PATH: '/nonexistent' }, 'darwin')).toBe(absolute)
  })

  it('returns null for an absolute or slash-containing path that does not exist', () => {
    expect(findExecutable('/nonexistent/tool', {}, 'darwin')).toBeNull()
    expect(findExecutable('./relative/tool', {}, 'darwin')).toBeNull()
    expect(findExecutable('sub\\tool', {}, 'darwin')).toBeNull()
  })

  it('finds a plain name on PATH, skipping directories with no match', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agentskit-command-empty-')); cleanups.push(empty)
    const dir = binDir({ tool: true })
    const env = { PATH: [empty, dir].join(delimiter) }
    expect(findExecutable('tool', env, 'darwin')).toBe(join(dir, 'tool'))
  })

  it('returns null when PATH is empty or unset', () => {
    expect(findExecutable('tool', {}, 'darwin')).toBeNull()
  })

  it('skips a PATH entry whose candidate exists but is not executable', () => {
    const dir = binDir({ tool: false })
    expect(findExecutable('tool', { PATH: dir }, 'darwin')).toBeNull()
  })

  it('on win32, tries each PATHEXT extension and falls back to the bare filename', () => {
    const dir = binDir({ 'tool.EXE': true })
    expect(findExecutable('tool', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(join(dir, 'tool.EXE'))
    const bareDir = binDir({ tool: true })
    expect(findExecutable('tool', { PATH: bareDir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(join(bareDir, 'tool'))
  })

  it('uses the default PATHEXT list on win32 when none is set', () => {
    const dir = binDir({ 'tool.CMD': true })
    expect(findExecutable('tool', { PATH: dir }, 'win32')).toBe(join(dir, 'tool.CMD'))
  })
})

describe('parseJsonEnvelope', () => {
  it('returns null for empty/blank input', () => {
    expect(parseJsonEnvelope('')).toBeNull()
    expect(parseJsonEnvelope('   ')).toBeNull()
  })

  it('returns null for a non-object JSON value (array, number, string, null)', () => {
    expect(parseJsonEnvelope('[1,2,3]')).toBeNull()
    expect(parseJsonEnvelope('42')).toBeNull()
    expect(parseJsonEnvelope('"just a string"')).toBeNull()
    expect(parseJsonEnvelope('null')).toBeNull()
  })

  it('returns null when the ok field is missing or not boolean', () => {
    expect(parseJsonEnvelope('{"result":{}}')).toBeNull()
    expect(parseJsonEnvelope('{"ok":"true","result":{}}')).toBeNull()
  })

  it('accepts a plain string error and omits error entirely when absent', () => {
    expect(parseJsonEnvelope('{"ok":false,"error":"boom"}')).toEqual({ ok: false, result: undefined, error: 'boom' })
    const noError = parseJsonEnvelope('{"ok":true,"result":1}')
    expect(noError).toEqual({ ok: true, result: 1 })
    expect(noError).not.toHaveProperty('error')
  })

  it('ignores a malformed error field (neither string nor {message: string})', () => {
    expect(parseJsonEnvelope('{"ok":false,"error":42}')).toEqual({ ok: false, result: undefined })
    expect(parseJsonEnvelope('{"ok":false,"error":{}}')).toEqual({ ok: false, result: undefined })
  })
})
