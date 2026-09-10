import { basename, extname, dirname, join } from 'node:path'
import { fail } from './errors.js'

export interface ChangedFile {
  readonly path: string
  readonly status?: string
}

export interface FilePreflightPlan {
  readonly files: readonly string[]
  readonly codeFiles: readonly string[]
  readonly testFiles: readonly string[]
  readonly docsOnly: boolean
  readonly checks: readonly ('lint' | 'typecheck' | 'test')[]
}

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.adoc', '.rst'])
const TEST_SUFFIXES = ['.test.', '.spec.', '__tests__']
const SHELL_META = /[;&|`$()<>\n\r]/

const normalizedPath = (value: string, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty path.`, 'INVALID_INPUT')
  const path = value.trim().replaceAll('\\', '/')
  if (path.startsWith('/') || path.split('/').includes('..')) fail(`${label} must be repository-relative.`, 'INVALID_INPUT')
  return path
}

export const validateSafeCommand = (command: string): { readonly valid: true; readonly command: string } => {
  if (typeof command !== 'string' || !command.trim()) fail('command must be a non-empty string.', 'INVALID_INPUT')
  const value = command.trim()
  if (SHELL_META.test(value)) fail('command contains shell metacharacters; use argv-based execution.', 'POLICY_BLOCKED')
  return { valid: true, command: value }
}

const isTest = (path: string): boolean => TEST_SUFFIXES.some((suffix) => path.includes(suffix)) || /(^|\/)(test|tests|__tests__)\//.test(path)
const isDoc = (path: string): boolean => DOC_EXTENSIONS.has(extname(path).toLowerCase())

export const planFilePreflight = (files: readonly ChangedFile[], options: { readonly testRoots?: readonly string[]; readonly includeTests?: boolean } = {}): FilePreflightPlan => {
  if (!Array.isArray(files)) fail('files must be an array.', 'INVALID_INPUT')
  const unique = [...new Set(files.map((file, index) => normalizedPath(file.path, `files[${index}].path`)))].sort()
  const codeFiles = unique.filter((path) => !isDoc(path) && !isTest(path))
  const existingTests = unique.filter(isTest)
  const roots = (options.testRoots ?? ['test', 'tests', '__tests__']).map((root, index) => normalizedPath(root, `testRoots[${index}]`))
  const colocated = options.includeTests === false ? [] : codeFiles.flatMap((path) => {
    const file = basename(path)
    const directory = dirname(path)
    const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file
    return [join(directory, `${stem}.test.ts`), join(directory, `${stem}.spec.ts`)].filter((candidate) => unique.includes(candidate))
  })
  const testFiles = [...new Set([...existingTests, ...colocated, ...unique.filter((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)))].sort())]
  const docsOnly = unique.length > 0 && codeFiles.length === 0 && existingTests.length === 0
  return { files: unique, codeFiles, testFiles, docsOnly, checks: docsOnly ? [] : ['lint', 'typecheck', ...(testFiles.length ? ['test' as const] : [])] }
}
