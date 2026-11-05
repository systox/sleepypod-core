/**
 * In-bed detection, one step a minute. A change needs weight and vibration to
 * agree for several straight minutes: weight alone can fall while someone is
 * awake and still in bed, and vibration alone drops when a sleeper lies still
 * and rises on an empty side when the other person moves.
 *
 * Empty levels drift, so each side's level is relearned, but only on proof
 * that the bed is empty: fresh readings with almost no vibration on both
 * sides. Missing data never counts as empty.
 */
import type { Side } from '@/src/hardware/types'

const SIDES: Side[] = ['left', 'right']
const VIBRATION_WINDOW = 5
const MIN_VIBRATION_SAMPLES = 3
const EMPTY_PROOF_MINUTES = 5
const MINUTE = 60_000
export const DEFAULT_EMPTY_LEVEL: Record<Side, number> = { left: 5125, right: 5150 }

export interface PresenceSideConfig {
  minutesToCall: number
  weightRise: number
  vibrationLimit: number
  otherSideShare: number
}

export type PresenceConfig = Record<Side, PresenceSideConfig> & {
  /** Vibration below this on both sides proves the bed is empty. */
  emptyVibration: number
}

export interface MinuteReading {
  ts: number
  weight: Record<Side, number | null>
  vibration: Record<Side, number | null>
}

export interface SidePresence {
  occupied: boolean | null
  since: number | null
  /** Minutes in a row that weight and vibration have asked for a change. */
  run: number
  runSince: number | null
  emptyLevel: number
  vibration: number[]
}

export type PresenceState = Record<Side, SidePresence> & {
  emptyRun: number
  emptyWeights: Record<Side, number[]>
}

export interface PresenceEvent {
  side: Side
  kind: 'in' | 'out'
  at: number
}

export function initialPresence(): PresenceState {
  const side = (s: Side): SidePresence => ({
    occupied: null, since: null, run: 0, runSince: null, emptyLevel: DEFAULT_EMPTY_LEVEL[s], vibration: [],
  })
  return { left: side('left'), right: side('right'), emptyRun: 0, emptyWeights: { left: [], right: [] } }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function rollingVibration(side: SidePresence): number | null {
  return side.vibration.length >= MIN_VIBRATION_SAMPLES ? median(side.vibration) : null
}

/** Weight on a side, less what the other side's body presses onto it. */
function bodyWeight(state: PresenceState, reading: MinuteReading, side: Side, config: PresenceConfig): number | null {
  const own = reading.weight[side]
  if (own === null) return null
  const other: Side = side === 'left' ? 'right' : 'left'
  const otherWeight = reading.weight[other]
  if (otherWeight === null) return own
  return own - config[side].otherSideShare * Math.max(0, otherWeight - state[other].emptyLevel)
}

function learnEmptyLevels(state: PresenceState, reading: MinuteReading, config: PresenceConfig): PresenceState {
  const quiet = SIDES.every((s) => {
    const level = rollingVibration(state[s])
    return level !== null && level < config.emptyVibration && reading.weight[s] !== null
  })
  if (!quiet) return { ...state, emptyRun: 0, emptyWeights: { left: [], right: [] } }
  const emptyWeights = {
    left: [...state.emptyWeights.left, reading.weight.left as number].slice(-EMPTY_PROOF_MINUTES),
    right: [...state.emptyWeights.right, reading.weight.right as number].slice(-EMPTY_PROOF_MINUTES),
  }
  const emptyRun = state.emptyRun + 1
  if (emptyRun < EMPTY_PROOF_MINUTES) return { ...state, emptyRun, emptyWeights }
  return {
    ...state,
    emptyRun,
    emptyWeights,
    left: { ...state.left, emptyLevel: median(emptyWeights.left) },
    right: { ...state.right, emptyLevel: median(emptyWeights.right) },
  }
}

export function stepPresence(previous: PresenceState, reading: MinuteReading, config: PresenceConfig): { state: PresenceState, events: PresenceEvent[] } {
  let state: PresenceState = {
    ...previous,
    left: pushVibration(previous.left, reading.vibration.left),
    right: pushVibration(previous.right, reading.vibration.right),
  }
  state = learnEmptyLevels(state, reading, config)

  const events: PresenceEvent[] = []
  const next = { left: state.left, right: state.right }
  for (const side of SIDES) {
    const current = state[side]
    const weight = bodyWeight(state, reading, side, config)
    const vibration = rollingVibration(current)
    if (weight === null || vibration === null) continue
    const weightIn = weight > current.emptyLevel + config[side].weightRise
    const vibrationIn = vibration > config[side].vibrationLimit
    if (current.occupied === null) {
      next[side] = { ...current, occupied: weightIn && vibrationIn, since: reading.ts, run: 0, runSince: null }
      continue
    }
    const wantsChange = current.occupied ? !weightIn && !vibrationIn : weightIn && vibrationIn
    if (!wantsChange) {
      next[side] = { ...current, run: 0, runSince: null }
      continue
    }
    // Straight minutes only: a gap in the readings starts the count again, so a
    // call is never dated back across minutes nobody could see.
    const unbroken = current.runSince === null || reading.ts - current.runSince <= current.run * MINUTE
    const run = (unbroken ? current.run : 0) + 1
    const runSince = unbroken ? current.runSince ?? reading.ts : reading.ts
    if (run < config[side].minutesToCall) {
      next[side] = { ...current, run, runSince }
      continue
    }
    next[side] = { ...current, occupied: !current.occupied, since: runSince, run: 0, runSince: null }
    events.push({ side, kind: current.occupied ? 'out' : 'in', at: runSince })
  }
  return { state: { ...state, ...next }, events }
}

function pushVibration(side: SidePresence, value: number | null): SidePresence {
  return { ...side, vibration: value === null ? side.vibration : [...side.vibration, value].slice(-VIBRATION_WINDOW) }
}

/** "Bed is empty now" after changing bedding: take the current readings as empty. */
export function markEmpty(state: PresenceState, weight: Record<Side, number | null>, ts: number): PresenceState {
  const side = (s: Side): SidePresence => ({
    ...state[s],
    occupied: false,
    since: ts,
    run: 0,
    runSince: null,
    emptyLevel: weight[s] ?? state[s].emptyLevel,
  })
  return { ...state, left: side('left'), right: side('right') }
}
