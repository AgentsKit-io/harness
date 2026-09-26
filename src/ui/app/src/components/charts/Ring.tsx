import * as React from 'react'
import { tone } from './palette'

export interface RingProps {
  /** 0..1; `null` draws an empty track. */
  readonly value: number | null
  readonly label: string
  readonly color?: string
  readonly size?: number
  readonly children?: React.ReactNode
}

/** Single-value donut with centred content. */
export const Ring = ({ value, label, color = tone.success, size = 96, children }: RingProps): React.ReactElement => {
  const r = 15.9155 // circumference 100, so dasharray reads as percent
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100
  return (
    <div role="img" aria-label={label} className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r={r} fill="none" stroke={tone.track} strokeWidth="4" />
        {pct > 0 && <circle className="chart-fade" cx="18" cy="18" r={r} fill="none" stroke={color} strokeWidth="4" strokeDasharray={`${pct} ${100 - pct}`} />}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center" aria-hidden>{children}</div>
    </div>
  )
}
