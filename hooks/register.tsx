import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { GaugeProps, ModelReading, Reading } from '../types'

const STORE_KEY = 'lastWeekly'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// A reading this many points above the share of the week gone is "ahead of pace".
const PACE_SLACK = 10

const reading = atom({ plugin: 'goldbar', key: 'reading' } as const, null)
const session = atom({ plugin: 'goldbar', key: 'session' } as const, null)
const fable = atom({ plugin: 'goldbar', key: 'fable' } as const, null)

const FABLE_KEY = 'lastFable'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?skip_spend=1'
const FETCH_EVERY_MS = 2 * 60 * 1000

/** Finds Fable's own weekly limit in the usage endpoint's answer, whichever shape it has. */
function findFable(body: unknown): Omit<ModelReading, 'at'> | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const pick = (name: unknown, pct: unknown, resets: unknown) =>
    typeof name === 'string' && /fable/i.test(name) && typeof pct === 'number'
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
    if (/^seven_day_fable/.test(k) && v && typeof v === 'object') {
      const r = v as Record<string, unknown>
      const hit = pick('Fable', r.utilization, r.resets_at)
      if (hit) return hit
    }
  }
  return null
}

let lastFetch = -Infinity

async function refreshFable($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - lastFetch < FETCH_EVERY_MS) return
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
  const all = ['#d9a400', '#c99400', '#b88400', '#a67400', '#936400', '#805500', '#6e4700']
  const golds = Array.from({ length: N }, (_, i) => all[Math.round((i * (all.length - 1)) / Math.max(1, N - 1))]!)
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * N
  const op = isStale ? 0.45 : 1
  const DUR = 1.6
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
    out += `<rect x="${x}" width="${PW}" height="${H}" rx="${H / 2}" fill="#8b949e" opacity="0.22">${swell(x, PW, i)}</rect>`
    if (f > 0) {
      const fw = f === 1 ? PW : f * PW
      out += `<rect x="${x}" width="${fw}" height="${H}" fill="${golds[i]}" opacity="${op}" clip-path="url(#d${i})">${f === 1 ? swell(x, PW, i) : ''}</rect>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + SWELL}" height="${H}" viewBox="0 0 ${W + SWELL} ${H}"><defs>${defs}</defs>${out}</svg>`
}

const barW = (n: number) => n * 22 + (n - 1) * 4 + 4
const DAYS_W = barW(7)

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




export const register: Register = on => {
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

    const f = await read($, fable)
    const five = await read($, session)

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const stale = gauge.staleFor
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          {five === null ? null : (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text bold color="#805500">5-hour</Text>
              <Svg source={days(five.percentUsed, e.props.isWorking, false, 5)} alt={`${five.percentUsed}% of the 5-hour limit used`} width={barW(5)} height={10} />
              <Text bold color="#b88400">{`${five.percentUsed}%`}</Text>
            </Box>
          )}
          {five === null ? null : <Text color="#1b1b1b">│</Text>}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text bold color="#805500">Weekly</Text>
            <Svg source={days(used, e.props.isWorking, stale !== null)} alt={`${used}% of the weekly limit used`} width={DAYS_W} height={10} />
            <Text bold color="#b88400" dimColor={stale !== null}>{`${used}%`}</Text>
            {gauge.resetIn === null ? null : <Text color="#b88400">{`↻ ${gauge.resetIn}`}</Text>}
            {stale === null ? null : <Text dimColor>{`(last seen ${stale} ago)`}</Text>}
          </Box>
          {f === null ? null : <Text color="#1b1b1b">│</Text>}
          {f === null ? null : (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text bold color="#805500">{f.name}</Text>
              <Svg source={days(f.percentUsed, e.props.isWorking, false)} alt={`${f.percentUsed}% of the ${f.name} weekly limit used`} width={DAYS_W} height={10} />
              <Text bold color="#b88400">{`${f.percentUsed}%`}</Text>
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
