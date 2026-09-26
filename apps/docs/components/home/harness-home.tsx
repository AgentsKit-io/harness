'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, GitPullRequest, Workflow } from 'lucide-react'

import { EcosystemShowcase } from './ecosystem'
import { AgentsKitAurora, ProductWordmark, SiteFooter } from '@/components/agentskit-shell'
import { CopyButton } from '@/components/copy-button'
import type { HarnessStatCounts } from '@/lib/stats'

/**
 * The home page, ported from the design canvas.
 *
 * Three things animate: the objective typing itself into the hero, the factory figure (pure CSS keyframes on an
 * SVG, so it costs nothing to run), and the recorded run replaying line by line into the terminal. One
 * `requestAnimationFrame` clock drives the two that need state; the figure needs none.
 *
 * `prefers-reduced-motion` is not an afterthought here: it stops the clock before it starts and renders the
 * finished state — the whole transcript, the last objective — so a reader who asked for stillness gets the same
 * information, not less of it.
 */

const OBJECTIVES = [
  'let ops see whether the service is alive',
  'cut the checkout timeout',
  'stop the nightly job from double-charging',
]

interface TranscriptLine {
  readonly tag: string
  readonly text: string
  readonly note: string
  readonly c: string
  readonly mark: string
}

/** The recorded run. `reconstructed` on a line is the label the docs use for output nobody captured live. */
const TRANSCRIPT: readonly TranscriptLine[] = [
  { tag: '$', text: 'loop tick --flow enterprise', note: '', c: '#56D364', mark: '' },
  { tag: 'plan', text: 'issue A3-118 · planner drafted 6 steps', note: '', c: '#8B949E', mark: '✓' },
  { tag: 'vote', text: '3 agents · 2 approve, 1 objects (no rollback path)', note: '', c: '#F85149', mark: '✗' },
  { tag: 'vote', text: 'objection answered in step 5 · 3/3 approve', note: '', c: '#2EA043', mark: '✓' },
  { tag: 'work', text: 'worktree a3-118 created · tmux session attached', note: '', c: '#58A6FF', mark: '✓' },
  { tag: 'build', text: '▰▰▰▰▰▰▰▰▰▰▰▰ 41 files changed · 1 migration', note: '', c: '#58A6FF', mark: '✓' },
  { tag: 'verify', text: '▰▰▰▰▰▰▰▰▰▰▰▰ 212 tests · 212 pass · lint clean', note: '', c: '#2EA043', mark: '✓' },
  { tag: 'review', text: '2 findings · 2 fixed · round 1 of 2', note: '', c: '#E3B341', mark: '✓' },
  { tag: 'dod', text: 'project checklist 9/9 · issue checklist 4/4', note: '', c: '#2EA043', mark: '✓' },
  { tag: 'pr', text: '#482 opened · checks green', note: 'reconstructed', c: '#58A6FF', mark: '✓' },
  { tag: 'merge', text: '#482 merged into main', note: 'reconstructed', c: '#A371F7', mark: '✓' },
  { tag: 'release', text: 'batch r-2026-09-19 awaiting approval', note: '', c: '#E3B341', mark: '⏸' },
  { tag: 'human', text: 'loop release approve', note: '', c: '#56D364', mark: '' },
]

/** The band under "machine surfaces": four of the generated counts, labelled as the reader would ask for them. */
const STATS: readonly { readonly key: keyof HarnessStatCounts; readonly label: string }[] = [
  { key: 'cliCommands', label: 'CLI commands' },
  { key: 'loopEvents', label: 'Loop events' },
  { key: 'configPaths', label: 'Config settings' },
  { key: 'decisionRecords', label: 'Decision records' },
]

const CHAR = 20
const GAP = 320
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']
const INSTALL = 'npx @agentskit/harness loop init'

const PROFILES = {
  enterprise: {
    label: 'Enterprise',
    description: 'For production changes with shared ownership.',
    steps: ['Plan', '3 votes', 'Build', 'CI checks', 'Human PR', 'Release'],
  },
  poc: {
    label: 'POC',
    description: 'A short path for validating an idea.',
    steps: ['Plan', '1 vote', 'Build', 'Release'],
  },
  incident: {
    label: 'Incident',
    description: 'Move quickly while keeping verification and review.',
    steps: ['Objective', 'Build', 'Verify', 'Review ×2', 'Release'],
  },
} as const

const PROFILE_ORDER = Object.keys(PROFILES) as ProfileName[]

type ProfileName = keyof typeof PROFILES

/** Where the replay is at `t` milliseconds: which line, how many characters of it, and whether it ended. */
const positionAt = (t: number): { readonly li: number; readonly ci: number; readonly done: boolean } => {
  let accumulated = 0
  for (let index = 0; index < TRANSCRIPT.length; index += 1) {
    const duration = TRANSCRIPT[index]!.text.length * CHAR
    if (t < accumulated + duration) return { li: index, ci: Math.max(0, Math.floor((t - accumulated) / CHAR)), done: false }
    if (t < accumulated + duration + GAP) return { li: index, ci: TRANSCRIPT[index]!.text.length, done: false }
    accumulated += duration + GAP
  }
  return { li: TRANSCRIPT.length - 1, ci: TRANSCRIPT[TRANSCRIPT.length - 1]!.text.length, done: true }
}

const elapsedFor = (li: number, ci: number): number => {
  let accumulated = 0
  for (let index = 0; index < li; index += 1) accumulated += TRANSCRIPT[index]!.text.length * CHAR + GAP
  return accumulated + ci * CHAR
}

const stamp = (index: number): string => {
  let ms = 0
  for (let k = 0; k < index; k += 1) ms += TRANSCRIPT[k]!.text.length * CHAR + GAP
  const seconds = ms / 1000
  return `${seconds < 10 ? '0' : ''}${seconds.toFixed(1)}s`
}

interface ReplayRow {
  readonly key: number
  readonly time: string
  readonly lead: string
  readonly leadColor: string
  readonly tag: string
  readonly tagColor: string
  readonly text: string
  readonly textColor: string
  readonly note: string
  readonly cursor: string
}

const row = (line: TranscriptLine, index: number, typing: boolean, chars: number | null, spin: number): ReplayRow => {
  const isHuman = line.tag === '$' || line.tag === 'human'
  return {
    key: index,
    time: stamp(index),
    lead: isHuman ? '❯' : (typing ? SPIN[spin] ?? '⠋' : line.mark),
    leadColor: typing ? '#56D364' : line.mark === '✗' ? '#F85149' : line.mark === '⏸' ? '#E3B341' : '#2EA043',
    tag: isHuman ? '' : line.tag,
    tagColor: line.c,
    text: chars === null ? line.text : line.text.slice(0, chars),
    textColor: isHuman ? '#E6EDF3' : '#C9D1D9',
    note: typing ? '' : line.note,
    cursor: '',
  }
}

interface HarnessHomeProps {
  /** Generated at build time from the repository and served at `/api/stats.json`; never typed into the page. */
  readonly counts: HarnessStatCounts
}

export function HarnessHome({ counts }: HarnessHomeProps) {
  // The home is always dark; shell v1's aurora picks its dark shader from <html data-theme="dark">. Docs keep their theme.
  useEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute('data-theme')
    root.setAttribute('data-theme', 'dark')
    return () => { if (previous === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', previous) }
  }, [])
  const [playing, setPlaying] = useState(true)
  const [typed, setTyped] = useState(OBJECTIVES[0]!)
  const [replaying, setReplaying] = useState(false)
  const [li, setLi] = useState(0)
  const [ci, setCi] = useState(0)
  const [spin, setSpin] = useState(0)
  const [done, setDone] = useState(false)
  const [profile, setProfile] = useState<ProfileName>('enterprise')
  const [copied, setCopied] = useState(false)
  const [reduced, setReduced] = useState(false)

  const termRef = useRef<HTMLDivElement | null>(null)
  const origin = useRef(0)
  const frozen = useRef(0)
  const replayOrigin = useRef(0)
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The rAF callback reads live state without restarting the clock on every frame.
  const live = useRef({ playing: true, replaying: false, li: 0, ci: 0, spin: 0, done: false })
  live.current = { playing, replaying, li, ci, spin, done }

  const restartReplay = useCallback(() => {
    replayOrigin.current = performance.now()
    setLi(0)
    setCi(0)
    setDone(false)
    setReplaying(true)
  }, [])

  useEffect(() => {
    const prefersReduced = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) {
      setReduced(true)
      setPlaying(false)
      setReplaying(false)
      setDone(true)
      setLi(TRANSCRIPT.length - 1)
      return undefined
    }

    origin.current = performance.now()
    replayOrigin.current = performance.now()
    let frame = 0

    const tick = (now: number) => {
      const state = live.current
      if (state.playing) {
        // `now` can land before the origin — a frame from a previous mount surviving a fast refresh, or a clock
        // the browser adjusted — and a negative elapsed makes the modulo negative, which indexes nothing.
        const elapsed = Math.max(0, now - origin.current)
        const sub = 6000
        const within = elapsed % sub
        const objective = OBJECTIVES[Math.floor(elapsed / sub) % OBJECTIVES.length] ?? OBJECTIVES[0]!
        const length = objective.length
        const chars = within < 1800
          ? Math.floor((within / 1800) * length)
          : within < 5300 ? length : Math.round(length * (1 - (within - 5300) / 700))
        setTyped(objective.slice(0, Math.min(length, Math.max(0, chars))))
      }
      if (state.replaying) {
        const t = Math.max(0, now - replayOrigin.current)
        const position = positionAt(t)
        const spinner = Math.floor(t / 110) % 8
        if (position.done) {
          setLi(position.li)
          setCi(position.ci)
          setDone(true)
          setReplaying(false)
          if (loopTimer.current) clearTimeout(loopTimer.current)
          // A run that ends and never starts again is a screenshot; four seconds later it runs once more.
          loopTimer.current = setTimeout(restartReplay, 4000)
        } else if (position.li !== state.li || position.ci !== state.ci || spinner !== state.spin) {
          setLi(position.li)
          setCi(position.ci)
          setSpin(spinner)
          setDone(false)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    // The replay only runs while it is on screen: an animation nobody is looking at is a battery bill.
    const element = termRef.current
    const observer = element && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
        const visible = entries[0]?.isIntersecting ?? false
        const state = live.current
        if (visible && !state.replaying) {
          if (state.done || state.ci === 0) restartReplay()
          else {
            replayOrigin.current = performance.now() - elapsedFor(state.li, state.ci)
            setReplaying(true)
          }
        } else if (!visible && state.replaying) {
          if (loopTimer.current) clearTimeout(loopTimer.current)
          setReplaying(false)
        }
      }, { threshold: 0.25 })
      : null
    if (observer && element) observer.observe(element)

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      if (loopTimer.current) clearTimeout(loopTimer.current)
    }
  }, [restartReplay])

  useEffect(() => {
    if (reduced) return undefined
    const timer = window.setInterval(() => {
      setProfile((current) => PROFILE_ORDER[(PROFILE_ORDER.indexOf(current) + 1) % PROFILE_ORDER.length]!)
    }, 4200)
    return () => window.clearInterval(timer)
  }, [reduced])

  const toggleFigure = useCallback(() => {
    setPlaying((current) => {
      if (current) frozen.current = performance.now() - origin.current
      else origin.current = performance.now() - frozen.current
      return !current
    })
  }, [])

  const toggleReplay = useCallback(() => {
    if (done) { restartReplay(); return }
    setReplaying((current) => {
      if (!current) replayOrigin.current = performance.now() - elapsedFor(li, ci)
      return !current
    })
  }, [done, li, ci, restartReplay])

  const copyInstall = useCallback(() => {
    try { void navigator.clipboard.writeText(INSTALL) } catch { /* a refused clipboard is not an error worth showing */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }, [])

  const selected = PROFILES[profile]

  const replayLines: readonly ReplayRow[] = reduced
    ? TRANSCRIPT.map((line, index) => row(line, index, false, null, spin))
    : TRANSCRIPT.slice(0, li + 1).map((line, index) => {
      const active = index === li && !done
      const typing = active && ci < line.text.length
      return { ...row(line, index, typing, active ? ci : null, spin), cursor: index === li ? '▌' : '' }
    })

  const figState = playing ? 'playing' : 'paused'
  const figureLabel = playing ? 'Pause' : 'Play'
  const replayLabel = replaying ? 'Pause' : done ? 'Replay' : 'Play'
  const copyLabel = copied ? 'Copied' : 'Copy'
  const nightShift = true

  return (
    <div className="harness-home">
      <AgentsKitAurora />

      <div data-home-content="" style={{ maxWidth: '100%', overflowX: 'hidden' }}>

      <header className="harness-home-header">
        <a href="/" aria-label="AgentsKit Harness home"><ProductWordmark /></a>
        <nav aria-label="Harness">
          <a href="/docs">Docs</a>
          <a href="#gates">Gates</a>
          <a href="#run">A run</a>
          <a href="/llms.txt">llms.txt</a>
        </nav>
      </header>

      <main>
      <section style={{ padding: '72px 28px 40px', maxWidth: '1180px', margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '56px', alignItems: 'start' }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '22px', paddingTop: '8px' }}>
            <h1 style={{ margin: '0', display: 'flex', alignItems: 'center', gap: '10px', fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364', fontWeight: '500' }}><span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '999px', background: '#56D364' }}></span>AgentsKit Harness</h1>
            <p style={{ margin: '0', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(34px, 4.6vw, 54px)', lineHeight: '1.05', fontWeight: '600', color: '#E6EDF3', textWrap: 'pretty' }}>The keep-pushing loop for your SDLC.</p>
            <p style={{ margin: '0', maxWidth: '46ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E', textWrap: 'pretty' }}>From a vague objective to production without babysitting an agent — interview, plan, votes, worker, review, merge, release. Every transition is the machine's decision over an explicit state. A human acts in five places, and only where something touches the world.</p>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', border: '1px solid #30363D', boxSizing: 'border-box', borderRadius: '0.5rem', background: '#161B22', width: '100%', maxWidth: '420px' }}>
              <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '13px', color: '#8B949E' }}>$</span>
              <code style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '13px', color: '#E6EDF3', flex: '1', overflowX: 'auto', whiteSpace: 'nowrap' }}>npx @agentskit/harness loop init</code>
              <button className="hv1" onClick={copyInstall} style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E', background: 'transparent', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '6px 9px', cursor: 'pointer' }}>{copyLabel}</button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center', fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase' }}>
              <a href="/docs">Read the docs →</a>
              <a href="#run" style={{ color: '#8B949E' }}>See a run →</a>
            </div>
          </div>

          <figure role="group" aria-label="The harness loop, drawn as a vertical factory" style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <figcaption style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>the loop · 11s cycle</figcaption>
              <button className="hv3" onClick={toggleFigure} aria-label="Play or pause the loop animation" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--ak-font-mono)', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#E6EDF3', background: '#161B22', border: '1px solid #30363D', borderRadius: '999px', padding: '7px 13px', cursor: 'pointer' }}>{figureLabel}</button>
            </div>

            <p style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>A vague objective enters at the top and descends through six levels: the objective becomes a PRD, the PRD becomes a technical design, the design fans out into parallel issues worked by separate agents, one of which goes back a level for a fix round, the branches converge into a reviewed pull request, and a merge reaches production. A human gate stops the flow at the PRD, at the design, and before the release. A return stroke climbs the right edge and starts the next cycle with a new objective.</p>

            <div style={{ boxSizing: 'border-box', width: '58.82%', minWidth: '0', margin: '0 auto -10px', padding: '10px 14px 12px', border: '1px solid #30363D', borderRadius: '8px', background: '#161B22', fontFamily: 'var(--ak-font-mono)' }}>
              <div style={{ fontSize: '9.5px', letterSpacing: '0.2em', color: '#8B949E' }}>00 · OBJECTIVE</div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', fontSize: '14px', color: '#E6EDF3', marginTop: '6px' }}>
                <span style={{ color: '#56D364', flex: 'none' }}>›</span>
                <span style={{ flex: '1', minWidth: '0', overflow: 'hidden', display: 'flex', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}><span style={{ flex: 'none', display: 'flex', marginRight: 'auto' }}><span>{typed}</span><span style={{ color: '#56D364', animation: 'blink 1s steps(1) infinite' }}>▌</span></span></span>
              </div>
            </div>
            <svg viewBox="0 84 680 716" role="img" aria-hidden="true" data-figure={figState} style={{ width: '100%', height: 'auto', display: 'block', fontFamily: 'var(--ak-font-mono)', overflow: 'visible' }}>

              <path d="M340 84 V 128" stroke="#30363D" strokeWidth="1.5" fill="none"></path>
              <path d="M340 84 V 128" stroke="#56D364" strokeWidth="1.5" fill="none" strokeDasharray="7 7" style={{ animation: 'flow .9s linear infinite, litA 11s linear infinite' }}></path>

              <g>
                <a href="/docs/guides/driving-plan">
                  <rect x="210" y="128" width="260" height="96" rx="8" fill="#161B22" stroke="#30363D"></rect>
                  <text x="228" y="150" fill="#8B949E" fontSize="9.5" letterSpacing="2">01 · PLAN</text>
                  <text x="228" y="170" fill="#E6EDF3" fontSize="13">PRD</text>
                  <rect x="228" y="182" width="200" height="4" rx="2" fill="#30363D" style={{ transformBox: 'fill-box', transformOrigin: 'left center', animation: 'drawLine 11s linear infinite' }}></rect>
                  <rect x="228" y="193" width="176" height="4" rx="2" fill="#30363D" style={{ transformBox: 'fill-box', transformOrigin: 'left center', animation: 'drawLine 11s linear .12s infinite' }}></rect>
                  <rect x="228" y="204" width="198" height="4" rx="2" fill="#30363D" style={{ transformBox: 'fill-box', transformOrigin: 'left center', animation: 'drawLine 11s linear .24s infinite' }}></rect>
                </a>
                <circle cx="500" cy="176" r="11" fill="none" stroke="#56D364" strokeWidth="1.5" style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'g1ring 11s linear infinite, pulse .7s ease-in-out infinite' }}></circle>
                <text x="494" y="181" fill="#2EA043" fontSize="13" style={{ animation: 'g1chk 11s linear infinite' }}>✓</text>
                <text x="518" y="180" fill="#8B949E" fontSize="9.5" letterSpacing="2">HUMAN</text>
              </g>

              <path d="M340 224 V 268" stroke="#30363D" strokeWidth="1.5" fill="none"></path>
              <path d="M340 224 V 268" stroke="#56D364" strokeWidth="1.5" fill="none" strokeDasharray="7 7" style={{ animation: 'flow .9s linear infinite, litB 11s linear infinite' }}></path>

              <g>
                <rect x="190" y="268" width="300" height="86" rx="8" fill="#161B22" stroke="#30363D"></rect>
                <text x="208" y="290" fill="#8B949E" fontSize="9.5" letterSpacing="2">02 · DESIGN</text>
                <rect x="208" y="302" width="76" height="34" rx="4" fill="#0D1117" stroke="#30363D"></rect>
                <text x="218" y="323" fill="#E6EDF3" fontSize="10">api</text>
                <rect x="302" y="302" width="76" height="34" rx="4" fill="#0D1117" stroke="#30363D"></rect>
                <text x="312" y="323" fill="#E6EDF3" fontSize="10">worker</text>
                <rect x="396" y="302" width="76" height="34" rx="4" fill="#0D1117" stroke="#30363D"></rect>
                <text x="406" y="323" fill="#E6EDF3" fontSize="10">schema</text>
                <path d="M284 319 H 302 M378 319 H 396" stroke="#58A6FF" strokeWidth="1.2" strokeDasharray="4 4" style={{ animation: 'flow 1.2s linear infinite' }}></path>
                <circle cx="520" cy="311" r="11" fill="none" stroke="#56D364" strokeWidth="1.5" style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'g2ring 11s linear infinite, pulse .7s ease-in-out infinite' }}></circle>
                <text x="514" y="316" fill="#2EA043" fontSize="13" style={{ animation: 'g2chk 11s linear infinite' }}>✓</text>
                <text x="538" y="315" fill="#8B949E" fontSize="9.5" letterSpacing="2">HUMAN</text>
              </g>

              <g fill="none" stroke="#30363D" strokeWidth="1.5">
                <path d="M340 354 C 340 382, 100 376, 100 404"></path>
                <path d="M340 354 C 340 382, 260 376, 260 404"></path>
                <path d="M340 354 C 340 382, 420 376, 420 404" data-branch="3"></path>
                <path d="M340 354 C 340 382, 580 376, 580 404" data-branch="4"></path>
              </g>
              <g fill="none" stroke="#56D364" strokeWidth="1.5" strokeDasharray="7 7" style={{ animation: 'litFan 11s linear infinite' }}>
                <path d="M340 354 C 340 382, 100 376, 100 404" style={{ animation: 'flow .9s linear infinite' }}></path>
                <path d="M340 354 C 340 382, 260 376, 260 404" style={{ animation: 'flow .9s linear .1s infinite' }}></path>
                <path d="M340 354 C 340 382, 420 376, 420 404" data-branch="3" style={{ animation: 'flow .9s linear .2s infinite' }}></path>
                <path d="M340 354 C 340 382, 580 376, 580 404" data-branch="4" style={{ animation: 'flow .9s linear .3s infinite' }}></path>
              </g>

              <g>
                <a href="/docs/concepts/contracts">
                  <g>
                    <rect x="35" y="404" width="130" height="120" rx="8" fill="#161B22" stroke="#30363D"></rect>
                    <text x="49" y="424" fill="#8B949E" fontSize="9.5" letterSpacing="2">03 · TICK</text>
                    <rect x="49" y="436" width="102" height="1" fill="#30363D"></rect>
                    <text x="49" y="458" fill="#2EA043" fontSize="10" style={{ animation: 'shimmer 1.4s linear infinite' }}>› build</text>
                    <text x="49" y="478" fill="#58A6FF" fontSize="10" style={{ animation: 'shimmer 1.4s linear .3s infinite' }}>› verify</text>
                    <text x="49" y="498" fill="#8B949E" fontSize="10" style={{ animation: 'shimmer 1.4s linear .6s infinite' }}>› review</text>
                    <text x="49" y="516" fill="#8B949E" fontSize="9">A3-118</text>
                  </g>
                  <g>
                    <rect x="195" y="404" width="130" height="120" rx="8" fill="#161B22" stroke="#30363D"></rect>
                    <text x="209" y="424" fill="#8B949E" fontSize="9.5" letterSpacing="2">03 · TICK</text>
                    <rect x="209" y="436" width="102" height="1" fill="#30363D"></rect>
                    <text x="209" y="458" fill="#2EA043" fontSize="10" style={{ animation: 'shimmer 1.4s linear .5s infinite' }}>› build</text>
                    <text x="209" y="478" fill="#58A6FF" fontSize="10" style={{ animation: 'shimmer 1.4s linear .8s infinite' }}>› verify</text>
                    <text x="209" y="498" fill="#F85149" fontSize="10" style={{ animation: 'shimmer 1.4s linear 1.1s infinite' }}>› re-work</text>
                    <text x="209" y="516" fill="#8B949E" fontSize="9">A3-119</text>
                  </g>
                  <g data-branch="3">
                    <rect x="355" y="404" width="130" height="120" rx="8" fill="#161B22" stroke="#30363D"></rect>
                    <text x="369" y="424" fill="#8B949E" fontSize="9.5" letterSpacing="2">03 · TICK</text>
                    <rect x="369" y="436" width="102" height="1" fill="#30363D"></rect>
                    <text x="369" y="458" fill="#2EA043" fontSize="10" style={{ animation: 'shimmer 1.4s linear .2s infinite' }}>› build</text>
                    <text x="369" y="478" fill="#58A6FF" fontSize="10" style={{ animation: 'shimmer 1.4s linear .9s infinite' }}>› verify</text>
                    <text x="369" y="498" fill="#8B949E" fontSize="10" style={{ animation: 'shimmer 1.4s linear .4s infinite' }}>› review</text>
                    <text x="369" y="516" fill="#8B949E" fontSize="9">A3-120</text>
                  </g>
                  <g data-branch="4">
                    <rect x="515" y="404" width="130" height="120" rx="8" fill="#161B22" stroke="#30363D"></rect>
                    <text x="529" y="424" fill="#8B949E" fontSize="9.5" letterSpacing="2">03 · TICK</text>
                    <rect x="529" y="436" width="102" height="1" fill="#30363D"></rect>
                    <text x="529" y="458" fill="#2EA043" fontSize="10" style={{ animation: 'shimmer 1.4s linear .7s infinite' }}>› build</text>
                    <text x="529" y="478" fill="#58A6FF" fontSize="10" style={{ animation: 'shimmer 1.4s linear .1s infinite' }}>› verify</text>
                    <text x="529" y="498" fill="#8B949E" fontSize="10" style={{ animation: 'shimmer 1.4s linear 1s infinite' }}>› review</text>
                    <text x="529" y="516" fill="#8B949E" fontSize="9">A3-121</text>
                  </g>
                </a>
              </g>


              <g fill="none" stroke="#30363D" strokeWidth="1.5">
                <path d="M100 524 C 100 562, 340 558, 340 596"></path>
                <path d="M260 524 C 260 562, 340 558, 340 596"></path>
                <path d="M420 524 C 420 562, 340 558, 340 596" data-branch="3"></path>
                <path d="M580 524 C 580 562, 340 558, 340 596" data-branch="4"></path>
              </g>
              <g fill="none" stroke="#56D364" strokeWidth="1.5" strokeDasharray="7 7" style={{ animation: 'litConv 11s linear infinite' }}>
                <path d="M100 524 C 100 562, 340 558, 340 596" style={{ animation: 'flow .9s linear infinite' }}></path>
                <path d="M260 524 C 260 562, 340 558, 340 596" style={{ animation: 'flow .9s linear .1s infinite' }}></path>
                <path d="M420 524 C 420 562, 340 558, 340 596" data-branch="3" style={{ animation: 'flow .9s linear .2s infinite' }}></path>
                <path d="M580 524 C 580 562, 340 558, 340 596" data-branch="4" style={{ animation: 'flow .9s linear .3s infinite' }}></path>
              </g>

              <g>
                <a href="/docs/concepts/definition-of-done">
                  <rect x="190" y="596" width="300" height="60" rx="8" fill="#161B22" stroke="#58A6FF"></rect>
                  <text x="208" y="618" fill="#8B949E" fontSize="9.5" letterSpacing="2">04 · DELIVER</text>
                  <text x="208" y="640" fill="#E6EDF3" fontSize="12">integration · pull request</text>
                </a>
                <text x="400" y="618" fill="#58A6FF" fontSize="9.5" letterSpacing="2" style={{ animation: 'stampRev 11s linear infinite' }}>REVIEWED</text>
              </g>

              <path d="M340 656 V 684" stroke="#30363D" strokeWidth="1.5" fill="none"></path>
              <path d="M340 656 V 684" stroke="#56D364" strokeWidth="2.5" fill="none" strokeDasharray="7 7" style={{ animation: 'flow .9s linear infinite, litFinal 11s linear infinite' }}></path>

              <g>
                <a href="/docs/guides/release">
                  <rect x="140" y="684" width="400" height="56" rx="8" fill="#161B22" stroke="#30363D"></rect>
                  <rect x="141" y="685" width="398" height="54" rx="7" fill="#2EA043" fillOpacity="0.16" style={{ transformBox: 'fill-box', transformOrigin: 'left center', animation: 'greenFill 11s linear infinite' }}></rect>
                  <text x="160" y="708" fill="#8B949E" fontSize="9.5" letterSpacing="2">05 · RELEASE</text>
                  <text x="160" y="728" fill="#E6EDF3" fontSize="13">production</text>
                </a>
                <circle cx="510" cy="712" r="11" fill="none" stroke="#56D364" strokeWidth="1.5" style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'g3ring 11s linear infinite, pulse .7s ease-in-out infinite' }}></circle>
                <text x="504" y="717" fill="#2EA043" fontSize="13" style={{ animation: 'g3chk 11s linear infinite' }}>✓</text>
              </g>

              <g>
                <text x="352" y="112" fill="#56D364" fontSize="15" style={{ animation: 'glyph 11s linear 1s infinite both' }}>¶</text>
                <g style={{ animation: 'glyph 11s linear 2.8s infinite both' }}>
                <rect x="350" y="232" width="13" height="16" rx="2" fill="#0D1117" stroke="#56D364"></rect>
                <path d="M353 237 H 360 M353 240 H 360 M353 243 H 358" stroke="#56D364" strokeWidth="1"></path>
                </g>
                <g style={{ animation: 'fanG1 11s linear 4s infinite both' }}>
                <rect x="333" y="356" width="13" height="16" rx="2" fill="#0D1117" stroke="#56D364"></rect>
                <path d="M336 361 H 343 M336 364 H 343 M336 367 H 341" stroke="#56D364" strokeWidth="1"></path>
                <text x="350" y="369" fill="#56D364" fontSize="9">A3-118</text>
                </g>
                <g style={{ animation: 'fanG2 11s linear 4.1s infinite both' }}>
                <rect x="333" y="356" width="13" height="16" rx="2" fill="#0D1117" stroke="#56D364"></rect>
                <path d="M336 361 H 343 M336 364 H 343 M336 367 H 341" stroke="#56D364" strokeWidth="1"></path>
                <text x="350" y="369" fill="#56D364" fontSize="9">A3-119</text>
                </g>
                <g data-branch="3" style={{ animation: 'fanG3 11s linear 4.2s infinite both' }}>
                <rect x="333" y="356" width="13" height="16" rx="2" fill="#0D1117" stroke="#56D364"></rect>
                <path d="M336 361 H 343 M336 364 H 343 M336 367 H 341" stroke="#56D364" strokeWidth="1"></path>
                <text x="350" y="369" fill="#56D364" fontSize="9">A3-120</text>
                </g>
                <g data-branch="4" style={{ animation: 'fanG4 11s linear 4.3s infinite both' }}>
                <rect x="333" y="356" width="13" height="16" rx="2" fill="#0D1117" stroke="#56D364"></rect>
                <path d="M336 361 H 343 M336 364 H 343 M336 367 H 341" stroke="#56D364" strokeWidth="1"></path>
                <text x="350" y="369" fill="#56D364" fontSize="9">A3-121</text>
                </g>
                <text x="88" y="540" fill="#56D364" fontSize="12" style={{ animation: 'convG1 11s linear 6s infinite both' }}>&lt;/&gt;</text>
                <text x="248" y="540" fill="#56D364" fontSize="12" style={{ animation: 'convFix 11s linear 6s infinite both' }}>&lt;/&gt;</text>
                <text x="408" y="540" fill="#56D364" fontSize="12" data-branch="3" style={{ animation: 'convG3 11s linear 6.15s infinite both' }}>&lt;/&gt;</text>
                <text x="568" y="540" fill="#56D364" fontSize="12" data-branch="4" style={{ animation: 'convG4 11s linear 6.3s infinite both' }}>&lt;/&gt;</text>
              </g>
              <path d="M540 712 H 655 V 104 H 560" fill="none" stroke="#8B949E" strokeWidth="1" strokeDasharray="900" strokeDashoffset="0" style={{ animation: 'drawReturn 11s linear infinite' }}></path>
              <text x="546" y="708" fill="#8B949E" fontSize="13" style={{ animation: 'returnGlyph 11s linear infinite' }}>↻</text>
              <text x="674" y="300" fill="#8B949E" fontSize="9.5" letterSpacing="2" transform="rotate(90 674 300)">RETRO · NEXT CYCLE</text>
            </svg>
          </figure>

        </div>
      </section>

      <section id="gates" style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
        <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>01 · The human part</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>Five places where you act. Nowhere else.</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: '16px', alignItems: 'stretch' }}>
          <div className="hv4" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}><span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>01</span><CopyButton text="ak-harness loop plan approve <id>" className="!min-h-8 !min-w-8 !rounded-md !border !border-[#30363D] !px-2 !py-1 !text-[#8B949E] hover:!border-[#56D364] hover:!bg-[#0D1117]" /></div>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>The PRD is approved.</p>
            <code className="harness-gate-command" style={{ marginTop: 'auto', display: 'block', overflowX: 'auto', whiteSpace: 'nowrap', border: '1px solid #30363D', borderRadius: '6px', background: '#0D1117', padding: '9px 10px', fontFamily: 'var(--ak-font-mono)', fontSize: '12px', color: '#C9D1D9' }}><span style={{ color: '#56D364' }}>ak-harness</span> loop plan approve &lt;id&gt;</code>
          </div>
          <div className="hv5" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}><span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>02</span><CopyButton text="ak-harness loop plan approve-design <id>" className="!min-h-8 !min-w-8 !rounded-md !border !border-[#30363D] !px-2 !py-1 !text-[#8B949E] hover:!border-[#56D364] hover:!bg-[#0D1117]" /></div>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>The technical design is approved, after 2 of 3 agents agree.</p>
            <code className="harness-gate-command" style={{ marginTop: 'auto', display: 'block', overflowX: 'auto', whiteSpace: 'nowrap', border: '1px solid #30363D', borderRadius: '6px', background: '#0D1117', padding: '9px 10px', fontFamily: 'var(--ak-font-mono)', fontSize: '12px', color: '#C9D1D9' }}><span style={{ color: '#56D364' }}>ak-harness</span> loop plan approve-design &lt;id&gt;</code>
          </div>
          <div className="hv6" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}><span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>03</span><CopyButton text="ak-harness loop tick --issue <identifier>" className="!min-h-8 !min-w-8 !rounded-md !border !border-[#30363D] !px-2 !py-1 !text-[#8B949E] hover:!border-[#56D364] hover:!bg-[#0D1117]" /></div>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>An issue enters the queue: Todo → Ready.</p>
            <code className="harness-gate-command" style={{ marginTop: 'auto', display: 'block', overflowX: 'auto', whiteSpace: 'nowrap', border: '1px solid #30363D', borderRadius: '6px', background: '#0D1117', padding: '9px 10px', fontFamily: 'var(--ak-font-mono)', fontSize: '12px', color: '#C9D1D9' }}><span style={{ color: '#56D364' }}>ak-harness</span> loop tick --issue &lt;identifier&gt;</code>
          </div>
          <div className="hv7" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}><span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>04</span><CopyButton text="ak-harness loop approve <issue> --head <sha> --by <actor>" className="!min-h-8 !min-w-8 !rounded-md !border !border-[#30363D] !px-2 !py-1 !text-[#8B949E] hover:!border-[#56D364] hover:!bg-[#0D1117]" /></div>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>A pull request is approved — only if the flow asks for it.</p>
            <code className="harness-gate-command" style={{ marginTop: 'auto', display: 'block', overflowX: 'auto', whiteSpace: 'nowrap', border: '1px solid #30363D', borderRadius: '6px', background: '#0D1117', padding: '9px 10px', fontFamily: 'var(--ak-font-mono)', fontSize: '12px', color: '#C9D1D9' }}><span style={{ color: '#56D364' }}>ak-harness</span> loop approve &lt;issue&gt; --head &lt;sha&gt; --by &lt;actor&gt;</code>
          </div>
          <div className="hv8" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}><span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>05</span><CopyButton text="ak-harness loop release approve" className="!min-h-8 !min-w-8 !rounded-md !border !border-[#30363D] !px-2 !py-1 !text-[#8B949E] hover:!border-[#56D364] hover:!bg-[#0D1117]" /></div>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>A release batch is promoted and deployed.</p>
            <code className="harness-gate-command" style={{ marginTop: 'auto', display: 'block', overflowX: 'auto', whiteSpace: 'nowrap', border: '1px solid #30363D', borderRadius: '6px', background: '#0D1117', padding: '9px 10px', fontFamily: 'var(--ak-font-mono)', fontSize: '12px', color: '#C9D1D9' }}><span style={{ color: '#56D364' }}>ak-harness</span> loop release approve</code>
          </div>
        </div>

      </section>

      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto' }}>
        <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>02 · Per issue</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>A plan, voted on, before any worker starts.</h2>
        <p style={{ margin: '0 0 36px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>The planner writes the plan and three agents vote on it — in the harness, headless, before a worktree exists. You read the plan and the votes; the machine counts them and decides.</p>

        <div data-anim="track" style={{ overflowX: 'auto' }}>
          <svg viewBox="0 0 980 240" role="img" aria-label="Track: planner, three voting agents, build, verify, review, definition of done, pull request, with a retry edge back to build" style={{ minWidth: '720px', width: '100%', height: 'auto', fontFamily: 'var(--ak-font-mono)' }}>
            <rect x="10" y="96" width="112" height="48" rx="6" fill="#0D1117" stroke="#30363D"></rect>
            <text x="26" y="118" fill="#E6EDF3" fontSize="12">planner</text>
            <text x="26" y="134" fill="#8B949E" fontSize="9.5" letterSpacing="1.6">6 STEPS</text>

            <path d="M122 120 C 150 120, 150 46, 178 46 M122 120 H 178 M122 120 C 150 120, 150 194, 178 194" fill="none" stroke="#30363D" strokeWidth="1.4"></path>
            <path d="M122 120 C 150 120, 150 46, 178 46 M122 120 H 178 M122 120 C 150 120, 150 194, 178 194" fill="none" stroke="#56D364" strokeWidth="1.4" strokeDasharray="7 7" opacity="0.7" style={{ animation: 'flow .9s linear infinite' }}></path>

            <rect x="178" y="26" width="120" height="40" rx="6" fill="#0D1117" stroke="#2EA043"></rect>
            <text x="194" y="51" fill="#2EA043" fontSize="11">vote · approve</text>
            <rect x="178" y="100" width="120" height="40" rx="6" fill="#0D1117" stroke="#2EA043"></rect>
            <text x="194" y="125" fill="#2EA043" fontSize="11">vote · approve</text>
            <rect x="178" y="174" width="120" height="40" rx="6" fill="#0D1117" stroke="#F85149"></rect>
            <text x="194" y="199" fill="#F85149" fontSize="11">vote · object</text>

            <path d="M298 46 C 326 46, 326 120, 354 120 M298 120 H 354 M298 194 C 326 194, 326 120, 354 120" fill="none" stroke="#30363D" strokeWidth="1.4"></path>
            <path d="M298 46 C 326 46, 326 120, 354 120 M298 120 H 354 M298 194 C 326 194, 326 120, 354 120" fill="none" stroke="#56D364" strokeWidth="1.4" strokeDasharray="7 7" opacity="0.7" style={{ animation: 'flow .9s linear .2s infinite' }}></path>

            <rect x="354" y="96" width="104" height="48" rx="6" fill="#0D1117" stroke="#56D364"></rect>
            <text x="370" y="118" fill="#E6EDF3" fontSize="12">2 of 3</text>
            <text x="370" y="134" fill="#56D364" fontSize="9.5" letterSpacing="1.6">PROCEED</text>

            <path d="M458 120 H 500 M586 120 H 620 M706 120 H 740 M826 120 H 860" stroke="#30363D" strokeWidth="1.4" fill="none"></path>
            <path d="M458 120 H 500 M586 120 H 620 M706 120 H 740 M826 120 H 860" stroke="#56D364" strokeWidth="1.4" fill="none" strokeDasharray="7 7" opacity="0.7" style={{ animation: 'flow .9s linear .1s infinite' }}></path>
            <rect x="500" y="96" width="86" height="48" rx="6" fill="#0D1117" stroke="#30363D"></rect>
            <text x="516" y="124" fill="#E6EDF3" fontSize="12">build</text>
            <rect x="620" y="96" width="86" height="48" rx="6" fill="#0D1117" stroke="#30363D"></rect>
            <text x="636" y="124" fill="#E6EDF3" fontSize="12">verify</text>
            <rect x="740" y="96" width="86" height="48" rx="6" fill="#0D1117" stroke="#30363D"></rect>
            <text x="756" y="124" fill="#E6EDF3" fontSize="12">review</text>
            <rect x="860" y="96" width="110" height="48" rx="6" fill="#0D1117" stroke="#58A6FF"></rect>
            <text x="876" y="118" fill="#E6EDF3" fontSize="12">DoD · PR</text>
            <text x="876" y="134" fill="#58A6FF" fontSize="9.5" letterSpacing="1.6">9/9 · 4/4</text>

            <path d="M783 144 C 783 196, 543 196, 543 144" fill="none" stroke="#F85149" strokeWidth="1.2" strokeDasharray="4 6" style={{ animation: 'flow 1.4s linear infinite' }}></path>
            <text x="566" y="214" fill="#F85149" fontSize="9.5" letterSpacing="1.6">MAX 3 CYCLES, THEN IT IS A HUMAN'S PROBLEM</text>
          </svg>
        </div>

      </section>

      <section id="run" style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto' }}>
        <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>03 · Evidence</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>This is the actual output.</h2>
        <p style={{ margin: '0 0 36px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Recorded from a real run. Lines the harness could not yet write to a live repository are marked <span style={{ color: '#E6EDF3' }}>reconstructed</span> — they are not evidence, and we will not pretend otherwise.</p>

        <div style={{ background: 'rgb(22 27 34 / 42%)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', borderBottom: '1px solid #30363D' }}>
            <span style={{ display: 'flex', gap: '6px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: '#30363D', display: 'inline-block' }}></span>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: '#30363D', display: 'inline-block' }}></span>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: '#30363D', display: 'inline-block' }}></span>
            </span>
            <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E', flex: '1' }}>run-2026-09-19-a3.log</span>
            <button className="hv9" onClick={toggleReplay} style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#E6EDF3', background: '#0D1117', border: '1px solid #30363D', borderRadius: '999px', padding: '6px 12px', cursor: 'pointer' }}>{replayLabel}</button>
            <button className="hv10" onClick={restartReplay} style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E', background: 'transparent', border: '1px solid #30363D', borderRadius: '999px', padding: '6px 12px', cursor: 'pointer' }}>Restart</button>
          </div>
          <div ref={termRef} style={{ padding: '20px 18px', minHeight: '340px', fontFamily: 'var(--ak-font-mono)', fontSize: '12.5px', lineHeight: '1.9' }}>
            {replayLines.map((line) => (
              <div key={line.key} style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                <span data-col="time" style={{ color: '#8B949E', width: '44px', flex: 'none', fontSize: '11px' }}>{line.time}</span>
                <span style={{ width: '14px', flex: 'none', color: `${line.leadColor}` }}>{line.lead}</span>
                <span style={{ width: '62px', flex: 'none', whiteSpace: 'nowrap', color: `${line.tagColor}` }}>{line.tag}</span>
                <span style={{ flex: '1', wordBreak: 'break-word', color: `${line.textColor}` }}>{line.text}<span style={{ color: '#56D364', animation: 'blink 1s steps(1) infinite' }}>{line.cursor}</span></span>
                <span style={{ color: '#F85149', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', flex: 'none' }}>{line.note}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="profiles" style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto' }}>
        <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>04 · Flow profiles</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>Not every change deserves the same ceremony.</h2>
        <p style={{ margin: '0 0 32px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>The same loop adapts to each kind of work. Profiles are configurable per project.</p>

        <div data-profile={profile} aria-label="Configurable flow profile" style={{ border: '1px solid rgb(139 148 158 / 22%)', borderRadius: '20px', background: 'rgb(22 27 34 / 58%)', padding: 'clamp(20px, 4vw, 32px)', backdropFilter: 'blur(20px) saturate(120%)' }}>
          <div key={profile} className="harness-profile-content" aria-live="off">
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {profile === 'enterprise' ? <><path d="M4 21h16M6 21V4h12v17M9 8h2m2 0h2M9 12h2m2 0h2M9 16h2m2 0h2" /></> : profile === 'poc' ? <><path d="M9 3h6m-5 0v6l-5.5 9.2A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.8L14 9V3M8 15h8" /><path d="M10 18h.01M14 17h.01" /></> : <><path d="M3 12h4l3-8 4 16 3-8h4" /><circle cx="12" cy="12" r="10" /></>}
                </svg>
                {selected.label}
              </span>
              <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '10px', letterSpacing: '0.16em', textTransform: 'uppercase', color: '#8B949E' }}>One configurable loop</span>
            </div>
            <p style={{ margin: '18px 0 22px', fontFamily: 'var(--ak-font-display)', fontSize: 'clamp(20px, 2.8vw, 28px)', lineHeight: '1.25', color: '#E6EDF3' }}>{selected.description}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '12px', rowGap: '8px', fontFamily: 'var(--ak-font-mono)', fontSize: 'clamp(11px, 1.6vw, 13px)', color: '#C9D1D9' }}>
              {selected.steps.map((step, index) => (
                <span key={step}>{index > 0 ? <span aria-hidden="true" style={{ color: '#56D364', marginRight: '12px' }}>→</span> : null}{step}</span>
              ))}
            </div>
            <p style={{ margin: '24px 0 0', paddingTop: '16px', borderTop: '1px solid rgb(139 148 158 / 18%)', fontSize: '13px', lineHeight: '1.6', color: '#8B949E' }}>Configure the steps, vote threshold, CI checks, review rounds, and human gates for your project.</p>
          </div>
        </div>
      </section>

      {nightShift ? (<>
      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto' }}>
        <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>05 · While you sleep</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>It keeps pushing.</h2>
        <p style={{ margin: '0 0 36px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>The runner dispatches on its configured schedule. Work moves through verification and review while releases wait at the human gate.</p>

        <div data-anim="night" style={{ overflowX: 'auto', padding: '18px 0' }}>
          <svg viewBox="0 0 960 190" role="img" aria-label="Work moves from queue through dispatch, verification and review to a release waiting for human approval" style={{ minWidth: '680px', width: '100%', height: 'auto', fontFamily: 'var(--ak-font-mono)' }}>
            <defs>
              <linearGradient id="harness-flow-line" x1="0" x2="1"><stop offset="0%" stopColor="#30363D"/><stop offset="50%" stopColor="#56D364"/><stop offset="100%" stopColor="#30363D"/></linearGradient>
            </defs>
            <path d="M80 96 H 880" fill="none" stroke="#30363D" strokeWidth="2"/>
            <path d="M80 96 H 880" fill="none" stroke="url(#harness-flow-line)" strokeWidth="2" strokeDasharray="10 14" style={{ animation: 'flow .65s linear infinite' }}/>
            <g fill="#0D1117" stroke="#8B949E" strokeWidth="2">
              <circle cx="80" cy="96" r="7"/><circle cx="280" cy="96" r="7"/><circle cx="480" cy="96" r="7"/><circle cx="680" cy="96" r="7"/><circle cx="880" cy="96" r="7"/>
            </g>
            <g fill="#E6EDF3" fontSize="12" textAnchor="middle">
              <text x="80" y="60">Queue</text><text x="280" y="60">Dispatch</text><text x="480" y="60">Verify</text><text x="680" y="60">Review</text><text x="880" y="60">Release</text>
            </g>
            <g fill="#8B949E" fontSize="10" textAnchor="middle">
              <text x="80" y="126">ready work</text><text x="280" y="126">worker starts</text><text x="480" y="126">checks run</text><text x="680" y="126">changes reviewed</text><text x="880" y="126">human gate</text>
            </g>
            <g className="harness-timeline-pulse" style={{ transformBox: 'view-box', animation: 'harness-timeline-travel 5s linear infinite' }}><circle cx="80" cy="96" r="5" fill="#56D364"/></g>
            <g className="harness-timeline-pulse" style={{ transformBox: 'view-box', animation: 'harness-timeline-travel 5s linear 2.5s infinite' }}><circle cx="80" cy="96" r="3.5" fill="#58A6FF"/></g>
          </svg>
        </div>
        <p style={{ margin: '8px 0 0', fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8B949E' }}>Local runner · git worktrees · tmux · configured schedule</p>
      </section>
      </>) : null}

      <section id="seams" style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto' }}>
        <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>06 · Seams</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>It does not name your vendor.</h2>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', columnGap: '32px', rowGap: '18px' }}>
          <p style={{ margin: '0', display: 'flex', alignItems: 'center', gap: '12px' }}><GitBranch size={20} strokeWidth={1.6} aria-hidden="true" /><span style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><code style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '13px', color: '#E6EDF3' }}>Tracker</code><span style={{ fontSize: '12px', color: '#8B949E' }}>Linear</span></span></p>
          <p style={{ margin: '0', display: 'flex', alignItems: 'center', gap: '12px' }}><GitPullRequest size={20} strokeWidth={1.6} aria-hidden="true" /><span style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><code style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '13px', color: '#E6EDF3' }}>Source control</code><span style={{ fontSize: '12px', color: '#8B949E' }}>GitHub</span></span></p>
          <p style={{ margin: '0', display: 'flex', alignItems: 'center', gap: '12px' }}><Workflow size={20} strokeWidth={1.6} aria-hidden="true" /><span style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><code style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '13px', color: '#E6EDF3' }}>Runner</code><span style={{ fontSize: '12px', color: '#8B949E' }}>Orca · local</span></span></p>
        </div>
      </section>

      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto' }}>
        <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>07 · Machine surfaces</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>Readable by the things that will read it.</h2>
        <p style={{ margin: '0 0 28px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Every command that reports also reports as JSON, and every page has a raw Markdown twin.</p>

        {/* Counted out of the repository at build time and served verbatim at /api/stats.json — the page and the
            machine surface can never disagree, because they are the same numbers. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: '16px', marginBottom: '28px' }}>
          {STATS.map((stat) => (
            <div key={stat.label} style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span style={{ fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.02em', fontSize: '32px', lineHeight: '1', fontWeight: '600', color: '#E6EDF3' }}>{counts[stat.key]}</span>
              <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>{stat.label}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          <a href="/llms.txt" style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '12px', padding: '10px 14px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22' }}>/llms.txt</a>
          <a href="/api/stats.json" style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '12px', padding: '10px 14px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22' }}>/api/stats.json</a>
          <a href="/docs" style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '12px', padding: '10px 14px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22' }}>raw Markdown for every page</a>
          <a href="/docs/reference/cli" style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '12px', padding: '10px 14px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22' }}>--json on every command</a>
        </div>
      </section>

      <section style={{ padding: 'clamp(88px, 12vw, 144px) 28px' }}>
        <div style={{ maxWidth: '1180px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px', alignItems: 'flex-start' }}>
          <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>AgentsKit Harness</span>
          <h2 style={{ margin: '0', fontFamily: 'var(--ak-font-display)', letterSpacing: '-0.035em', fontSize: 'clamp(40px, 7vw, 76px)', lineHeight: '0.98', fontWeight: '600', maxWidth: '11ch' }}>Put the loop to work.</h2>
          <p style={{ margin: '0', maxWidth: '52ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Start with one command. Keep the workflow, evidence, and release gates under your control.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', border: '1px solid rgb(139 148 158 / 24%)', borderRadius: '14px', background: 'rgb(22 27 34 / 48%)', minWidth: 'min(420px, 100%)', boxSizing: 'border-box' }}>
              <span style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '13px', color: '#56D364' }}>$</span>
              <code style={{ fontFamily: 'var(--ak-font-mono)', fontSize: '13px', color: '#E6EDF3', flex: '1', overflowX: 'auto', whiteSpace: 'nowrap' }}>{INSTALL}</code>
              <CopyButton text={INSTALL} />
            </div>
            <a href="/docs" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', minHeight: '44px', padding: '0 16px', borderRadius: '999px', background: '#E6EDF3', color: '#0D1117', fontSize: '14px', fontWeight: '600' }}>Read the docs →</a>
          </div>
        </div>
      </section>

      <EcosystemShowcase />
      </main>

      <SiteFooter />

      </div>
    </div>
  )
}
