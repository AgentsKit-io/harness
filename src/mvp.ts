// MVP requirements manifest (docs/mvp.yaml): parser, validator, approval digest and the product report.
// Port of the factory's mvp_manifest.py; the digest must stay byte-identical (golden test: docs/fixtures/mvp).
// The file is a strict YAML subset, parsed here on purpose so a manifest means the same thing in both tools.
import { createHash } from 'node:crypto'
import { splitLines } from '@agentskit/cross-platform'
import { isRecord } from './record.js'

export const MVP_FILES = ['docs/mvp.yaml', '.factory/mvp.yaml'] as const
export const MVP_LEVELS = ['merged', 'accepted', 'proven'] as const
export type MvpLevel = typeof MVP_LEVELS[number]
const ID_RE = /^[A-Z][A-Z0-9]*-[0-9]+[a-z]?$/
const LAUNCH_LABELS = ['piloto', 'público']
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

export class MvpManifestError extends Error {}
const bad = (message: string): never => { throw new MvpManifestError(message) }

// ponytail: a float is kept apart from an int only so the digest prints `1.0` like Python does; nothing else reads it.
class PyFloat { constructor(readonly value: number) {} }
const numberOf = (x: unknown): number | null => typeof x === 'number' ? x : x instanceof PyFloat ? x.value : null

// ---------- the YAML subset ----------
const stripComment = (s: string): string => {
  const out: string[] = []
  let q: string | null = null
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (q) {
      out.push(c)
      if (q === '"' && c === '\\' && i + 1 < s.length) { out.push(s[i + 1]!); i += 2; continue }
      if (c === q) q = null
    } else if ((c === '"' || c === "'") && (out.length === 0 || ' [,:-'.includes(out[out.length - 1]!) || out.join('').trim() === '')) {
      q = c; out.push(c)
    } else if (c === '#' && (out.length === 0 || out[out.length - 1] === ' ' || out[out.length - 1] === '\t')) {
      break
    } else out.push(c)
    i += 1
  }
  return out.join('').trimEnd()
}

const splitFlow = (s: string, lineno: number): string[] => {
  const items: string[] = []
  let cur: string[] = []
  let q: string | null = null
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (q) {
      cur.push(c)
      if (q === '"' && c === '\\' && i + 1 < s.length) { cur.push(s[i + 1]!); i += 2; continue }
      if (c === q) q = null
    } else if (c === '"' || c === "'") { q = c; cur.push(c) }
    else if ('[]{}'.includes(c)) bad(`linha ${lineno}: listas aninhadas em [ ] não são aceitas`)
    else if (c === ',') { items.push(cur.join('').trim()); cur = [] }
    else cur.push(c)
    i += 1
  }
  if (q) bad(`linha ${lineno}: aspas sem fechar`)
  const last = cur.join('').trim()
  if (last || items.length) items.push(last)
  if (items.some((x) => x === '')) bad(`linha ${lineno}: item vazio em [ ]`)
  return items
}

const scalar = (raw: string, lineno: number): unknown => {
  const s = raw.trim()
  if (s === '' || ['~', 'null', 'Null', 'NULL'].includes(s)) return null
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) bad(`linha ${lineno}: aspas sem fechar`)
    try { return JSON.parse(s) as unknown } catch (e) { return bad(`linha ${lineno}: texto entre aspas inválido (${(e as Error).message})`) }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) bad(`linha ${lineno}: aspas sem fechar`)
    return s.slice(1, -1).replaceAll("''", "'")
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) bad(`linha ${lineno}: [ sem fechar`)
    return splitFlow(s.slice(1, -1), lineno).map((x) => scalar(x, lineno))
  }
  if (s === '{}') return {}
  if (s.startsWith('{')) bad(`linha ${lineno}: mapas em { } não são aceitos; use um bloco indentado`)
  if ('&*!|>%@`'.includes(s[0]!)) bad(`linha ${lineno}: "${s[0]}" não é aceito aqui (use aspas)`)
  if (['true', 'True', 'TRUE'].includes(s)) return true
  if (['false', 'False', 'FALSE'].includes(s)) return false
  if (/^[-+]?[0-9]+$/.test(s)) return parseInt(s, 10)
  if (/^[-+]?([0-9]+\.[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$/.test(s)) return new PyFloat(parseFloat(s))
  if (s.includes(': ') || s.endsWith(':')) bad(`linha ${lineno}: ":" num texto sem aspas; ponha o texto entre aspas`)
  return s
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*|"[^"]*"|'[^']*')\s*:(\s+(.*))?$/

export const parseMvpYaml = (text: string): unknown => {
  const lines: [number, string][] = splitLines(text, { dropTrailingEmpty: false }).map((l, i) => [i + 1, l])
  for (const [n, l] of lines) if (l.slice(0, l.length - l.replace(/^[ \t]+/, '').length).includes('\t')) bad(`linha ${n}: tabulação na indentação: use espaços`)
  let pos = 0
  const peek = (): [number, number, string] | null => {
    while (pos < lines.length) {
      const [n, l] = lines[pos]!
      const c = stripComment(l)
      if (c.trim() === '' || (c.trim() === '---' && n === 1)) { pos += 1; continue }
      return [n, c.length - c.replace(/^ +/, '').length, c.trim()]
    }
    return null
  }
  const blockScalar = (style: string, parentIndent: number): string => {
    const fold = style[0] === '>'
    const chomp = style.slice(1, 2)
    const body: string[] = []
    let ind: number | null = null
    while (pos < lines.length) {
      const l = lines[pos]![1]
      if (l.trim() === '') { body.push(''); pos += 1; continue }
      const i = l.length - l.replace(/^ +/, '').length
      if (ind === null) {
        if (i <= parentIndent) break
        ind = i
      }
      if (i < ind) break
      body.push(l.slice(ind)); pos += 1
    }
    while (body.length && body[body.length - 1] === '' && chomp !== '+') body.pop()
    let s: string
    if (!fold) s = body.join('\n')
    else {
      const paras: string[] = []
      let cur: string[] = []
      for (const b of body) {
        if (b === '') { paras.push(cur.join(' ')); cur = [] } else cur.push(b.trim())
      }
      paras.push(cur.join(' '))
      s = paras.join('\n')
    }
    return s + (chomp !== '-' && s ? '\n' : '')
  }
  const valueAfter = (rest: string, n: number, indent: number): unknown => {
    if (['|', '|-', '|+', '>', '>-', '>+'].includes(rest)) { pos += 1; return blockScalar(rest, indent) }
    if (rest === '') {
      pos += 1
      const nxt = peek()
      if (nxt === null || nxt[1] < indent || (nxt[1] === indent && !nxt[2].startsWith('- ') && nxt[2] !== '-')) return null
      if (nxt[1] === indent) return parseBlock(indent, true)
      return parseBlock(nxt[1])
    }
    pos += 1
    return scalar(rest, n)
  }
  const parseBlock = (indent: number, listOnly = false): unknown => {
    const first = peek()
    if (first === null) return null
    if (first[2] === '-' || first[2].startsWith('- ')) {
      const out: unknown[] = []
      for (;;) {
        const cur = peek()
        if (cur === null || cur[1] < indent) break
        const [n, i, c] = cur
        if (i > indent) bad(`linha ${n}: indentação inesperada`)
        if (!(c === '-' || c.startsWith('- '))) {
          if (listOnly) break
          bad(`linha ${n}: esperava um item "- " da lista`)
        }
        const rest = c.slice(1).trim()
        if (KEY_RE.test(rest)) {
          const sub = i + 2
          lines[pos] = [n, ' '.repeat(sub) + rest]
          out.push(parseMap(sub))
        } else out.push(valueAfter(rest, n, i))
      }
      return out
    }
    if (listOnly) return null
    return parseMap(indent)
  }
  const parseMap = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (;;) {
      const cur = peek()
      if (cur === null || cur[1] < indent) break
      const [n, i, c] = cur
      if (i > indent) bad(`linha ${n}: indentação inesperada`)
      if (c === '-' || c.startsWith('- ')) break
      const m = KEY_RE.exec(c)
      if (!m) bad(`linha ${n}: esperava "chave: valor"`)
      let k = m![1]!
      if (k[0] === '"' || k[0] === "'") k = k.slice(1, -1)
      if (Object.hasOwn(out, k)) bad(`linha ${n}: chave repetida "${k}"`)
      out[k] = valueAfter((m![3] ?? '').trim(), n, i)
    }
    return out
  }
  const first = peek()
  if (first === null) return {}
  if (first[1] !== 0) bad(`linha ${first[0]}: o arquivo começa indentado`)
  const doc = parseBlock(0)
  const rest = peek()
  if (rest !== null) bad(`linha ${rest[0]}: conteúdo fora da estrutura (indentação?)`)
  return doc
}

// ---------- the manifest ----------
const normList = (v: unknown): unknown[] => v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]
const isIntPos = (x: unknown): boolean => typeof x === 'number' && Number.isInteger(x) && x > 0

const launchItemErrors = (item: unknown, where: string): string[] => {
  if (!isRecord(item)) return [`${where}: deve ser um mapa (date: AAAA-MM-DD, label: piloto|público)`]
  const errs: string[] = []
  const d = item['date']
  let ok = typeof d === 'string' && DATE_RE.test(d)
  if (ok) { const t = new Date(`${d as string}T00:00:00Z`); ok = !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d }
  if (!ok) errs.push(`${where}.date: data no formato AAAA-MM-DD`)
  const lb = item['label']
  if (lb !== undefined && lb !== null && !LAUNCH_LABELS.includes(lb as string)) errs.push(`${where}.label: ${LAUNCH_LABELS.join(' ou ')} (ou sem rótulo)`)
  const unknown = Object.keys(item).filter((k) => k !== 'date' && k !== 'label').sort()
  if (unknown.length) errs.push(`${where}: chaves desconhecidas ${JSON.stringify(unknown)}`)
  return errs
}

const launchErrors = (launch: unknown): string[] => {
  if (launch === undefined || launch === null) return []
  if (Array.isArray(launch)) {
    if (!launch.length) return ['launch: lista vazia']
    const errs = launch.flatMap((item, n) => launchItemErrors(item, `launch[${n + 1}]`))
    const dates = launch.filter(isRecord).map((i) => i['date'])
    if (new Set(dates).size !== dates.length) errs.push('launch: datas repetidas')
    return errs
  }
  return launchItemErrors(launch, 'launch')
}

export interface MvpLaunch { readonly date: string; readonly label: string | null }
/** Every valid launch, earliest first (empty: none or invalid). */
export const mvpLaunches = (doc: Record<string, unknown>): MvpLaunch[] => {
  const l = doc['launch']
  if (l === undefined || l === null || launchErrors(l).length) return []
  return (Array.isArray(l) ? l : [l]).map((i: Record<string, unknown>) => ({ date: i['date'] as string, label: (i['label'] as string | null | undefined) ?? null })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
}

const checkError = (c: unknown, kind: 'acceptance' | 'homolog'): string | null => {
  const allowed = kind === 'acceptance' ? ['test', 'ci', 'run'] : ['url', 'ci', 'run']
  if (!isRecord(c)) return `deve ser um mapa (${allowed.join('/')})`
  const wrong = ['test', 'url'].find((k) => k in c && !allowed.includes(k))
  if (wrong) return `${wrong} não vale como evidência de ${kind === 'acceptance' ? 'aceite' : 'homolog'}`
  if (!allowed.some((k) => k in c)) return `falta ${allowed.join(', ')}`
  if ('ci' in c) {
    const ci = c['ci']
    if (typeof ci !== 'string' && !(isRecord(ci) && typeof ci['job'] === 'string')) return 'ci: o nome do job (ci: ci) ou {job, step, workflow}'
  }
  if ('url' in c && !(typeof c['url'] === 'string' && /^(https:\/\/|\/)/.test(c['url']))) return 'url: https://... ou um caminho /... sobre homolog.base_url'
  if ('test' in c && typeof c['test'] !== 'string') return 'test: o caminho do arquivo de teste'
  if ('run' in c && typeof c['run'] !== 'string') return 'run: o caminho do registro (JSON) no repo'
  return null
}

const REQUIREMENT_KEYS = ['id', 'title', 'done_when', 'weight', 'acceptance', 'homolog', 'issues', 'prs', 'notes', 'source', 'size', 'decision']
const blank = (x: unknown): boolean => typeof x !== 'string' || x.trim() === ''

/** The format's errors (empty: valid). */
export const validateMvp = (doc: unknown): string[] => {
  if (!isRecord(doc)) return ['o arquivo não é um mapa (chave: valor)']
  const errs: string[] = []
  if (doc['version'] !== 1) errs.push('version: deve ser 1')
  let reqs = doc['requirements']
  if (!Array.isArray(reqs) || !reqs.length) { errs.push('requirements: lista vazia ou ausente'); reqs = [] }
  const ap = doc['approval']
  if (ap !== undefined && ap !== null && !isRecord(ap)) errs.push('approval: deve ser um mapa (by, at, digest)')
  errs.push(...launchErrors(doc['launch']))
  const seen = new Set<string>()
  ;(reqs as unknown[]).forEach((r, idx) => {
    let where = `requirements[${idx + 1}]`
    if (!isRecord(r)) { errs.push(`${where}: deve ser um mapa`); return }
    const rid = r['id']
    if (typeof rid !== 'string' || !ID_RE.test(rid)) errs.push(`${where}: id "${String(rid ?? 'None')}" fora do formato (ex.: RF-01)`)
    else if (seen.has(rid)) errs.push(`${where}: id repetido ${rid}`)
    else { seen.add(rid); where = rid }
    if (blank(r['title'])) errs.push(`${where}: title vazio`)
    if (blank(r['done_when'])) errs.push(`${where}: done_when (pronto quando) vazio`)
    const w = 'weight' in r ? numberOf(r['weight']) : 1
    if (w === null || w <= 0) errs.push(`${where}: weight deve ser um número > 0`)
    for (const k of ['issues', 'prs']) if (normList(r[k]).some((x) => !isIntPos(x))) errs.push(`${where}: ${k} deve ser uma lista de números`)
    for (const k of ['acceptance', 'homolog'] as const) normList(r[k]).forEach((c, j) => { const e = checkError(c, k); if (e) errs.push(`${where}: ${k}[${j + 1}]: ${e}`) })
    const unknown = Object.keys(r).filter((k) => !REQUIREMENT_KEYS.includes(k)).sort()
    if (unknown.length) errs.push(`${where}: chaves desconhecidas ${JSON.stringify(unknown)}`)
  })
  return errs
}

const pyNumber = (x: unknown): string => {
  if (x instanceof PyFloat) { const s = String(x.value); return Number.isInteger(x.value) && !s.includes('e') ? `${s}.0` : s }
  return String(x)
}

/** What the owner approves: ids, titles, done_when and weights in order (evidence links can change freely). */
export const mvpDigest = (doc: Record<string, unknown>): string => {
  const items = (Array.isArray(doc['requirements']) ? doc['requirements'] : []).filter(isRecord).map((r) => {
    const title = typeof r['title'] === 'string' ? r['title'].trim() : ''
    const doneWhen = typeof r['done_when'] === 'string' ? r['done_when'].split(/\s+/).filter(Boolean).join(' ') : ''
    // keys in sorted order, compact, non-ASCII kept: the same bytes as Python's json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return `{"done_when":${JSON.stringify(doneWhen)},"id":${JSON.stringify(r['id'] ?? null)},"title":${JSON.stringify(title)},"weight":${'weight' in r ? pyNumber(r['weight']) : '1'}}`
  })
  return createHash('sha256').update(`[${items.join(',')}]`).digest('hex').slice(0, 16)
}

export const mvpApprovalState = (doc: Record<string, unknown>, approvers: readonly string[] = []): { readonly approved: boolean; readonly why: string } => {
  const ap = isRecord(doc['approval']) ? doc['approval'] : {}
  const by = ap['by']
  const dg = ap['digest']
  if (!by) return { approved: false, why: 'lista ainda não aprovada' }
  if (approvers.length && !approvers.some((a) => a.toLowerCase() === String(by).toLowerCase())) return { approved: false, why: `aprovada por ${String(by)}, que não aprova listas de MVP` }
  if (!dg) return { approved: false, why: 'aprovação sem digest (approval.digest = ak-harness mvp digest <arquivo>)' }
  if (dg !== mvpDigest(doc)) return { approved: false, why: 'a lista mudou depois da aprovação (digest diferente): precisa de nova aprovação' }
  return { approved: true, why: `aprovada por ${String(by)}${ap['at'] ? ` em ${String(ap['at'])}` : ''}` }
}

/** Parse + validate; throws MvpManifestError with the first errors. */
export const loadMvp = (text: string): Record<string, unknown> => {
  const doc = parseMvpYaml(text)
  const errs = validateMvp(doc)
  if (errs.length) bad(errs.slice(0, 8).join('; ') + (errs.length > 8 ? ` … e mais ${errs.length - 8}` : ''))
  return doc as Record<string, unknown>
}

// ---------- the three levels ----------
/** Each answer is [ok, detail]; ok null = cannot be checked (sem evidência). */
export type MvpAnswer = readonly [boolean | null, string]
export interface MvpEvidence {
  pr(number: number): MvpAnswer
  ci(job: string, step: string | null, workflow: string | null): MvpAnswer
  file(path: string): MvpAnswer
  url(url: string, expect: unknown, contains: unknown): MvpAnswer
  run(path: string, maxAgeDays: unknown, rid: string): MvpAnswer
}

interface MvpCheck { readonly kind: string; readonly ref: string; readonly ok: boolean | null; readonly detail: string }
const ciSpec = (c: Record<string, unknown>): { job: string; step: string | null; workflow: string | null } | null => {
  const ci = c['ci']
  if (typeof ci === 'string') return { job: ci, step: null, workflow: null }
  if (isRecord(ci)) return { job: ci['job'] as string, step: (ci['step'] as string | null | undefined) ?? null, workflow: (ci['workflow'] as string | null | undefined) ?? null }
  return null
}

const evalCheck = (c: Record<string, unknown>, ev: MvpEvidence, baseUrl: string | null, rid: string): MvpCheck => {
  const ci = ciSpec(c)
  if ('test' in c) {
    const ref = String(c['test']) + (c['name'] ? ` :: ${String(c['name'])}` : '')
    if (!ci) return { kind: 'test', ref, ok: null, detail: 'sem evidência: o teste não diz o job de CI que o roda (ci:)' }
    const [okf, df] = ev.file(c['test'] as string)
    if (okf !== true) return { kind: 'test', ref, ok: okf, detail: df }
    const [okc, dc] = ev.ci(ci.job, ci.step, ci.workflow)
    return { kind: 'test', ref, ok: okc, detail: `${df}; ${dc}` }
  }
  if (ci) {
    const [ok, detail] = ev.ci(ci.job, ci.step, ci.workflow)
    return { kind: 'ci', ref: ci.job + (ci.step ? ` / ${ci.step}` : ''), ok, detail }
  }
  if ('url' in c) {
    let u = c['url'] as string
    if (u.startsWith('/')) {
      if (!baseUrl) return { kind: 'url', ref: u, ok: null, detail: 'sem evidência: caminho relativo sem homolog.base_url' }
      u = baseUrl.replace(/\/+$/, '') + u
    }
    const [ok, detail] = ev.url(u, c['expect'] ?? 200, c['contains'] ?? null)
    return { kind: 'url', ref: u, ok, detail }
  }
  if ('run' in c) {
    const [ok, detail] = ev.run(c['run'] as string, c['max_age_days'] ?? 30, rid)
    return { kind: 'run', ref: c['run'] as string, ok, detail }
  }
  return { kind: '?', ref: '', ok: null, detail: 'sem evidência: check sem tipo' }
}

/** True when all green; false when one failed; null (sem evidência) when none or any unknown and none failed. */
const levelOf = (checks: readonly { readonly ok: boolean | null; readonly detail: string }[], empty: string): MvpAnswer => {
  if (!checks.length) return [null, empty]
  const failed = checks.find((c) => c.ok === false)
  if (failed) return [false, failed.detail]
  const unknown = checks.find((c) => c.ok === null)
  if (unknown) return [null, unknown.detail]
  return [true, `${checks.length} verificação(ões) verdes`]
}

/** pronto: proven; bloqueado: a level failed; em QA: merged, not yet proven; sem começar: the rest. */
export type MvpState = 'pronto' | 'qa' | 'bloqueado' | 'sem-comecar'
export const MVP_STATES: readonly MvpState[] = ['pronto', 'qa', 'bloqueado', 'sem-comecar']

export interface MvpRequirementReport {
  readonly id: string; readonly title: string; readonly doneWhen: string; readonly weight: number
  readonly state: MvpState
  readonly levels: Record<MvpLevel, { readonly ok: boolean | null; readonly detail: string }>
}
export interface MvpReport {
  readonly approved: boolean; readonly approval: string; readonly digest: string
  readonly launch: MvpLaunch | null; readonly launches: readonly MvpLaunch[]
  readonly levels: Record<MvpLevel, { readonly count: number; readonly pct: number }>
  readonly states: Record<MvpState, number>
  readonly total: number; readonly weight: number; readonly noEvidence: number
  /** The official % (proven ÷ total by weight); null until the owner's approval matches the list. */
  readonly pct: number | null
  readonly requirements: readonly MvpRequirementReport[]
}

const safely = (ev: MvpEvidence): MvpEvidence => {
  const wrap = <A extends unknown[]>(f: (...a: A) => MvpAnswer) => (...a: A): MvpAnswer => { try { return f(...a) } catch (e) { return [null, `sem evidência: ${e instanceof Error ? e.message : String(e)}`] } }
  return { pr: wrap((n: number) => ev.pr(n)), ci: wrap((j: string, s: string | null, w: string | null) => ev.ci(j, s, w)), file: wrap((p: string) => ev.file(p)), url: wrap((u: string, e: unknown, c: unknown) => ev.url(u, e, c)), run: wrap((p: string, m: unknown, r: string) => ev.run(p, m, r)) }
}

/** The manifest against the evidence: per requirement the three levels and a state, and the totals (by weight). */
export const evaluateMvp = (doc: Record<string, unknown>, evidence: MvpEvidence, approvers: readonly string[] = []): MvpReport => {
  const ev = safely(evidence)
  const homolog = doc['homolog']
  const baseUrl = isRecord(homolog) ? (homolog['base_url'] as string | undefined) ?? null : null
  const count = { merged: 0, accepted: 0, proven: 0 }
  const weightOf = { merged: 0, accepted: 0, proven: 0 }
  const states: Record<MvpState, number> = { pronto: 0, qa: 0, bloqueado: 0, 'sem-comecar': 0 }
  let totalWeight = 0
  let noEvidence = 0
  const reqs: MvpRequirementReport[] = (doc['requirements'] as Record<string, unknown>[]).map((r) => {
    const w = 'weight' in r ? numberOf(r['weight'])! : 1
    const rid = r['id'] as string
    const lv: Record<MvpLevel, MvpAnswer> = {
      merged: levelOf(normList(r['prs']).map((n) => { const [ok, detail] = ev.pr(n as number); return { ok, detail } }), 'sem evidência: nenhum PR ligado'),
      accepted: levelOf(normList(r['acceptance']).map((c) => evalCheck(c as Record<string, unknown>, ev, baseUrl, rid)), 'sem evidência: nenhum teste de aceite ligado'),
      proven: levelOf(normList(r['homolog']).map((c) => evalCheck(c as Record<string, unknown>, ev, baseUrl, rid)), 'sem evidência: nenhuma verificação em homolog ligada'),
    }
    totalWeight += w
    for (const k of MVP_LEVELS) if (lv[k][0] === true) { count[k] += 1; weightOf[k] += w }
    if (MVP_LEVELS.every((k) => lv[k][0] === null)) noEvidence += 1
    const state: MvpState = MVP_LEVELS.some((k) => lv[k][0] === false) ? 'bloqueado' : lv.proven[0] ? 'pronto' : lv.merged[0] ? 'qa' : 'sem-comecar'
    states[state] += 1
    return { id: rid, title: r['title'] as string, doneWhen: (r['done_when'] as string).split(/\s+/).filter(Boolean).join(' '), weight: w, state, levels: { merged: { ok: lv.merged[0], detail: lv.merged[1] }, accepted: { ok: lv.accepted[0], detail: lv.accepted[1] }, proven: { ok: lv.proven[0], detail: lv.proven[1] } } }
  })
  // Python's round() is half-to-even; JS Math.round is half-up. Differs only at exact .5 of a percent.
  const pct = (k: MvpLevel): number => { if (!totalWeight) return 0; const x = 100 * weightOf[k] / totalWeight; const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r }
  const { approved, why } = mvpApprovalState(doc, approvers)
  const launches = mvpLaunches(doc)
  return {
    approved, approval: why, digest: mvpDigest(doc), launch: launches[0] ?? null, launches,
    levels: { merged: { count: count.merged, pct: pct('merged') }, accepted: { count: count.accepted, pct: pct('accepted') }, proven: { count: count.proven, pct: pct('proven') } },
    states, total: reqs.length, weight: totalWeight, noEvidence, pct: approved ? pct('proven') : null, requirements: reqs,
  }
}

/** Evidence from a JSON file: `{prs: {"12": true}, ci: {"job": true, "job/step": false}, files: {...}, urls: {...}, runs: {...}}`; absent keys are sem evidência. */
export const evidenceFromJson = (raw: unknown): MvpEvidence => {
  const src = isRecord(raw) ? raw : {}
  const look = (section: string, key: string): MvpAnswer => {
    const table = src[section]
    const v = isRecord(table) ? table[key] : undefined
    if (typeof v === 'boolean') return [v, v ? 'verde' : 'vermelho']
    if (isRecord(v) && typeof v['ok'] === 'boolean') return [v['ok'], typeof v['detail'] === 'string' ? v['detail'] : v['ok'] ? 'verde' : 'vermelho']
    return [null, `sem evidência: ${section} ${key} não consta no arquivo de evidências`]
  }
  return {
    pr: (n) => look('prs', String(n)),
    ci: (job, step) => look('ci', step ? `${job}/${step}` : job),
    file: (p) => look('files', p),
    url: (u) => look('urls', u),
    run: (p) => look('runs', p),
  }
}

export const formatMvpReport = (r: MvpReport): string => {
  const lines = [
    `MVP: ${r.total} requisitos (peso ${r.weight}); ${r.approved ? `aprovado, ${r.pct}% provado em homolog` : `não aprovado: ${r.approval}`}`,
    `mergeado com CI verde: ${r.levels.merged.count}/${r.total} (${r.levels.merged.pct}%)`,
    `aceite verde: ${r.levels.accepted.count}/${r.total} (${r.levels.accepted.pct}%)`,
    `provado em homolog: ${r.levels.proven.count}/${r.total} (${r.levels.proven.pct}%)`,
    `pronto ${r.states.pronto} | em QA ${r.states.qa} | bloqueado ${r.states.bloqueado} | sem começar ${r.states['sem-comecar']}`,
    '',
    ...r.requirements.map((q) => `${q.id}  ${q.state}  ${q.title}`),
  ]
  return lines.join('\n')
}
