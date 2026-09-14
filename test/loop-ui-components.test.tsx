import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { Banner, CheckRow, Confirm, Section, Select, Spinner, Summary, TextInput, statusIcon } from '../src/loop/ui/components.js'
import type { DoctorCheck } from '../src/loop/doctor.js'

const check = (status: DoctorCheck['status'], id = 'x', detail = 'detail'): DoctorCheck => ({ id, status, detail })

/** ink's useInput/useEffectEvent registration lands a tick after render — every interactive test must wait
 * before writing to stdin, else the keypress is delivered to no listener and silently dropped. A lone Escape
 * byte is also ambiguous (it could be the start of an arrow-key sequence), so ink holds it as a "pending
 * escape" and only flushes it after its own internal 20ms timer — a bare-Escape assertion needs a longer wait. */
const flush = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('loop ui components', () => {
  it('maps every doctor status to an icon and colour', () => {
    expect(statusIcon('passed')).toEqual({ glyph: '✔', color: 'green' })
    expect(statusIcon('warning')).toEqual({ glyph: '△', color: 'yellow' })
    expect(statusIcon('failed')).toEqual({ glyph: '✖', color: 'red' })
  })

  it('renders a spinner frame and label, animating over time', async () => {
    const { lastFrame, unmount } = render(<Spinner label="working" />)
    expect(lastFrame()).toContain('working')
    const first = lastFrame()
    await flush(120)
    expect(lastFrame()).not.toBe(first)
    unmount()
  })

  it('renders a check row for each status', () => {
    expect(render(<CheckRow check={check('passed')} />).lastFrame()).toContain('✔')
    expect(render(<CheckRow check={check('warning')} />).lastFrame()).toContain('△')
    expect(render(<CheckRow check={check('failed')} />).lastFrame()).toContain('✖')
  })

  it('renders a section title with and without a step/total prefix', () => {
    expect(render(<Section title="Setup" />).lastFrame()).toContain('Setup')
    expect(render(<Section title="Setup" step={2} total={5} />).lastFrame()).toContain('2/5 Setup')
  })

  it('renders a banner with its lines', () => {
    const frame = render(<Banner title="Welcome" lines={['line one', 'line two']} />).lastFrame()
    expect(frame).toContain('Welcome')
    expect(frame).toContain('line one')
    expect(frame).toContain('line two')
  })

  it('renders a banner with no lines', () => {
    expect(render(<Banner title="Welcome" lines={[]} />).lastFrame()).toContain('Welcome')
  })

  it('summarises passed/warning/failed counts', () => {
    const frame = render(<Summary checks={[check('passed'), check('warning'), check('failed')]} />).lastFrame()
    expect(frame).toContain('1 passed')
    expect(frame).toContain('1 warning')
    expect(frame).toContain('1 failed')
  })

  it('Select moves the cursor with arrow keys and j/k, and resolves on Enter', async () => {
    const onDone = vi.fn()
    const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', hint: 'default' }]
    const { stdin, lastFrame } = render(<Select question="Pick one" options={options} onDone={onDone} />)
    await flush()
    expect(lastFrame()).toContain('Pick one')
    expect(lastFrame()).toContain('❯ Alpha')
    stdin.write('[B') // down arrow
    await flush()
    expect(lastFrame()).toContain('❯ Beta')
    expect(lastFrame()).toContain('default')
    stdin.write('k') // up via vim key
    await flush()
    expect(lastFrame()).toContain('❯ Alpha')
    stdin.write('j') // down via vim key
    await flush()
    stdin.write('\r')
    await flush()
    expect(onDone).toHaveBeenCalledWith('b')
  })

  it('Select cancels with q, resolving null', async () => {
    const onDone = vi.fn()
    const options = [{ value: 'a', label: 'Alpha' }]
    const { stdin } = render(<Select question="Pick" options={options} onDone={onDone} />)
    await flush()
    stdin.write('q')
    await flush()
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('Select cancels with Escape too', async () => {
    const onDone = vi.fn()
    const options = [{ value: 'a', label: 'Alpha' }]
    const { stdin } = render(<Select question="Pick" options={options} onDone={onDone} />)
    await flush()
    stdin.write('')
    await flush(30)
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('Select clamps the initial index within bounds and tolerates an empty option list', () => {
    const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]
    expect(render(<Select question="Pick" options={options} initial={99} onDone={() => {}} />).lastFrame()).toContain('❯ Beta')
    expect(render(<Select question="Pick" options={[]} initial={0} onDone={() => {}} />).lastFrame()).toContain('Pick')
  })

  it('Confirm takes the fallback on Enter and explicit y/n otherwise', async () => {
    const onDoneTrue = vi.fn()
    const a = render(<Confirm question="Proceed?" fallback={true} onDone={onDoneTrue} />)
    await flush()
    a.stdin.write('\r')
    await flush()
    expect(onDoneTrue).toHaveBeenCalledWith(true)

    const onDoneNo = vi.fn()
    const b = render(<Confirm question="Proceed?" fallback={true} onDone={onDoneNo} />)
    await flush()
    b.stdin.write('n')
    await flush()
    expect(onDoneNo).toHaveBeenCalledWith(false)

    const onDoneYes = vi.fn()
    const c = render(<Confirm question="Proceed?" fallback={false} onDone={onDoneYes} />)
    await flush()
    c.stdin.write('y')
    await flush()
    expect(onDoneYes).toHaveBeenCalledWith(true)

    const onDoneEscape = vi.fn()
    const d = render(<Confirm question="Proceed?" fallback={true} onDone={onDoneEscape} />)
    await flush()
    d.stdin.write('')
    await flush(30)
    expect(onDoneEscape).toHaveBeenCalledWith(false)
  })

  it('Confirm accepts the Portuguese "s" for yes', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<Confirm question="Proceed?" fallback={false} onDone={onDone} />)
    await flush()
    stdin.write('s')
    await flush()
    expect(onDone).toHaveBeenCalledWith(true)
  })

  it('Confirm shows the [Y/n] vs [y/N] hint depending on the fallback', () => {
    expect(render(<Confirm question="Proceed?" fallback={true} onDone={() => {}} />).lastFrame()).toContain('[Y/n]')
    expect(render(<Confirm question="Proceed?" fallback={false} onDone={() => {}} />).lastFrame()).toContain('[y/N]')
  })

  it('TextInput accumulates typed characters, backspaces, and submits on Enter with the typed value', async () => {
    const onDone = vi.fn()
    const { stdin, lastFrame } = render(<TextInput question="Name?" fallback="anon" onDone={onDone} />)
    await flush()
    stdin.write('hi')
    await flush()
    expect(lastFrame()).toContain('hi')
    stdin.write('') // backspace
    await flush()
    expect(lastFrame()).toContain('h')
    expect(lastFrame()).not.toContain('hi')
    stdin.write('\r')
    await flush()
    expect(onDone).toHaveBeenCalledWith('h')
  })

  it('TextInput falls back to the default when submitted empty', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<TextInput question="Name?" fallback="anon" onDone={onDone} />)
    await flush()
    stdin.write('\r')
    await flush()
    expect(onDone).toHaveBeenCalledWith('anon')
  })

  it('TextInput surfaces a validation error instead of submitting', async () => {
    const onDone = vi.fn()
    const validate = (value: string): string | null => (value === 'bad' ? 'not allowed' : null)
    const { stdin, lastFrame } = render(<TextInput question="Name?" fallback="bad" validate={validate} onDone={onDone} />)
    await flush()
    stdin.write('\r')
    await flush()
    expect(onDone).not.toHaveBeenCalled()
    expect(lastFrame()).toContain('not allowed')
  })

  it('TextInput cancels on Escape', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<TextInput question="Name?" fallback="anon" onDone={onDone} />)
    await flush()
    stdin.write('')
    await flush(30)
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('TextInput ignores ctrl/meta key combinations', async () => {
    const onDone = vi.fn()
    const { stdin, lastFrame } = render(<TextInput question="Name?" fallback="anon" onDone={onDone} />)
    await flush()
    stdin.write('') // ctrl+c-shaped input
    await flush()
    expect(lastFrame()).not.toContain('c')
    stdin.write('\r')
    await flush()
    expect(onDone).toHaveBeenCalledWith('anon')
  })
})
