import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
vi.mock('@/src/scheduler', () => ({ getJobManager: async () => ({
  cancelTemperatureJob: vi.fn(), cancelPowerJob: vi.fn(), upsertTemperatureJob: vi.fn(), upsertPowerJob: vi.fn(),
}) }))
import { db, sqlite } from '@/src/db'
import { curveTemplates, deviceSettings, powerSchedules, temperatureSchedules } from '@/src/db/schema'
import { closeStore, readKey } from '../store'
import { applyPreset, deletePreset, listPresets, presetForWeek, savePreset, saveRotation, stepIndex, syncRotation, weekNumber, type Rotation, type WeekPreset } from '../weeks'

const rotation: Rotation = { steps: ['off', 'day', 'night'], anchorDate: '2026-11-02', changeTime: '16:00', paused: false, swap: null }
const ny = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h + 5, m)

function curve(name: string, bedtime: string, temperature: number) {
  return db.insert(curveTemplates).values({
    name, bedtime, wake: '07:00', points: { [bedtime]: temperature, '07:00': temperature + 1 }, reasoning: '', leftDays: [], rightDays: [], active: false, createdAt: new Date(), updatedAt: new Date(),
  } as never).returning().get()
}

const days = (id: number | null, monday = id): WeekPreset['days'] => ({
  monday, tuesday: id, wednesday: id, thursday: id, friday: id, saturday: id, sunday: id,
})

beforeAll(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  db.insert(deviceSettings).values({ id: 1, timezone: 'America/New_York' }).onConflictDoNothing().run()
})
beforeEach(() => {
  closeStore()
  db.delete(temperatureSchedules).run()
  db.delete(powerSchedules).run()
  db.delete(curveTemplates).run()
})
afterAll(() => {
  closeStore()
  sqlite.close()
})

describe('which week it is', () => {
  it('changes on Monday at the change time, not at midnight', () => {
    expect(weekNumber(rotation, ny(9, 15, 59), 'America/New_York')).toBe(0)
    expect(weekNumber(rotation, ny(9, 16), 'America/New_York')).toBe(1)
  })

  it('walks the order and repeats', () => {
    expect([0, 1, 2, 3, 4].map(week => stepIndex(rotation, week))).toEqual([0, 1, 2, 0, 1])
    expect(stepIndex(rotation, -1)).toBe(2)
  })

  it('uses a swap for its one week, then the order carries on', () => {
    const swapped = { ...rotation, swap: { week: 1, presetId: 'night' } }
    expect(presetForWeek(swapped, 1)).toBe('night')
    expect(presetForWeek(swapped, 2)).toBe('night')
    expect(presetForWeek(swapped, 3)).toBe('off')
  })

  it('keeps Monday at 16:00 local across a clock change', () => {
    const spring: Rotation = { ...rotation, anchorDate: '2027-03-08' }
    expect(weekNumber(spring, Date.UTC(2027, 2, 15, 19, 59), 'America/New_York')).toBe(0)
    expect(weekNumber(spring, Date.UTC(2027, 2, 15, 20, 0), 'America/New_York')).toBe(1)
  })
})

describe('applying a preset', () => {
  it('puts each curve on its days for one side and leaves the other side alone', async () => {
    const late = curve('Late', '23:30', 84)
    const day = curve('Day', '22:30', 85)
    db.insert(temperatureSchedules).values({ side: 'right', dayOfWeek: 'monday', time: '22:30', temperature: 80, enabled: true }).run()
    await applyPreset('left', { id: 'w', name: 'Day week', days: days(day.id, late.id) })
    const rows = db.select().from(temperatureSchedules).where(eq(temperatureSchedules.side, 'left')).all()
    expect(rows.filter(r => r.dayOfWeek === 'monday').map(r => r.time)).toContain('23:30')
    expect(rows.filter(r => r.dayOfWeek === 'tuesday').map(r => r.time)).toContain('22:30')
    expect(db.select().from(temperatureSchedules).where(eq(temperatureSchedules.side, 'right')).all()).toHaveLength(1)
    const saved = db.select().from(curveTemplates).all()
    expect(saved.find(c => c.id === day.id)).toMatchObject({ active: true })
    expect(saved.find(c => c.id === late.id)?.leftDays).toEqual(['monday'])
  })

  it('moves days from one preset\'s curves to the next week\'s', async () => {
    const a = curve('A', '23:00', 80)
    const b = curve('B', '04:00', 82)
    await applyPreset('left', { id: 'a', name: 'A', days: days(a.id) })
    await applyPreset('left', { id: 'b', name: 'B', days: days(b.id) })
    const saved = db.select().from(curveTemplates).all()
    expect(saved.find(c => c.id === a.id)).toMatchObject({ active: false, leftDays: [] })
    expect(db.select().from(powerSchedules).where(eq(powerSchedules.side, 'left')).all()).toHaveLength(7)
    expect(db.select().from(powerSchedules).where(eq(powerSchedules.side, 'left')).all().every(p => p.onTime === '04:00')).toBe(true)
  })

  it('does not wake the other side\'s days saved on a curve that was off', async () => {
    const a = curve('A', '23:00', 80)
    db.update(curveTemplates).set({ rightDays: ['friday'] }).where(eq(curveTemplates.id, a.id)).run()
    await applyPreset('left', { id: 'a', name: 'A', days: days(a.id) })
    expect(db.select().from(curveTemplates).all()[0]).toMatchObject({ active: true, rightDays: [] })
    expect(db.select().from(temperatureSchedules).where(eq(temperatureSchedules.side, 'right')).all()).toHaveLength(0)
  })

  it('keeps the other side\'s days on a curve that was on', async () => {
    const a = curve('A', '23:00', 80)
    db.update(curveTemplates).set({ rightDays: ['friday'], active: true }).where(eq(curveTemplates.id, a.id)).run()
    await applyPreset('left', { id: 'a', name: 'A', days: days(a.id) })
    expect(db.select().from(curveTemplates).all()[0].rightDays).toEqual(['friday'])
  })

  it('leaves days saved on an off curve the week does not use', async () => {
    const a = curve('A', '23:00', 80)
    const b = curve('B', '22:30', 82)
    db.update(curveTemplates).set({ rightDays: ['friday'] }).where(eq(curveTemplates.id, b.id)).run()
    await applyPreset('left', { id: 'a', name: 'A', days: days(a.id) })
    expect(db.select().from(curveTemplates).where(eq(curveTemplates.id, b.id)).get()).toMatchObject({ active: false, rightDays: ['friday'] })
  })

  it('reports a curve that was deleted, and that day runs nothing', async () => {
    const a = curve('A', '23:00', 80)
    const missing = await applyPreset('left', { id: 'a', name: 'A', days: { ...days(a.id), friday: 9999 } })
    expect(missing).toEqual(['friday'])
    expect(db.select().from(powerSchedules).where(eq(powerSchedules.dayOfWeek, 'friday')).all()).toHaveLength(0)
  })
})

describe('rotation', () => {
  it('applies the week once, and again only when it changes', async () => {
    const a = curve('A', '23:00', 80)
    const b = curve('B', '22:30', 82)
    const off = savePreset({ name: 'Off', days: days(a.id) })
    const day = savePreset({ name: 'Day', days: days(b.id) })
    saveRotation('left', { ...rotation, steps: [off.id, day.id] })
    await syncRotation('left', ny(3, 12))
    expect(db.select().from(powerSchedules).where(eq(powerSchedules.onTime, '23:00')).all()).toHaveLength(7)
    db.delete(powerSchedules).run()
    await syncRotation('left', ny(3, 13))
    expect(db.select().from(powerSchedules).all()).toHaveLength(0)
    await syncRotation('left', ny(9, 16, 1))
    expect(db.select().from(powerSchedules).where(eq(powerSchedules.onTime, '22:30')).all()).toHaveLength(7)
    expect(readKey<string>('rotation-applied:left')).toBe(`1:${day.id}`)
  })

  it('applies a change missed while the Pod was down', async () => {
    const a = curve('A', '23:00', 80)
    const off = savePreset({ name: 'Off', days: days(a.id) })
    saveRotation('left', { ...rotation, steps: [off.id] })
    await syncRotation('left', ny(30, 9))
    expect(db.select().from(powerSchedules).all()).toHaveLength(7)
  })

  it('does nothing while paused', async () => {
    const a = curve('A', '23:00', 80)
    const off = savePreset({ name: 'Off', days: days(a.id) })
    saveRotation('left', { ...rotation, steps: [off.id], paused: true })
    await syncRotation('left', ny(3, 12))
    expect(db.select().from(powerSchedules).all()).toHaveLength(0)
  })

  it('won\'t delete a week still in a rotation', () => {
    const off = savePreset({ name: 'Off', days: days(null) })
    saveRotation('left', { ...rotation, steps: [off.id] })
    expect(() => deletePreset(off.id)).toThrow(/rotation/)
    saveRotation('left', { ...rotation, steps: ['other'] })
    deletePreset(off.id)
    expect(listPresets()).toEqual([])
  })
})
