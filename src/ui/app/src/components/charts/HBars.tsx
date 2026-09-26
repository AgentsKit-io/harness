import * as React from 'react'
import { tone } from './palette'

export interface HBarItem { readonly label: string; readonly value: number; readonly color?: string }

/** Labelled horizontal bars, longest = full width. A real list, so screen readers get the numbers as text. */
export const HBarList = ({ items, label, max }: { readonly items: readonly HBarItem[]; readonly label: string; readonly max?: number }): React.ReactElement => {
  const top = max ?? Math.max(1, ...items.map((item) => item.value))
  return (
    <ul aria-label={label} className="flex flex-col gap-2.5">
      {items.map((item, index) => (
        <li key={item.label} className="flex flex-col gap-1">
          <div className="flex text-xs text-ink-muted"><span className="min-w-0 truncate">{item.label}</span><span className="ml-auto pl-2 font-mono text-ink-subtle">{item.value}</span></div>
          <div className="h-1.5 rounded-sm bg-line-soft" aria-hidden>
            <div className="chart-grow-x h-1.5 rounded-sm" style={{ width: `${(item.value / top) * 100}%`, background: item.color ?? tone.accent, animationDelay: `${index * 40}ms` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export interface Segment { readonly label: string; readonly value: number; readonly color: string }

/** One 100%-wide bar split by share (criteria at merge, plan used). */
export const SegmentBar = ({ segments, label, className }: { readonly segments: readonly Segment[]; readonly label: string; readonly className?: string }): React.ReactElement => {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  return (
    <div role="img" aria-label={label} className={`chart-grow-x flex overflow-hidden rounded-md bg-line-soft ${className ?? 'h-3'}`}>
      {total > 0 && segments.map((segment) => segment.value > 0 && <span key={segment.label} style={{ width: `${(segment.value / total) * 100}%`, background: segment.color }} />)}
    </div>
  )
}
