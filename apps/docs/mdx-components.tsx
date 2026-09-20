import defaultMdxComponents from 'fumadocs-ui/mdx'
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock'
import type { HTMLAttributes } from 'react'
import { Mermaid } from '@/components/mermaid'

/**
 * Fumadocs MDX map with explicit CodeBlock (Shiki highlight + copy button) and `<Mermaid chart={`…`} />`.
 *
 * Mermaid is a component rather than a ```mermaid fence on purpose: the fence would go through Shiki, which
 * has no grammar for it, and a diagram that silently renders as grey text is worse than no diagram.
 */
export function getMDXComponents(components?: Record<string, unknown>) {
  return {
    ...defaultMdxComponents,
    Mermaid,
    pre: ({ children, ...props }: HTMLAttributes<HTMLPreElement>) => (
      <CodeBlock {...props} allowCopy keepBackground>
        <Pre>{children}</Pre>
      </CodeBlock>
    ),
    ...components,
  }
}
