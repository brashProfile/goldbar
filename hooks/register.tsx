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

/** Seven rounded day pills; the fill runs through them in golds. While a turn
 * runs, a swell travels left to right: each pill widens briefly in turn. */
function days(percent: number, isWorking: boolean, isStale: boolean, N = 7): string {
  const PW = 22, H = 10, GAP = 4, W = N * PW + (N - 1) * GAP, SWELL = 4
  const golds = ramp(N)
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * N
  const op = isStale ? 0.45 : 1
  const DUR = Math.max(0.3, cfg.pulseSeconds)
  isWorking = isWorking && cfg.pulse
  const swell = (x: number, w: number, i: number) =>
    isWorking
      ? `<animate attributeName="width" values="${w};${w + SWELL};${w};${w}" keyTimes="0;0.12;0.26;1" dur="${DUR}s" begin="${(i * 0.12).toFixed(2)}s" repeatCount="indefinite"/>` +
        `<animate attributeName="x" values="${x};${x - SWELL / 2};${x};${x}" keyTimes="0;0.12;0.26;1" dur="${DUR}s" begin="${(i * 0.12).toFixed(2)}s" repeatCount="indefinite"/>`
      : ''
  let defs = ''
  let out = ''
  for (let i = 0; i < N; i++) {
    const x = SWELL / 2 + i * (PW + GAP)
    const f = Math.max(0, Math.min(1, filled - i))
    defs += `<clipPath id="d${i}"><rect x="${x}" width="${PW}" height="${H}" rx="${H / 2}">${swell(x, PW, i)}</rect></clipPath>`
    out += `<rect x="${x}" width="${PW}" height="${H}" rx="${H / 2}" fill="${cfg.trackColor}" opacity="0.22">${swell(x, PW, i)}</rect>`
    if (f > 0) {
      const fw = f === 1 ? PW : f * PW
      out += `<rect x="${x}" width="${fw}" height="${H}" fill="${golds[i]}" opacity="${op}" clip-path="url(#d${i})">${f === 1 ? swell(x, PW, i) : ''}</rect>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + SWELL}" height="${H}" viewBox="0 0 ${W + SWELL} ${H}"><defs>${defs}</defs>${out}</svg>`
}

const barW = (n: number) => n * 22 + (n - 1) * 4 + 4

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
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          {!cfg.showBackground ? null : (<Box flexDirection="row" gap={1} alignItems="center">
            <Svg
              source={bg === 0 ? spinnerIdle() : spinner()}
              alt={bg === 0 ? 'No background tasks running' : `${bg} background task${bg === 1 ? '' : 's'} running`}
              width={14}
              height={14}
            />
            <Text color={cfg.valueColor} dimColor={bg === 0}>{`${bg}`}</Text>
          </Box>)}
          {!cfg.showBackground ? null : <Text color={cfg.dividerColor}>│</Text>}
          {five === null ? null : (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text bold color={cfg.labelColor}>{cfg.sessionLabel}</Text>
              <Svg source={days(five.percentUsed, e.props.isWorking, false, cfg.sessionPills)} alt={`${five.percentUsed}% of the ${cfg.sessionLabel} limit used`} width={barW(cfg.sessionPills)} height={10} />
              <Text bold color={cfg.valueColor}>{`${five.percentUsed}%`}</Text>
            </Box>
          )}
          {five === null || !cfg.showWeekly ? null : <Text color={cfg.dividerColor}>│</Text>}
          {!cfg.showWeekly ? null : (<Box flexDirection="row" gap={1} alignItems="center">
            <Text bold color={cfg.labelColor}>{cfg.weeklyLabel}</Text>
            <Svg source={days(used, e.props.isWorking, stale !== null, cfg.weeklyPills)} alt={`${used}% of the weekly limit used`} width={barW(cfg.weeklyPills)} height={10} />
            <Text bold color={cfg.valueColor} dimColor={stale !== null}>{`${used}%`}</Text>
            {gauge.resetIn === null || !cfg.showResetTime ? null : <Text color={cfg.valueColor}>{`↻ ${gauge.resetIn}`}</Text>}
            {stale === null ? null : <Text dimColor>{`(last seen ${stale} ago)`}</Text>}
          </Box>)}
          {f === null ? null : <Text color={cfg.dividerColor}>│</Text>}
          {f === null ? null : (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text bold color={cfg.labelColor}>{f.name}</Text>
              <Svg source={days(f.percentUsed, e.props.isWorking, false, cfg.modelPills)} alt={`${f.percentUsed}% of the ${f.name} weekly limit used`} width={barW(cfg.modelPills)} height={10} />
              <Text bold color={cfg.valueColor}>{`${f.percentUsed}%`}</Text>
            </Box>
          )}
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
