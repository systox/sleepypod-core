import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
vi.mock('@/src/hardware/base/instance', () => ({ getBaseController: vi.fn() }))
vi.mock('@/src/temperature/instance', () => ({ getTemperatureController: vi.fn() }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getSharedHardwareClient: vi.fn() }))
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({ broadcastMutationStatus: vi.fn() }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: () => false }))
vi.mock('@/src/services/autoOffWatcher', () => ({ cancelAutoOffTimer: vi.fn() }))
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
import { db, sqlite } from '@/src/db'
import { powerSchedules, temperatureSchedules } from '@/src/db/schema'
import { JobManager } from '../jobManager'

let manager: JobManager
const power = { side: 'left' as const, dayOfWeek: 'monday' as const, onTemperature: 84, enabled: true }

const schedule = (id: string) => manager.getScheduler().getJob(id)?.schedule

beforeAll(() => migrate(db, { migrationsFolder: 'src/db/migrations' }))
beforeEach(() => {
  db.delete(temperatureSchedules).run()
  db.delete(powerSchedules).run()
  manager = new JobManager('UTC', { heartbeatIntervalMs: 0 })
})
afterEach(async () => {
  await manager.shutdown()
})
afterAll(() => sqlite.close())

describe('a curve fires from the day it starts', () => {
  it('fires an overnight curve\'s morning and off time the day after', async () => {
    const row = db.insert(powerSchedules).values({ ...power, onTime: '22:30', offTime: '07:00' }).returning().get()
    const evening = db.insert(temperatureSchedules).values({ side: 'left', dayOfWeek: 'monday', time: '23:45', temperature: 82, enabled: true }).returning().get()
    const morning = db.insert(temperatureSchedules).values({ side: 'left', dayOfWeek: 'monday', time: '02:00', temperature: 80, enabled: true }).returning().get()
    await manager.loadSchedules()
    expect(schedule(`power-on-${row.id}`)).toBe('30 22 * * 1')
    expect(schedule(`power-off-${row.id}`)).toBe('0 7 * * 2')
    expect(schedule(`temp-${evening.id}`)).toBe('45 23 * * 1')
    expect(schedule(`temp-${morning.id}`)).toBe('0 2 * * 2')
  })

  it('fires a curve that starts before noon on its own day', async () => {
    const row = db.insert(powerSchedules).values({ ...power, onTime: '04:00', offTime: '15:00' }).returning().get()
    await manager.loadSchedules()
    expect(schedule(`power-on-${row.id}`)).toBe('0 4 * * 1')
    expect(schedule(`power-off-${row.id}`)).toBe('0 15 * * 1')
  })

  it('keeps a lone temperature row on its own weekday', async () => {
    const lone = db.insert(temperatureSchedules).values({ side: 'left', dayOfWeek: 'monday', time: '02:00', temperature: 80, enabled: true }).returning().get()
    await manager.loadSchedules()
    expect(schedule(`temp-${lone.id}`)).toBe('0 2 * * 1')
  })

  it('uses a power row saved after load', () => {
    const row = db.insert(powerSchedules).values({ ...power, onTime: '22:30', offTime: '07:00' }).returning().get()
    const morning = db.insert(temperatureSchedules).values({ side: 'left', dayOfWeek: 'monday', time: '02:00', temperature: 80, enabled: true }).returning().get()
    manager.upsertPowerJob(row)
    manager.upsertTemperatureJob(morning)
    expect(schedule(`temp-${morning.id}`)).toBe('0 2 * * 2')
    manager.cancelPowerJob(row.id)
    manager.upsertTemperatureJob(morning)
    expect(schedule(`temp-${morning.id}`)).toBe('0 2 * * 1')
  })
})
