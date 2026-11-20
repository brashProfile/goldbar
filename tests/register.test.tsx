import { expect, mock, test } from 'claude-code/testing'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-19T12:00:00Z')

const BAND = {
  plugin: 'goldbar',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const percent = async (ui: { find: (q: { type: string; text: RegExp; in?: string }) => Promise<{ text: string } | undefined> }, surface: 'terminal' | 'desktop') =>
  surface === 'desktop'
    ? (await ui.find({ type: 'Text', text: /^\d+%$/ }))?.text
    : (await ui.find({ type: 'Text', text: /^\d+%$/, in: 'gauge' }))?.text

const usage = (rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) => ({
  value: { startedAt: 0, context: { window: 200_000 }, rateLimits },
})

test('draws the weekly reading with pace, on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Three days left of seven: 4/7 of the week, 57%, is gone.
  on('session.usage', () =>
    usage([
      { kind: 'seven_day', percentUsed: 80, resetsAt: new Date(NOW + 3 * DAY).toISOString() },
    ]),
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await percent(ui, surface))).toBe('80%')
    const details = await ui.find({ type: 'Text', text: /↻/, in: surface === 'desktop' ? undefined : 'gauge' })
    expect(details?.text).toBe(
      surface === 'desktop' ? '↻ 3d 0h' : '↻ 3d 0h · 57% of week gone',
    )
    await ui.unmount()
  }
})

test('shows a placeholder before any reading', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usage([]))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /no reading yet/ }))?.text).toMatch(/^Weekly usage/)
  await ui.unmount()
})

test('carries the last reading over from an earlier session, marked old', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    lastWeekly: {
      percentUsed: 30,
      resetsAt: new Date(NOW + 5 * DAY).toISOString(),
      at: NOW - 2 * 60 * 60 * 1000,
      isStale: false,
    },
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usage([]))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await percent(ui, 'desktop'))).toBe('30%')
  expect(await ui.find({ type: 'Text', text: '(last seen 2h 0m ago)' })).toBeTruthy()
  await ui.unmount()
})

test('ignores a stored reading whose week has reset', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    lastWeekly: {
      percentUsed: 95,
      resetsAt: new Date(NOW - DAY).toISOString(),
      at: NOW - 3 * DAY,
      isStale: false,
    },
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usage([]))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /no reading yet/ })).toBeTruthy()
  await ui.unmount()
})

test('yields the band to a survey', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('survey')
  await ui.unmount()
})

test('a reading after a turn redraws the mounted band', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => usage([]))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /no reading yet/ })).toBeTruthy()

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 4 * DAY).toISOString() },
    ],
    changed: ['rateLimits'],
  })

  expect((await percent(ui, 'desktop'))).toBe('41%')
  await ui.unmount()
})

test('the gauge pulses while a turn runs, and sits still otherwise', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () =>
    usage([{ kind: 'seven_day', percentUsed: 60, resetsAt: new Date(NOW + 3 * DAY).toISOString() }]),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true } })
    const pill = async () => (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.source)).join('')
    expect(await pill()).toContain('<animate')
    await ui.redraw({ ...BAND.props, isWorking: false })
    expect(await pill()).not.toContain('<animate')
    await ui.unmount()
  }

  for (const surface of ['terminal'] as const) {
    const colors = async () =>
      JSON.stringify(
        (await ui.findAll({ type: 'Text', in: 'gauge' })).map(t => [t.text, t.props.color]),
      )

    const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, isWorking: true } })
    const first = await colors()
    await ui.advance(350)
    expect(await colors()).not.toBe(first)

    await ui.redraw({ ...BAND.props, isWorking: false })
    const idle = await colors()
    await ui.advance(350)
    expect(await colors()).toBe(idle)
    await ui.unmount()
  }
})

test('shows the Fable weekly limit as a second bar', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () =>
    usage([{ kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 3 * DAY).toISOString() }]),
  )
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ model_scoped: [{ display_name: 'Fable', utilization: 44, resets_at: null }] }),
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Fable' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '44%' })).toBeTruthy()
  const bars = await ui.findAll({ type: 'Svg' })
  expect(bars).toHaveLength(2)
  expect((String(bars[0]!.props.source).match(/rx="5"/g) ?? []).length).toBe(14)
  await ui.unmount()
})

test('shows the 5-hour window first', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () =>
    usage([
      { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 2 * 3600000).toISOString() },
      { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 3 * DAY).toISOString() },
    ]),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.slice(0, 4)).toEqual(['5-hour', '12%', '│', 'Weekly'])
  const bars = await ui.findAll({ type: 'Svg' })
  expect((String(bars[0]!.props.source).match(/<clipPath/g) ?? []).length).toBe(5)
  await ui.unmount()
})
