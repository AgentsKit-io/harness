/** Canonical public site — custom domain, no GitHub Pages subpath. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://harness.agentskit.io'

/** Only a fork publishing under a subpath sets this; the Pages workflow never does. */
export const BASE_PATH = process.env.DOCS_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? ''
