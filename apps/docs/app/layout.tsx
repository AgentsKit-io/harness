import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import Script from 'next/script'
import { RootProvider } from 'fumadocs-ui/provider/next'
import './globals.css'
import { SITE_URL } from '@/lib/site'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' })
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' })
const ecosystemBarOrigin = process.env.NEXT_PUBLIC_AGENTSKIT_SITE_URL
  ?? (process.env.NODE_ENV === 'development' ? 'http://localhost:3101' : 'https://www.agentskit.io')

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
      <body className={`${inter.variable} ${jetbrains.variable} ${spaceGrotesk.variable}`}>
        <Script src={`${ecosystemBarOrigin}/ecosystem-bar.js?v=ak-ecosystem-6`} strategy="afterInteractive" data-current="harness" />
        <RootProvider search={{ enabled: true, options: { type: 'static', api: `${basePath}/api/search/` } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
