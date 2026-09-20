import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()
// harness.agentskit.io is a custom domain: no base path, ever. The variable exists only so a fork that
// publishes under a GitHub Pages subpath can set it; the Pages workflow never does.
const basePath = process.env.DOCS_BASE_PATH ?? ''

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://harness.agentskit.io',
  },
}

export default withMDX(config)
