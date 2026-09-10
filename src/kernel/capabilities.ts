import { fail } from './errors.js'
import { hashJson } from './hash.js'

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 1 as const
export const CAPABILITY_KINDS = ['kernel', 'execution', 'adapter', 'composition'] as const
export type CapabilityKind = typeof CAPABILITY_KINDS[number]

export interface CapabilityDescriptor {
  readonly id: string
  readonly version: string
  readonly kind: CapabilityKind
  readonly entryPoint: string
  readonly exports: readonly string[]
  readonly dependencies?: readonly string[]
}

export interface CapabilityManifest {
  readonly type: 'agentskit-harness-capability-manifest'
  readonly schemaVersion: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION
  readonly package: string
  readonly packageVersion: string
  readonly entryPoint: string
  readonly sourceDigest: string
  readonly capabilities: readonly CapabilityDescriptor[]
  readonly digest: string
}

export interface CapabilityManifestInput {
  readonly package: string
  readonly packageVersion: string
  readonly entryPoint: string
  readonly sourceDigest: string
  readonly capabilities: readonly CapabilityDescriptor[]
}

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== 'string') fail(`${label} is required.`, 'INVALID_INPUT')
  const result = (value as string).trim()
  if (!result) fail(`${label} is required.`, 'INVALID_INPUT')
  return result
}

const digest = (value: unknown, label: string): string => {
  const result = nonEmpty(value, label)
  if (!/^[a-f0-9]{64}$/.test(result)) fail(`${label} must be a lowercase SHA-256 digest.`, 'INVALID_INPUT')
  return result
}

const stringList = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value)) fail(`${label} must be a non-empty string array.`, 'INVALID_INPUT')
  if (!(value as readonly unknown[]).length) fail(`${label} must be a non-empty string array.`, 'INVALID_INPUT')
  const items: readonly unknown[] = value as readonly unknown[]
  const result = items.map((item, index) => nonEmpty(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates.`, 'INVALID_INPUT')
  return result
}

const descriptor = (value: unknown, index: number): CapabilityDescriptor => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`capabilities[${index}] must be an object.`, 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  const kind = candidate['kind']
  if (typeof kind !== 'string' || !(CAPABILITY_KINDS as readonly string[]).includes(kind)) fail(`capabilities[${index}].kind is invalid.`, 'INVALID_INPUT')
  const dependencies = candidate['dependencies'] === undefined ? undefined : stringList(candidate['dependencies'], `capabilities[${index}].dependencies`)
  return {
    id: nonEmpty(candidate['id'], `capabilities[${index}].id`),
    version: nonEmpty(candidate['version'], `capabilities[${index}].version`),
    kind: kind as CapabilityKind,
    entryPoint: nonEmpty(candidate['entryPoint'], `capabilities[${index}].entryPoint`),
    exports: stringList(candidate['exports'], `capabilities[${index}].exports`),
    ...(dependencies === undefined ? {} : { dependencies }),
  }
}

const manifestBody = (input: CapabilityManifestInput): Omit<CapabilityManifest, 'digest'> => ({
  type: 'agentskit-harness-capability-manifest',
  schemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION,
  package: nonEmpty(input.package, 'package'),
  packageVersion: nonEmpty(input.packageVersion, 'packageVersion'),
  entryPoint: nonEmpty(input.entryPoint, 'entryPoint'),
  sourceDigest: digest(input.sourceDigest, 'sourceDigest'),
  capabilities: (Array.isArray(input.capabilities) ? input.capabilities : fail('capabilities must be an array.', 'INVALID_INPUT')).map(descriptor),
})

export const createCapabilityManifest = (input: CapabilityManifestInput): CapabilityManifest => {
  const body = manifestBody(input)
  if (!body.capabilities.length) fail('capabilities must be non-empty.', 'INVALID_INPUT')
  if (new Set(body.capabilities.map((item) => item.id)).size !== body.capabilities.length) fail('capability ids must be unique.', 'INVALID_INPUT')
  return { ...body, digest: hashJson(body) }
}

export const validateCapabilityManifest = (value: unknown): CapabilityManifest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Capability manifest must be an object.', 'INVALID_INPUT')
  const candidate = value as Record<string, unknown>
  const capabilities = Array.isArray(candidate['capabilities']) ? candidate['capabilities'] : fail('capabilities must be an array.', 'INVALID_INPUT')
  const body = manifestBody({ package: nonEmpty(candidate['package'], 'package'), packageVersion: nonEmpty(candidate['packageVersion'], 'packageVersion'), entryPoint: nonEmpty(candidate['entryPoint'], 'entryPoint'), sourceDigest: digest(candidate['sourceDigest'], 'sourceDigest'), capabilities: capabilities as readonly CapabilityDescriptor[] })
  if (new Set(body.capabilities.map((item) => item.id)).size !== body.capabilities.length) fail('capability ids must be unique.', 'INVALID_INPUT')
  if (candidate['type'] !== body.type || candidate['schemaVersion'] !== body.schemaVersion) fail('Capability manifest type or schemaVersion is invalid.', 'INVALID_INPUT')
  const manifestDigest = digest(candidate['digest'], 'digest')
  if (manifestDigest !== hashJson(body)) fail('Capability manifest digest is invalid.', 'INVALID_INPUT')
  return { ...body, digest: manifestDigest }
}
