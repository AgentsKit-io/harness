#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const listSourceFiles = (root) => readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
  const path = join(root, entry.name)
  return entry.isDirectory() ? listSourceFiles(path) : extname(entry.name) === '.ts' ? [path] : []
})

const resolveModule = (file, specifier) => {
  const candidate = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'))
  if (existsSync(candidate)) return candidate
  const index = join(candidate, 'index.ts')
  return existsSync(index) ? index : null
}

const areaFor = (sourceRoot, file) => {
  const path = relative(sourceRoot, file).replaceAll('\\', '/')
  const [area] = path.split('/')
  return area === 'kernel' || area === 'execution' || area === 'context' || area === 'delivery' || area === 'profiles' || area === 'adapters' ? area : 'root'
}

const importPattern = /\b(import|export)\s+(type\s+)?[^;\n]*?\sfrom\s+['"]([^'"]+)['"]/g

export const findDependencyViolations = (sourceRoot = resolve('src')) => {
  const violations = []
  for (const file of listSourceFiles(sourceRoot)) {
    const sourceArea = areaFor(sourceRoot, file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const [, , typeKeyword, specifier] = match
      if (!specifier.startsWith('.')) continue
      const target = resolveModule(file, specifier)
      if (!target) continue
      const targetArea = areaFor(sourceRoot, target)
      const typeOnly = Boolean(typeKeyword)
      const forbidden = (sourceArea === 'kernel' && (targetArea === 'adapters' || (!typeOnly && ['execution', 'context', 'delivery', 'profiles'].includes(targetArea)))) ||
        (sourceArea === 'adapters' && targetArea === 'execution') ||
        (sourceArea === 'execution' && targetArea === 'adapters')
      if (forbidden) violations.push({ source: relative(sourceRoot, file).replaceAll('\\', '/'), target: relative(sourceRoot, target).replaceAll('\\', '/'), typeOnly })
    }
  }
  return violations
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const violations = findDependencyViolations(resolve(process.argv[2] ?? 'src'))
  console.log(JSON.stringify(violations.length ? { status: 'failed', criteria: ['dependency-direction'], violations } : { status: 'passed', criteria: ['dependency-direction'], violations: [] }))
  process.exitCode = violations.length ? 1 : 0
}
