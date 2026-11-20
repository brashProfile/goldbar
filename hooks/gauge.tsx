import type { ClientModule } from 'claude-code'

import type { GaugeProps } from '../types'

type Rgb = [number, number, number]
type State = { frame: number }

// The newest props per instance, read by its frame timer.
const latest = new WeakMap<object, GaugeProps>()

const FRAME_MS = 70
const PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// Heat along the bar: green, amber, orange, red.
const STOPS: [number, Rgb][] = [
  [0, [217, 164, 0]],
  [50, [166, 116, 0]],
  [100, [110, 71, 0]],
]

function heat(percent: number): Rgb {
  const p = Math.min(100, Math.max(0, percent))
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i]!
    const [p0, c0] = STOPS[i - 1]!
    if (p <= p1) {
      const k = (p - p0) / (p1 - p0)
      return [0, 1, 2].map(j => c0[j]! + (c1[j]! - c0[j]!) * k) as Rgb
    }
  }
  return STOPS[STOPS.length - 1]![1]
}

/** Mixes toward white by `k` (0 to 1) and returns hex. */
function hex([r, g, b]: Rgb, k = 0): string {
  const ch = (v: number) =>
    Math.round(v + (255 - v) * k)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

function pie(used: number): string {
  if (used < 12.5) return '○'
  if (used < 37.5) return '◔'
  if (used < 62.5) return '◑'
  if (used < 87.5) return '◕'
  return '●'
}

type Cell = { ch: string; color?: string; backgroundColor?: string; dim?: boolean; bold?: boolean }

function cells(p: GaugeProps, frame: number): Cell[] {
  const { used, gone, width, isWorking, staleFor } = p
  const fillCells = (Math.min(100, Math.max(0, used)) / 100) * width
  const marker = gone === null ? -1 : Math.min(width - 1, Math.floor((gone / 100) * width))
  // A bright band that sweeps along the filled part while a turn runs.
  const head = isWorking ? ((frame * 0.5) % (Math.ceil(fillCells) + 8)) - 4 : -99

  const out: Cell[] = []
  for (let i = 0; i < width; i++) {
    const fill = Math.min(1, Math.max(0, fillCells - i))
    const base = heat(((i + 0.5) / width) * 100)
    const glow = Math.max(0, 1 - Math.abs(i - head) / 2.5) * 0.7
    const color = hex(base, glow)

    if (i === marker) {
      out.push(
        fill >= 0.5
          ? { ch: '┃', color: '#ffffff', backgroundColor: color, bold: true }
          : { ch: '┃', color: 'text', bold: true },
      )
    } else if (fill >= 1) {
      out.push({ ch: '█', color, dim: staleFor !== null })
    } else if (fill > 0) {
      const eighth = Math.round(fill * 8)
      out.push(
        eighth >= 8
          ? { ch: '█', color, dim: staleFor !== null }
          : eighth === 0
            ? { ch: '░', dim: true }
            : { ch: PARTIALS[eighth]!, color, dim: staleFor !== null },
      )
    } else {
      out.push({ ch: '░', dim: true })
    }
  }
  return out
}

/** Joins neighbouring cells drawn alike into one run. */
function runs(list: Cell[]): Cell[] {
  const out: Cell[] = []
  for (const c of list) {
    const last = out[out.length - 1]
    if (
      last &&
      last.color === c.color &&
      last.backgroundColor === c.backgroundColor &&
      last.dim === c.dim &&
      last.bold === c.bold
    ) {
      last.ch += c.ch
    } else {
      out.push({ ...c })
    }
  }
  return out
}

function chip(p: GaugeProps): { label: string; backgroundColor: string } | null {
  if (p.staleFor !== null) return { label: ` LAST SEEN ${p.staleFor} AGO `, backgroundColor: 'inactive' }
  return null
}

const Gauge: ClientModule<GaugeProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements

  if (surface.state === undefined) {
    surface.setState({ frame: 0 })
    surface.every(FRAME_MS, () => {
      // Ticks only redraw while a turn runs; idle, the gauge sits still.
      if (latest.get(surface)?.isWorking) {
        surface.setState({ frame: (surface.state?.frame ?? 0) + 1 })
      }
    })
  }
  latest.set(surface, props)

  const frame = surface.state?.frame ?? 0
  const accent = heat(props.used)
  const breathe = props.isWorking ? (Math.sin(frame * 0.35) + 1) / 2 : 0
  const badge = chip(props)
  const details = [
    props.resetIn === null ? null : `↻ ${props.resetIn}`,
    props.hideBar || props.gone === null ? null : `${props.gone}% of week gone`,
  ]
    .filter(part => part !== null)
    .join(' · ')

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={hex(accent, breathe * 0.75)} bold>
        {props.isWorking && breathe > 0.5 ? '●' : pie(props.used)}
      </Text>
      {props.hideBar ? null : <Text bold>Weekly</Text>}
      {props.hideBar ? null : <Text>
        {runs(cells(props, frame)).map(c => (
          <Text
            color={c.color}
            backgroundColor={c.backgroundColor}
            dimColor={c.dim}
            bold={c.bold}
          >
            {c.ch}
          </Text>
        ))}
      </Text>}
      <Text color={hex(accent)} bold dimColor={props.staleFor !== null}>
        {`${props.used}%`}
      </Text>
      {badge === null || props.hideBar ? null : (
        <Text color="inverseText" backgroundColor={badge.backgroundColor} bold>
          {badge.label}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {details}
      </Text>
    </Box>
  )
}

export default Gauge
