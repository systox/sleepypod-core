import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'

const NOON = 12 * 60

/** A side's power row for one day: the clock times that frame a saved curve. */
export interface NightPower {
  onTime: string
  offTime: string
}

function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

/** A curve that starts before noon runs the morning after the day it's saved under. */
export function startsBeforeNoon(minutes: number): boolean {
  return minutes < NOON
}

/**
 * A curve belongs to the night of the day it's saved under, so a time in it
 * can fall on the next calendar day: Monday's 22:30 curve reaches 02:00 on
 * Tuesday, and Monday's 04:00 curve is early Tuesday. A row with no power row
 * beside it isn't part of a curve and keeps its own weekday.
 */
export function runsNextDay(time: string, power: NightPower | null | undefined): boolean {
  if (!power) return false
  const start = toMinutes(power.onTime)
  if (startsBeforeNoon(start)) return true
  const at = toMinutes(time)
  return startsBeforeNoon(at) || (toMinutes(power.offTime) < start && at <= toMinutes(power.offTime))
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
