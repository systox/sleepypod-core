/**
 * Tonight's curve for a side, read from the same schedule rows the scheduler
 * reads, and the one-night copy of it handed to run-once.
 */
import { nightDay, type NightPower } from '@/src/lib/nightDay'
import { DAYS_OF_WEEK, hhmmToMinutes, type DayOfWeek } from '@/src/lib/scheduleTime'
import { weeklyWindow, weeklyZone } from '@/src/scheduler/occurrences'

const DAY_MIN = 24 * 60
const MINUTE = 60_000
const MAX_POINTS = 96
const MAX_SESSION_MS = 14 * 60 * MINUTE
/** A rewrite never schedules a point this close: a time already past rolls to tomorrow. */
const NEXT_POINT_MARGIN_MS = 90_000

export interface CurveRow { dayOfWeek: DayOfWeek, time: string, temperature: number }
export interface PowerRow extends NightPower { dayOfWeek: DayOfWeek, onTemperature: number }

export interface CurvePoint {
  /** Minutes after the curve's first point. */
  offset: number
  temperature: number
}

export interface Curve {
  day: DayOfWeek
  bedtime: number
  points: CurvePoint[]
}

export interface TonightWindow {
  curve: Curve
  windowStart: number
  windowEnd: number
}

export interface WindowHours { hoursEarly: number, hoursLate: number }

/** A saved day's curve as minutes from its first point. Points outside on-to-off never ran. */
export function curvePoints(temps: CurveRow[], power: PowerRow): CurvePoint[] {
  const start = hhmmToMinutes(power.onTime)
  const span = (hhmmToMinutes(power.offTime) - start + DAY_MIN) % DAY_MIN
  const byOffset = new Map<number, number>([[0, power.onTemperature]])
  for (const row of temps) {
    if (row.dayOfWeek !== power.dayOfWeek) continue
    const offset = (hhmmToMinutes(row.time) - start + DAY_MIN) % DAY_MIN
    if (offset <= span) byOffset.set(offset, row.temperature)
  }
  return [...byOffset].map(([offset, temperature]) => ({ offset, temperature })).sort((a, b) => a.offset - b.offset)
}

export function temperatureAt(points: CurvePoint[], position: number): number {
  let temperature = points[0].temperature
  for (const point of points) {
    if (point.offset > position) break
    temperature = point.temperature
  }
  return temperature
}

/** Every recent and coming bedtime for the saved curves, oldest first. */
function occurrences(temps: CurveRow[], powers: PowerRow[], timezone: string, now: number): Curve[] {
  const zone = weeklyZone(now, timezone)
  const out: Curve[] = []
  for (const power of powers) {
    const points = curvePoints(temps, power)
    const [hour, minute] = power.onTime.split(':').map(Number)
    const fires = DAYS_OF_WEEK.indexOf(nightDay(power.dayOfWeek, power.onTime, power))
    const { startsAt, expiresAt } = weeklyWindow(zone, fires, hour, minute, now)
    for (const bedtime of [startsAt, expiresAt]) {
      if (Number.isFinite(bedtime)) out.push({ day: power.dayOfWeek, bedtime, points })
    }
  }
  return out.sort((a, b) => a.bedtime - b.bedtime)
}

const windowOf = (curve: Curve, hours: WindowHours): TonightWindow => ({
  curve,
  windowStart: curve.bedtime - hours.hoursEarly * 60 * MINUTE,
  windowEnd: curve.bedtime + hours.hoursLate * 60 * MINUTE,
})

/**
 * The window `now` falls in, nearest bedtime first, or null between windows,
 * and the next one to open. Together because both need the same expensive
 * zone table, and the Tonight page asks every few seconds.
 */
export function windowsAround(temps: CurveRow[], powers: PowerRow[], timezone: string, now: number, hours: WindowHours): { window: TonightWindow | null, next: TonightWindow | null } {
  const windows = occurrences(temps, powers, timezone, now).map(curve => windowOf(curve, hours))
  const open = windows
    .filter(w => now >= w.windowStart && now < w.windowEnd)
    .sort((a, b) => Math.abs(a.curve.bedtime - now) - Math.abs(b.curve.bedtime - now))
  const coming = windows.filter(w => w.windowStart > now).sort((a, b) => a.windowStart - b.windowStart)
  return { window: open[0] ?? null, next: coming[0] ?? null }
}

function clockIn(timezone: string, at: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at))
  const value = (type: string) => parts.find(p => p.type === type)?.value ?? '00'
  return `${value('hour').padStart(2, '0')}:${value('minute').padStart(2, '0')}`
}

export interface TonightCopy {
  setPoints: Array<{ time: string, temperature: number }>
  wakeTime: string
  endsAt: number
}

function thin<T>(points: T[], limit: number): T[] {
  if (points.length <= limit) return points
  const step = (points.length - 1) / (limit - 1)
  return Array.from({ length: limit }, (_, i) => points[Math.round(i * step)])
}

/**
 * The one-night copy. `curveZeroAt` is the moment the curve's first point
 * falls on: in the past for a run under way, ahead while someone waits for
 * bedtime. It always runs forward from now, stays within run-once's limits,
 * and its last temperature holds until `endsAt`.
 */
export function buildCopy(points: CurvePoint[], curveZeroAt: number, now: number, endsAt: number, timezone: string): TonightCopy {
  const end = Math.min(endsAt, now + MAX_SESSION_MS)
  const position = (now - curveZeroAt) / MINUTE
  const start = position >= 0 ? temperatureAt(points, position) : points[0].temperature
  const ahead = points
    .map(p => ({ at: curveZeroAt + p.offset * MINUTE, temperature: p.temperature }))
    .filter(p => p.at >= now + NEXT_POINT_MARGIN_MS && p.at < end)
  const setPoints = [{ time: clockIn(timezone, now), temperature: start }]
  for (const point of thin(ahead, MAX_POINTS - 1)) {
    const time = clockIn(timezone, point.at)
    const last = setPoints[setPoints.length - 1]
    if (time === last.time) last.temperature = point.temperature
    else if (point.temperature !== last.temperature) setPoints.push({ time, temperature: point.temperature })
  }
  return { setPoints, wakeTime: clockIn(timezone, end), endsAt: end }
}
