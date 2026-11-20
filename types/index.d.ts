/** The last `seven_day` rate-limit reading the mod saw. */
export type Reading = {
  /** 0 to 100, as the API reports it. */
  percentUsed: number
  /** When the weekly window resets, ISO 8601; null when not reported. */
  resetsAt: string | null
  /** When the reading was taken, in `$.clock.now()` milliseconds. */
  at: number
  /** True when carried over from an earlier session, not yet refreshed. */
  isStale: boolean
}

/** One model's own weekly limit, from the account's usage endpoint. */
export type ModelReading = {
  name: string
  percentUsed: number
  resetsAt: string | null
  at: number
}

/** A background task the mod saw start and has not yet seen end. */
export type BgTask = { toolUseId: string | null; taskId: string | null; at: number }

/** What the hooks module hands the animated gauge (`hooks/gauge.tsx`). */
export type GaugeProps = {
  /** Percent of the weekly limit used, 0 to 100. */
  used: number
  /** Percent of the week gone, where the reset time is known. */
  gone: number | null
  pace: 'ahead' | 'on' | 'under' | null
  /** "3d 14h", where the reset time is known. */
  resetIn: string | null
  /** "2h 5m" when the reading is carried over from an earlier session. */
  staleFor: string | null
  /** A turn is running: the gauge pulses. */
  isWorking: boolean
  /** The bar is drawn outside (desktop SVG): leave out label and bar. */
  hideBar?: boolean
  /** Bar width in cells. */
  width: number
}

declare module 'claude-code' {
  interface PluginState {
    'goldbar': { reading: Reading | null; fable: ModelReading | null; session: ModelReading | null; background: number; tasks: BgTask[] }
  }
}
