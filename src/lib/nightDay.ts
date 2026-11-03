import { DAYS_OF_WEEK, hhmmToMinutes, type DayOfWeek } from '@/src/lib/scheduleTime'

const NOON = 12 * 60
const HALF_DAY = 12 * 60
const EVENING = 18 * 60
const DAY = 24 * 60

/** A side's power row for one day: the clock times that frame a saved curve. */
export interface NightPower {
  onTime: string
  offTime: string
}

/**
 * A saved curve's points in the order they run, as minutes from midnight of
 * the day it's saved under. With no power row to go on, a gap of 12 hours or
 * more is when the side is off, so the curve starts just after it. A curve
 * with no such gap runs over 12 hours. If its longest gap crosses midnight
 * that's the time off, and it's a day curve. Otherwise a flat stretch has
 * outlasted the time off, so it's an overnight curve, starting after 6 PM.
 */
export function nightOrder<T extends { minutes: number }>(timeline: T[]): T[] {
  const byClock = timeline.map(p => ({ ...p, minutes: p.minutes % DAY })).sort((a, b) => a.minutes - b.minutes)
  const gapBefore = (i: number) => (byClock[i].minutes - byClock[(i + byClock.length - 1) % byClock.length].minutes + DAY) % DAY
  const widest = byClock.reduce((best, _, i) => (gapBefore(i) > gapBefore(best) ? i : best), 0)
  const evening = byClock.findIndex(p => p.minutes >= EVENING)
  const start = widest === 0 || gapBefore(widest) >= HALF_DAY || evening < 0 ? widest : evening
  const first = byClock[start]?.minutes
  return [...byClock.slice(start), ...byClock.slice(0, start)].map(p => ({
    ...p,
    minutes: p.minutes + (p.minutes < first ? DAY : 0),
  }))
}

/**
 * A curve belongs to the day it starts, so a time in it can fall on the next
 * calendar day: Monday's 22:30 curve reaches 02:00 on Tuesday, while Monday's
 * 04:00 curve is all on Monday. A row with no power row beside it isn't part
 * of a curve and keeps its own weekday.
 */
export function runsNextDay(time: string, power: NightPower | null | undefined): boolean {
  if (!power) return false
  const start = hhmmToMinutes(power.onTime)
  const at = hhmmToMinutes(time)
  const off = hhmmToMinutes(power.offTime)
  return (off < start && at <= off) || (start >= NOON && at < NOON)
}

/** The weekday a time in a saved curve really fires on. */
export function nightDay(day: DayOfWeek, time: string, power: NightPower | null | undefined): DayOfWeek {
  if (!runsNextDay(time, power)) return day
  return DAYS_OF_WEEK[(DAYS_OF_WEEK.indexOf(day) + 1) % DAYS_OF_WEEK.length]
}

export function nightPowerKey(side: string, day: string): string {
  return `${side}:${day}`
}

/** Rows moved onto the weekday they fire on, given one side's power rows by day. */
export function nightRows<T extends { dayOfWeek: DayOfWeek, time: string }>(rows: T[], powerByDay: ReadonlyMap<string, NightPower>): T[] {
  return rows.map(row => ({ ...row, dayOfWeek: nightDay(row.dayOfWeek, row.time, powerByDay.get(row.dayOfWeek)) }))
}
