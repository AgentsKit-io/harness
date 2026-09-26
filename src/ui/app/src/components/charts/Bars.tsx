import * as React from 'react'

export interface BarDatum {
  readonly label: string
  /** One value per segment, bottom first; a single value is a plain bar. */
  readonly values: readonly number[]
  /** Optional per-bar colour override for single-segment bars. */
  readonly color?: string
}

export interface BarsProps {
  readonly data: readonly BarDatum[]
  /** Segment colours, bottom first. */
  readonly colors: readonly string[]
  /** Accessible summary with the key numbers. */
  readonly label: string
  /** Text shown above each bar (e.g. the merged count); omitted when not given. */
  readonly valueLabel?: (datum: BarDatum) => string
  readonly max?: number
  readonly gap?: number
  readonly className?: string
}

/**
 * Vertical bars, optionally stacked. Columns are flex boxes, so they are responsive without a viewBox and the
 * value labels never stretch. The visible bars are decorative; `label` carries the numbers for screen readers.
 */
export const Bars = ({ data, colors, label, valueLabel, max, gap = 6, className }: BarsProps): React.ReactElement => {
  const top = max ?? Math.max(1, ...data.map((datum) => datum.values.reduce((sum, value) => sum + value, 0)))
  return (
    <div role="img" aria-label={label} className={`flex min-h-0 items-end border-b border-line ${className ?? 'h-32'}`} style={{ gap }}>
      {data.map((datum, index) => (
        <div key={`${datum.label}-${index}`} title={`${datum.label}: ${datum.values.join(' / ')}`} className="flex h-full min-w-0 grow basis-0 flex-col justify-end gap-0.5" aria-hidden>
          {valueLabel && <span className="text-center font-mono text-[10px] text-ink-subtle">{valueLabel(datum)}</span>}
          <div className="chart-grow-y flex flex-col-reverse overflow-hidden rounded-t-[3px]" style={{ height: `${(datum.values.reduce((sum, value) => sum + value, 0) / top) * 88}%`, animationDelay: `${index * 15}ms` }}>
            {datum.values.map((value, segment) => value > 0 && (
              <span key={segment} style={{ flexGrow: value, background: datum.color ?? colors[segment % colors.length] }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export interface StackedBarsProps<K extends string> {
  readonly data: readonly { readonly label: string; readonly values: Readonly<Partial<Record<K, number>>> }[]
  /** Stack order bottom first; also the legend. */
  readonly keys: readonly { readonly key: K; readonly label: string; readonly color: string }[]
  readonly label: string
  readonly className?: string
  readonly gap?: number
}

/** Bars stacked by a named key (tokens by role, …): a keyed front-end for `Bars`. */
export const StackedBars = <K extends string>({ data, keys, label, className, gap = 4 }: StackedBarsProps<K>): React.ReactElement => (
  <Bars label={label} className={className} gap={gap} colors={keys.map((item) => item.color)}
    data={data.map((datum) => ({ label: datum.label, values: keys.map((item) => datum.values[item.key] ?? 0) }))} />
)

export const Legend = ({ items, className }: { readonly items: readonly { readonly label: string; readonly color: string; readonly value?: string }[]; readonly className?: string }): React.ReactElement => (
  <ul className={`flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] text-ink-muted ${className ?? ''}`}>
    {items.map((item) => <li key={item.label}><span aria-hidden style={{ color: item.color }}>■</span> {item.label}{item.value !== undefined && ` ${item.value}`}</li>)}
  </ul>
)
