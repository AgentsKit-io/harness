import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderMock = vi.fn()
const unmountMock = vi.fn()

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>()
  return { ...actual, render: renderMock }
})

const setTty = (isTTY: boolean): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true })
}

describe('createRichIO', () => {
  let originalStdinTty: boolean | undefined
  let originalStdoutTty: boolean | undefined
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalStdinTty = process.stdin.isTTY
    originalStdoutTty = process.stdout.isTTY
    renderMock.mockReset()
    unmountMock.mockReset()
    renderMock.mockReturnValue({ unmount: unmountMock })
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    setTty(originalStdinTty ?? false)
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTty, configurable: true })
    writeSpy.mockRestore()
    vi.resetModules()
  })

  it('falls back to plain line output when stdin/stdout are not TTYs, every prompt resolving its fallback', async () => {
    setTty(false)
    const { createRichIO } = await import('../src/loop/ui/terminal.js')
    const io = createRichIO()
    expect(io.interactive).toBe(false)

    io.write('hello')
    expect(writeSpy).toHaveBeenCalledWith('hello\n')

    await expect(io.confirm('Proceed?', true)).resolves.toBe(true)
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('non-interactive → yes'))
    await expect(io.confirm('Proceed?', false)).resolves.toBe(false)
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('non-interactive → no'))

    const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]
    await expect(io.select('Pick', options)).resolves.toBe('a')
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('non-interactive → Alpha'))
    await expect(io.select('Pick', options, 1)).resolves.toBe('b')
    await expect(io.select('Pick', [])).resolves.toBeNull()
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('non-interactive → none'))

    await expect(io.text('Name?', 'anon')).resolves.toBe('anon')
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('non-interactive → anon'))

    io.checks([{ id: 'a', status: 'passed', detail: 'ok' }, { id: 'b', status: 'warning', detail: 'meh' }, { id: 'c', status: 'failed', detail: 'bad' }])
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('✔ a'))
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('△ b'))
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('✖ c'))

    io.section('Setup')
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Setup'))
    io.section('Setup', 2, 5)
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('2/5 Setup'))

    io.banner('Welcome', ['line one'])
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Welcome'))
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('line one'))

    io.bullet('a bullet')
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('a bullet'))
  })

  it('renders via ink when interactive, resolving prompts through the onDone callback and unmounting afterwards', async () => {
    setTty(true)
    const { createRichIO } = await import('../src/loop/ui/terminal.js')
    const io = createRichIO()
    expect(io.interactive).toBe(true)

    io.write('hello')
    expect(renderMock).toHaveBeenCalled()
    expect(unmountMock).toHaveBeenCalledTimes(1)

    const confirmPromise = io.confirm('Proceed?', true)
    const confirmElement = renderMock.mock.calls.at(-1)![0] as { props: { onDone: (value: boolean) => void } }
    confirmElement.props.onDone(true)
    await expect(confirmPromise).resolves.toBe(true)
    expect(unmountMock).toHaveBeenCalledTimes(2)

    const selectPromise = io.select('Pick', [{ value: 'a', label: 'Alpha' }])
    const selectElement = renderMock.mock.calls.at(-1)![0] as { props: { onDone: (value: string | null) => void } }
    selectElement.props.onDone('a')
    await expect(selectPromise).resolves.toBe('a')

    const textPromise = io.text('Name?', 'anon')
    const textElement = renderMock.mock.calls.at(-1)![0] as { props: { onDone: (value: string | null) => void } }
    textElement.props.onDone('typed')
    await expect(textPromise).resolves.toBe('typed')

    io.checks([{ id: 'a', status: 'passed', detail: 'ok' }])
    io.section('Setup')
    io.banner('Welcome', ['line'])
    io.bullet('a bullet', 'ok')
    io.bullet('a bullet', 'warn')
    io.bullet('a bullet', 'fail')
    // every paint() call renders one static tree and unmounts it immediately
    expect(renderMock).toHaveBeenCalledTimes(10)
    expect(unmountMock).toHaveBeenCalledTimes(10)
  })
})
