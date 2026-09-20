import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { RootProvider } from 'fumadocs-ui/provider/next'
import './globals.css'
import { SITE_URL } from '@/lib/site'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Harness — the keep-pushing loop for your SDLC',
    template: '%s · Harness',
  },
  description:
    'An unattended SDLC loop: a vague objective interviewed into a PRD, issues contracted and dispatched into their own worktrees, reviewed, proven against a definition of done, merged, and released behind a human gate.',
  alternates: { canonical: `${SITE_URL}/` },
  openGraph: {
    type: 'website',
    siteName: 'AgentsKit Harness',
    title: 'Harness',
    description: 'The keep-pushing loop for your SDLC.',
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentsKit Harness',
    description: 'The keep-pushing loop for your SDLC.',
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = { colorScheme: 'light dark', themeColor: '#111714' }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        <Script src="https://www.agentskit.io/ecosystem-bar.js" strategy="afterInteractive" data-current="harness" />
        <RootProvider search={{ enabled: true, options: { type: 'static', api: `${basePath}/api/search/` } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
