import { defineConfig, defineDocs } from 'fumadocs-mdx/config'

/**
 * The site owns its content.
 *
 * Doc Bridge points this at the repository's `docs/` and filters with an allowlist; the harness cannot: its
 * `docs/` holds 37 ADRs and two internal documents in Portuguese, and an allowlist there would be a list of
 * exclusions that grows by itself every time someone adds a file. Here the site's own tree is the public surface,
 * and the generated reference (`pnpm docs:generate`) writes into it.
 */
export const docs = defineDocs({
  dir: './content/docs',
  meta: { files: ['**/meta.json'] },
})

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: 'github-light-default',
        dark: 'github-dark-default',
      },
    },
  },
})
