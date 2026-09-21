/**
 * The phases of one issue, as boxes with a repeat edge back from review to build.
 *
 * The boxes are HTML — real text, selectable, readable by a screen reader and reflowing on a phone. Only the
 * connectors are SVG, stretched with `preserveAspectRatio="none"` so the geometry follows the layout instead of
 * fighting it, and drawn with `vectorEffect="non-scaling-stroke"` so stretching never thickens a line.
 */
const PHASES = [
  { id: 'planner', label: 'planner', detail: 'writes the plan' },
  { id: 'vote', label: 'vote', detail: '2 of 3 approve' },
  { id: 'builder', label: 'builder', detail: 'works in its own worktree' },
  { id: 'verify', label: 'verify', detail: 'the cheap check first' },
  { id: 'review', label: 'review', detail: 'adversarial, at a severity floor' },
  { id: 'dod', label: 'definition of done', detail: 'both lists, proven' },
]

export function PipelineTrack({ repeatFrom = 'review', repeatTo = 'builder' }: { readonly repeatFrom?: string; readonly repeatTo?: string }) {
  return (
    <figure className="my-8 not-prose" aria-labelledby="pipeline-track-caption">
      <ol className="grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-6">
        {PHASES.map((phase, index) => (
          <li key={phase.id} className="relative m-0 rounded-xl border border-fd-border bg-fd-card p-3">
            <span className="font-mono text-[11px] text-fd-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
            <p className="mt-1 text-sm font-semibold">{phase.label}</p>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{phase.detail}</p>
          </li>
        ))}
      </ol>
      <svg
        className="mt-2 h-8 w-full text-fd-muted-foreground"
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        role="presentation"
        focusable="false"
      >
        <path
          d="M 83 1 L 83 7 L 42 7 L 42 1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 2"
          pathLength={100}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption id="pipeline-track-caption" className="text-sm text-fd-muted-foreground">
        The phases of one issue, in order. The dashed edge is the repeat: {repeatFrom} sends the work back to{' '}
        {repeatTo} as a fix round, and it is the only loop inside the pipeline. Which phases run at all is the
        flow&apos;s decision.
      </figcaption>
    </figure>
  )
}
