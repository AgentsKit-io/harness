import * as React from 'react'

/** Tiny inline sparkline for the home cards; `className` sets the stroke color (e.g. `text-success`). */
export const Sparkline = ({ values, className }: { readonly values: readonly number[]; readonly className?: string }): React.ReactElement => {
  const max = Math.max(...values, 1)
  const points = values.map((value, index) => `${(index * 100 / Math.max(values.length - 1, 1)).toFixed(1)},${(24 - value / max * 22).toFixed(1)}`).join(' ')
  return (
    <svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden className={className} style={{ width: '100%', height: 26 }}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
