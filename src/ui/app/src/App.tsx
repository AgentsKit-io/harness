import * as React from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { SnapshotProvider } from '@/lib/snapshot'
import { AttentionPage } from '@/pages/Attention'
import { RunsPage } from '@/pages/Runs'
import { TrendsPage } from '@/pages/Trends'
import { CostsPage } from '@/pages/Costs'
import { SystemPage } from '@/pages/System'
import { ExplorePage } from '@/pages/Explore'
import { SettingsPage } from '@/pages/Settings'
import { BatchPage } from '@/pages/Batch'
import { WizardPage } from '@/pages/Wizard'
import { NotFoundPage } from '@/pages/NotFound'

/** Issue detail is a side panel, not a route: any page opens it with `?issue=<id>` (see `useIssuePanel`). */
export const App = (): React.ReactElement => (
  <SnapshotProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AttentionPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/trends" element={<TrendsPage />} />
        <Route path="/costs" element={<CostsPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/batch" element={<BatchPage />} />
        <Route path="/wizard/:issue" element={<WizardPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  </SnapshotProvider>
)
