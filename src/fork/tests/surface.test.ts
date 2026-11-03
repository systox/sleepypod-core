import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const h = vi.hoisted(() => ({
  status: { blocked: null as string | null, source: 'schedule' },
  target: 84 as number | null,
  occupied: true as boolean | null,
  reconcile: vi.fn(),
}))

vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/biometrics-schema')
  const sqlite = new Database(':memory:')
  return { biometricsDb: drizzle(sqlite, { schema }), biometricsSqlite: sqlite }
})
vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({
    status: () => h.status,
    baselineTarget: () => h.target,
    reconcile: h.reconcile,
  }),
}))
vi.mock('../presence/collector', () => ({
  presenceOf: () => ({ occupied: h.occupied, since: null }),
  sensorsFresh: () => true,
}))

import { biometricsDb } from '@/src/db'
import { bedTemp } from '@/src/db/biometrics-schema'
import { runtime } from '../runtime'
import { setSideSettings } from '../settings'
import { closeStore, listEvents } from '../store'
import { clearSurfaces, readSurface, stepSurface, surfaceOffset, withSurfaceOffset } from '../surface'

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 3, 4, 0)
const toCenti = (f: number) => Math.round((f - 32) * 5 / 9 * 100)

function surfaceAt(f: number, at = NOW): void {
  const c = toCenti(f)
  biometricsDb.insert(bedTemp).values({ timestamp: new Date(at - MIN), leftOuterTemp: c, leftCenterTemp: c, leftInnerTemp: c }).run()
}

beforeAll(() => {
  migrate(biometricsDb, { migrationsFolder: 'src/db/biometrics-migrations' })
})
beforeEach(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  closeStore()
  clearSurfaces()
  biometricsDb.delete(bedTemp).run()
  runtime.running = true
  h.status = { blocked: null, source: 'schedule' }
  h.target = 84
  h.occupied = true
  h.reconcile.mockReset()
  setSideSettings('left', { surfaceMode: 'on', surfaceLowF: 86, surfaceHighF: 88, surfaceStepMinutes: 20, warmestF: 90 })
})
afterAll(() => {
  runtime.running = false
  closeStore()
})

describe('surface range', () => {
  it('reads the median of the side\'s zones over the last 10 minutes', () => {
    surfaceAt(84)
    surfaceAt(85, NOW - 2 * MIN)
    surfaceAt(90, NOW - 20 * MIN)
    expect(readSurface('left', NOW)).toBeCloseTo(85, 0)
    expect(readSurface('right', NOW)).toBeNull()
  })

  it('warms the water a degree at a time, no faster than the step time', async () => {
    surfaceAt(84)
    await stepSurface('left', NOW)
    expect(surfaceOffset('left')).toBe(1)
    expect(h.reconcile).toHaveBeenCalledWith('left')
    await stepSurface('left', NOW + 10 * MIN)
    expect(surfaceOffset('left')).toBe(1)
    surfaceAt(84, NOW + 21 * MIN)
    await stepSurface('left', NOW + 21 * MIN)
    expect(surfaceOffset('left')).toBe(2)
    expect(listEvents(0, NOW + DAY, ['surface-step'])).toHaveLength(2)
  })

  it('only logs in watch mode', async () => {
    setSideSettings('left', { surfaceMode: 'watch' })
    surfaceAt(84)
    await stepSurface('left', NOW)
    expect(surfaceOffset('left')).toBe(0)
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(listEvents(0, NOW + DAY, ['surface-watch'])).toHaveLength(1)
  })

  it('leaves a hold alone and clears once the side is empty', async () => {
    surfaceAt(84)
    await stepSurface('left', NOW)
    h.status = { blocked: null, source: 'manual' }
    await stepSurface('left', NOW + 30 * MIN)
    expect(surfaceOffset('left')).toBe(1)
    h.status = { blocked: null, source: 'schedule' }
    h.occupied = false
    await stepSurface('left', NOW + 31 * MIN)
    expect(surfaceOffset('left')).toBe(0)
  })

  it('stops at the warmest allowed and never carries a curve past it', async () => {
    surfaceAt(84)
    h.target = 90
    await stepSurface('left', NOW)
    expect(surfaceOffset('left')).toBe(0)
    h.target = 84
    await stepSurface('left', NOW)
    const requests = withSurfaceOffset('left', [
      { id: 'temperature:1', temperature: 90 },
      { id: 'temperature:2', temperature: 84 },
      { id: 'alarm:3', temperature: 80 },
    ])
    expect(requests.map(r => r.temperature)).toEqual([90, 85, 80])
  })

  it('does nothing in range or with the setting off', async () => {
    surfaceAt(87)
    await stepSurface('left', NOW)
    expect(surfaceOffset('left')).toBe(0)
    setSideSettings('left', { surfaceMode: 'off' })
    surfaceAt(80, NOW + 30 * MIN)
    await stepSurface('left', NOW + 30 * MIN)
    expect(surfaceOffset('left')).toBe(0)
  })
})

const DAY = 86_400_000
