/**
 * Turns a side back on after the Pod loses power during its curve.
 *
 * The scheduler turns a side on only when its start time fires and never
 * replays a start it missed, so a side that was on when the power went would
 * stay off until the next night. Each side's power is noted here as it
 * changes. Once the firmware reports in after a restart, a side that was on
 * when last seen, is off now and is still inside its power window comes back
 * on through the scheduler's own start, so every guard it applies still holds.
 * The controller then sets the curve's point for the current time.
 *
 * A side someone turned off before the cut was noted as off, so it stays off.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState, powerSchedules } from '@/src/db/schema'
import { hasFirmwareSynced } from '@/src/hardware/deviceStateSync'
import type { Side } from '@/src/hardware/types'
import { nightDay } from '@/src/lib/nightDay'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { getJobManager } from '@/src/scheduler/instance'
import { weeklyWindow, weeklyZone } from '@/src/scheduler/occurrences'
import { deviceTimezone } from './clock'
import { getPodSettings } from './settings'
import { logEvent, readKey, writeKey } from './store'

const SIDES: Side[] = ['left', 'right']
const SEEN_KEY = 'power-seen'
const RESUMED_KEY = 'power-resumed'
/** A power-on that throws, say just after boot, is tried this many times, one tick apart. */
const MAX_ATTEMPTS = 4
/** The Pod can boot with its clock near 2010 until it syncs; before this the time is not trusted. */
const EARLIEST_TRUSTED = Date.UTC(2025, 0, 1)

type PowerRow = typeof powerSchedules.$inferSelect
type Seen = Partial<Record<Side, { powered: boolean, at: number }>>

const globalResume = globalThis as typeof globalThis & { __sp_forkPowerResume?: { checked: boolean, attempts: number } }
const resume = globalResume.__sp_forkPowerResume ??= { checked: false, attempts: 0 }

function poweredNow(side: Side): boolean {
  return Boolean(db.select({ isPowered: deviceState.isPowered }).from(deviceState).where(eq(deviceState.side, side)).get()?.isPowered)
}

/** The power row that started most recently, if its window still holds `now`. */
export function activePowerRow(rows: PowerRow[], timezone: string, now: number): PowerRow | null {
  const zone = weeklyZone(now, timezone)
  const latest = (day: DayOfWeek, time: string) => {
    const [hour, minute] = time.split(':').map(Number)
    return weeklyWindow(zone, DAYS_OF_WEEK.indexOf(day), hour, minute, now).startsAt
  }
  let best: { row: PowerRow, on: number } | null = null
  for (const row of rows) {
    const on = latest(row.dayOfWeek, row.onTime)
    if (!best || on > best.on) best = { row, on }
  }
  if (!best || !Number.isFinite(best.on)) return null
  const { row } = best
  const off = row.endAction === 'maintain' ? -Infinity : latest(nightDay(row.dayOfWeek, row.offTime, row), row.offTime)
  return best.on > off ? row : null
}

/** Called each tick. Checks once after a restart, then notes each side's power as it changes. */
export async function syncPowerResume(now = Date.now()): Promise<void> {
  if (!hasFirmwareSynced()) return
  // Until the clock is right, both the window and the times noted are guesses.
  if (now < EARLIEST_TRUSTED) return
  const seen = readKey<Seen>(SEEN_KEY) ?? {}
  if (!resume.checked) {
    if (SIDES.some(side => (seen[side]?.at ?? 0) > now)) return
    resume.attempts++
    const failed = getPodSettings().resumeAfterPowerCut && !(await resumeSides(seen, now))
    resume.checked = !failed || resume.attempts >= MAX_ATTEMPTS
    // Power isn't noted until the check is done, so a retry still sees how it was before the restart.
    if (!resume.checked) return
  }
  let changed = false
  for (const side of SIDES) {
    const powered = poweredNow(side)
    if (seen[side]?.powered === powered) continue
    seen[side] = { powered, at: now }
    changed = true
  }
  if (changed) writeKey(SEEN_KEY, seen)
}

/** False if a power-on failed and is worth trying again. */
async function resumeSides(seen: Seen, now: number): Promise<boolean> {
  const timezone = deviceTimezone()
  let ok = true
  for (const side of SIDES) {
    if (!seen[side]?.powered || poweredNow(side)) continue
    const rows = db.select().from(powerSchedules).where(and(eq(powerSchedules.side, side), eq(powerSchedules.enabled, true))).all()
    const row = activePowerRow(rows, timezone, now)
    if (!row) continue
    try {
      await (await getJobManager()).runPowerOnJob(row)
      if (!poweredNow(side)) continue
      logEvent(side, 'power-resumed', { lastSeenOn: seen[side]?.at ?? null, scheduleId: row.id }, now)
      writeKey(RESUMED_KEY, { ...readKey<Partial<Record<Side, number>>>(RESUMED_KEY), [side]: now })
      console.log(`[fork] ${side} was on before the Pod restarted and its curve is still running, so it is back on`)
    }
    catch (error) {
      ok = false
      console.warn(`[fork] ${side} power resume failed:`, error instanceof Error ? error.message : error)
    }
  }
  return ok
}

/** When each side last came back on after a restart, for the Tonight page. */
export function powerResumedAt(side: Side): number | null {
  return readKey<Partial<Record<Side, number>>>(RESUMED_KEY)?.[side] ?? null
}

/** For tests: check again as if just restarted. */
export function resetPowerResume(): void {
  resume.checked = false
  resume.attempts = 0
}
