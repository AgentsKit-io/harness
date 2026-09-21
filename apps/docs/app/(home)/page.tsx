import type { Metadata } from 'next'
import './home.css'
import { HarnessHome } from '@/components/home/harness-home'
import { SITE_URL } from '@/lib/site'
import { readHarnessStats } from '@/lib/stats'

export const metadata: Metadata = {
  title: 'Harness — the keep-pushing loop for your SDLC',
  description:
    'From a vague objective to production without babysitting an agent — interview, plan, votes, worker, review, merge, release. Every transition is the machine’s decision over an explicit state.',
  alternates: { canonical: `${SITE_URL}/` },
}

export default function HomePage() {
  return <HarnessHome counts={readHarnessStats().counts} />
}
