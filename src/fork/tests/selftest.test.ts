import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

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
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { plannedDays, syncSelfTest } from '../selftest'
import { setSideSettings } from '../settings'
import { closeStore } from '../store'

// Tuesday 2026-11-03 at noon in New York.
const NOW = Date.UTC(2026, 10, 3, 17, 0)
const ZONE = 'America/New_York'

function curve(name: string, days: string[]) {
  return db.insert(curveTemplates).values({
    name, bedtime: '23:00', wake: '07:00', points: { '23:00': 84, '07:00': name === 'A' ? 86 : 84 },
    reasoning: '', leftDays: days, rightDays: [], active: days.length > 0, createdAt: new Date(), updatedAt: new Date(),
  } as never).returning().get()
}

const daysOf = (id: number) => db.select().from(curveTemplates).all().find(c => c.id === id)?.leftDays

describe('self-test nights', () => {
  beforeAll(() => {
    migrate(db, { migrationsFolder: 'src/db/migrations' })
    db.insert(deviceSettings).values({ id: 1, timezone: ZONE }).onConflictDoNothing().run()
  })
  beforeEach(() => {
    process.env.FORK_DATABASE_PATH = ':memory:'
    closeStore()
    db.delete(temperatureSchedules).run()
    db.delete(powerSchedules).run()
    db.delete(curveTemplates).run()
  })
  afterAll(() => {
    closeStore()
    sqlite.close()
  })

  it('alternates by date on the days either curve holds, from tomorrow', () => {
    const all = Object.fromEntries(DAYS_OF_WEEK.map(day => [day, 1]))
    const plan = plannedDays({ ...all, friday: 3 }, { a: 1, b: 2 }, NOW, ZONE)
    // Odd day numbers get B: Wednesday 11-04 and Sunday 11-08. Friday 11-06 runs another curve.
    expect(plan.map(p => p.day)).toEqual(['wednesday', 'sunday'])
    expect(plan.every(p => p.curveId === 2)).toBe(true)
  })

  it('swaps days on the schedule, leaves today alone, and puts A back when turned off', async () => {
    const a = curve('A', [...DAYS_OF_WEEK])
    const b = curve('B', [])
    setSideSettings('left', { selfTestOn: true, selfTestCurveA: a.id, selfTestCurveB: b.id })
    await syncSelfTest('left', NOW)
    expect(daysOf(b.id)).toEqual(['wednesday', 'friday', 'sunday'])
    expect(daysOf(a.id)).toContain('tuesday')
    await syncSelfTest('left', NOW)
    expect(daysOf(b.id)).toEqual(['wednesday', 'friday', 'sunday'])

    setSideSettings('left', { selfTestOn: false })
    await syncSelfTest('left', NOW)
    expect(daysOf(b.id)).toEqual([])
    expect(daysOf(a.id)).toHaveLength(7)
  })

  it('leaves the rows of last night alone after midnight', () => {
    const all = Object.fromEntries(DAYS_OF_WEEK.map(day => [day, 1]))
    // 01:00 on Wednesday 11-04 in New York: Tuesday's night may still be running.
    const plan = plannedDays(all, { a: 1, b: 2 }, Date.UTC(2026, 10, 4, 6, 0), ZONE)
    expect(plan.map(p => p.day)).not.toContain('tuesday')
    expect(plan.map(p => p.day)).not.toContain('wednesday')
  })

  it('does nothing without two different curves', async () => {
    const a = curve('A', [...DAYS_OF_WEEK])
    setSideSettings('left', { selfTestOn: true, selfTestCurveA: a.id, selfTestCurveB: a.id })
    await syncSelfTest('left', NOW)
    expect(daysOf(a.id)).toHaveLength(7)
  })
})
