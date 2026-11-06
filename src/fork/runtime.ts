/**
 * In-memory service state. Sits on globalThis because Turbopack can load
 * several module instances, and it imports nothing heavy so upstream code can
 * ask about it from hot paths.
 */
import type { Side } from '@/src/hardware/types'

export interface PersonPowerMark {
  on: boolean
  at: number
}

interface ForkRuntime {
  running: boolean
  disabled: string | null
  lastBeat: number
  sensorsOkAt: number
  ownershipStaleMs: number
  detectionOn: boolean
  detectionLive: boolean
  /** Whether Smart start governs a side, read from the bed as it is when asked. The service sets it. */
  smartFor: (side: Side) => boolean
  personPower: Map<Side, PersonPowerMark>
  /** Halves with a button press waiting to settle: the firmware's move there is still being measured. */
  pressing: Set<Side>
}

const PERSON_MARK_FRESH_MS = 2 * 60_000

const globalRuntime = globalThis as typeof globalThis & { __sp_forkRuntime?: ForkRuntime }

export const runtime: ForkRuntime = globalRuntime.__sp_forkRuntime ??= {
  running: false,
  disabled: null,
  lastBeat: 0,
  sensorsOkAt: 0,
  ownershipStaleMs: 2 * 60_000,
  detectionOn: false,
  detectionLive: false,
  smartFor: () => false,
  personPower: new Map(),
  pressing: new Set(),
}
// A server reloaded in place keeps the runtime made before this field existed.
runtime.pressing ??= new Set()

/**
 * True while Smart start owns a side, so sleepypod's automatic power-ons skip
 * it. Needs the service reporting and sensor data arriving: if either stops,
 * the weekly schedule takes the side back within 2 minutes.
 */
export function smartOwnsSide(side: Side, now = Date.now()): boolean {
  return runtime.running
    && !runtime.disabled
    && runtime.detectionLive
    && now - runtime.lastBeat < runtime.ownershipStaleMs
    && now - runtime.sensorsOkAt < runtime.ownershipStaleMs
    && runtime.smartFor(side)
}

/** A person turned a side on or off. Sleepypod doesn't otherwise record who did. */
export function markPersonPower(side: Side, on: boolean, at = Date.now()): void {
  runtime.personPower.set(side, { on, at })
}

/** The side's latest mark, if it's fresh. An old one says nothing about now. */
export function takePersonPower(side: Side, now = Date.now()): PersonPowerMark | null {
  const mark = runtime.personPower.get(side)
  runtime.personPower.delete(side)
  return mark && now - mark.at <= PERSON_MARK_FRESH_MS ? mark : null
}
