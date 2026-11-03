/**
 * Which curve ran each night, noted as it starts. The schedule rows change
 * with the rotation and self-test nights, so later they can't say what ran.
 */
import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { curveTemplates } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import type { DayOfWeek } from '@/src/lib/scheduleTime'
import { curveDays } from '@/src/server/scheduleLibrary'
import { windowsOf } from './smart/runner'
import { listEvents, logEvent, readKey, writeKey, type ForkEvent } from './store'

const HOUR = 3_600_000

export interface NightRecord {
  side: Side
  bedtime: number
  curveId: number | null
  curveName: string | null
}

/** The saved curve on a side's day, or null when the rows there came from no saved curve. */
export function curveOn(side: Side, day: DayOfWeek): { id: number, name: string } | null {
  const curve = db.select().from(curveTemplates).where(eq(curveTemplates.active, true)).all()
    .find(c => curveDays(c)[side].includes(day))
  return curve ? { id: curve.id, name: curve.name } : null
}

export function noteNightStart(side: Side, now = Date.now()): void {
  const { window } = windowsOf(side, now)
  if (!window || now < window.curve.bedtime) return
  const key = `night-noted:${side}`
  if (readKey<number>(key) === window.curve.bedtime) return
  const curve = curveOn(side, window.curve.day)
  logEvent(side, 'night', { bedtime: window.curve.bedtime, curveId: curve?.id ?? null, curveName: curve?.name ?? null }, window.curve.bedtime)
  writeKey(key, window.curve.bedtime)
}

export function nightRecords(events: ForkEvent[], side: Side): NightRecord[] {
  return events.filter(e => e.side === side && e.kind === 'night' && e.detail).map((e) => {
    const detail = JSON.parse(e.detail as string) as Omit<NightRecord, 'side'>
    return { side, bedtime: detail.bedtime, curveId: detail.curveId, curveName: detail.curveName }
  }).sort((a, b) => a.bedtime - b.bedtime)
}

/** A night runs until the next one starts, or the backstop at most. */
export function nightEnd(nights: NightRecord[], index: number, backstopHours: number): number {
  const limit = nights[index].bedtime + backstopHours * HOUR
  const next = nights[index + 1]?.bedtime
  return next === undefined ? limit : Math.min(next, limit)
}

/** Net direction of a press burst: 1 warmer, -1 cooler, 0 if they cancel out. */
export function pressDirection(event: ForkEvent): number {
  const buttons = (event.detail ? (JSON.parse(event.detail) as { buttons?: string[] }).buttons : undefined) ?? []
  return Math.sign(buttons.filter(b => b === 'top').length - buttons.filter(b => b === 'bottom').length)
}

export function eventsSince(from: number, to: number): ForkEvent[] {
  return listEvents(from, to)
}
