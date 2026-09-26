import * as React from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, Shell } from '@/components/Shell'
import { Button } from '@/components/ui/button'

/** Catches any unmatched path — a stale bookmark from a route the app used to have, a typo, a shared link — so it
 * never renders a blank page. Issue detail moved from its own route to a `?issue=` side panel (see App.tsx); this
 * is also where an old deep link to that route lands. */
export const NotFoundPage = (): React.ReactElement => (
  <Shell title="Page not found" error={null}>
    <EmptyState>
      This page doesn't exist — it may have moved.
      <br />
      <Button asChild variant="outline" size="sm" className="mt-3"><Link to="/">← Back to Attention</Link></Button>
    </EmptyState>
  </Shell>
)
