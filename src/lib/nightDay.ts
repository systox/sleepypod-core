import { DAYS_OF_WEEK, hhmmToMinutes, type DayOfWeek } from '@/src/lib/scheduleTime'

const NOON = 12 * 60
const DAY = 24 * 60

/** A side's power row for one day: the clock times that frame a saved curve. */
export interface NightPower {
  onTime: string
  offTime: string
}

/**
 * A saved curve's points in the order they run, as minutes from midnight of
 * the day it's saved under. With no power row to go on, the longest stretch
 * without a point is when the side is off, so the curve starts just after it.
 */
export function nightOrder<T extends { minutes: number }>(timeline: T[]): T[] {
  const byClock = timeline.map(p => ({ ...p, minutes: p.minutes % DAY })).sort((a, b) => a.minutes - b.minutes)
  const gapBefore = (i: number) => (byClock[i].minutes - byClock[(i + byClock.length - 1) % byClock.length].minutes + DAY) % DAY
  const start = byClock.reduce((best, _, i) => (gapBefore(i) > gapBefore(best) ? i : best), 0)
  const first = byClock[start]?.minutes
  return [...byClock.slice(start), ...byClock.slice(0, start)].map(p => ({
    ...p,
    minutes: p.minutes + (first < NOON ? DAY : 0) + (p.minutes < first ? DAY : 0),
  }))
}

/**
 * A curve belongs to the night of the day it's saved under, so a time in it
 * can fall on the next calendar day: Monday's 22:30 curve reaches 02:00 on
 * Tuesday, and Monday's 04:00 curve is early Tuesday. A row with no power row
 * beside it isn't part of a curve and keeps its own weekday.
 */
export function runsNextDay(time: string, power: NightPower | null | undefined): boolean {
  if (!power) return false
  const start = hhmmToMinutes(power.onTime)
  if (start < NOON) return true
  const at = hhmmToMinutes(time)
  return at < NOON || (hhmmToMinutes(power.offTime) < start && at <= hhmmToMinutes(power.offTime))
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
