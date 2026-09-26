import * as React from 'react'
import { useSnapshot, type UiSnapshot } from './api'

interface SnapshotValue { readonly snapshot: UiSnapshot | null; readonly error: string | null; readonly refresh: () => void }

const SnapshotContext = React.createContext<SnapshotValue>({ snapshot: null, error: null, refresh: () => undefined })

/** One live snapshot (SSE + polling fallback) shared by the shell and every page. */
export const SnapshotProvider = ({ children }: { readonly children: React.ReactNode }): React.ReactElement => {
  const value = useSnapshot()
  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>
}

export const useLiveSnapshot = (): SnapshotValue => React.useContext(SnapshotContext)

/** Age in ms of the snapshot the tab is showing, re-evaluated every second. */
export const useSnapshotAge = (): number | null => {
  const { snapshot } = useLiveSnapshot()
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer) }, [])
  return snapshot ? Math.max(0, now - Date.parse(snapshot.generatedAt)) : null
}

export const formatAge = (ms: number | null): string => {
  if (ms === null) return '—'
  const s = Math.round(ms / 1_000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`
}
