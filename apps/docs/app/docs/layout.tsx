import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'
import { source } from '@/lib/source'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: 'Harness', url: '/' }}
      searchToggle={{ enabled: true }}
      links={[
        { text: 'AgentsKit', url: 'https://www.agentskit.io', external: true },
        { text: 'Registry', url: 'https://registry.agentskit.io', external: true },
        { text: 'Chat', url: 'https://chat.agentskit.io', external: true },
        { text: 'Doc Bridge', url: 'https://doc-bridge.agentskit.io', external: true },
        { text: 'GitHub', url: 'https://github.com/AgentsKit-io/harness', external: true },
      ]}
    >
      {children}
    </DocsLayout>
  )
}
