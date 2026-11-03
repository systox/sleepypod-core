/**
 * Self-test nights: two versions of a curve take turns, night by night, on
 * the days either one already runs. The rotation still decides which days
 * those are; this only swaps one for the other, so turning it off puts A back.
 * Today's row is never touched, because its night may already be running.
 */
import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { curveTemplates } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import { hasDays, type CurveDays } from '@/src/lib/scheduleLibrary'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { applySchedulerOps, curveDays, emptySchedulerOps, writeSide } from '@/src/server/scheduleLibrary'
import { deviceTimezone } from './clock'
import { eventsSince, nightEnd, nightRecords } from './nights'
import { getSideSettings } from './settings'
import { logEvent, readKey, removeKey, writeKey } from './store'

const DAY_MS = 86_400_000
const SUMMARY_DAYS = 60

interface Pair { a: number, b: number }

const pairKey = (side: Side) => `self-test:${side}`

/** Days since 1970 of the local date `days` after `now`'s, and that date's weekday. */
function localDay(now: number, zone: string, days: number): { number: number, day: DayOfWeek } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now)).map(p => [p.type, Number(p.value)]))
  const number = Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS + days
  return { number, day: DAYS_OF_WEEK[new Date(number * DAY_MS).getUTCDay()] }
}

/** The curve each day after today should run: A on even dates, B on odd ones, on days either holds. */
export function plannedDays(current: Partial<Record<DayOfWeek, number>>, pair: Pair, now: number, zone: string): Array<{ day: DayOfWeek, curveId: number }> {
  const out: Array<{ day: DayOfWeek, curveId: number }> = []
  for (let ahead = 1; ahead < 7; ahead++) {
    const { number, day } = localDay(now, zone, ahead)
    const holds = current[day]
    if (holds !== pair.a && holds !== pair.b) continue
    const want = number % 2 === 0 ? pair.a : pair.b
    if (holds !== want) out.push({ day, curveId: want })
  }
  return out
}

function currentDays(side: Side, rows: Array<typeof curveTemplates.$inferSelect>): Partial<Record<DayOfWeek, number>> {
  const out: Partial<Record<DayOfWeek, number>> = {}
  for (const row of rows) {
    if (!row.active) continue
    for (const day of curveDays(row)[side]) out[day] = row.id
  }
  return out
}

async function move(side: Side, changes: Array<{ day: DayOfWeek, curveId: number }>): Promise<void> {
  if (changes.length === 0) return
  const ops = emptySchedulerOps()
  db.transaction((tx) => {
    const rows = tx.select().from(curveTemplates).all()
    const days = new Map<number, CurveDays>(rows.map(r => [r.id, curveDays(r)]))
    const touched = new Set<number>()
    for (const { day, curveId } of changes) {
      const curve = rows.find(r => r.id === curveId)
      if (!curve) continue
      for (const [id, held] of days) {
        if (id !== curveId && held[side].includes(day)) {
          days.set(id, { ...held, [side]: held[side].filter(d => d !== day) })
          touched.add(id)
        }
      }
      const own = days.get(curveId) as CurveDays
      days.set(curveId, { ...own, [side]: [...own[side], day] })
      touched.add(curveId)
      writeSide(tx, curve, side, [day], [], ops)
    }
    for (const id of touched) {
      const held = days.get(id) as CurveDays
      tx.update(curveTemplates).set({ leftDays: held.left, rightDays: held.right, active: hasDays(held) }).where(eq(curveTemplates.id, id)).run()
    }
  })
  await applySchedulerOps(ops)
  logEvent(side, 'self-test-days', { changes })
}

export async function syncSelfTest(side: Side, now = Date.now()): Promise<void> {
  const settings = getSideSettings(side)
  const saved = readKey<Pair>(pairKey(side))
  const a = settings.selfTestCurveA
  const b = settings.selfTestCurveB
  const pair = settings.selfTestOn && a !== null && b !== null && a !== b ? { a, b } : null
  const rows = db.select().from(curveTemplates).all()
  const zone = deviceTimezone()

  // A changed or finished test first gives its B days back to its A.
  if (saved && (!pair || saved.a !== pair.a || saved.b !== pair.b)) {
    const current = currentDays(side, rows)
    const today = localDay(now, zone, 0).day
    const back = DAYS_OF_WEEK.filter(day => day !== today && current[day] === saved.b).map(day => ({ day, curveId: saved.a }))
    await move(side, back)
    // Today's row goes back once it's no longer today, so the old test finishes first.
    if (current[today] === saved.b) return
    removeKey(pairKey(side))
    if (!pair) return
  }
  if (!pair || !rows.some(r => r.id === pair.a) || !rows.some(r => r.id === pair.b)) return
  writeKey(pairKey(side), pair)
  await move(side, plannedDays(currentDays(side, db.select().from(curveTemplates).all()), pair, now, zone))
}

export interface SelfTestCurve { curveId: number, name: string | null, nights: number, pressesPerNight: number, outsPerNight: number }

/** How each curve's nights went: presses and times out of bed. */
export function selfTestSummary(side: Side, now = Date.now()): SelfTestCurve[] {
  const settings = getSideSettings(side)
  const ids = [settings.selfTestCurveA, settings.selfTestCurveB].filter((id): id is number => id !== null)
  const events = eventsSince(now - SUMMARY_DAYS * DAY_MS, now)
  const nights = nightRecords(events, side)
  return ids.map((curveId) => {
    let count = 0
    let presses = 0
    let outs = 0
    nights.forEach((night, i) => {
      if (night.curveId !== curveId) return
      const end = nightEnd(nights, i, settings.backstopHours)
      if (end > now) return
      count += 1
      for (const e of events) {
        if (e.side !== side || e.ts < night.bedtime || e.ts >= end) continue
        if (e.kind === 'press') presses += 1
        if (e.kind === 'out') outs += 1
      }
    })
    const name = nights.find(n => n.curveId === curveId)?.curveName ?? null
    return { curveId, name, nights: count, pressesPerNight: count ? presses / count : 0, outsPerNight: count ? outs / count : 0 }
  })
}
