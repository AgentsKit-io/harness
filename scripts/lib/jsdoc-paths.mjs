/**
 * JSDoc extraction over a TypeScript source file, by dotted path.
 *
 * `src/loop/config.ts` has **zero** `.describe()` calls and 178 JSDoc blocks; the Zod schema knows the types,
 * defaults and enums, and the JSDoc knows what any of it means. Neither source is sufficient alone, so the
 * reference generators read both and join them on the dotted path this module produces.
 */
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const sourceFileOf = (path) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)

/** The JSDoc text attached to a node, as one line — the first paragraph is what a table cell can hold. */
export const jsdocOf = (node) => {
  const blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
  const text = blocks.map((block) => typeof block.comment === 'string' ? block.comment : (block.comment ?? []).map((part) => part.text).join('')).join('\n').trim()
  return text
}

const nameOf = (property) => {
  const name = property.name
  if (!name) return null
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name)) return name.text
  return null
}

/** The object literal a Zod call wraps, if this expression is one: `z.object({…})`, `z.partialRecord(k, {…})`, … */
const objectLiteralArgument = (expression) => {
  if (!ts.isCallExpression(expression)) return null
  for (const argument of expression.arguments) if (ts.isObjectLiteralExpression(argument)) return argument
  return null
}

/**
 * Follow the chain a Zod field is written as — `z.object({…}).prefault({})`, `z.array(z.object({…})).default([])`
 * — down to the object literal that carries the nested fields, if there is one.
 */
const nestedObject = (expression) => {
  let current = expression
  for (let depth = 0; current && depth < 20; depth += 1) {
    if (ts.isCallExpression(current)) {
      // The shape that carries fields is the only object literal with properties: `.prefault({})` and
      // `.default({})` take an empty one, and taking theirs would silently drop every nested field.
      const rich = current.arguments.find((argument) => ts.isObjectLiteralExpression(argument) && argument.properties.length > 0)
      if (rich) return rich
      const inner = current.arguments.find((argument) => ts.isCallExpression(argument))
      if (inner) { current = inner; continue }
      current = ts.isPropertyAccessExpression(current.expression) ? current.expression.expression : null
      continue
    }
    if (ts.isPropertyAccessExpression(current)) { current = current.expression; continue }
    return null
  }
  return null
}

const walkObject = (object, prefix, out) => {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = nameOf(property)
    if (!name) continue
    const path = prefix ? `${prefix}.${name}` : name
    const doc = jsdocOf(property)
    if (doc) out.set(path, doc)
    const nested = nestedObject(property.initializer)
    if (nested) walkObject(nested, path, out)
  }
}

/**
 * Every documented dotted path inside `export const <name> = z.object({ … })`.
 *
 * Returns a Map of `dotted.path` → JSDoc text. A field with no JSDoc simply does not appear.
 */
export const jsdocPathsOfSchema = (path, name) => {
  const file = sourceFileOf(path)
  const out = new Map()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue
      const object = nestedObject(declaration.initializer)
      if (object) walkObject(object, '', out)
    }
  }
  return out
}

/** Every documented key of a plain `export const <name> = { … } as const` object, one level deep. */
export const jsdocKeysOfObject = (path, name) => {
  const file = sourceFileOf(path)
  const out = new Map()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue
      let initializer = declaration.initializer
      while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression
      if (!ts.isObjectLiteralExpression(initializer)) continue
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const key = nameOf(property)
        const doc = jsdocOf(property)
        if (key && doc) out.set(key, doc)
      }
    }
  }
  return out
}
