// Collects the MVP evidence (the JSON `mvp report --evidence` reads) from GitHub, with the reference's rules:
// merged PR with green CI on the merge commit; job/step in the latest default-branch run, a continue-on-error step never counts;
// file on the default branch; URL with status and text; a recorded run younger than its validity.
import { parse as parseYaml } from 'yaml'
import { fail } from '../kernel/errors.js'
import { isRecord } from '../record.js'
import { evaluateMvp, type MvpAnswer } from '../mvp.js'
import type { CommandRunner } from './command.js'

/** GET a GitHub REST path as JSON; null when it does not exist (404). Recorded responses plug in here in tests. */
export type GitHubGet = (path: string) => Promise<unknown>
export interface UrlProbe { readonly status: number; readonly body: string }
export interface MvpEvidenceDeps { readonly get: GitHubGet; readonly probe: (url: string) => Promise<UrlProbe>; readonly now: Date }

type Section = 'prs' | 'ci' | 'files' | 'urls' | 'runs'
type Table = Record<Section, Record<string, { ok: boolean | null; detail: string }>>

/** `gh api` as the GitHubGet: a 404 is null, anything else that fails throws. */
export const ghApiGet = (runner: CommandRunner, bin = 'gh'): GitHubGet => async (path) => {
  const out = await runner.run([bin, 'api', path], { timeoutMs: 30_000 })
  if (out.timedOut) return fail(`gh api ${path} timed out.`, 'HARNESS_ERROR')
  if (out.code !== 0) {
    if (/HTTP 404|Not Found/i.test(out.stderr + out.stdout)) return null
    return fail(`gh api ${path} exited ${out.code ?? 'null'}: ${out.stderr.trim().slice(0, 300)}`, 'HARNESS_ERROR')
  }
  try { return JSON.parse(out.stdout) as unknown } catch { return fail(`gh api ${path} did not return JSON.`, 'HARNESS_ERROR') }
}

/** Real URL probe: a plain GET, no redirect following, so the status the page answers is the status recorded. */
export const fetchProbe = async (url: string): Promise<UrlProbe> => {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
  return { status: response.status, body: await response.text() }
}

const OK_CONCLUSIONS = ['success', 'neutral', 'skipped']
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const list = (v: unknown, key: string): Record<string, unknown>[] => isRecord(v) && Array.isArray(v[key]) ? (v[key] as unknown[]).filter(isRecord) : []
const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/')
const noEvidence = (why: string): MvpAnswer => [null, `sem evidência: ${why}`]

const collector = (repo: string, deps: MvpEvidenceDeps) => {
  const { get } = deps
  const cache = new Map<string, Promise<unknown>>()
  const cached = (path: string): Promise<unknown> => { const hit = cache.get(path) ?? get(path); cache.set(path, hit); return hit }
  const branch = async (): Promise<string> => {
    const info = await cached(`repos/${repo}`)
    return isRecord(info) && str(info['default_branch']) ? str(info['default_branch']) : fail(`Cannot read the default branch of ${repo}.`, 'HARNESS_ERROR')
  }
  const contents = async (path: string, ref: string): Promise<unknown> => cached(`repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`)
  const text = async (path: string, ref: string): Promise<string | null> => {
    const file = await contents(path, ref)
    return isRecord(file) && str(file['encoding']) === 'base64' ? Buffer.from(str(file['content']), 'base64').toString('utf8') : null
  }

  const pr = async (n: number): Promise<MvpAnswer> => {
    const p = await cached(`repos/${repo}/pulls/${n}`)
    if (!isRecord(p)) return noEvidence(`PR #${n} não encontrado`)
    if (p['merged'] !== true) return str(p['state']) === 'closed' ? [false, `PR #${n} fechado sem merge`] : noEvidence(`PR #${n} ainda não mergeado`)
    const sha = str(p['merge_commit_sha'])
    if (!sha) return noEvidence(`PR #${n} sem commit de merge`)
    const runs = list(await cached(`repos/${repo}/commits/${sha}/check-runs?per_page=100`), 'check_runs')
    const status = await cached(`repos/${repo}/commits/${sha}/status`)
    const statuses = list(status, 'statuses')
    const bad = [...runs.filter((r) => !OK_CONCLUSIONS.includes(str(r['conclusion']))).map((r) => str(r['name'])), ...(statuses.length && isRecord(status) && str(status['state']) !== 'success' ? statuses.filter((s) => str(s['state']) !== 'success').map((s) => str(s['context'])) : [])]
    if (bad.length) return [false, `PR #${n}: CI não verde no commit de merge ${sha.slice(0, 7)} (${bad.join(', ')})`]
    if (!runs.length && !statuses.length) return noEvidence(`PR #${n}: nenhum check no commit de merge ${sha.slice(0, 7)}`)
    return [true, `PR #${n} mergeado, CI verde no commit de merge ${sha.slice(0, 7)}`]
  }

  const continueOnError = async (run: Record<string, unknown>, job: Record<string, unknown>, step: string): Promise<boolean | null> => {
    const src = await text(str(run['path']), str(run['head_sha']))
    if (src === null) return null
    const doc = parseYaml(src) as unknown
    const jobs = isRecord(doc) && isRecord(doc['jobs']) ? doc['jobs'] : {}
    const name = str(job['name'])
    const def = Object.entries(jobs).find(([key, j]) => isRecord(j) && [key, str(j['name'])].some((n) => n && (n === name || name.startsWith(`${n} (`))))?.[1]
    if (!isRecord(def) || !Array.isArray(def['steps'])) return null
    const s = (def['steps'] as unknown[]).find((x) => isRecord(x) && x['name'] === step)
    return isRecord(s) ? s['continue-on-error'] !== undefined && s['continue-on-error'] !== false && s['continue-on-error'] !== 'false' : null
  }

  const ci = async (jobName: string, step: string | null, workflow: string | null): Promise<MvpAnswer> => {
    const b = await branch()
    const q = `branch=${encodeURIComponent(b)}&per_page=${workflow ? 1 : 50}`
    const runs = list(await cached(workflow ? `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?${q}` : `repos/${repo}/actions/runs?${q}`), 'workflow_runs')
    const seen = new Set<unknown>()
    const latest = runs.filter((r) => !seen.has(r['workflow_id']) && seen.add(r['workflow_id']))
    if (!latest.length) return noEvidence(`nenhuma execução na ${b}`)
    for (const run of latest) {
      const job = list(await cached(`repos/${repo}/actions/runs/${String(run['id'])}/jobs?per_page=100&filter=latest`), 'jobs').find((j) => str(j['name']) === jobName)
      if (!job) continue
      const where = `${str(run['name'])} #${String(run['run_number'] ?? run['id'])} na ${b}`
      if (str(run['status']) !== 'completed') return noEvidence(`${where} ainda em andamento`)
      if (str(job['conclusion']) !== 'success') return [false, `job ${jobName} ${str(job['conclusion']) || 'sem conclusão'} (${where})`]
      if (!step) return [true, `job ${jobName} verde (${where})`]
      const s = list(job, 'steps').find((x) => str(x['name']) === step)
      if (!s) return [false, `step ${step} não consta no job ${jobName} (${where})`]
      if (str(s['conclusion']) !== 'success') return [false, `step ${step} ${str(s['conclusion']) || 'sem conclusão'} (${where})`]
      const coe = await continueOnError(run, job, step)
      if (coe === null) return noEvidence(`não deu para ler continue-on-error do step ${step} em ${str(run['path'])}`)
      return coe ? [false, `step ${step} tem continue-on-error: não conta (${where})`] : [true, `step ${step} verde (${where})`]
    }
    return [false, `job ${jobName} não consta na última execução da ${b}`]
  }

  const file = async (path: string): Promise<MvpAnswer> => {
    const b = await branch()
    return await contents(path, b) ? [true, `${path} existe na ${b}`] : [false, `${path} não existe na ${b}`]
  }

  const url = async (u: string, expect: unknown, contains: unknown): Promise<MvpAnswer> => {
    const { status, body } = await deps.probe(u)
    if (status !== (typeof expect === 'number' ? expect : 200)) return [false, `${u} respondeu ${status}, esperado ${String(expect ?? 200)}`]
    if (typeof contains === 'string' && !body.includes(contains)) return [false, `${u} respondeu ${status} sem o texto "${contains}"`]
    return [true, `${u} respondeu ${status}${typeof contains === 'string' ? ` com "${contains}"` : ''}`]
  }

  const run = async (path: string, maxAgeDays: unknown): Promise<MvpAnswer> => {
    const raw = await text(path, await branch())
    if (raw === null) return [false, `registro ${path} não existe na ${await branch()}`]
    let rec: unknown
    try { rec = JSON.parse(raw) } catch { return [false, `registro ${path} não é JSON`] }
    if (!isRecord(rec)) return [false, `registro ${path} não é um objeto`]
    if (rec['ok'] === false || ['fail', 'failed', 'failure', 'error'].includes(str(rec['status']).toLowerCase())) return [false, `registro ${path} diz que a execução falhou`]
    const at = ['finished_at', 'finishedAt', 'at', 'timestamp', 'date'].map((k) => str(rec[k])).find(Boolean)
    const ms = at ? Date.parse(at) : NaN
    if (Number.isNaN(ms)) return noEvidence(`registro ${path} sem data (finished_at/at/timestamp)`)
    const limit = typeof maxAgeDays === 'number' ? maxAgeDays : 30
    const age = (deps.now.getTime() - ms) / 86_400_000
    return age > limit ? [false, `execução de ${at} tem ${Math.floor(age)} dia(s), validade ${limit}`] : [true, `execução de ${at} dentro da validade (${limit} dias)`]
  }
  return { pr, ci, file, url, run }
}

/**
 * Evidence for every check the manifest asks for. The report is evaluated against what is known so far; each question it
 * asks that is still open is answered from GitHub, until a pass asks nothing new. A failed lookup is "sem evidência", never green.
 */
export const collectMvpEvidence = async (doc: Record<string, unknown>, deps: MvpEvidenceDeps): Promise<Table> => {
  const repo = doc['repo']
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return fail('MVP manifest needs repo: <owner>/<name> to collect evidence.', 'INVALID_CONFIG')
  const api = collector(repo, deps)
  const table: Table = { prs: {}, ci: {}, files: {}, urls: {}, runs: {} }
  for (;;) {
    const open: (() => Promise<void>)[] = []
    const ask = (section: Section, key: string, answer: () => Promise<MvpAnswer>): MvpAnswer => {
      const known = table[section][key]
      if (known) return [known.ok, known.detail]
      open.push(async () => {
        const [ok, detail] = await answer().catch((error: unknown): MvpAnswer => noEvidence(error instanceof Error ? error.message : String(error)))
        table[section][key] = { ok, detail }
      })
      return noEvidence('coleta pendente')
    }
    evaluateMvp(doc, {
      pr: (n) => ask('prs', String(n), () => api.pr(n)),
      ci: (job, step, workflow) => ask('ci', step ? `${job}/${step}` : job, () => api.ci(job, step, workflow)),
      file: (p) => ask('files', p, () => api.file(p)),
      url: (u, expect, contains) => ask('urls', u, () => api.url(u, expect, contains)),
      run: (p, maxAge) => ask('runs', p, () => api.run(p, maxAge)),
    })
    if (!open.length) return table
    for (const job of open) await job()
  }
}

