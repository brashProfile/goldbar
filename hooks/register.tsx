import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'

import type { BgTask, GaugeProps, ModelReading, Reading } from '../types'

const STORE_KEY = 'lastWeekly'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// A reading this many points above the share of the week gone is "ahead of pace".
const PACE_SLACK = 10

const reading = atom({ plugin: 'goldbar', key: 'reading' } as const, null)
const session = atom({ plugin: 'goldbar', key: 'session' } as const, null)
const background = atom({ plugin: 'goldbar', key: 'background' } as const, 0)
const tasks = atom({ plugin: 'goldbar', key: 'tasks' } as const, [] as BgTask[])
const fable = atom({ plugin: 'goldbar', key: 'fable' } as const, null)

const FABLE_KEY = 'lastFable'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?skip_spend=1'

/** Every setting, with its default; `userConfig` in plugin.json lists them for the config menu. */
const DEFAULTS = {
  showBackground: true,
  showSession: true,
  showWeekly: true,
  showModel: true,
  sessionLabel: '5-hour',
  weeklyLabel: 'Weekly',
  modelName: 'Fable',
  sessionPills: 5,
  weeklyPills: 5,
  modelPills: 5,
  goldStart: '#d9a400',
  goldEnd: '#6e4700',
  labelColor: '#805500',
  valueColor: '#b88400',
  dividerColor: '#1b1b1b',
  trackColor: '#8b949e',
  showResetTime: true,
  pulse: true,
  pulseSeconds: 1.6,
  modelRefreshMinutes: 2,
  columnPixels: 8,
  bounce: true,
}
type Config = typeof DEFAULTS

let cfg: Config = DEFAULTS

function readConfig(options: PluginOptions): Config {
  const out: Record<string, unknown> = { ...DEFAULTS }
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = options[k]
    if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof d === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v)
    else if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v
    else if (typeof d === 'string' && typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  const c = out as Config
  const pills = (n: number) => Math.max(1, Math.min(14, Math.round(n)))
  return { ...c, sessionPills: pills(c.sessionPills), weeklyPills: pills(c.weeklyPills), modelPills: pills(c.modelPills) }
}

const hex2rgb = (h: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h)
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `n` colors from goldStart to goldEnd. */
function ramp(n: number): string[] {
  const a = hex2rgb(cfg.goldStart) ?? hex2rgb(DEFAULTS.goldStart)!
  const b = hex2rgb(cfg.goldEnd) ?? hex2rgb(DEFAULTS.goldEnd)!
  return Array.from({ length: n }, (_, i) => {
    const k = n === 1 ? 0 : i / (n - 1)
    return '#' + [0, 1, 2].map(j => Math.round(a[j]! + (b[j]! - a[j]!) * k).toString(16).padStart(2, '0')).join('')
  })
}

/** Finds Fable's own weekly limit in the usage endpoint's answer, whichever shape it has. */
function findFable(body: unknown): Omit<ModelReading, 'at'> | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const pick = (name: unknown, pct: unknown, resets: unknown) =>
    typeof name === 'string' && name.toLowerCase().includes(cfg.modelName.toLowerCase()) && typeof pct === 'number'
      ? { name, percentUsed: Math.round(pct * 10) / 10, resetsAt: typeof resets === 'string' ? resets : null }
      : null
  for (const m of Array.isArray(b.model_scoped) ? b.model_scoped : []) {
    const r = m as Record<string, unknown>
    const hit = pick(r.display_name, r.utilization, r.resets_at)
    if (hit) return hit
  }
  for (const m of Array.isArray(b.limits) ? b.limits : []) {
    const r = m as { scope?: { model?: { display_name?: unknown } }; percent?: unknown; resets_at?: unknown }
    const hit = pick(r.scope?.model?.display_name, r.percent, r.resets_at)
    if (hit) return hit
  }
  for (const [k, v] of Object.entries(b)) {
    if (k === `seven_day_${cfg.modelName.toLowerCase()}` && v && typeof v === 'object') {
      const r = v as Record<string, unknown>
      const hit = pick(cfg.modelName, r.utilization, r.resets_at)
      if (hit) return hit
    }
  }
  return null
}

let lastFetch = -Infinity

async function refreshFable($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (!cfg.showModel || now - lastFetch < Math.max(0.5, cfg.modelRefreshMinutes) * 60_000) return
  lastFetch = now
  try {
    const auth = await $.session.authorize()
    if (!auth) return
    const res = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) return
    const hit = findFable(JSON.parse(res.text))
    if (!hit) return
    const next: ModelReading = { ...hit, at: now }
    await update($, fable, () => next)
    await $.store.set(FABLE_KEY, next)
  } catch {
    // Offline or a changed answer: keep the last reading.
  }
}

const PILL_MAX = 22
const PILL_MIN = 10
const PILL_H = 10
const BAR_H = 14
const BAR_PAD = 3
const pillGap = (pw: number) => (pw >= 16 ? 4 : 3)
const barW = (n: number, pw = PILL_MAX) => n * pw + (n - 1) * pillGap(pw) + BAR_PAD * 2

/** A one-shot squish-and-bounce, staggered by `i`, for when a shape changes. */
const popAnim = (i: number) =>
  `<animateTransform attributeName="transform" type="scale" values="1 1;0.55 0.7;1.14 1.12;0.97 0.98;1 1" keyTimes="0;0.25;0.6;0.82;1" dur="0.5s" begin="${(i * 0.045).toFixed(3)}s" calcMode="spline" keySplines="0.3 0 0.7 1;0.3 0 0.5 1;0.3 0 0.7 1;0.3 0 0.7 1"/>`

/** A row of rounded pills, each `pw` wide (at PILL_MIN they are round beads);
 * the fill runs through them in golds. While a turn runs, a swell travels
 * left to right. `pop` adds the one-shot bounce. */
function days(percent: number, isWorking: boolean, isStale: boolean, N = 5, pw = PILL_MAX, pop = false): string {
  const gap = pillGap(pw)
  const W = barW(N, pw)
  const golds = ramp(N)
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * N
  const op = isStale ? 0.45 : 1
  const DUR = Math.max(0.3, cfg.pulseSeconds)
  const delay = pop ? 0.6 : 0
  const swell = (i: number) =>
    isWorking && cfg.pulse
      ? `<animateTransform attributeName="transform" type="scale" values="1 1;${(1 + 4 / pw).toFixed(3)} 1;1 1;1 1" keyTimes="0;0.12;0.26;1" dur="${DUR}s" begin="${(delay + i * 0.12).toFixed(2)}s" repeatCount="indefinite"/>`
      : ''
  const x0 = -pw / 2, y0 = -PILL_H / 2
  let out = ''
  for (let i = 0; i < N; i++) {
    const cx = BAR_PAD + i * (pw + gap) + pw / 2
    const f = Math.max(0, Math.min(1, filled - i))
    const fill = f > 0
      ? `<rect x="${x0}" y="${y0}" width="${(f * pw).toFixed(2)}" height="${PILL_H}" fill="${golds[i]}" opacity="${op}" clip-path="url(#p)"/>`
      : ''
    out += `<g transform="translate(${cx} ${BAR_H / 2})"><g>${pop ? popAnim(i) : ''}<g>${swell(i)}<rect x="${x0}" y="${y0}" width="${pw}" height="${PILL_H}" rx="${PILL_H / 2}" fill="${cfg.trackColor}" opacity="0.22"/>${fill}</g></g></g>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAR_H}" viewBox="0 0 ${W} ${BAR_H}"><defs><clipPath id="p"><rect x="${x0}" y="${y0}" width="${pw}" height="${PILL_H}" rx="${PILL_H / 2}"/></clipPath></defs>${out}</svg>`
}

/** A bar rolled up into a ring: the arc is the share used. `pop` draws the
 * arc in from nothing with a bounce; a running turn makes the ring breathe. */
function ring(percent: number, isWorking: boolean, isStale: boolean, pop = false): string {
  const r = 5, c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, percent)) / 100
  const golds = ramp(5)
  const color = golds[Math.min(4, Math.floor(p * 5))]
  const len = (p * c).toFixed(2)
  const DUR = Math.max(0.3, cfg.pulseSeconds)
  const roll = pop ? `<animate attributeName="stroke-dasharray" values="0 ${c.toFixed(2)};${len} ${c.toFixed(2)}" dur="0.55s" calcMode="spline" keySplines="0.2 0.7 0.3 1"/>` : ''
  const breathe = isWorking && cfg.pulse
    ? `<animateTransform attributeName="transform" type="scale" values="1;1.16;1;1" keyTimes="0;0.2;0.45;1" dur="${DUR}s" begin="${pop ? 0.6 : 0}s" repeatCount="indefinite"/>`
    : ''
  const arc = p > 0
    ? `<circle r="${r}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${len} ${c.toFixed(2)}" transform="rotate(-90)" opacity="${isStale ? 0.45 : 1}">${roll}</circle>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g transform="translate(8 8)"><g>${pop ? popAnim(0) : ''}<g>${breathe}<circle r="${r}" fill="none" stroke="${cfg.trackColor}" stroke-opacity="0.3" stroke-width="2.6"/>${arc}</g></g></g></svg>`
}

type BarShape = { mode: 'pills'; pw: number } | { mode: 'ring' } | { mode: 'none' }
type Shape = { side: BarShape; weekly: BarShape; hasReset: boolean; hasLabel: boolean; hasDividers: boolean }
type Sizes = { cols: number; spinner: number; five: [number, number] | null; model: [number, number] | null; weekly: [number, number]; reset: number }

/** How many columns a shape needs. Text counts a column a character; a
 * drawing its pixels over `columnPixels`. */
function shapeCols(sh: Shape, z: Sizes): number {
  const px = (n: number) => n / Math.max(4, cfg.columnPixels)
  const bar = (b: BarShape, [label, pct]: [number, number], pills: number, withLabel = true) =>
    b.mode === 'none' ? 0
    : b.mode === 'ring' ? px(16) + 1 + (withLabel ? label + 1 : 0) + pct
    : label + 1 + px(barW(pills, b.pw)) + 1 + pct
  const parts = [
    z.spinner,
    z.five ? bar(sh.side, z.five, cfg.sessionPills) : 0,
    bar(sh.weekly, z.weekly, cfg.weeklyPills, sh.hasLabel) + (sh.hasReset && z.reset ? 1 + z.reset : 0),
    z.model ? bar(sh.side, z.model, cfg.modelPills) : 0,
  ].filter(n => n > 0)
  const between = sh.hasDividers ? 3 : 2
  return parts.reduce((a, n) => a + n, 0) + (parts.length - 1) * between + 1
}

/** The richest shape that fits: side bars squish first, then roll up into
 * rings and step aside; the weekly bar then gives up its countdown,
 * squishes, and at the very last rolls up too. Pill widths are solved, so they shrink smoothly. */
function fit(z: Sizes): Shape {
  const pills = (pw: number): BarShape => ({ mode: 'pills', pw })
  const R: BarShape = { mode: 'ring' }, X: BarShape = { mode: 'none' }
  const full = pills(PILL_MAX)
  // Each rung only ever takes away, so nothing shrinks and then grows back.
  const ladder: Array<(pw: number) => Shape> = [
    pw => ({ side: pills(pw), weekly: full, hasReset: true, hasLabel: true, hasDividers: true }),
    () => ({ side: R, weekly: full, hasReset: true, hasLabel: true, hasDividers: true }),
    () => ({ side: X, weekly: full, hasReset: true, hasLabel: true, hasDividers: false }),
    pw => ({ side: X, weekly: pills(pw), hasReset: false, hasLabel: true, hasDividers: false }),
  ]
  for (const step of ladder) {
    for (let pw = PILL_MAX; pw >= PILL_MIN; pw--) {
      const sh = step(pw)
      if (shapeCols(sh, z) <= z.cols) return sh
    }
  }
  const small: Shape = { side: X, weekly: R, hasReset: false, hasLabel: true, hasDividers: false }
  return shapeCols(small, z) <= z.cols ? small : { ...small, hasLabel: false }
}

/** The last shape drawn per bar, to bounce only when one changes. */
const lastShape: Record<string, { key: string; at: number } | undefined> = {}
const POP_MS = 700

function changed(id: string, b: BarShape, now: number): boolean {
  const key = b.mode === 'pills' ? `pills:${b.pw}` : b.mode
  const prev = lastShape[id]
  if (prev === undefined) {
    lastShape[id] = { key, at: -Infinity }
    return false
  }
  if (prev.key !== key) lastShape[id] = { key, at: now }
  return cfg.bounce && now - lastShape[id]!.at < POP_MS
}

/** The same ring, still and faint, while nothing runs: it keeps the space. */
const spinnerIdle = () => `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${cfg.labelColor}" stroke-opacity="0.35" stroke-width="2"/></svg>`

/** A small gold arc that spins. */
const spinner = () => `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${cfg.labelColor}" stroke-opacity="0.35" stroke-width="2"/><path d="M7 1.5 A5.5 5.5 0 0 1 12.5 7" fill="none" stroke="${cfg.goldStart}" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.9s" repeatCount="indefinite"/></path></svg>`

function isReading(value: unknown): value is Reading {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.percentUsed === 'number' &&
    typeof r.at === 'number' &&
    (r.resetsAt === null || typeof r.resetsAt === 'string')
  )
}

/** Saves the `seven_day` window, if the limits have one. */
async function record(
  $: EngineInterface,
  limits: readonly SessionRateLimit[],
): Promise<boolean> {
  const five = limits.find(l => l.kind === 'five_hour')
  if (five) {
    const at = await $.clock.now()
    await update($, session, () => ({ name: '5-hour', percentUsed: five.percentUsed, resetsAt: five.resetsAt ?? null, at }))
  }
  const weekly = limits.find(l => l.kind === 'seven_day')
  if (!weekly) return false

  const next: Reading = {
    percentUsed: weekly.percentUsed,
    resetsAt: weekly.resetsAt ?? null,
    at: await $.clock.now(),
    isStale: false,
  }
  await update($, reading, () => next)
  await $.store.set(STORE_KEY, next)
  return true
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}




const STALE_MS = 6 * 60 * 60 * 1000

async function setTasks($: EngineInterface, fn: (list: BgTask[]) => BgTask[]): Promise<void> {
  const now = await $.clock.now()
  let count = 0
  await update($, tasks, list => {
    const next = fn(list ?? []).filter(t => now - t.at < STALE_MS)
    count = next.length
    return next
  })
  await update($, background, () => count)
}

/** Drops the tasks a task-notification text names as finished. */
async function clearFinished($: EngineInterface, text: string): Promise<void> {
  if (!text.includes('task-notification')) return
  const ids = new Set<string>()
  for (const m of text.matchAll(/<(?:task-id|tool-use-id)>([^<]+)</g)) ids.add(m[1]!)
  if (ids.size === 0) return
  await setTasks($, list =>
    list.filter(t => !(t.taskId && ids.has(t.taskId)) && !(t.toolUseId && ids.has(t.toolUseId))),
  )
}

export const register: Register = (on, options) => {
  cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, fable)) === null) {
      const kept = await $.store.get(FABLE_KEY)
      if (kept && typeof kept === 'object' && typeof (kept as ModelReading).percentUsed === 'number') {
        await update($, fable, () => kept as ModelReading)
      }
    }
    void refreshFable($)
    const { rateLimits } = await $.session.usage()
    if (await record($, rateLimits)) return result

    // No reading yet this session: show the last one, marked as old,
    // unless its week has already reset.
    if ((await read($, reading)) !== null) return result
    const stored = await $.store.get(STORE_KEY)
    if (!isReading(stored)) return result
    const now = await $.clock.now()
    const hasReset = stored.resetsAt !== null && Date.parse(stored.resetsAt) <= now
    if (!hasReset) {
      await update($, reading, () => ({ ...stored, isStale: true }))
    }
    return result
  })

  // Background work, tracked from the calls that start it and the
  // notifications that end it.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { run_in_background?: boolean; task_id?: string; shell_id?: string }
    const starts =
      e.tool === 'Monitor' ||
      ((e.tool === 'Bash' || e.tool === 'Agent') && input.run_in_background === true)
    const result = await next(e)
    try {
      if (starts) {
        const text = JSON.stringify(result)
        const id = /(?:with ID|agentId|task_id|taskId)["\\:\s]*["']?([A-Za-z0-9_-]{5,})/.exec(text)?.[1] ?? null
        const at = await $.clock.now()
        await setTasks($, list => [...list, { toolUseId: e.tool_use_id ?? null, taskId: id, at }])
      } else if (e.tool === 'TaskStop') {
        const id = input.task_id ?? input.shell_id
        if (id) await setTasks($, list => list.filter(t => t.taskId !== id))
      }
    } catch {
      // Never get in the way of the call itself.
    }
    return result
  })

  // A finished task's notice reaches the session as a queued prompt too.
  on('prompt.submit', async ($, e, next) => {
    try {
      await clearFinished($, e.text)
    } catch {
      // ignore
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    try {
      await clearFinished($, JSON.stringify(e.message))
    } catch {
      // ignore
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refreshFable($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await record($, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const r = await read($, reading)

    if (r === null) {
      return (
        <Box>
          <Text dimColor wrap="truncate-end">
            Weekly usage: no reading yet, it shows after your next message
          </Text>
        </Box>
      )
    }

    const now = await $.clock.now()
    const used = r.percentUsed
    const resetsAt = r.resetsAt === null ? null : Date.parse(r.resetsAt)
    const left = resetsAt === null ? null : resetsAt - now
    const gone =
      left === null
        ? null
        : Math.min(100, Math.max(0, Math.round(((WEEK_MS - left) / WEEK_MS) * 100)))

    const gauge: GaugeProps = {
      used,
      gone,
      pace:
        gone === null
          ? null
          : used > gone + PACE_SLACK
            ? 'ahead'
            : used < gone - PACE_SLACK
              ? 'under'
              : 'on',
      resetIn: left === null ? null : span(left),
      staleFor: r.isStale ? span(now - r.at) : null,
      isWorking: e.props.isWorking,
      width: Math.max(12, Math.min(28, e.props.bodyColumns - 72)),
    }

    const f = cfg.showModel ? await read($, fable) : null
    const five = cfg.showSession ? await read($, session) : null
    const bg = await read($, background)

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const stale = gauge.staleFor
      const working = e.props.isWorking
      const pct = (n: number) => `${n}%`
      const resetText = [
        gauge.resetIn !== null && cfg.showResetTime ? `↻ ${gauge.resetIn}` : '',
        stale !== null ? `(last seen ${stale} ago)` : '',
      ].filter(t => t !== '').join(' ')
      const sh = fit({
        cols: e.props.bodyColumns,
        spinner: cfg.showBackground ? 14 / Math.max(4, cfg.columnPixels) + 1 + `${bg}`.length : 0,
        five: five ? [cfg.sessionLabel.length, pct(five.percentUsed).length] : null,
        model: f ? [f.name.length, pct(f.percentUsed).length] : null,
        weekly: cfg.showWeekly ? [cfg.weeklyLabel.length, pct(used).length] : [0, 0],
        reset: resetText.length,
      })
      const divider = sh.hasDividers ? <Text color={cfg.dividerColor}>│</Text> : null

      const bar = (id: string, b: BarShape, label: string, value: number, pills: number, isOld: boolean, extra: string) => {
        if (b.mode === 'none') return null
        const pop = changed(id, b, now)
        const alt = `${value}% of the ${label} limit used`
        return (
          <Box flexDirection="row" gap={1} alignItems="center">
            {b.mode === 'ring' ? (
              <Svg source={ring(value, working, isOld, pop)} alt={alt} width={16} height={16} />
            ) : (
              <Text bold color={cfg.labelColor}>{label}</Text>
            )}
            {b.mode === 'ring' ? (
              id !== 'weekly' || sh.hasLabel ? <Text bold color={cfg.labelColor}>{label}</Text> : null
            ) : (
              <Svg source={days(value, working, isOld, pills, b.pw, pop)} alt={alt} width={barW(pills, b.pw)} height={BAR_H} />
            )}
            <Text bold color={cfg.valueColor} dimColor={isOld}>{pct(value)}</Text>
            {extra === '' ? null : <Text color={cfg.valueColor}>{extra}</Text>}
          </Box>
        )
      }

      const fiveBar = five ? bar('session', sh.side, cfg.sessionLabel, five.percentUsed, cfg.sessionPills, false, '') : null
      const weekBar = cfg.showWeekly
        ? bar('weekly', sh.weekly, cfg.weeklyLabel, used, cfg.weeklyPills, stale !== null, sh.hasReset ? resetText : '')
        : null
      const modelBar = f ? bar('model', sh.side, f.name, f.percentUsed, cfg.modelPills, false, '') : null

      return (
        <Box flexDirection="row" gap={sh.hasDividers ? 1 : 2} justifyContent={sh.hasDividers ? 'space-between' : 'flex-start'} alignItems="center">
          {!cfg.showBackground ? null : (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Svg
                source={bg === 0 ? spinnerIdle() : spinner()}
                alt={bg === 0 ? 'No background tasks running' : `${bg} background task${bg === 1 ? '' : 's'} running`}
                width={14}
                height={14}
              />
              <Text color={cfg.valueColor} dimColor={bg === 0}>{`${bg}`}</Text>
            </Box>
          )}
          {cfg.showBackground && (fiveBar || weekBar) ? divider : null}
          {fiveBar}
          {fiveBar && weekBar ? divider : null}
          {weekBar}
          {modelBar && (weekBar || fiveBar) ? divider : null}
          {modelBar}
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const { Client } = $.ui.resolve(e)
      return (
        <Box>
          <Client key="gauge" module="./gauge.tsx" props={gauge} />
          {f === null ? null : <Text bold>{`  ${f.name} ${f.percentUsed}%`}</Text>}
          {bg === 0 || !cfg.showBackground ? null : <Text color={cfg.valueColor}>{`  ⟳ ${bg} running`}</Text>}
        </Box>
      )
    }

    // No Client here: a still line.
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {`Weekly: ${used}% used${gone === null ? '' : `, ${gone}% of week gone`}`}
        </Text>
      </Box>
    )
  })
}
