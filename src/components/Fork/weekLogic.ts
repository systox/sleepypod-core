import type { SavedCurve } from '@/src/hooks/useCurveTemplates'
import type { DayOfWeek } from '@/src/lib/scheduleTime'

export const WEEK_DAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
export const DAY_SHORT: Record<DayOfWeek, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
}

export type WeekDays = Record<DayOfWeek, number | null>
export const EMPTY_WEEK: WeekDays = {
  monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null,
}

const DAY_MIN = 24 * 60
const BAR_START_MIN = 18 * 60
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const toMinutes = (time: string): number => {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

/** Where a time sits on a day's bar, which runs 6 PM to 6 PM. */
function barPosition(minutes: number): number {
  return ((minutes - BAR_START_MIN + DAY_MIN) % DAY_MIN) / DAY_MIN * 100
}

export interface Bar { top: number, height: number }

export function barFor(curve: Pick<SavedCurve, 'bedtime' | 'wake'> | undefined): Bar {
  if (!curve) return { top: 0, height: 0 }
  const top = barPosition(toMinutes(curve.bedtime))
  const end = barPosition(toMinutes(curve.wake))
  return { top, height: end > top ? end - top : 100 - top }
}

/** "Mon–Fri", "Mon, Wed" and so on, in week order. */
export function dayRange(days: DayOfWeek[]): string {
  const groups: Array<[number, number]> = []
  for (const index of days.map(d => WEEK_DAYS.indexOf(d)).sort((a, b) => a - b)) {
    const last = groups[groups.length - 1]
    if (last && last[1] === index - 1) last[1] = index
    else groups.push([index, index])
  }
  return groups.map(([a, b]) => (a === b ? DAY_SHORT[WEEK_DAYS[a]] : `${DAY_SHORT[WEEK_DAYS[a]]}–${DAY_SHORT[WEEK_DAYS[b]]}`)).join(', ')
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
    return `${dayRange(part.days)} · ${name}`
  }).join(', ')
}

const localDate = (date: string): Date => new Date(`${date}T12:00:00`)
const shortDate = (d: Date): string => `${MONTHS[d.getMonth()]} ${d.getDate()}`

/** The Monday of a date's week, as YYYY-MM-DD. */
export function mondayOf(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7), 12)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

/** A step moved within the order. This week stays first, so it never moves. */
export function moveStep(steps: string[], from: number, to: number): string[] {
  if (from === 0 || to === 0 || to >= steps.length) return steps
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
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
