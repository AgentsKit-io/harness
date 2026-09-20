/**
 * The whole cycle on one canvas, static: the six stages and what moves between them.
 *
 * HTML for the boxes (real text, accessible, reflowing), SVG only for the arrow that closes the cycle back to
 * the queue. No animation at all — a concept page is read, not watched.
 */
const STAGES = [
  { id: 'plan', label: 'plan', body: 'objective → PRD → design → issues', gate: 'two human gates' },
  { id: 'tick', label: 'tick', body: 'queue → contract → plan → dispatch', gate: null },
  { id: 'deliver', label: 'deliver', body: 'PR → checks → review → DoD → merge', gate: null },
  { id: 'observe', label: 'observe', body: 'anomalies, metrics, a scheduler exit code', gate: null },
  { id: 'release', label: 'release', body: 'promote → deploy → smoke → rollback', gate: 'human approval, bound to a sha' },
  { id: 'intake', label: 'intake · maintain', body: 'alerts and checks become issues', gate: null },
]

export function LoopFactory() {
  return (
    <figure className="my-8 not-prose" aria-labelledby="loop-factory-caption">
      <ol className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {STAGES.map((stage) => (
          <li key={stage.id} className="m-0 rounded-xl border border-fd-border bg-fd-card p-4">
            <p className="font-mono text-xs uppercase tracking-wider text-fd-muted-foreground">{stage.label}</p>
            <p className="mt-2 text-sm leading-6">{stage.body}</p>
            {stage.gate ? <p className="mt-3 text-xs font-medium">{stage.gate}</p> : null}
          </li>
        ))}
      </ol>
      <svg className="mt-2 h-6 w-full text-fd-muted-foreground" viewBox="0 0 100 6" preserveAspectRatio="none" role="presentation" focusable="false">
        <path d="M 95 1 L 95 4 L 5 4 L 5 1" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" pathLength={100} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption id="loop-factory-caption" className="text-sm text-fd-muted-foreground">
        The cycle closes: what <code>intake</code> and <code>maintain</code> file goes back into the queue that{' '}
        <code>tick</code> drains, and what <code>retro</code> learns tunes the knobs the next cycle runs with.
      </figcaption>
    </figure>
  )
}
