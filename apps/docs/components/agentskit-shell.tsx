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

/** Shared ecosystem footer. The static fallback keeps links in server HTML (SEO / no-JS); v1.js replaces it. */
export function SiteFooter() {
  return (
    <agentskit-footer current={SHELL_PRODUCT_ID} repo={SHELL_PRODUCT_REPO}>
      <footer className="harness-footer-fallback">
        <nav aria-label="AgentsKit ecosystem">
          <ul>
            {ECOSYSTEM_PRODUCTS.map(product => (
              <li key={product.id}>
                <a href={product.id === SHELL_PRODUCT_ID ? '/' : product.href} aria-current={product.id === SHELL_PRODUCT_ID ? 'page' : undefined}>{product.name}</a>
              </li>
            ))}
          </ul>
        </nav>
        <p>
          <a href={SHELL_PRODUCT_GITHUB}>GitHub · {SHELL_PRODUCT_REPO}</a> · <a href={`${SHELL_PRODUCT_GITHUB}/blob/main/LICENSE`}>MIT License</a>
        </p>
      </footer>
    </agentskit-footer>
  )
}
