import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'
import { source } from '@/lib/source'
import { ProductWordmark } from '@/components/agentskit-shell'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: <ProductWordmark />, url: '/' }}
      searchToggle={{ enabled: true }}
    >
      {children}
    </DocsLayout>
  )
}
