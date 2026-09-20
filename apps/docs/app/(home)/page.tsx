import Link from 'next/link'

/**
 * Placeholder home.
 *
 * The real one is being designed separately (`HOME-BRIEF.md` at the repository root). This exists so `/` is a
 * page and not a 404, and so the route it will replace already points at the documentation.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-5 py-24">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-fd-muted-foreground">AgentsKit Harness</p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">The keep-pushing loop for your SDLC</h1>
      <p className="max-w-2xl text-lg text-fd-muted-foreground">
        A vague objective interviewed into a PRD, issues contracted and dispatched into their own worktrees,
        reviewed, proven against a definition of done, merged, and released behind a human gate — unattended,
        on a schedule.
      </p>
      <p>
        <Link className="font-medium underline underline-offset-4" href="/docs">
          Read the documentation →
        </Link>
      </p>
    </main>
  )
}
