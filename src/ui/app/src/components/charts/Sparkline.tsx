import * as React from 'react'
import { tone } from './palette'

export interface SparklineProps {
  readonly values: readonly number[]
  /** Accessible summary, e.g. "Merged in the last 24h: 7". */
  readonly label: string
  readonly color?: string
  readonly className?: string
}

/** Tiny trend line; scales to its box (viewBox + non-scaling stroke). */
export const Sparkline = ({ values, label, color = tone.accent, className }: SparklineProps): React.ReactElement => {
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? 100 / (values.length - 1) : 0
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(23 - (value / max) * 22).toFixed(2)}`).join(' ')
  return (
    <svg role="img" aria-label={label} viewBox="0 0 100 24" preserveAspectRatio="none" className={className ?? 'h-6 w-24'}>
      {values.length > 1 && <polyline className="chart-fade" points={points} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
    </svg>
  )
}
