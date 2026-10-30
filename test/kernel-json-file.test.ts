import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { parseJsonFileText, readJsonFile } from '../src/kernel/json-file.js'

const dirs: string[] = []
const write = (text: string): string => { const dir = mkdtempSync(join(tmpdir(), 'ak-json-file-')); dirs.push(dir); const path = join(dir, 'f.json'); writeFileSync(path, text); return path }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const schema = z.object({ n: z.number() })

it('reads a valid file, tolerating a UTF-8 BOM', () => {
  expect(readJsonFile(write('{"n":1}'), schema)).toEqual({ n: 1 })
  expect(parseJsonFileText(write('﻿{"n":2}'))).toEqual({ n: 2 })
})

it('answers null for absent, unparseable and schema-invalid files', () => {
  expect(readJsonFile(join(tmpdir(), 'ak-json-file-missing.json'), schema)).toBeNull()
  expect(readJsonFile(write('{not json'), schema)).toBeNull()
  expect(readJsonFile(write('{"n":"x"}'), schema)).toBeNull()
})
