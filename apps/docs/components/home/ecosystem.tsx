import { ECOSYSTEM_PRODUCTS, SHELL_PRODUCT_ID } from '@/lib/shell'

/**
 * The ecosystem tour, rendered by the shared custom element every sibling site uses.
 *
 * Shell v1 (`v1.js`, loaded in the root layout) upgrades `<agentskit-ecosystem>` into the tabbed tour, reading the
 * same product list as the bar. The children are the no-JS fallback: the six products from the canonical
 * `ecosystem.json`, each with its stage and a link.
 */
export function EcosystemShowcase() {
  return (
    <agentskit-ecosystem current={SHELL_PRODUCT_ID} data-visual="agentskit-home">
      <section className="harness-ecosystem-fallback">
        <span className="harness-ecosystem-fallback__eyebrow">The AgentsKit ecosystem</span>
        <h2>Build the agent. Then take it all the way.</h2>
        <nav aria-label="AgentsKit ecosystem">
          {ECOSYSTEM_PRODUCTS.map((product, index) => (
            <a
              key={product.id}
              href={product.id === SHELL_PRODUCT_ID ? '/' : product.href}
              aria-current={product.id === SHELL_PRODUCT_ID ? 'page' : undefined}
            >
              <span>{`${String(index + 1).padStart(2, '0')} / ${product.stage}`}</span>
              <span>{product.name}</span>
            </a>
          ))}
        </nav>
      </section>
    </agentskit-ecosystem>
  )
}
