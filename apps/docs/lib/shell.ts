import ecosystem from '../../../ecosystem.json'

/** Shell v1 host. Local review points this at the AgentsKit docs dev server (http://localhost:3000). */
export const SHELL_ORIGIN = (process.env.NEXT_PUBLIC_AGENTSKIT_SHELL_ORIGIN ?? 'https://www.agentskit.io').replace(/\/+$/, '')
export const SHELL_PRODUCT_ID = 'harness'
export const SHELL_PRODUCT_REPO = 'AgentsKit-io/harness'
export const SHELL_PRODUCT_GITHUB = `https://github.com/${SHELL_PRODUCT_REPO}`

/** The six products shown in the bar, tour and footer fallback — read from the canonical ecosystem.json. */
export const ECOSYSTEM_PRODUCTS = ecosystem.products
  .filter(product => product.navigation?.showInBar)
  .sort((a, b) => (a.navigation?.order ?? 0) - (b.navigation?.order ?? 0))
  .map(product => ({ id: product.id, name: product.shortName, stage: product.showcase?.stage ?? '', href: product.surfaces.home }))
