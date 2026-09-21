import Link from 'next/link'
import type { Metadata } from 'next'
import { BASE_PATH, SITE_URL } from '@/lib/site'

export const metadata: Metadata = {
  title: 'For agents',
  description: 'What an agent needs to operate the keep-pushing loop without guessing: the read-only commands, the files the loop reads, and the one rule about human answers.',
  alternates: { canonical: `${SITE_URL}/for-agents/` },
}

const STEPS = [
  { title: 'Look before touching', body: 'loop doctor, loop debrief, loop observe and loop status answer "what is it doing" and "why is it stuck" without dispatching, reviewing or merging anything.' },
  { title: 'Read what the worker left', body: 'Each worktree carries .ak-loop/plan.md, verify.json and dod.json. The loop advances on those files, so they are also the fastest explanation of where an issue actually is.' },
  { title: 'Never answer for the human', body: 'Driving loop plan means relaying one question at a time with alternatives and a recommendation. The answers are the requirements; an agent that invents one builds the wrong thing confidently.' },
]

export default function ForAgentsPage() {
  return (
    <main className="mx-auto max-w-5xl px-5 py-16 lg:px-8 lg:py-24">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">Machine-first entry point</p>
      <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Operate the loop without guessing.</h1>
      <p className="mt-6 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
        The harness orchestrates the lifecycle; it does not drive a worker&apos;s own model loop. Everything below is
        readable, checkable state — no screen scraping, no inference from a terminal.
      </p>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {STEPS.map((step) => (
          <article key={step.title} className="rounded-2xl border border-fd-border p-6">
            <h2 className="text-lg font-semibold">{step.title}</h2>
            <p className="mt-2 break-words text-sm leading-6 text-fd-muted-foreground">{step.body}</p>
          </article>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link href="/docs" className="inline-flex min-h-11 items-center rounded-full bg-fd-primary px-5 py-3 font-medium text-fd-primary-foreground">
          Read the documentation
        </Link>
        <a href={`${BASE_PATH}/llms.txt`} className="inline-flex min-h-11 items-center rounded-full border border-fd-border px-5 py-3 font-medium">llms.txt</a>
        <a href={`${BASE_PATH}/llms-full.txt`} className="inline-flex min-h-11 items-center rounded-full border border-fd-border px-5 py-3 font-medium">Full corpus</a>
      </div>
    </main>
  )
}
