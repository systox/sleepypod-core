/**
 * Surface range: keeps the cover's surface between two temperatures by adding
 * a small offset to whatever the curve asks for. Watch only logs what it would
 * do. A hold someone set is left alone, and the offset clears as soon as the
 * side reads empty or goes off, so it never carries into another night.
 */
import { gte } from 'drizzle-orm'
import { biometricsDb } from '@/src/db'
import { bedTemp } from '@/src/db/biometrics-schema'
import { MIN_TEMP, type Side } from '@/src/hardware/types'
import { getTemperatureController } from '@/src/temperature/instance'
import { awayHalfOf, bedOwnerOf } from './oneSide'
import { bedPresenceOf, presenceOf, sensorsFresh } from './presence/collector'
import { runtime } from './runtime'
import { getSideSettings } from './settings'
import { logEvent } from './store'

const MINUTE = 60_000
const READING_WINDOW_MS = 10 * MINUTE

interface SurfaceState {
  offset: number
  stepAt: number
  /** The side's warmest allowed, so the offset can't carry the curve past it. */
  warmest: number
  /** False in watch mode: the offset is only what On would have reached. */
  live: boolean
}

const globalSurface = globalThis as typeof globalThis & { __sp_forkSurface?: Map<Side, SurfaceState> }
const surfaces = globalSurface.__sp_forkSurface ??= new Map<Side, SurfaceState>()

const centiToF = (centi: number): number => centi / 100 * 9 / 5 + 32

/** The side's surface: the median over 10 minutes of its three zones' mean, or null with no readings. */
export function readSurface(side: Side, now = Date.now()): number | null {
  const zones = side === 'left'
    ? { o: bedTemp.leftOuterTemp, c: bedTemp.leftCenterTemp, n: bedTemp.leftInnerTemp }
    : { o: bedTemp.rightOuterTemp, c: bedTemp.rightCenterTemp, n: bedTemp.rightInnerTemp }
  const rows = biometricsDb.select(zones).from(bedTemp).where(gte(bedTemp.timestamp, new Date(now - READING_WINDOW_MS))).all()
  const values = rows.flatMap((row) => {
    const known = [row.o, row.c, row.n].filter((z): z is number => z !== null)
    return known.length > 0 ? [centiToF(known.reduce((a, b) => a + b, 0) / known.length)] : []
  }).sort((a, b) => a - b)
  return values.length > 0 ? values[Math.floor(values.length / 2)] : null
}

export function surfaceOffset(side: Side): number {
  const state = surfaces.get(side)
  return runtime.running && state?.live ? state.offset : 0
}

/** The hook in sleepypod's baseline read. Alarms keep their own temperatures. */
export function withSurfaceOffset<T extends { id: string, temperature: number }>(side: Side, requests: T[]): T[] {
  const offset = surfaceOffset(side)
  if (offset === 0) return requests
  const warmest = surfaces.get(side)?.warmest ?? Infinity
  return requests.map((request) => {
    if (request.id.startsWith('alarm:')) return request
    const moved = request.temperature + offset
    const temperature = offset > 0 ? Math.min(moved, Math.max(request.temperature, warmest)) : Math.max(moved, Math.min(request.temperature, MIN_TEMP))
    return { ...request, temperature }
  })
}

export function surfaceView(side: Side, now = Date.now()): { reading: number | null, offset: number } {
  const reading = readSurface(side, now)
  return { reading: reading === null ? null : Math.round(reading * 10) / 10, offset: surfaces.get(side)?.offset ?? 0 }
}

function clear(side: Side): void {
  const state = surfaces.get(side)
  if (!state) return
  surfaces.delete(side)
  if (state.offset !== 0) logEvent(side, state.live ? 'surface-clear' : 'surface-watch-clear', { offset: state.offset })
}

/** One check: step the offset 1°F toward the range, no faster than the side's step time. */
export async function stepSurface(side: Side, now = Date.now()): Promise<void> {
  const settings = getSideSettings(side)
  // The empty half of a one-side bed takes the home side's offset with its plan.
  if (settings.surfaceMode === 'off' || bedOwnerOf(side) !== side) return clear(side)
  const controller = getTemperatureController()
  const status = controller.status(side)
  const occupied = sensorsFresh(now) ? bedPresenceOf(side).occupied : null
  if (status.blocked !== null || occupied === false) return clear(side)
  // Sensors blind, or someone chose a temperature: leave everything as it is.
  if (occupied !== true || status.source === 'manual') return
  const live = settings.surfaceMode === 'on'
  const state = surfaces.get(side) ?? { offset: 0, stepAt: 0, warmest: settings.warmestF, live }
  // Switching between Watch and On starts again from the curve.
  const current = state.live === live ? state : { offset: 0, stepAt: 0, warmest: settings.warmestF, live }
  if (now - current.stepAt < settings.surfaceStepMinutes * MINUTE) return
  const surface = readSurface(surfaceHalfOf(side), now)
  const target = controller.baselineTarget(side)
  if (surface === null || target === null) return
  const want = surface < settings.surfaceLowF ? 1 : surface > settings.surfaceHighF ? -1 : 0
  if (want === 0) return
  const offset = Math.max(-settings.surfaceMaxOffsetF, Math.min(settings.surfaceMaxOffsetF, current.offset + want))
  // In watch mode the target holds no offset, so the limit counts the one On would have added.
  const reached = live ? target : target + current.offset
  if (offset === current.offset || (want > 0 && reached >= settings.warmestF) || (want < 0 && reached <= MIN_TEMP)) return
  surfaces.set(side, { offset, stepAt: now, warmest: settings.warmestF, live })
  logEvent(side, live ? 'surface-step' : 'surface-watch', { surface: Math.round(surface * 10) / 10, curve: live ? target - current.offset : target, offset }, now)
  if (live) await controller.reconcile(side)
}

/** The half whose surface the sleeper is on: on a one-side bed, the empty half when only it shows them. */
function surfaceHalfOf(side: Side): Side {
  const away = awayHalfOf(side)
  if (away === null || presenceOf(side).occupied === true) return side
  return presenceOf(away).occupied === true ? away : side
}

/** Forget a half's offset, when the half stops having a plan of its own. */
export function clearSurface(side: Side): void {
  clear(side)
}

export function clearSurfaces(): void {
  surfaces.clear()
}
