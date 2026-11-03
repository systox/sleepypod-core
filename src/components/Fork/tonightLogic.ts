import type { RunState } from '@/src/fork/smart/engine'
import type { ForkSideSettings } from '@/src/fork/settings'

const MINUTE = 60_000

export interface SideView {
  settings: ForkSideSettings
  run: RunState
  presence: { occupied: boolean | null, since: number | null }
  fade: { curve: number, by: number } | null
  tonight: { bedtime: number, windowStart: number, windowEnd: number, points: Array<{ offset: number, temperature: number }> } | null
  upcoming: { bedtime: number, windowStart: number, windowEnd: number, firstTemperature: number } | null
  rotation: { thisPresetId: string } | null
  surface: { reading: number | null, offset: number }
}

export interface NextStep { at: number, temperature: number }

/** The curve's next change during a run. */
export function nextStep(view: Pick<SideView, 'run'>, now: number): NextStep | null {
  const { points, curveZeroAt, phase, pausedAt } = view.run
  if (!points || curveZeroAt === null || pausedAt !== null || (phase !== 'running' && phase !== 'reading')) return null
  for (const point of points) {
    const at = curveZeroAt + point.offset * MINUTE
    if (at > now) return { at, temperature: point.temperature }
  }
  return null
}

/** A side's state in words, such as "In bed since 11:12 PM" or "Closed until 9:30 PM". */
export function describeSide(view: SideView, now: number, clock: (at: number) => string): string {
  const { run, presence, settings, upcoming } = view
  if (!settings.smartStart) return 'On the weekly schedule'
  const since = presence.since === null ? '' : ` since ${clock(presence.since)}`
  switch (run.phase) {
    case 'running':
      if (run.offForTrip) return 'Off, waiting for someone to come back'
      if (run.pausedAt !== null) return 'Paused while the side is empty'
      return presence.occupied ? `In bed${since}` : `Running${since ? `, empty${since}` : ''}`
    case 'reading':
      return `In bed${since}, curve begins at ${clock(run.curveZeroAt as number)}`
    case 'warming':
      return `Warmed up, waiting for someone until ${clock(run.copyEndsAt as number)}`
    case 'closed':
      return run.closedUntil === null ? 'Closed for tonight' : `Closed until ${clock(run.closedUntil)}`
    default:
      if (upcoming && now < upcoming.windowStart) return `Opens at ${clock(upcoming.windowStart)}`
      return upcoming ? `Waiting for someone until ${clock(upcoming.windowEnd)}` : 'No curve saved for this side'
  }
}

export interface NightEvent { id: number, ts: number, side: string | null, kind: string }

export interface NightRow {
  key: string
  /** Noon that opens this night, in local time. */
  start: number
  side: string
  events: NightEvent[]
  presses: number
}

/** Events grouped by side and noon-to-noon night, newest first. */
export function groupNights(events: NightEvent[]): NightRow[] {
  const rows = new Map<string, NightRow>()
  for (const event of events) {
    if (!event.side) continue
    const d = new Date(event.ts)
    if (d.getHours() < 12) d.setDate(d.getDate() - 1)
    d.setHours(12, 0, 0, 0)
    const key = `${event.side}:${d.getTime()}`
    const row = rows.get(key) ?? { key, start: d.getTime(), side: event.side, events: [], presses: 0 }
    if (event.kind === 'press') row.presses += 1
    else row.events.push(event)
    rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => b.start - a.start || a.side.localeCompare(b.side))
}
