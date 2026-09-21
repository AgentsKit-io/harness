import { createElement } from 'react'

/**
 * The ecosystem tour, rendered by the shared custom element every sibling site uses.
 *
 * `ecosystem-bar.js` (loaded in the root layout) upgrades `<agentskit-ecosystem>` into the tabbed tour, reading
 * the same `ecosystem.json` as the header bar — so this page never carries its own copy of the product list,
 * which is exactly how the hand-rolled version it replaced went stale.
 *
 * The children are the fallback: what a visitor sees before the script arrives, or if it never does. They are
 * deliberately the plain truth — the product, its promise and a link — rather than a skeleton of the tour.
 */
const PEERS = [
  { stage: '01 / Build', name: 'AgentsKit', url: 'https://www.agentskit.io' },
  { stage: '02 / Discover', name: 'Registry', url: 'https://registry.agentskit.io' },
  { stage: '03 / Deliver', name: 'Chat', url: 'https://chat.agentskit.io' },
  { stage: '04 / Understand', name: 'Doc Bridge', url: 'https://doc-bridge.agentskit.io' },
  { stage: '05 / Ship', name: 'Harness', url: '/', current: true },
  { stage: '06 / Standardize', name: 'Playbook', url: 'https://playbook.agentskit.io' },
]

export function EcosystemShowcase() {
  return createElement(
    'agentskit-ecosystem',
    { current: 'harness' },
    <section style={{ padding: '72px 28px', maxWidth: '1180px', margin: '0 auto', borderTop: '1px solid #30363D' }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8B949E' }}>
        The AgentsKit ecosystem
      </span>
      <h2 style={{ margin: '16px 0 28px', fontFamily: "'Space Grotesk', sans-serif", letterSpacing: '-0.02em', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', fontWeight: 600 }}>
        Build the agent. Then take it all the way.
      </h2>
      <nav style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: '12px' }}>
        {PEERS.map((peer) => (
          <a
            key={peer.name}
            href={peer.url}
            style={{
              display: 'flex', flexDirection: 'column', gap: '6px', padding: '16px', borderRadius: '0.5rem',
              color: '#E6EDF3', border: `1px solid ${peer.current ? '#56D364' : '#30363D'}`,
              transition: 'border-color 200ms cubic-bezier(0.4,0,0.2,1)',
            }}
          >
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: peer.current ? '#56D364' : '#8B949E' }}>
              {peer.stage}
            </span>
            <span style={{ fontSize: '14px' }}>{peer.name}</span>
          </a>
        ))}
      </nav>
    </section>,
  )
}
