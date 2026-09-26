import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/** The issue side panel lives in the URL (`?issue=<id>`) so any page can open it and a reload keeps it open. */
export const useIssuePanel = (): { readonly issue: string | null; readonly open: (issue: string) => void; readonly close: () => void } => {
  const [params, setParams] = useSearchParams()
  const set = useCallback((issue: string | null) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (issue) next.set('issue', issue); else next.delete('issue')
    return next
  }), [setParams])
  return { issue: params.get('issue'), open: useCallback((issue: string) => set(issue), [set]), close: useCallback(() => set(null), [set]) }
}
