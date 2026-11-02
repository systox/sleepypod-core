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
  detectionLive: boolean
  smartSides: Record<Side, boolean>
  personPower: Map<Side, PersonPowerMark>
}

const globalRuntime = globalThis as typeof globalThis & { __sp_forkRuntime?: ForkRuntime }

export const runtime: ForkRuntime = globalRuntime.__sp_forkRuntime ??= {
  running: false,
  disabled: null,
  lastBeat: 0,
  sensorsOkAt: 0,
  ownershipStaleMs: 2 * 60_000,
  detectionLive: false,
  smartSides: { left: false, right: false },
  personPower: new Map(),
}

/**
 * True while Smart start owns a side, so sleepypod's automatic power-ons skip
 * it. Needs the service reporting and sensor data arriving: if either stops,
 * the weekly schedule takes the side back within 2 minutes.
 */
export function smartOwnsSide(side: Side, now = Date.now()): boolean {
  return runtime.running
    && !runtime.disabled
    && runtime.detectionLive
    && runtime.smartSides[side]
    && now - runtime.lastBeat < runtime.ownershipStaleMs
    && now - runtime.sensorsOkAt < runtime.ownershipStaleMs
}

/** A person turned a side on or off. Sleepypod doesn't otherwise record who did. */
export function markPersonPower(side: Side, on: boolean, at = Date.now()): void {
  runtime.personPower.set(side, { on, at })
}

export function takePersonPower(side: Side): PersonPowerMark | null {
  const mark = runtime.personPower.get(side)
  runtime.personPower.delete(side)
  return mark ?? null
}
