/** Theme tokens as CSS values, so charts follow `index.css` instead of hard-coding hex. */
export const tone = {
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  drift: 'var(--color-drift)',
  system: 'var(--color-system)',
  muted: 'var(--color-ink-subtle)',
  track: 'var(--color-line-soft)',
  axis: 'var(--color-line)',
} as const

/** Categorical order for series without a fixed meaning (roles, providers). */
export const series = [tone.accent, tone.warning, tone.drift, tone.system, tone.success, tone.danger] as const
export const seriesColor = (index: number): string => series[index % series.length] ?? tone.accent
