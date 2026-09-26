import * as React from 'react'
import { tone } from './palette'

export interface LinePoint { readonly x: number; readonly y: number | null }

export interface LineSeries {
  readonly label: string
  readonly color: string
  /** `y: null` breaks the line. */
  readonly points: readonly LinePoint[]
  /** Drawn dashed, e.g. a projection from the last real point forward. */
  readonly projection?: readonly LinePoint[]
}

export interface LineChartProps {
  readonly series: readonly LineSeries[]
  readonly label: string
  readonly xDomain?: readonly [number, number]
  readonly yMax?: number
  /** Vertical dashed marker (e.g. "now"), in x units. */
  readonly marker?: number
  /** Horizontal guide lines, in y units. */
  readonly guides?: readonly number[]
  readonly className?: string
}

const W = 400
const H = 150

/** Split a series into drawable runs at `null` gaps. */
export const segments = (points: readonly LinePoint[]): LinePoint[][] => {
  const runs: LinePoint[][] = [[]]
  for (const point of points) {
    if (point.y === null) { if (runs.at(-1)?.length) runs.push([]) } else runs.at(-1)?.push(point)
  }
  return runs.filter((run) => run.length > 0)
}

/** Multi-series line chart in a fixed viewBox stretched to its box; strokes stay crisp via non-scaling-stroke. */
export const LineChart = ({ series, label, xDomain, yMax, marker, guides = [], className }: LineChartProps): React.ReactElement => {
  const all = series.flatMap((item) => [...item.points, ...(item.projection ?? [])])
  const xs = all.map((point) => point.x)
  const [x0, x1] = xDomain ?? [Math.min(0, ...xs), Math.max(1, ...xs)]
  const top = yMax ?? Math.max(1, ...all.map((point) => point.y ?? 0)) * 1.1
  const px = (x: number): number => ((x - x0) / Math.max(1e-9, x1 - x0)) * W
  const py = (y: number): number => H - 1 - (y / top) * (H - 4)
  const path = (run: readonly LinePoint[]): string => run.map((point) => `${px(point.x).toFixed(1)},${py(point.y ?? 0).toFixed(1)}`).join(' ')
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className ?? 'h-32 w-full'}>
      {guides.map((y) => <line key={y} x1={0} x2={W} y1={py(y)} y2={py(y)} stroke={tone.track} vectorEffect="non-scaling-stroke" />)}
      <line x1={0} x2={W} y1={H - 1} y2={H - 1} stroke={tone.axis} vectorEffect="non-scaling-stroke" />
      {marker !== undefined && <line x1={px(marker)} x2={px(marker)} y1={0} y2={H} stroke={tone.axis} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}
      {series.map((item) => (
        <g key={item.label} className="chart-fade">
          {segments(item.points).map((run, index) => run.length === 1
            ? <circle key={index} cx={px(run[0]?.x ?? 0)} cy={py(run[0]?.y ?? 0)} r={2} fill={item.color} />
            : <polyline key={index} points={path(run)} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
          {item.projection && item.projection.length > 1 && (
            <polyline points={path(item.projection)} fill="none" stroke={item.color} strokeWidth={2} strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
          )}
        </g>
      ))}
    </svg>
  )
}
