'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A recorded run, replayed line by line into a `<pre>`.
 *
 * Deliberately not a terminal emulator: xterm would ship a few hundred kilobytes to animate text nobody can
 * type into. A `requestAnimationFrame` clock over a recorded array is the whole mechanism, the text stays
 * selectable, and a reader who prefers reduced motion gets the finished output immediately.
 */
export function RunReplay({ lines, title = 'recorded run', msPerLine = 420 }: { readonly lines: readonly string[]; readonly title?: string; readonly msPerLine?: number }) {
  const [shown, setShown] = useState(lines.length)
  const [playing, setPlaying] = useState(false)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduced) { setShown(0); setPlaying(true) }
  }, [])

  useEffect(() => {
    if (!playing) return undefined
    let start: number | null = null
    const step = (now: number) => {
      if (start === null) start = now
      const next = Math.min(lines.length, Math.floor((now - start) / msPerLine) + 1)
      setShown(next)
      if (next >= lines.length) { setPlaying(false); return }
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }
  }, [playing, lines.length, msPerLine])

  const replay = useCallback(() => { setShown(0); setPlaying(true) }, [])

  return (
    <figure className="my-6 not-prose overflow-hidden rounded-xl border border-fd-border">
      <div className="flex items-center justify-between border-b border-fd-border px-4 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-fd-muted-foreground">{title}</span>
        <button type="button" onClick={replay} className="min-h-11 rounded-md px-3 font-mono text-[11px] text-fd-muted-foreground hover:text-fd-foreground">
          {playing ? 'playing…' : 'replay'}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto p-4 text-[13px] leading-6" aria-live="off">
        {lines.slice(0, shown).join('\n')}
      </pre>
    </figure>
  )
}
