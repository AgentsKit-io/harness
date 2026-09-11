import { Box, Text, useInput } from 'ink'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { DoctorCheck } from '../doctor.js'

/** Brand-neutral palette; every colour is a name Ink resolves against the terminal theme. */
export const palette = { ok: 'green', warn: 'yellow', fail: 'red', accent: 'cyan', dim: 'gray' } as const

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export const Spinner = ({ label }: { readonly label: string }): ReactElement => {
  const [frame, setFrame] = useState(0)
  useEffect(() => { const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80); return () => clearInterval(timer) }, [])
  return <Text><Text color={palette.accent}>{SPINNER_FRAMES[frame]}</Text> {label}</Text>
}

export const statusIcon = (status: DoctorCheck['status']): { readonly glyph: string; readonly color: string } => status === 'passed' ? { glyph: '✔', color: palette.ok } : status === 'warning' ? { glyph: '△', color: palette.warn } : { glyph: '✖', color: palette.fail }

export const CheckRow = ({ check, width = 24 }: { readonly check: DoctorCheck; readonly width?: number }): ReactElement => {
  const icon = statusIcon(check.status)
  return (
    <Box>
      <Box width={2}><Text color={icon.color}>{icon.glyph}</Text></Box>
      <Box width={width}><Text color={check.status === 'failed' ? palette.fail : undefined}>{check.id}</Text></Box>
      <Box flexGrow={1}><Text color={check.status === 'passed' ? undefined : icon.color} wrap="wrap">{check.detail}</Text></Box>
    </Box>
  )
}

export const Section = ({ step, total, title, children }: { readonly step?: number; readonly total?: number; readonly title: string; readonly children?: ReactNode }): ReactElement => (
  <Box flexDirection="column" marginTop={1}>
    <Text bold color={palette.accent}>{step && total ? `${step}/${total} ` : ''}{title}</Text>
    <Box flexDirection="column" marginLeft={1}>{children}</Box>
  </Box>
)

export const Banner = ({ title, lines }: { readonly title: string; readonly lines: readonly string[] }): ReactElement => (
  <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
    <Text bold>{title}</Text>
    {lines.map((line, index) => <Text key={index} color={palette.dim}>{line}</Text>)}
  </Box>
)

export const Summary = ({ checks }: { readonly checks: readonly DoctorCheck[] }): ReactElement => {
  const passed = checks.filter((check) => check.status === 'passed').length
  const warned = checks.filter((check) => check.status === 'warning').length
  const failed = checks.filter((check) => check.status === 'failed').length
  return <Text><Text color={palette.ok}>{passed} passed</Text> · <Text color={palette.warn}>{warned} warning</Text> · <Text color={failed ? palette.fail : palette.dim}>{failed} failed</Text></Text>
}

export interface SelectOption { readonly value: string; readonly label: string; readonly hint?: string }

/** Arrow-key list; Enter picks; Esc or q cancels (resolves null). */
export const Select = ({ question, options, initial = 0, onDone }: { readonly question: string; readonly options: readonly SelectOption[]; readonly initial?: number; readonly onDone: (value: string | null) => void }): ReactElement => {
  const [index, setIndex] = useState(Math.min(initial, Math.max(0, options.length - 1)))
  useInput((input, key) => {
    if (key.upArrow || input === 'k') setIndex((current) => (current - 1 + options.length) % options.length)
    else if (key.downArrow || input === 'j') setIndex((current) => (current + 1) % options.length)
    else if (key.return) onDone(options[index]?.value ?? null)
    else if (key.escape || input === 'q') onDone(null)
  })
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{question}</Text>
      {options.map((option, position) => (
        <Text key={option.value} color={position === index ? palette.accent : undefined}>{position === index ? '❯ ' : '  '}{option.label}{option.hint ? <Text color={palette.dim}>  {option.hint}</Text> : null}</Text>
      ))}
      <Text color={palette.dim}>↑↓ move · Enter select · Esc cancel</Text>
    </Box>
  )
}

/** Yes/No question; Enter takes the default. */
export const Confirm = ({ question, fallback, onDone }: { readonly question: string; readonly fallback: boolean; readonly onDone: (value: boolean) => void }): ReactElement => {
  useInput((input, key) => {
    const answer = input.toLowerCase()
    if (key.return) onDone(fallback)
    else if (answer === 'y' || answer === 's') onDone(true)
    else if (answer === 'n' || key.escape) onDone(false)
  })
  return <Box marginTop={1}><Text bold>{question} </Text><Text color={palette.dim}>{fallback ? '[Y/n]' : '[y/N]'}</Text></Box>
}

/** Free-text line with a default; Enter submits, Esc cancels. */
export const TextInput = ({ question, fallback, validate, onDone }: { readonly question: string; readonly fallback: string; readonly validate?: (value: string) => string | null; readonly onDone: (value: string | null) => void }): ReactElement => {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  useInput((input, key) => {
    if (key.return) { const candidate = value.trim() || fallback; const problem = validate?.(candidate) ?? null; if (problem) setError(problem); else onDone(candidate) }
    else if (key.escape) onDone(null)
    else if (key.backspace || key.delete) setValue((current) => current.slice(0, -1))
    else if (input && !key.ctrl && !key.meta) setValue((current) => current + input)
  })
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text><Text bold>{question}</Text> <Text color={palette.dim}>[{fallback}]</Text> {value}<Text color={palette.accent}>▏</Text></Text>
      {error ? <Text color={palette.fail}>{error}</Text> : null}
    </Box>
  )
}
