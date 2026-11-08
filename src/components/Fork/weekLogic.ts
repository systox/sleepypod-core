import type { SavedCurve } from '@/src/hooks/useCurveTemplates'
import { DAY_ORDER, DAY_SHORT, formatDayRange } from '@/src/components/Schedule/scheduleFormat'
import { hhmmToMinutes, type DayOfWeek } from '@/src/lib/scheduleTime'

export { DAY_SHORT }
export const WEEK_DAYS = DAY_ORDER

export type WeekDays = Record<DayOfWeek, number | null>
export const EMPTY_WEEK: WeekDays = {
  monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null,
}

const DAY_MIN = 24 * 60
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface Bar { top: number, height: number }

type BarCurve = Pick<SavedCurve, 'bedtime' | 'wake'>

const share = (minutes: number): number => minutes / DAY_MIN * 100
const runsPastMidnight = (curve: BarCurve): boolean => hhmmToMinutes(curve.wake) <= hhmmToMinutes(curve.bedtime)

/** What a day's bar, midnight to midnight, shows: the end of the day before's curve, then its own. */
export function barsFor(curve: BarCurve | undefined, before: BarCurve | undefined): Bar[] {
  const bars: Bar[] = []
  if (before && runsPastMidnight(before)) bars.push({ top: 0, height: share(hhmmToMinutes(before.wake)) })
  if (curve) {
    const start = hhmmToMinutes(curve.bedtime)
    const end = runsPastMidnight(curve) ? DAY_MIN : hhmmToMinutes(curve.wake)
    bars.push({ top: share(start), height: share(end - start) })
  }
  return bars
}

export function dayBars(days: WeekDays, day: DayOfWeek, curves: ReadonlyMap<number, BarCurve>): Bar[] {
  const curveOn = (d: DayOfWeek) => {
    const id = days[d]
    return id === null ? undefined : curves.get(id)
  }
  return barsFor(curveOn(day), curveOn(WEEK_DAYS[(WEEK_DAYS.indexOf(day) + 6) % 7]))
}

/** "Mon · Late Monday, Tue–Sun · Day shift". */
export function weekSummary(days: WeekDays, curves: ReadonlyMap<number, Pick<SavedCurve, 'name'>>): string {
  const parts: Array<{ id: number | null, days: DayOfWeek[] }> = []
  for (const day of WEEK_DAYS) {
    const last = parts[parts.length - 1]
    if (last && last.id === days[day]) last.days.push(day)
    else parts.push({ id: days[day], days: [day] })
  }
  return parts.map((part) => {
    const name = part.id === null ? 'No curve' : curves.get(part.id)?.name ?? 'Missing'
    return `${formatDayRange(part.days)} · ${name}`
  }).join(', ')
}

const localDate = (date: string): Date => new Date(`${date}T12:00:00`)
const shortDate = (d: Date): string => `${MONTHS[d.getMonth()]} ${d.getDate()}`

const isoDate = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The Monday of a date's week, as YYYY-MM-DD. */
export function mondayOf(now: Date): string {
  return isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7), 12))
}

/** The Monday `weeks` on from an anchor, as YYYY-MM-DD. */
export function anchorAfter(anchor: string, weeks: number): string {
  return isoDate(weekStart(anchor, weeks))
}

/** Which step of an order a week lands on. Weeks before the anchor count back. */
export function stepOf(week: number, steps: number): number {
  return ((week % steps) + steps) % steps
}

/** A Monday `weeks` on from an anchor. */
export function weekStart(anchor: string, weeks: number): Date {
  const d = localDate(anchor)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + weeks * 7, 12)
}

/** "Nov 2 – 8", or "Nov 30 – Dec 6" across a month. */
export function weekDates(anchor: string, weeks: number): string {
  const start = weekStart(anchor, weeks)
  const end = weekStart(anchor, weeks)
  end.setDate(end.getDate() + 6)
  return start.getMonth() === end.getMonth() ? `${shortDate(start)} – ${end.getDate()}` : `${shortDate(start)} – ${shortDate(end)}`
}

export function dayDate(anchor: string, weeks: number): string {
  return shortDate(weekStart(anchor, weeks))
}

export function repeatText(steps: number): string {
  return steps === 1 ? 'Repeats every week' : `Repeats every ${steps} weeks`
}

/** The weeks in the rotation from this week on, and the weeks out of it. */
export interface WeekLists { active: string[], inactive: string[] }
/** A place a week sits: its list and its position there. */
export interface Spot { list: 'active' | 'inactive', index: number }

/**
 * A week dragged from one place to another, or null when nothing changes.
 * Dropped on a rotation slot, it takes that slot and the later weeks move on
 * one. The rotation keeps at least one week, and the inactive weeks have no
 * order to keep.
 */
export function moveSpot(lists: WeekLists, from: Spot, to: Spot): WeekLists | null {
  const id = lists[from.list][from.index]
  if (id === undefined || (from.list === 'inactive' && to.list === 'inactive')) return null
  if (from.list === 'active' && to.list === 'inactive') {
    if (lists.active.length === 1) return null
    const active = lists.active.filter((_, i) => i !== from.index)
    // A week that's still in the rotation in another slot isn't inactive.
    return { active, inactive: active.includes(id) || lists.inactive.includes(id) ? lists.inactive : [...lists.inactive, id] }
  }
  const active = [...lists.active]
  if (from.list === 'active') {
    if (from.index === to.index) return null
    active.splice(from.index, 1)
  }
  active.splice(Math.min(to.index, active.length), 0, id)
  return { active, inactive: lists.inactive.filter(other => other !== id) }
}

/**
 * The stored order for weeks shown from this week on, keeping the rotation's
 * anchor: this week's place stays where it was, so a reorder that leaves this
 * week alone doesn't put its curves on the bed again.
 */
export function stepsFrom(shown: string[], week: number): string[] {
  const at = stepOf(week, shown.length)
  return shown.map((_, i) => shown[(i - at + shown.length) % shown.length])
}

/** The order starting from another step, so that step becomes this week. */
export function makeThisWeek(steps: string[], index: number): string[] {
  return [...steps.slice(index), ...steps.slice(0, index)]
}

export function sparkline(points: Array<{ temperature: number }>, width: number, height: number): string {
  if (points.length === 0) return ''
  const temps = points.map(p => p.temperature)
  const low = Math.min(...temps)
  const high = Math.max(...temps)
  const range = Math.max(1, high - low)
  return points.map((p, i) => {
    const x = points.length === 1 ? 0 : i / (points.length - 1) * width
    const y = (high - p.temperature) / range * (height - 4) + 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}
