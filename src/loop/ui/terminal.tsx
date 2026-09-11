import { render, Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { DoctorCheck } from '../doctor.js'
import type { GuidedInstallIO } from '../guided-install.js'
import { Banner, CheckRow, Confirm, Section, Select, Summary, TextInput, palette, type SelectOption } from './components.js'

export interface RichIO extends GuidedInstallIO {
  readonly interactive: boolean
  readonly select: (question: string, options: readonly SelectOption[], initial?: number) => Promise<string | null>
  readonly text: (question: string, fallback: string, validate?: (value: string) => string | null) => Promise<string | null>
  readonly checks: (checks: readonly DoctorCheck[]) => void
  readonly section: (title: string, step?: number, total?: number) => void
  readonly banner: (title: string, lines: readonly string[]) => void
  readonly bullet: (line: string, tone?: 'ok' | 'warn' | 'fail' | 'dim') => void
}

/** Render one static Ink tree and unmount immediately — output stays in the scrollback like a log. */
const paint = (element: ReactElement): void => { const app = render(element, { exitOnCtrlC: false, patchConsole: false }); app.unmount() }

/** Mount an interactive prompt, resolve with its answer, unmount. */
const ask = <T,>(build: (resolve: (value: T) => void) => ReactElement): Promise<T> => new Promise((resolve) => {
  let app: ReturnType<typeof render> | null = null
  const finish = (value: T): void => { app?.unmount(); resolve(value) }
  app = render(build(finish), { exitOnCtrlC: true, patchConsole: false })
})

/** Ink-backed IO when stdin/stdout are TTYs; plain line output otherwise, with every prompt taking its fallback. */
export const createRichIO = (): RichIO => {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const write = (line: string): void => { process.stdout.write(`${line}\n`) }
  if (!interactive) {
    return {
      interactive,
      write,
      confirm: async (question, fallback) => { write(`${question} [non-interactive → ${fallback ? 'yes' : 'no'}]`); return fallback },
      select: async (question, options, initial = 0) => { const chosen = options[initial] ?? null; write(`${question} [non-interactive → ${chosen?.label ?? 'none'}]`); return chosen?.value ?? null },
      text: async (question, fallback) => { write(`${question} [non-interactive → ${fallback}]`); return fallback },
      checks: (checks) => { for (const check of checks) write(`  ${check.status === 'passed' ? '✔' : check.status === 'warning' ? '△' : '✖'} ${check.id.padEnd(24)} ${check.detail}`) },
      section: (title, step, total) => write(`\n${step && total ? `${step}/${total} ` : ''}${title}`),
      banner: (title, lines) => { write(title); for (const line of lines) write(`  ${line}`) },
      bullet: (line) => write(`  ${line}`),
    }
  }
  return {
    interactive,
    write: (line) => paint(<Text>{line}</Text>),
    confirm: (question, fallback) => ask<boolean>((resolve) => <Confirm question={question} fallback={fallback} onDone={resolve} />),
    select: (question, options, initial = 0) => ask<string | null>((resolve) => <Select question={question} options={options} initial={initial} onDone={resolve} />),
    text: (question, fallback, validate) => ask<string | null>((resolve) => <TextInput question={question} fallback={fallback} validate={validate} onDone={resolve} />),
    checks: (checks) => paint(<Box flexDirection="column" marginLeft={1}>{checks.map((check) => <CheckRow key={check.id} check={check} />)}<Box marginTop={0}><Summary checks={checks} /></Box></Box>),
    section: (title, step, total) => paint(<Section title={title} step={step} total={total} />),
    banner: (title, lines) => paint(<Banner title={title} lines={lines} />),
    bullet: (line, tone = 'dim') => paint(<Text color={tone === 'ok' ? palette.ok : tone === 'warn' ? palette.warn : tone === 'fail' ? palette.fail : undefined}>  {line}</Text>),
  }
}
