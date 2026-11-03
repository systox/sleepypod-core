import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type * as Store from '../../store'

const h = vi.hoisted(() => ({
  powerOff: vi.fn(),
  cancel: vi.fn(),
  writes: [] as string[],
}))

vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({
    status: () => ({ blocked: null }),
    powerOff: h.powerOff,
    reconcile: vi.fn(),
  }),
}))
vi.mock('@/src/mcp/caller', () => ({
  getCaller: () => ({ runOnce: { cancel: h.cancel, start: vi.fn() } }),
}))
vi.mock('../../store', async (importOriginal) => {
  const store = await importOriginal<typeof Store>()
  return {
    ...store,
    writeKey: (key: string, value: unknown) => {
      h.writes.push(key)
      store.writeKey(key, value)
    },
  }
})

import { db, sqlite } from '@/src/db'
import { deviceSettings, powerSchedules, temperatureSchedules } from '@/src/db/schema'
import { setSideSettings } from '../../settings'
import { closeStore } from '../../store'
import { noteSwitchedOn, runCommand, runStateOf, tickSide } from '../runner'

// 2026-11-02 is a Monday, so Monday's 22:30 curve opens this evening.
const EVENING = Date.UTC(2026, 10, 2, 22, 0)
const BEDTIME = Date.UTC(2026, 10, 2, 22, 30)

function saveCurve(): void {
  db.insert(powerSchedules).values({ side: 'left', dayOfWeek: 'monday', onTime: '22:30', offTime: '07:00', onTemperature: 85, enabled: true }).run()
  db.insert(temperatureSchedules).values([
    { side: 'left', dayOfWeek: 'monday', time: '22:30', temperature: 85, enabled: true },
    { side: 'left', dayOfWeek: 'monday', time: '01:00', temperature: 81, enabled: true },
  ]).run()
}

beforeAll(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  db.insert(deviceSettings).values({ id: 1, timezone: 'UTC' }).onConflictDoNothing().run()
})
beforeEach(() => {
  closeStore()
  db.delete(temperatureSchedules).run()
  db.delete(powerSchedules).run()
  h.writes.length = 0
  h.cancel.mockReset()
  h.powerOff.mockReset()
  setSideSettings('left', { smartStart: true })
})
afterAll(() => {
  closeStore()
  sqlite.close()
})

describe('a failed off', () => {
  it('stays owed, and goes through on the next tick', async () => {
    saveCurve()
    await runCommand('left', 'start-new', EVENING)
    h.powerOff.mockRejectedValueOnce(new Error('hardware busy'))
    await expect(runCommand('left', 'stop', EVENING + 60_000)).rejects.toThrow('hardware busy')
    expect(runStateOf('left')).toMatchObject({ phase: 'closed', offOwed: true })

    await tickSide('left', EVENING + 90_000)
    expect(h.powerOff).toHaveBeenCalledTimes(2)
    expect(runStateOf('left').offOwed).toBe(false)
  })
})

describe('writing state', () => {
  it('writes nothing on a tick that changed nothing', async () => {
    await tickSide('left', EVENING)
    await tickSide('left', EVENING + 30_000)
    expect(h.writes.filter(key => key === 'run:left')).toEqual([])
  })
})

describe('switching on', () => {
  it('counts a window already open as seen', () => {
    saveCurve()
    noteSwitchedOn('left', EVENING)
    expect(runStateOf('left').windowFor).toBe(BEDTIME)
  })

  it('leaves the state alone with no window open', () => {
    noteSwitchedOn('left', EVENING)
    expect(runStateOf('left').windowFor).toBeNull()
  })
})
