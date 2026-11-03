/**
 * Morning suggestions: when the same hour of the same curve drew presses the
 * same way on enough recent nights, offer to move that hour by a degree. It
 * changes nothing until someone accepts. Presses just after the other person
 * got in don't count, because they may mean being woken, not being cold.
 */
import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { curveTemplates } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import { hhmmToMinutes } from '@/src/lib/scheduleTime'
import { applySchedulerOps, curveDays, emptySchedulerOps, syncCurveRows } from '@/src/server/scheduleLibrary'
import { eventsSince, nightEnd, nightRecords, pressDirection } from './nights'
import { presenceOf } from './presence/collector'
import { getSideSettings } from './settings'
import { logEvent, readKey, writeKey } from './store'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY_MIN = 24 * 60
const LOOK_BACK_MS = 21 * 24 * HOUR
/** A night still in progress isn't over enough to judge, unless the side has been empty a while. */
const SETTLED_AFTER_MS = 4 * HOUR
const COOLEST_F = 55

export interface Suggestion {
  id: string
  side: Side
  curveId: number
  curveName: string
  /** Minutes after the curve's first point, and the clock times on the saved curve. */
  fromMinute: number
  from: string
  to: string
  delta: number
  nights: number
  of: number
}

const doneKey = (side: Side) => `suggestions-done:${side}`
/** When a suggestion last changed a curve: nights before it ran the old curve. */
const changedKey = (curveId: number) => `suggestion-changed:${curveId}`
const clock = (minutes: number): string => {
  const m = ((minutes % DAY_MIN) + DAY_MIN) % DAY_MIN
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * The saved curve with one stretch moved by `delta`, clamped to the allowed
 * range. Points are added at the stretch's edges where needed, so the curve
 * outside it keeps exactly the temperatures it had. Nothing moves past the
 * curve's wake, so points kept before bedtime stay where they are.
 */
export function shiftPart(points: Record<string, number>, bedtime: string, wake: string, fromMinute: number, toMinute: number, delta: number, coolest: number, warmest: number): Record<string, number> {
  const start = hhmmToMinutes(bedtime)
  const offsetOf = (time: string) => (hhmmToMinutes(time) - start + DAY_MIN) % DAY_MIN
  const end = offsetOf(wake)
  const entries = Object.entries(points).map(([time, temperature]) => ({ offset: offsetOf(time), temperature })).sort((a, b) => a.offset - b.offset)
  if (entries.length === 0 || fromMinute >= end) return { ...points }
  const at = (offset: number) => [...entries].reverse().find(e => e.offset <= offset)?.temperature ?? entries[0].temperature
  const edges = [fromMinute, toMinute].filter(offset => offset < end && !entries.some(e => e.offset === offset))
  const withEdges = [...entries, ...edges.map(offset => ({ offset, temperature: at(offset) }))]
  return Object.fromEntries(withEdges.map(({ offset, temperature }) => [
    clock(start + offset),
    offset >= fromMinute && offset < toMinute && offset < end ? Math.max(coolest, Math.min(warmest, temperature + delta)) : temperature,
  ]))
}

export function suggestionsFor(side: Side, now = Date.now()): Suggestion[] {
  const settings = getSideSettings(side)
  if (!settings.suggestOn) return []
  const other: Side = side === 'left' ? 'right' : 'left'
  const events = eventsSince(now - LOOK_BACK_MS, now)
  const all = nightRecords(events, side)
  const settled = all.filter((night, i) => {
    const end = nightEnd(all, i, settings.backstopHours)
    return end <= now || (now - night.bedtime >= SETTLED_AFTER_MS && presenceOf(side).occupied === false)
  })
  const latest = settled[settled.length - 1]
  if (!latest || latest.curveId === null) return []
  // Only nights on the same curve, since it last changed, can say anything about it.
  const changedAt = readKey<number>(changedKey(latest.curveId)) ?? 0
  const nights = settled.filter(n => n.curveId === latest.curveId && n.bedtime >= changedAt).slice(-settings.suggestNights)
  if (nights.length < settings.suggestNeeded) return []

  const otherIns = events.filter(e => e.side === other && e.kind === 'in').map(e => e.ts)
  const counts = new Map<string, Set<number>>()
  nights.forEach((night, n) => {
    const index = all.indexOf(night)
    const end = nightEnd(all, index, settings.backstopHours)
    const started = events.find(e => e.side === side && e.kind === 'smart:start'
      && e.ts >= night.bedtime - settings.hoursEarly * HOUR && e.ts < end)
    const zero = started?.ts ?? night.bedtime
    for (const press of events) {
      if (press.side !== side || press.kind !== 'press' || press.ts < zero || press.ts >= end) continue
      if (otherIns.some(t => press.ts >= t && press.ts - t <= settings.suggestIgnoreMinutes * MINUTE)) continue
      const direction = pressDirection(press)
      if (direction === 0) continue
      const key = `${Math.floor((press.ts - zero) / HOUR)}:${direction}`
      counts.set(key, (counts.get(key) ?? new Set()).add(n))
    }
  })

  const curve = db.select().from(curveTemplates).where(eq(curveTemplates.id, latest.curveId)).get()
  if (!curve) return []
  const done = new Set(readKey<string[]>(doneKey(side)) ?? [])
  const out: Suggestion[] = []
  for (const [key, seen] of counts) {
    const [hour, direction] = key.split(':').map(Number)
    // Presses both ways in the same hour say nothing clear.
    if (seen.size < settings.suggestNeeded || (counts.get(`${hour}:${-direction}`)?.size ?? 0) >= settings.suggestNeeded) continue
    const id = `${side}:${curve.id}:${hour}:${direction}:${latest.bedtime}`
    if (done.has(id)) continue
    const fromMinute = hour * 60
    const start = hhmmToMinutes(curve.bedtime)
    out.push({
      id, side, curveId: curve.id, curveName: curve.name, fromMinute,
      from: clock(start + fromMinute), to: clock(start + fromMinute + 60),
      delta: direction * settings.suggestStepF, nights: seen.size, of: nights.length,
    })
  }
  return out.sort((a, b) => a.fromMinute - b.fromMinute)
}

function markDone(side: Side, id: string): void {
  const done = readKey<string[]>(doneKey(side)) ?? []
  // The ids carry the night they came from, so old ones can go.
  writeKey(doneKey(side), [...done.filter(d => d !== id).slice(-199), id])
}

export function dismissSuggestion(side: Side, id: string): void {
  markDone(side, id)
  logEvent(side, 'suggestion-dismissed', { id })
}

export async function acceptSuggestion(side: Side, id: string, now = Date.now()): Promise<void> {
  const suggestion = suggestionsFor(side, now).find(s => s.id === id)
  if (!suggestion) throw new Error('That suggestion is no longer current')
  const settings = getSideSettings(side)
  const ops = emptySchedulerOps()
  db.transaction((tx) => {
    const curve = tx.select().from(curveTemplates).where(eq(curveTemplates.id, suggestion.curveId)).get()
    if (!curve) throw new Error('That curve was deleted')
    const points = shiftPart(curve.points, curve.bedtime, curve.wake, suggestion.fromMinute, suggestion.fromMinute + 60, suggestion.delta, COOLEST_F, settings.warmestF)
    tx.update(curveTemplates).set({ points, updatedAt: new Date() }).where(eq(curveTemplates.id, curve.id)).run()
    syncCurveRows(tx, { ...curve, points }, { days: curveDays(curve), active: curve.active }, ops)
  })
  await applySchedulerOps(ops)
  writeKey(changedKey(suggestion.curveId), now)
  markDone(side, id)
  logEvent(side, 'suggestion-accepted', { id, curveId: suggestion.curveId, from: suggestion.from, delta: suggestion.delta })
}
