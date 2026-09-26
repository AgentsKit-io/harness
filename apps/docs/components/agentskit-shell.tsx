import Script from 'next/script'
import { ECOSYSTEM_PRODUCTS, SHELL_ORIGIN, SHELL_PRODUCT_GITHUB, SHELL_PRODUCT_ID, SHELL_PRODUCT_REPO } from '@/lib/shell'

/** Shell v1 stylesheet: shared tokens, fonts, wordmark, footer fallback and aurora styles. */
export function AgentsKitShellStyles() {
  return <link rel="stylesheet" href={`${SHELL_ORIGIN}/shell/v1.css`} />
}

/** Shell v1 script: auto-injects the ecosystem bar (Star targets this repo) and upgrades the shell elements. */
export function AgentsKitShellScript() {
  return (
    <Script
      id="agentskit-shell-v1"
      src={`${SHELL_ORIGIN}/shell/v1.js`}
      strategy="afterInteractive"
      data-current={SHELL_PRODUCT_ID}
      data-current-repo={SHELL_PRODUCT_REPO}
    />
  )
}

/** Shared animated background; fixed, aria-hidden and non-interactive (styled by v1.css). */
export function AgentsKitAurora() {
  return <agentskit-aurora aria-hidden="true" />
}

/** Product wordmark for headers; typography and colours come from v1.css. */
export function ProductWordmark() {
  return (
    <span className="ak-product-wordmark">
      <span className="ak-product-wordmark__brand">AgentsKit</span>{' '}
      <span className="ak-product-wordmark__product">Harness</span>
    </span>
  )
}

const LOCAL_COLUMNS = [
  { title: 'Start', links: [{ text: 'Documentation', href: '/docs' }, { text: 'Human gates', href: '#gates' }, { text: 'Example run', href: '#run' }] },
  { title: 'Build', links: [{ text: 'Flow profiles', href: '#profiles' }, { text: 'Connectors', href: '#seams' }, { text: 'llms.txt', href: '/llms.txt' }] },
] as const

/**
 * Shared ecosystem footer. Harness-owned columns project into the upgraded footer through the `local` slot; the
 * plain product, repository and license links are the server-rendered fallback (SEO / no-JS) that v1.js replaces.
 */
export function SiteFooter() {
  return (
    <agentskit-footer current={SHELL_PRODUCT_ID} repo={SHELL_PRODUCT_REPO} description="The configurable loop that takes software work from objective to release.">
      <div slot="local" className="ak-footer-local">
        {LOCAL_COLUMNS.map(column => (
          <div key={column.title} className="ak-footer-col">
            <h2 className="ak-footer-col__title">{column.title}</h2>
            <ul>{column.links.map(link => <li key={link.href}><a href={link.href}>{link.text}</a></li>)}</ul>
          </div>
        ))}
      </div>
      <nav aria-label="AgentsKit ecosystem" className="ak-footer-fallback">
        {ECOSYSTEM_PRODUCTS.map(product => (
          <a key={product.id} href={product.id === SHELL_PRODUCT_ID ? '/' : product.href} aria-current={product.id === SHELL_PRODUCT_ID ? 'page' : undefined}>{product.name}</a>
        ))}
        <a href={SHELL_PRODUCT_GITHUB}>GitHub</a>
        <a href={`${SHELL_PRODUCT_GITHUB}/blob/main/LICENSE`}>MIT License</a>
      </nav>
    </agentskit-footer>
  )
}
