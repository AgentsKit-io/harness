'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { EcosystemShowcase } from './ecosystem'

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

const CHAR = 20
const GAP = 320
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']
const INSTALL = 'npx @agentskit/harness loop init'

const PROFILES = {
  enterprise: { votes: 3, ci: 1, pr: 1 },
  poc: { votes: 1, ci: 0.25, pr: 0.25 },
  incident: { votes: 0.25, ci: 0.25, pr: 0.25 },
} as const

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

export function HarnessHome() {
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
  const border = (name: ProfileName): string => (profile === name ? '#56D364' : '#30363D')

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
  const nVotes = selected.votes < 1 ? 0 : selected.votes
  const hasVotes = selected.votes >= 1
  const hasCI = selected.ci >= 1
  const hasPr = selected.pr >= 1
  const bEnterprise = border('enterprise')
  const bPoc = border('poc')
  const bIncident = border('incident')
  const pickEnterprise = useCallback(() => setProfile('enterprise'), [])
  const pickPoc = useCallback(() => setProfile('poc'), [])
  const pickIncident = useCallback(() => setProfile('incident'), [])
  const nightShift = true

  return (
    <div className="harness-home">

      <div style={{ maxWidth: '100%', overflowX: 'hidden' }}>

      <header style={{ position: 'sticky', top: '0', zIndex: '40', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', padding: '14px 28px', borderBottom: '1px solid #30363D', background: 'rgba(13,17,23,0.86)', backdropFilter: 'blur(10px)' }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#E6EDF3' }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: '22px', height: '22px', display: 'block', flex: 'none' }}>
            <path d="M12 5.5 L5 17 L19 17 Z" fill="none" stroke="#56D364" strokeWidth="1.2"></path>
            <circle cx="12" cy="5.5" r="2.7" fill="#56D364"></circle>
            <circle cx="5" cy="17" r="2.7" fill="#56D364"></circle>
            <circle cx="19" cy="17" r="2.7" fill="#56D364"></circle>
          </svg>
          <span style={{ fontFamily: '\'Space Grotesk\', sans-serif', fontWeight: '600', letterSpacing: '-0.02em', fontSize: '15px' }}>agentskit harness</span>
        </a>
        <nav style={{ display: 'flex', alignItems: 'center', gap: '22px', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>
          <a href="/docs" style={{ color: '#8B949E' }}>Docs</a>
          <a href="#gates" style={{ color: '#8B949E' }}>Gates</a>
          <a href="#run" style={{ color: '#8B949E' }}>A run</a>
          <a href="/llms.txt" style={{ color: '#8B949E' }}>llms.txt</a>
          <a href="https://github.com/AgentsKit-io" style={{ color: '#8B949E' }}>GitHub</a>
        </nav>
      </header>

      <section style={{ padding: '72px 28px 40px', maxWidth: '1180px', margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '56px', alignItems: 'start' }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '22px', paddingTop: '8px' }}>
            <h1 style={{ margin: '0', display: 'flex', alignItems: 'center', gap: '10px', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364', fontWeight: '500' }}><span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '999px', background: '#56D364' }}></span>AgentsKit Harness</h1>
            <p style={{ margin: '0', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(34px, 4.6vw, 54px)', lineHeight: '1.05', fontWeight: '600', color: '#E6EDF3', textWrap: 'pretty' }}>The keep-pushing loop for your SDLC.</p>
            <p style={{ margin: '0', maxWidth: '46ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E', textWrap: 'pretty' }}>From a vague objective to production without babysitting an agent — interview, plan, votes, worker, review, merge, release. Every transition is the machine's decision over an explicit state. A human acts in five places, and only where something touches the world.</p>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', border: '1px solid #30363D', boxSizing: 'border-box', borderRadius: '0.5rem', background: '#161B22', width: '100%', maxWidth: '420px' }}>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', color: '#8B949E' }}>$</span>
              <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', color: '#E6EDF3', flex: '1', overflowX: 'auto', whiteSpace: 'nowrap' }}>npx @agentskit/harness loop init</code>
              <button className="hv1" onClick={copyInstall} style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E', background: 'transparent', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '6px 9px', cursor: 'pointer' }}>{copyLabel}</button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase' }}>
              <a className="hv2" href="https://github.com/AgentsKit-io/agentskit-harness" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 16px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22', color: '#E6EDF3', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}><span style={{ color: '#56D364', letterSpacing: '0' }}>★</span>Star on GitHub</a>
              <a href="/docs">Read the docs →</a>
              <a href="#run" style={{ color: '#8B949E' }}>See a run →</a>
            </div>
          </div>

          <figure role="group" aria-label="The harness loop, drawn as a vertical factory" style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <figcaption style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>the loop · 11s cycle</figcaption>
              <button className="hv3" onClick={toggleFigure} aria-label="Play or pause the loop animation" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#E6EDF3', background: '#161B22', border: '1px solid #30363D', borderRadius: '999px', padding: '7px 13px', cursor: 'pointer' }}>{figureLabel}</button>
            </div>

            <p style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>A vague objective enters at the top and descends through six levels: the objective becomes a PRD, the PRD becomes a technical design, the design fans out into parallel issues worked by separate agents, one of which goes back a level for a fix round, the branches converge into a reviewed pull request, and a merge reaches production. A human gate stops the flow at the PRD, at the design, and before the release. A return stroke climbs the right edge and starts the next cycle with a new objective.</p>

            <div style={{ boxSizing: 'border-box', width: '58.82%', minWidth: '0', margin: '0 auto -10px', border: '1px solid #30363D', borderRadius: '8px', background: '#161B22', padding: '10px 14px 12px', fontFamily: '\'JetBrains Mono\', monospace' }}>
              <div style={{ fontSize: '9.5px', letterSpacing: '0.2em', color: '#8B949E' }}>00 · OBJECTIVE</div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', fontSize: '14px', color: '#E6EDF3', marginTop: '6px' }}>
                <span style={{ color: '#56D364', flex: 'none' }}>›</span>
                <span style={{ flex: '1', minWidth: '0', overflow: 'hidden', display: 'flex', justifyContent: 'flex-end', whiteSpace: 'nowrap' }}><span style={{ flex: 'none', display: 'flex', marginRight: 'auto' }}><span>{typed}</span><span style={{ color: '#56D364', animation: 'blink 1s steps(1) infinite' }}>▌</span></span></span>
              </div>
            </div>
            <svg viewBox="0 84 680 716" role="img" aria-hidden="true" data-figure={figState} style={{ width: '100%', height: 'auto', display: 'block', fontFamily: '\'JetBrains Mono\', monospace', overflow: 'visible' }}>

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
        <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>01 · The human part</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>Five places where you act. Nowhere else.</h2>
        <p style={{ margin: '0 0 40px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Everything that touches the world keeps a person in front of it. Everything else is the machine's decision over an explicit state.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: '16px' }}>
          <div className="hv4" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>01</span>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>The PRD is approved.</p>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', color: '#8B949E', background: '#0D1117', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '8px 10px', overflowX: 'auto' }}>loop plan approve &lt;id&gt;</code>
          </div>
          <div className="hv5" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>02</span>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>The technical design is approved, after 2 of 3 agents agree.</p>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', color: '#8B949E', background: '#0D1117', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '8px 10px', overflowX: 'auto' }}>loop plan approve-design &lt;id&gt;</code>
          </div>
          <div className="hv6" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>03</span>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>An issue enters the queue: Todo → Ready.</p>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', color: '#8B949E', background: '#0D1117', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '8px 10px', overflowX: 'auto' }}>a gesture in your tracker</code>
          </div>
          <div className="hv7" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>04</span>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>A pull request is approved — only if the flow asks for it.</p>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', color: '#8B949E', background: '#0D1117', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '8px 10px', overflowX: 'auto' }}>on GitHub</code>
          </div>
          <div className="hv8" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)' }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', color: '#56D364' }}>05</span>
            <p style={{ margin: '0', fontSize: '15px', lineHeight: '1.5', color: '#E6EDF3' }}>A release batch is promoted and deployed.</p>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', color: '#8B949E', background: '#0D1117', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '8px 10px', overflowX: 'auto' }}>loop release approve</code>
          </div>
        </div>

        <p style={{ margin: '28px 0 0', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', lineHeight: '1.7', color: '#8B949E' }}>Everything between these five is decided by the machine over state it can read: plan, votes, worktree, checks, Definition of Done, merge, release batch.</p>
      </section>

      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
        <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>02 · Per issue</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>A plan, voted on, before any worker starts.</h2>
        <p style={{ margin: '0 0 36px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>The planner writes the plan and three agents vote on it — in the harness, headless, before a worktree exists. You read the plan and the votes; the machine counts them and decides.</p>

        <div data-anim="track" style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', padding: '24px', overflowX: 'auto' }}>
          <svg viewBox="0 0 980 240" role="img" aria-label="Track: planner, three voting agents, build, verify, review, definition of done, pull request, with a retry edge back to build" style={{ minWidth: '720px', width: '100%', height: 'auto', fontFamily: '\'JetBrains Mono\', monospace' }}>
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

        <ul style={{ listStyle: 'none', margin: '24px 0 0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '14px' }}>
          <li style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', lineHeight: '1.7', color: '#8B949E', borderLeft: '1px solid #30363D', paddingLeft: '14px' }}>A rejecting vote must carry a concrete objection. One that cannot be answered is discarded, not counted.</li>
          <li style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', lineHeight: '1.7', color: '#8B949E', borderLeft: '1px solid #30363D', paddingLeft: '14px' }}>Both Definition of Done lists — the project's and the issue's — are proven on the PR before it merges.</li>
          <li style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', lineHeight: '1.7', color: '#8B949E', borderLeft: '1px solid #30363D', paddingLeft: '14px' }}>Three models disagreeing three times is an ambiguous requirement, not a retry.</li>
        </ul>
      </section>

      <section id="run" style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
        <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>03 · Evidence</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>This is the actual output.</h2>
        <p style={{ margin: '0 0 36px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Recorded from a real run. Lines the harness could not yet write to a live repository are marked <span style={{ color: '#E6EDF3' }}>reconstructed</span> — they are not evidence, and we will not pretend otherwise.</p>

        <div style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', borderBottom: '1px solid #30363D' }}>
            <span style={{ display: 'flex', gap: '6px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: '#30363D', display: 'inline-block' }}></span>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: '#30363D', display: 'inline-block' }}></span>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: '#30363D', display: 'inline-block' }}></span>
            </span>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E', flex: '1' }}>run-2026-09-19-a3.log</span>
            <button className="hv9" onClick={toggleReplay} style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#E6EDF3', background: '#0D1117', border: '1px solid #30363D', borderRadius: '999px', padding: '6px 12px', cursor: 'pointer' }}>{replayLabel}</button>
            <button className="hv10" onClick={restartReplay} style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E', background: 'transparent', border: '1px solid #30363D', borderRadius: '999px', padding: '6px 12px', cursor: 'pointer' }}>Restart</button>
          </div>
          <div ref={termRef} style={{ padding: '20px 18px', minHeight: '340px', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12.5px', lineHeight: '1.9' }}>
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
        <p style={{ margin: '16px 0 0', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>41 s of wall clock · one issue · one pull request</p>
      </section>

      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
        <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>04 · Flow profiles</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>Not every change deserves the same ceremony.</h2>
        <p style={{ margin: '0 0 32px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Same engine, three configurations. Pick one and the loop re-prices itself.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '14px', marginBottom: '28px' }}>
          <button onClick={pickEnterprise} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '8px', padding: '18px', borderRadius: '0.75rem', background: '#161B22', cursor: 'pointer', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)', border: `1px solid ${bEnterprise}` }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>enterprise</span>
            <span style={{ fontSize: '14px', color: '#8B949E', lineHeight: '1.5' }}>Everything on. For code other teams depend on.</span>
          </button>
          <button onClick={pickPoc} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '8px', padding: '18px', borderRadius: '0.75rem', background: '#161B22', cursor: 'pointer', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)', border: `1px solid ${bPoc}` }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>poc</span>
            <span style={{ fontSize: '14px', color: '#8B949E', lineHeight: '1.5' }}>One vote, no CI babysitting, no PR approval.</span>
          </button>
          <button onClick={pickIncident} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '8px', padding: '18px', borderRadius: '0.75rem', background: '#161B22', cursor: 'pointer', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)', border: `1px solid ${bIncident}` }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>incident</span>
            <span style={{ fontSize: '14px', color: '#8B949E', lineHeight: '1.5' }}>Planning votes skipped. Two fix rounds kept.</span>
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '20px', alignItems: 'stretch' }}>
          <div style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>the loop, re-priced</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '8px 12px', border: '1px solid #30363D', borderRadius: '0.375rem', color: '#E6EDF3' }}>plan</span>
              {hasVotes ? (<>
                <span style={{ color: '#30363D' }}>→</span>
                <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '8px 12px', border: '1px solid #30363D', borderRadius: '0.375rem', color: '#E6EDF3' }}>votes ×{nVotes}</span>
              </>) : null}
              <span style={{ color: '#30363D' }}>→</span>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '8px 12px', border: '1px solid #30363D', borderRadius: '0.375rem', color: '#E6EDF3' }}>work</span>
              {hasCI ? (<>
                <span style={{ color: '#30363D' }}>→</span>
                <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '8px 12px', border: '1px solid #30363D', borderRadius: '0.375rem', color: '#E6EDF3' }}>ci watch</span>
              </>) : null}
              {hasPr ? (<>
                <span style={{ color: '#30363D' }}>→</span>
                <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '8px 12px', border: '1px solid #30363D', borderRadius: '0.375rem', color: '#E6EDF3' }}>human PR</span>
              </>) : null}
              <span style={{ color: '#30363D' }}>→</span>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '8px 12px', border: '1px solid #56D364', borderRadius: '0.375rem', color: '#E6EDF3' }}>release</span>
            </div>
            <div style={{ borderTop: '1px solid #30363D', paddingTop: '14px', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', lineHeight: '1.8', color: '#8B949E' }}>
              <div><span style={{ color: '#F85149' }}>- merge.requireChecks: true</span></div>
              <div><span style={{ color: '#2EA043' }}>+ merge.requireChecks: false</span></div>
            </div>
            <p style={{ margin: '0', fontSize: '14px', lineHeight: '1.6', color: '#8B949E' }}>That one line is the difference between an enterprise flow and a POC one.</p>
          </div>

          <div style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) repeat(3, minmax(max-content, 1fr))', gridAutoRows: '1fr', flex: '1', fontFamily: '\'JetBrains Mono\', monospace' }}>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8B949E', whiteSpace: 'nowrap', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 18px' }}></span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8B949E', whiteSpace: 'nowrap', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>enterprise</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8B949E', whiteSpace: 'nowrap', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>poc</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8B949E', whiteSpace: 'nowrap', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 18px 14px 0' }}>incident</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#8B949E', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 18px' }}>Plan votes</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>3</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>1</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 18px 14px 0' }}>skipped</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#8B949E', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 18px' }}>CI babysitting</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>on</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>off</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 18px 14px 0' }}>off</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#8B949E', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 18px' }}>Human PR approval</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>yes</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 10px 14px 0' }}>no</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', borderBottom: '1px solid #30363D', padding: '14px 18px 14px 0' }}>no</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#8B949E', minWidth: '0', padding: '14px 10px 14px 18px' }}>Fix rounds</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', padding: '14px 10px 14px 0' }}>2</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', padding: '14px 10px 14px 0' }}>1</span>
              <span style={{ display: 'flex', alignItems: 'center', fontSize: '12.5px', color: '#E6EDF3', minWidth: '0', padding: '14px 18px 14px 0' }}>2</span>
            </div>
          </div>
        </div>
      </section>

      {nightShift ? (<>
      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
        <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>05 · While you sleep</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>It keeps pushing.</h2>
        <p style={{ margin: '0 0 36px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>The crontab dispatches on its own schedule. At 09:00 the queue is a list of merged pull requests and one thing that needs a person.</p>

        <div data-anim="night" style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', padding: '24px', overflowX: 'auto' }}>
          <svg viewBox="0 0 960 190" role="img" aria-label="A 24-hour band showing dispatches, reviews and merges through the night, with one item waiting for a human at 09:00" style={{ minWidth: '680px', width: '100%', height: 'auto', fontFamily: '\'JetBrains Mono\', monospace' }}>
            <rect x="460" y="44" width="220" height="102" fill="#0D1117"></rect>
            <text x="468" y="34" fill="#8B949E" fontSize="9.5" letterSpacing="2">02:00 — 06:00 · UNATTENDED</text>
            <line x1="20" y1="146" x2="940" y2="146" stroke="#30363D"></line>
            <g fill="#8B949E" fontSize="9.5" letterSpacing="1.6" textAnchor="middle">
              <text x="20" y="166" textAnchor="start">18:00</text>
              <text x="240" y="166">22:00</text>
              <text x="460" y="166">02:00</text>
              <text x="680" y="166">06:00</text>
              <text x="900" y="166" textAnchor="end">09:00</text>
            </g>
            <g stroke="#30363D">
              <line x1="20" y1="140" x2="20" y2="146"></line>
              <line x1="240" y1="140" x2="240" y2="146"></line>
              <line x1="460" y1="140" x2="460" y2="146"></line>
              <line x1="680" y1="140" x2="680" y2="146"></line>
              <line x1="900" y1="140" x2="900" y2="146"></line>
            </g>
            <g fontSize="10">
              <rect x="60" y="112" width="86" height="22" rx="4" fill="#161B22" stroke="#30363D"></rect>
              <text x="70" y="127" fill="#8B949E">dispatch ×2</text>
              <rect x="250" y="82" width="78" height="22" rx="4" fill="#161B22" stroke="#58A6FF"></rect>
              <text x="260" y="97" fill="#58A6FF">review ×3</text>
              <rect x="400" y="112" width="86" height="22" rx="4" fill="#161B22" stroke="#30363D"></rect>
              <text x="410" y="127" fill="#8B949E">dispatch ×3</text>
              <rect x="520" y="52" width="72" height="22" rx="4" fill="#161B22" stroke="#2EA043"></rect>
              <text x="530" y="67" fill="#2EA043">merge ×2</text>
              <rect x="640" y="82" width="86" height="22" rx="4" fill="#161B22" stroke="#58A6FF"></rect>
              <text x="650" y="97" fill="#58A6FF">fix round ×1</text>
              <rect x="770" y="52" width="72" height="22" rx="4" fill="#161B22" stroke="#2EA043"></rect>
              <text x="780" y="67" fill="#2EA043">merge ×4</text>
              <rect x="856" y="96" width="96" height="40" rx="6" fill="#161B22" stroke="#56D364"></rect>
              <text x="866" y="112" fill="#E6EDF3">waiting</text>
              <text x="866" y="128" fill="#56D364" fontSize="9">1 release</text>
            </g>
            <line x1="20" y1="146" x2="940" y2="146" stroke="#56D364" strokeWidth="2" strokeDasharray="7 7" style={{ animation: 'flow .9s linear infinite' }}></line>
          </svg>
        </div>
        <p style={{ margin: '16px 0 0', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>Local runner: git worktree + tmux + the system crontab</p>
      </section>
      </>) : null}

      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
        <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>06 · Seams</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>It does not name your vendor.</h2>
        <p style={{ margin: '0 0 36px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Three interfaces, and today's implementations behind them. An interface with one implementation is a guess, so we say which ones are guesses.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: '16px' }}>
          <div style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', color: '#58A6FF' }}>TrackerConnector</code>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', padding: '6px 10px', border: '1px solid #30363D', borderRadius: '999px', color: '#E6EDF3' }}>Linear</span>
            </div>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>1 implementation</span>
          </div>
          <div style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', color: '#58A6FF' }}>ScmConnector</code>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', padding: '6px 10px', border: '1px solid #30363D', borderRadius: '999px', color: '#E6EDF3' }}>GitHub</span>
            </div>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>1 implementation</span>
          </div>
          <div style={{ border: '1px solid #30363D', borderRadius: '0.75rem', background: '#161B22', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', color: '#58A6FF' }}>RunnerConnector</code>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', padding: '6px 10px', border: '1px solid #30363D', borderRadius: '999px', color: '#E6EDF3' }}>Orca</span>
              <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', padding: '6px 10px', border: '1px solid #30363D', borderRadius: '999px', color: '#E6EDF3' }}>local</span>
            </div>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>2 implementations</span>
          </div>
        </div>

        <div style={{ marginTop: '16px', border: '1px solid #30363D', borderLeft: '2px solid #56D364', borderRadius: '0.5rem', background: '#161B22', padding: '18px 20px' }}>
          <p style={{ margin: '0', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', lineHeight: '1.7', color: '#E6EDF3' }}>The local runner is git worktree + tmux + the system crontab. No daemon, no Orca.</p>
        </div>
      </section>

      <section style={{ padding: '88px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
        <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#56D364' }}>07 · Machine surfaces</span>
        <h2 style={{ margin: '16px 0 12px', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: '600' }}>Readable by the things that will read it.</h2>
        <p style={{ margin: '0 0 28px', maxWidth: '62ch', fontSize: '16px', lineHeight: '1.65', color: '#8B949E' }}>Every command that reports also reports as JSON, and every page has a raw Markdown twin.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          <a href="/llms.txt" style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '10px 14px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22' }}>/llms.txt</a>
          <a href="/docs" style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '10px 14px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22' }}>raw Markdown for every page</a>
          <a href="/docs/reference/cli" style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '12px', padding: '10px 14px', border: '1px solid #30363D', borderRadius: '0.5rem', background: '#161B22' }}>--json on every command</a>
        </div>
      </section>

      <section style={{ padding: '96px 28px', borderTop: '1px solid #30363D', background: '#161B22' }}>
        <div style={{ maxWidth: '1180px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px', alignItems: 'flex-start' }}>
          <h2 style={{ margin: '0', fontFamily: '\'Space Grotesk\', sans-serif', letterSpacing: '-0.02em', fontSize: 'clamp(32px, 4vw, 48px)', lineHeight: '1.05', fontWeight: '600' }}>Start the loop.</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', border: '1px solid #30363D', boxSizing: 'border-box', borderRadius: '0.5rem', background: '#0D1117', width: '100%', maxWidth: '420px' }}>
            <span style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', color: '#8B949E' }}>$</span>
            <code style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '13px', color: '#E6EDF3', flex: '1', overflowX: 'auto', whiteSpace: 'nowrap' }}>npx @agentskit/harness loop init</code>
            <button className="hv11" onClick={copyInstall} style={{ fontFamily: '\'JetBrains Mono\', monospace', fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E', background: 'transparent', border: '1px solid #30363D', borderRadius: '0.375rem', padding: '6px 9px', cursor: 'pointer' }}>{copyLabel}</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase' }}>
            <a className="hv12" href="https://github.com/AgentsKit-io/agentskit-harness" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 16px', border: '1px solid #30363D', borderRadius: '0.5rem', color: '#E6EDF3', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)', background: '#0D1117' }}><span style={{ color: '#56D364', letterSpacing: '0' }}>★</span>Star on GitHub</a>
            <a href="/docs">Read the docs →</a>
          </div>
        </div>
      </section>

      <EcosystemShowcase />

      <footer style={{ padding: '56px 28px 72px', borderTop: '1px solid #30363D' }}>
        <div style={{ maxWidth: '1180px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '28px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', justifyContent: 'space-between', alignItems: 'center', fontFamily: '\'JetBrains Mono\', monospace', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>
            <span>Built in the open</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px' }}>
              <a href="/docs" style={{ color: '#8B949E' }}>Docs</a>
              <a href="/llms.txt" style={{ color: '#8B949E' }}>llms.txt</a>
              <a href="https://github.com/AgentsKit-io" style={{ color: '#8B949E' }}>GitHub</a>
            </div>
          </div>
        </div>
      </footer>

      </div>
    </div>
  )
}
