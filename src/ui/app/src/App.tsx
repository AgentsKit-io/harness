import * as React from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { OperationPage } from '@/pages/Operation'
import { InboxPage } from '@/pages/Inbox'
import { WizardPage } from '@/pages/Wizard'
import { RunDetailPage } from '@/pages/RunDetail'

export const App = (): React.ReactElement => (
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<OperationPage />} />
      <Route path="/inbox" element={<InboxPage />} />
      <Route path="/wizard/:issue" element={<WizardPage />} />
      <Route path="/runs/:issue" element={<RunDetailPage />} />
    </Routes>
  </BrowserRouter>
)
