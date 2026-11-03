/**
 * What a change to the temperature does next: how long it holds, and how the
 * bed gets back to the curve afterwards.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState, powerSchedules, runOnceSessions, temperatureSchedules } from '@/src/db/schema'
import { nightRows, type NightPower } from '@/src/lib/nightDay'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { weeklyWindow, weeklyZone } from '@/src/scheduler/occurrences'
import { timeToDate } from '@/src/scheduler/timeUtils'
import { fahrenheitToLevel, type Side } from '@/src/hardware/types'
import { withSideLock } from '@/src/hardware/sideLock'
import { MAX_HOLD_MS } from '@/src/temperature/controller'
import { getTemperatureController } from '@/src/temperature/instance'
import { deviceTimezone } from './clock'
import { observeMiddle } from './middleButton'
import { noteSmartPress } from './smart/runner'
import { runtime } from './runtime'
import { getPodSettings, getSideSettings } from './settings'
import { logEvent } from './store'

const MINUTE = 60_000
const FALLBACK_NEXT_CHANGE_MS = 30 * MINUTE
/** A step goes out this close to a hold's end. Wider than the service's tick. */
const STEP_LEAD_MS = 45_000
/** Sleepypod reads firmware level 0 as off, so a press never rests there. */
const STEP_OFF_NEUTRAL_F = 83

interface PressWait {
  timer: ReturnType<typeof setTimeout>
  wasOn: boolean
  buttons: string[]
}

interface Fade {
  startedAt: number
  holdUntil: number
}

const globalHolds = globalThis as typeof globalThis & {
  __sp_forkPresses?: Map<Side, PressWait>
  __sp_forkFades?: Map<Side, Fade>
}
const presses = globalHolds.__sp_forkPresses ??= new Map<Side, PressWait>()
const fades = globalHolds.__sp_forkFades ??= new Map<Side, Fade>()

/** Next time the curve changes temperature on a side, or null with nothing running. */
export function nextCurveChange(side: Side, now: number): number | null {
  const timezone = deviceTimezone()
  const session = db.select().from(runOnceSessions)
    .where(and(eq(runOnceSessions.side, side), eq(runOnceSessions.status, 'active'))).get()
  if (session) {
    const points = JSON.parse(session.setPoints) as Array<{ time: string }>
    const times = points.map(p => timeToDate(p.time, timezone, new Date(now)).getTime()).filter(t => t < session.expiresAt.getTime())
    return times.length > 0 ? Math.min(...times) : session.expiresAt.getTime()
  }
  const powers = db.select().from(powerSchedules).where(and(eq(powerSchedules.side, side), eq(powerSchedules.enabled, true))).all()
  const temps = db.select().from(temperatureSchedules).where(and(eq(temperatureSchedules.side, side), eq(temperatureSchedules.enabled, true))).all()
  if (temps.length === 0) return null
  const powerByDay = new Map<string, NightPower>(powers.map(p => [p.dayOfWeek, p]))
  const zone = weeklyZone(now, timezone)
  const current = getTemperatureController().baselineTarget(side)
  let next: number | null = null
  for (const row of nightRows(temps, powerByDay)) {
    if (row.temperature === current) continue
    const [hour, minute] = row.time.split(':').map(Number)
    const { expiresAt } = weeklyWindow(zone, DAYS_OF_WEEK.indexOf(row.dayOfWeek), hour, minute, now)
    if (Number.isFinite(expiresAt) && (next === null || expiresAt < next)) next = expiresAt
  }
  return next
}

/**
 * How long a change with no named length holds: the saved Hold after
 * adjustment, or with Off, until the curve's next change. Undefined keeps
 * sleepypod's own default, as it does whenever the service isn't running.
 */
export function defaultHoldMs(side: Side): number | undefined {
  if (!runtime.running) return undefined
  try {
    const minutes = getPodSettings().holdMinutes
    if (minutes > 0) return minutes * MINUTE
    const now = Date.now()
    const next = nextCurveChange(side, now)
    const ms = next === null ? FALLBACK_NEXT_CHANGE_MS : next - now
    return Math.round(Math.min(MAX_HOLD_MS, Math.max(MINUTE, ms)))
  }
  catch (error) {
    console.warn('[fork] hold length unavailable:', error instanceof Error ? error.message : error)
    return undefined
  }
}

function currentTarget(side: Side): number | null {
  return db.select({ target: deviceState.targetTemperature }).from(deviceState).where(eq(deviceState.side, side)).get()?.target ?? null
}

/**
 * Press bursts run together, so the hold waits for the last press in one.
 * Only the top and bottom buttons change temperature; the middle one has its
 * own gestures.
 */
export function observePress(frame: Record<string, unknown>): void {
  if (!runtime.running) return
  for (const side of ['left', 'right'] as const) {
    const press = frame[side] as { button?: string, type?: string, count?: number } | undefined
    if (press?.button === 'middle') {
      observeMiddle(side, press)
      continue
    }
    if (press?.button !== 'top' && press?.button !== 'bottom') continue
    const waiting = presses.get(side)
    if (waiting) clearTimeout(waiting.timer)
    const wasOn = waiting?.wasOn ?? getTemperatureController().status(side).blocked === null
    const buttons = [...(waiting?.buttons ?? []), press.button]
    const timer = setTimeout(() => {
      presses.delete(side)
      void settlePress(side, wasOn, buttons).catch((error) => {
        console.warn(`[fork] ${side} press failed:`, error instanceof Error ? error.message : error)
      })
    }, getPodSettings().pressWaitSeconds * 1000)
    timer.unref()
    presses.set(side, { timer, wasOn, buttons })
  }
}

export function clearPressWaits(): void {
  for (const wait of presses.values()) clearTimeout(wait.timer)
  presses.clear()
}

export async function settlePress(side: Side, wasOn: boolean, buttons: string[]): Promise<void> {
  logEvent(side, 'press', { buttons })
  if (!wasOn) {
    await noteSmartPress(side)
    return
  }
  const pod = getPodSettings()
  if (pod.holdMinutes === 0) return
  await withSideLock(side, async () => {
    const controller = getTemperatureController()
    // A hold can power a side on, so a press must not undo someone turning it off.
    if (controller.status(side).blocked === 'safety' || controller.turnedOff(side)) return
    const target = currentTarget(side)
    const landed = target === null || fahrenheitToLevel(Math.round(target)) === 0 ? STEP_OFF_NEUTRAL_F : Math.round(target)
    const temperature = Math.min(landed, getSideSettings(side).warmestF)
    await controller.setManualLocked(side, temperature, pod.holdMinutes * MINUTE)
  })
  fades.delete(side)
}

/** One Smooth return check: step the hold 1°F toward the curve as it's about to end. */
export async function stepSmoothReturn(side: Side, now = Date.now()): Promise<void> {
  const pod = getPodSettings()
  const controller = getTemperatureController()
  const status = controller.status(side)
  if (!pod.smoothReturn || status.source !== 'manual' || status.holdUntil === null || status.blocked !== null) {
    fades.delete(side)
    return
  }
  if (status.holdUntil - now > STEP_LEAD_MS) return
  const curve = controller.baselineTarget(side)
  const held = status.targetTemperature
  if (curve === null || held === null) return
  const fade = fades.get(side)
  // A hold the service didn't set is a new change, so its fade starts fresh.
  const current = fade?.holdUntil === status.holdUntil ? fade : { startedAt: now, holdUntil: status.holdUntil }
  if (Math.abs(curve - held) <= 1 || now - current.startedAt >= pod.smoothMaxHours * 60 * MINUTE) {
    fades.delete(side)
    return
  }
  const stepMs = Math.round(60 / pod.smoothRatePerHour * MINUTE)
  await withSideLock(side, async () => {
    const latest = controller.status(side)
    if (latest.holdUntil !== status.holdUntil || latest.blocked !== null) return
    const next = await controller.setManualLocked(side, held + Math.sign(curve - held), stepMs)
    fades.set(side, { startedAt: current.startedAt, holdUntil: next.holdUntil as number })
  })
}

/** A running fade: the curve it's easing back to, and when it should get there. */
export function fadeOf(side: Side, now = Date.now()): { curve: number, by: number } | null {
  if (!fades.has(side)) return null
  const controller = getTemperatureController()
  const curve = controller.baselineTarget(side)
  const held = controller.status(side).targetTemperature
  if (curve === null || held === null) return null
  return { curve, by: now + Math.abs(curve - held) * 60 / getPodSettings().smoothRatePerHour * MINUTE }
}
