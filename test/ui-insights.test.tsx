import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Bars, HBarList, LineChart, Ring, SegmentBar, Sparkline, StackedBars, segments } from '../src/ui/app/src/components/charts'
import {
  averageFixRounds, capLevel, formatDuration, formatTokens, leadTimeDelta, obviouslyWeakens, parseValue, planDomain, projection,
} from '../src/ui/app/src/lib/format'

describe('ui insight charts', () => {
  it('every chart exposes an accessible summary', () => {
    const html = [
      renderToStaticMarkup(<Sparkline values={[1, 3, 2]} label="Merged 24h: 6" />),
      renderToStaticMarkup(<Bars label="Throughput: 5 merged" colors={['green']} data={[{ label: 'a', values: [5] }]} />),
      renderToStaticMarkup(<LineChart label="Lead time median 1h" series={[{ label: 'm', color: 'blue', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }]} />),
      renderToStaticMarkup(<Ring value={0.68} label="68% approved" />),
      renderToStaticMarkup(<SegmentBar label="proven 91%" segments={[{ label: 'p', value: 91, color: 'green' }]} />),
    ].join('')
    for (const label of ['Merged 24h: 6', 'Throughput: 5 merged', 'Lead time median 1h', '68% approved', 'proven 91%']) expect(html).toContain(`aria-label="${label}"`)
    expect(html.match(/role="img"/g)).toHaveLength(5)
  })

  it('stacks bar segments proportionally and prints value labels', () => {
    const html = renderToStaticMarkup(<Bars label="x" colors={['green', 'red']} valueLabel={(datum) => String(datum.values[0])}
      data={[{ label: 'a', values: [3, 1] }, { label: 'b', values: [2, 0] }]} />)
    expect(html).toContain('height:88%') // tallest stack fills the plot
    expect(html).toContain('height:44%')
    expect(html).toContain('flex-grow:3;background:green')
    expect(html).toContain('flex-grow:1;background:red')
    expect(html).not.toMatch(/flex-grow:0/) // empty segments are skipped
    expect(html).toContain('>3</span>')
  })

  it('StackedBars maps keyed values in key order, missing keys as zero', () => {
    const html = renderToStaticMarkup(<StackedBars label="tokens" keys={[{ key: 'builder', label: 'builder', color: 'blue' }, { key: 'review', label: 'review', color: 'amber' }]}
      data={[{ label: 'h1', values: { review: 2 } }, { label: 'h2', values: { builder: 4, review: 4 } }]} />)
    expect(html).toContain('title="h1: 0 / 2"')
    expect(html).toContain('title="h2: 4 / 4"')
  })

  it('HBarList scales to the largest item and is a labelled list', () => {
    const html = renderToStaticMarkup(<HBarList label="Why runs stop" items={[{ label: 'CI', value: 6 }, { label: 'HITL', value: 3 }]} />)
    expect(html).toContain('<ul aria-label="Why runs stop"')
    expect(html).toContain('width:100%')
    expect(html).toContain('width:50%')
  })

  it('LineChart breaks lines at null, draws projections dashed and the now marker', () => {
    expect(segments([{ x: 0, y: 1 }, { x: 1, y: null }, { x: 2, y: 3 }, { x: 3, y: 4 }])).toEqual([[{ x: 0, y: 1 }], [{ x: 2, y: 3 }, { x: 3, y: 4 }]])
    const html = renderToStaticMarkup(<LineChart label="plan" xDomain={[0, 10]} yMax={100} marker={5}
      series={[{ label: 'claude', color: 'blue', points: [{ x: 0, y: 100 }, { x: 5, y: 50 }], projection: [{ x: 5, y: 50 }, { x: 10, y: 0 }] }]} />)
    expect(html).toContain('stroke-dasharray="5 5"')
    expect(html).toContain('stroke-dasharray="3 4"')
    expect(html).toContain('x1="200"')
  })

  it('Ring draws the value as a percent of the circumference', () => {
    expect(renderToStaticMarkup(<Ring value={0.25} label="r" />)).toContain('stroke-dasharray="25 75"')
    expect(renderToStaticMarkup(<Ring value={null} label="r" />)).not.toContain('stroke-dasharray')
  })
})

describe('ui insight formatting', () => {
  it('formats tokens and durations compactly', () => {
    expect([formatTokens(1_760_000), formatTokens(61_000), formatTokens(950), formatTokens(null)]).toEqual(['1.76M', '61k', '950', '—'])
    expect([formatDuration(112 * 60_000), formatDuration(5 * 60_000), formatDuration(null)]).toEqual(['1h 52m', '5m', '—'])
  })

  it('describes the lead-time delta and whether it improved', () => {
    expect(leadTimeDelta(76, 100)).toEqual({ text: 'Median down 24%', better: true })
    expect(leadTimeDelta(150, 100)).toEqual({ text: 'Median up 50%', better: false })
    expect(leadTimeDelta(null, 100)).toBeNull()
  })

  it('averages fix rounds with 3+ and cap counted as 3', () => {
    expect(averageFixRounds([{ label: '0', count: 2 }, { label: '1', count: 1 }, { label: '3+', count: 1 }, { label: 'cap', count: 0 }])).toBe(1)
    expect(averageFixRounds([])).toBeNull()
  })

  it('colours usage against the cap at 80% and 100%', () => {
    expect([capLevel(79, 100), capLevel(80, 100), capLevel(100, 100), capLevel(500, null)]).toEqual(['ok', 'warn', 'over', 'ok'])
  })

  it('projects plan remaining to zero and clips it at the chart edge', () => {
    const provider = { provider: 'claude', roles: [], remainingPercent: 40, cooldownUntil: null, projectedZeroAt: '2026-09-25T20:00:00.000Z',
      series: [{ at: '2026-09-25T10:00:00.000Z', remainingPercent: 80 }, { at: '2026-09-25T12:00:00.000Z', remainingPercent: 40 }] }
    const report = { from: '2026-09-25T00:00:00.000Z', to: '2026-09-25T12:00:00.000Z', providers: [provider] }
    const [from, end] = planDomain(report)
    expect(end - from).toBe(18 * 3_600_000) // capped at half a window past now
    expect(projection(provider, end)).toEqual([{ x: Date.parse('2026-09-25T12:00:00.000Z'), y: 40 }, { x: end, y: 10 }])
    expect(projection({ ...provider, projectedZeroAt: null }, end)).toBeUndefined()
  })

  it('flags obvious gate weakening and leaves the rest to the server', () => {
    expect(obviouslyWeakens('gate', true, false)).toBe(true)
    expect(obviouslyWeakens('gate', 2, 0)).toBe(true)
    expect(obviouslyWeakens('gate', 120000, 90000)).toBe(false)
    expect(obviouslyWeakens('safe', true, false)).toBe(false)
    expect([parseValue('2'), parseValue('false'), parseValue('medium'), parseValue('[1]')]).toEqual([2, false, 'medium', [1]])
  })
})
