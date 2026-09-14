import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EVIDENCE_BUNDLE_SCHEMA_VERSION, exportEvidenceBundle, readEvidenceTrustStore, verifyEvidenceBundle } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-bundle-')); cleanups.push(dir); return dir }

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const validBundle = () => {
  const unsigned = {
    type: 'agentskit-harness-evidence-bundle' as const, schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    runId: 'run-1', signerKeyId: 'fixture-v1', sourceRevision: 'a'.repeat(40), configHash: 'c'.repeat(64), contractHash: 'd'.repeat(64), verificationDigest: 'e'.repeat(64),
    eventLog: { status: 'verified', eventCount: 0 } as never,
    files: [
      { path: `runs/run-1/run.json`, sha256: 'a'.repeat(64), contentBase64: Buffer.from('{}').toString('base64') },
      { path: `runs/run-1/events.ndjson`, sha256: 'a'.repeat(64), contentBase64: Buffer.from('').toString('base64') },
    ],
  }
  // real sha256 for the two files so hash checks pass
  const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex')
  unsigned.files[0]!.sha256 = sha256('{}')
  unsigned.files[1]!.sha256 = sha256('')
  const payloadHash = sha256(JSON.stringify(unsigned))
  const signatureBase64 = sign(null, Buffer.from(payloadHash), privateKey).toString('base64')
  return { ...unsigned, payloadHash, signature: { algorithm: 'ed25519' as const, keyId: 'fixture-v1', publicKeyPem, signatureBase64 } }
}

const writeBundle = (bundle: unknown): string => {
  const dir = tempDir()
  const path = join(dir, 'evidence.json')
  writeFileSync(path, JSON.stringify(bundle))
  return path
}

describe('verifyEvidenceBundle: metadata validation', () => {
  it('accepts a well-formed, correctly signed bundle', () => {
    expect(verifyEvidenceBundle(writeBundle(validBundle()))).toMatchObject({ status: 'verified', runId: 'run-1', fileCount: 2, signed: true })
  })

  it('rejects invalid JSON', () => {
    const dir = tempDir()
    const path = join(dir, 'evidence.json')
    writeFileSync(path, 'not json')
    expect(() => verifyEvidenceBundle(path)).toThrow(/Invalid evidence bundle JSON/)
  })

  it('rejects a wrong type, schemaVersion, missing runId, or malformed signerKeyId/payloadHash', () => {
    expect(() => verifyEvidenceBundle(writeBundle({ ...validBundle(), type: 'wrong' }))).toThrow(/metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...validBundle(), schemaVersion: 2 }))).toThrow(/metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...validBundle(), runId: '' }))).toThrow(/metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...validBundle(), signerKeyId: '!!!' }))).toThrow(/metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...validBundle(), payloadHash: 'not-hex' }))).toThrow(/metadata is invalid/)
  })

  it('rejects a malformed or mismatched signature block', () => {
    const b = validBundle()
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, signature: { ...b.signature, algorithm: 'rsa' } }))).toThrow(/metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, signature: { ...b.signature, keyId: 'someone-else' } }))).toThrow(/metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, signature: { ...b.signature, publicKeyPem: 123 } }))).toThrow(/metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, signature: { ...b.signature, signatureBase64: 123 } }))).toThrow(/metadata is invalid/)
  })

  it('rejects a non-array files field', () => {
    expect(() => verifyEvidenceBundle(writeBundle({ ...validBundle(), files: 'nope' }))).toThrow(/metadata is invalid/)
  })

  it('rejects an untrusted or revoked signer, and a public key mismatch against the trust store', () => {
    const path = writeBundle(validBundle())
    expect(() => verifyEvidenceBundle(path, { trustedKeys: [{ keyId: 'someone-else', publicKeyPem, status: 'active' }] })).toThrow(/not trusted/)
    expect(() => verifyEvidenceBundle(path, { trustedKeys: [{ keyId: 'fixture-v1', publicKeyPem, status: 'revoked' }] })).toThrow(/revoked/)
    expect(() => verifyEvidenceBundle(path, { trustedKeys: [{ keyId: 'fixture-v1', publicKeyPem: 'different', status: 'active' }] })).toThrow(/does not match trust store/)
  })

  it('rejects a malformed file entry, a duplicate path, and a file hash mismatch', () => {
    const b = validBundle()
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, files: [{ path: 1, sha256: 'x', contentBase64: 'y' }] }))).toThrow(/file metadata is invalid/)
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, files: [b.files[0], b.files[0]] }))).toThrow(/file metadata is invalid/)
    const tampered = { ...b, files: [{ ...b.files[0]!, contentBase64: Buffer.from('tampered').toString('base64') }, b.files[1]] }
    expect(() => verifyEvidenceBundle(writeBundle(tampered))).toThrow(/file hash mismatch/)
  })

  it('rejects a bundle missing the run projection or event log file', () => {
    const b = validBundle()
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, files: [b.files[0]] }))).toThrow(/missing the run projection or event log/)
  })

  it('rejects a tampered payloadHash and an invalid signature', () => {
    const b = validBundle()
    expect(() => verifyEvidenceBundle(writeBundle({ ...b, payloadHash: 'a'.repeat(64) }))).toThrow(/payload hash mismatch/)
    const otherKey = generateKeyPairSync('ed25519')
    const wrongSig = { ...b, signature: { ...b.signature, publicKeyPem: otherKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
    expect(() => verifyEvidenceBundle(writeBundle(wrongSig))).toThrow(/signature is invalid/)
  })

  it('rejects a single file whose base64 payload exceeds maxFileBytes, before ever decoding it', () => {
    const b = validBundle()
    const oversized = { path: 'runs/run-1/extra.bin', sha256: 'a'.repeat(64), contentBase64: 'A'.repeat(1000) }
    const bundleWithOversizedFile = { ...b, files: [...b.files, oversized] }
    expect(() => verifyEvidenceBundle(writeBundle(bundleWithOversizedFile), { maxFileBytes: 100 })).toThrow(/exceeds the maximum allowed size: runs\/run-1\/extra\.bin/)
  })

  it('rejects a bundle whose files individually fit but collectively exceed maxTotalBytes', () => {
    const b = validBundle()
    const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex')
    const extraContent = 'x'.repeat(200)
    const extra = { path: 'runs/run-1/extra.bin', sha256: sha256(extraContent), contentBase64: Buffer.from(extraContent).toString('base64') }
    const bundleWithExtra = { ...b, files: [...b.files, extra] }
    expect(() => verifyEvidenceBundle(writeBundle(bundleWithExtra), { maxFileBytes: 1_000, maxTotalBytes: 150 })).toThrow(/exceeds the maximum total allowed size/)
  })

  it('accepts a bundle within custom, smaller limits', () => {
    const b = validBundle()
    expect(verifyEvidenceBundle(writeBundle(b), { maxFileBytes: 1_000, maxTotalBytes: 1_000 })).toMatchObject({ status: 'verified' })
  })
})

describe('readEvidenceTrustStore', () => {
  it('reads a valid trust store', () => {
    const dir = tempDir()
    const path = join(dir, 'trust.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: 'k1', publicKeyPem, status: 'active' }] }))
    expect(readEvidenceTrustStore(path)).toEqual([{ keyId: 'k1', publicKeyPem, status: 'active' }])
  })

  it('rejects the wrong schemaVersion or a non-array keys field', () => {
    const dir = tempDir()
    const path = join(dir, 'trust.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, keys: [] }))
    expect(() => readEvidenceTrustStore(path)).toThrow(/schemaVersion 1 and a keys array/)
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: 'nope' }))
    expect(() => readEvidenceTrustStore(path)).toThrow(/schemaVersion 1 and a keys array/)
  })

  it('rejects a malformed key entry', () => {
    const dir = tempDir()
    const path = join(dir, 'trust.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: '!!!', publicKeyPem, status: 'active' }] }))
    expect(() => readEvidenceTrustStore(path)).toThrow(/Invalid evidence trust store key at index 0/)
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: 'k1', publicKeyPem: 1, status: 'active' }] }))
    expect(() => readEvidenceTrustStore(path)).toThrow(/Invalid evidence trust store key at index 0/)
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: [{ keyId: 'k1', publicKeyPem, status: 'pending' }] }))
    expect(() => readEvidenceTrustStore(path)).toThrow(/Invalid evidence trust store key at index 0/)
  })
})

describe('exportEvidenceBundle: guard clauses', () => {
  it('rejects a malformed keyId before touching the filesystem', async () => {
    await expect(exportEvidenceBundle({ configPath: '/nonexistent/config.json', outputPath: '/tmp/x.json', privateKeyPath: '/tmp/key.pem', keyId: '!!!' })).rejects.toThrow(/keyId must contain only letters, numbers, dot, underscore, colon, or hyphen/)
  })

  it('rejects exporting when no verification run exists yet', async () => {
    const root = tempDir()
    mkdirSync(join(root, '.codex'), { recursive: true })
    const configPath = join(root, '.codex', 'verification.json')
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, project: 'fixture', root: '..', profile: 'strict', contract: { intent: 'x', scope: { inScope: ['a'], outOfScope: [] }, ambiguities: [], outcomes: [{ id: 'o', statement: 's', checks: ['logic'] }] }, surfaces: { logic: true, endpoint: false, database: false, cli: false, mcp: false, ui: false, docs: false }, checks: [{ id: 'logic', category: 'logic', command: 'true', evidence: 'structured' }], tracking: { required: false, reason: 'fixture' } }))
    await expect(exportEvidenceBundle({ configPath, outputPath: join(root, 'out.json'), privateKeyPath: join(root, 'key.pem'), keyId: 'fixture-v1' })).rejects.toThrow(/No verification run exists/)
  })
})
