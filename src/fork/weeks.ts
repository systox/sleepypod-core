/**
 * Week presets and rotations. A preset is a Monday-to-Sunday list of saved
 * curves, tied to no side. A rotation is a side's presets in an order that
 * repeats; at each change this puts that week's curves on their days with the
 * same library code the curve editor uses, for that side only, in one
 * database step.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/src/db'
import { curveTemplates } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import { type CurveDays, hasDays, type LibrarySide } from '@/src/lib/scheduleLibrary'
import { DAYS_OF_WEEK, hhmmToMinutes, type DayOfWeek } from '@/src/lib/scheduleTime'
import { applySchedulerOps, curveDays, emptySchedulerOps, writeSide } from '@/src/server/scheduleLibrary'
import { deviceTimezone } from './clock'
import { logEvent, readKey, writeKey } from './store'

const PRESETS_KEY = 'week-presets'
const DAY_MIN = 24 * 60
const WEEK_MIN = 7 * DAY_MIN

const dayCurves = z.object({
  monday: z.number().int().nullable(),
  tuesday: z.number().int().nullable(),
  wednesday: z.number().int().nullable(),
  thursday: z.number().int().nullable(),
  friday: z.number().int().nullable(),
  saturday: z.number().int().nullable(),
  sunday: z.number().int().nullable(),
})

export const weekPresetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  days: dayCurves,
})

export const rotationSchema = z.object({
  /** Presets in order. A preset can appear twice. */
  steps: z.array(z.string().min(1).max(64)).min(1).max(26),
  /** The Monday of the week the first step runs, as YYYY-MM-DD. */
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Local time the week changes on Mondays. */
  changeTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  paused: z.boolean(),
  /** A preset used for one week only, by its week number. */
  swap: z.object({ week: z.number().int(), presetId: z.string().min(1).max(64) }).nullable(),
})

export type WeekPreset = z.infer<typeof weekPresetSchema>
export type Rotation = z.infer<typeof rotationSchema>

export function listPresets(): WeekPreset[] {
  return readKey<WeekPreset[]>(PRESETS_KEY) ?? []
}

export function savePreset(input: Omit<WeekPreset, 'id'> & { id?: string }): WeekPreset {
  const preset = weekPresetSchema.parse({ ...input, id: input.id ?? randomUUID() })
  const all = listPresets()
  writeKey(PRESETS_KEY, all.some(p => p.id === preset.id) ? all.map(p => (p.id === preset.id ? preset : p)) : [...all, preset])
  return preset
}

export function deletePreset(id: string): void {
  for (const side of ['left', 'right'] as const) {
    if (getRotation(side)?.steps.includes(id)) throw new Error('Take this week out of the rotation first')
  }
  writeKey(PRESETS_KEY, listPresets().filter(p => p.id !== id))
}

export function getRotation(side: Side): Rotation | null {
  return readKey<Rotation>(`rotation:${side}`)
}

export function saveRotation(side: Side, rotation: Rotation): Rotation {
  const parsed = rotationSchema.parse(rotation)
  writeKey(`rotation:${side}`, parsed)
  return parsed
}

/** Whole minutes since 1970 on the local clock, so daylight saving can't shift the change. */
function localMinutes(at: number, zone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(at)).map(p => [p.type, Number(p.value)]))
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 60_000
}

const dateMinutes = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 60_000

/** Whole weeks since the anchor's first change. Negative before it. */
export function weekNumber(rotation: Rotation, at: number, zone: string): number {
  return Math.floor((localMinutes(at, zone) - dateMinutes(rotation.anchorDate) - hhmmToMinutes(rotation.changeTime)) / WEEK_MIN)
}

export function stepIndex(rotation: Rotation, week: number): number {
  const n = rotation.steps.length
  return ((week % n) + n) % n
}

export function presetForWeek(rotation: Rotation, week: number): string {
  return rotation.swap?.week === week ? rotation.swap.presetId : rotation.steps[stepIndex(rotation, week)]
}

/** Put a preset's curves on one side's days. Other sides and alarms stay untouched. */
export async function applyPreset(side: LibrarySide, preset: WeekPreset): Promise<string[]> {
  const ops = emptySchedulerOps()
  const missing: string[] = []
  db.transaction((tx) => {
    const curves = tx.select().from(curveTemplates).all()
    const known = new Set(curves.map(c => c.id))
    const wanted = new Map<number, DayOfWeek[]>()
    for (const day of DAYS_OF_WEEK) {
      const id = preset.days[day]
      if (id === null) continue
      if (!known.has(id)) missing.push(day)
      else wanted.set(id, [...(wanted.get(id) ?? []), day])
    }
    writeSide(tx, { points: {}, endAction: 'turn_off', notes: '' }, side, [], [...DAYS_OF_WEEK], ops)
    for (const curve of curves) {
      const onDays = wanted.get(curve.id) ?? []
      // A curve that's off and unused keeps the days saved on it.
      if (!curve.active && onDays.length === 0) continue
      // Turning a curve on makes all its days real, so an off curve's other-side days can't stay.
      const kept: CurveDays = curve.active ? curveDays(curve) : { left: [], right: [] }
      const days = { ...kept, [side]: onDays }
      if (onDays.length > 0) writeSide(tx, curve, side, onDays, [], ops)
      tx.update(curveTemplates).set({ leftDays: days.left, rightDays: days.right, active: hasDays(days) })
        .where(eq(curveTemplates.id, curve.id)).run()
    }
  })
  await applySchedulerOps(ops)
  return missing
}

/** Apply the side's current week when it changed, including one missed while the Pod was down. */
export async function syncRotation(side: Side, now = Date.now(), force = false): Promise<void> {
  const rotation = getRotation(side)
  if (!rotation || rotation.paused) return
  const week = weekNumber(rotation, now, deviceTimezone())
  const presetId = presetForWeek(rotation, week)
  const appliedKey = `rotation-applied:${side}`
  const stamp = `${week}:${presetId}`
  if (!force && readKey<string>(appliedKey) === stamp) return
  const preset = listPresets().find(p => p.id === presetId)
  if (!preset) {
    logEvent(side, 'rotation-missing-week', { presetId })
    return
  }
  const missing = await applyPreset(side, preset)
  writeKey(appliedKey, stamp)
  logEvent(side, 'rotation-applied', { week, preset: preset.name, missing })
}

export interface RotationView {
  rotation: Rotation
  week: number
  thisPresetId: string
}

export function rotationView(side: Side, now = Date.now()): RotationView | null {
  const rotation = getRotation(side)
  if (!rotation) return null
  const week = weekNumber(rotation, now, deviceTimezone())
  return { rotation, week, thisPresetId: presetForWeek(rotation, week) }
}
