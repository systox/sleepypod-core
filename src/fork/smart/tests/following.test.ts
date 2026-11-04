import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  powerOff: vi.fn(),
  reconcile: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  syncMirroredSide: vi.fn(),
}))

vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({ status: () => ({ blocked: null }), powerOff: h.powerOff, reconcile: h.reconcile }),
}))
vi.mock('@/src/mcp/caller', () => ({
  getCaller: () => ({ runOnce: { cancel: h.cancel, start: h.start } }),
}))
vi.mock('@/src/scheduler/instance', () => ({ getJobManager: async () => ({ syncMirroredSide: h.syncMirroredSide }) }))

import { db, sqlite } from '@/src/db'
import { deviceSettings, runOnceSessions, sideSettings } from '@/src/db/schema'
import type { BedState } from '@/src/lib/singleSleeper'
import { setSideSettings } from '../../settings'
import { closeStore, listEvents } from '../../store'
import { followingOf, pointsFromNow, smartSourceOf, smartStartFor, syncFollowing } from '../following'
import { runCommand } from '../runner'

const HOUR = 3_600_000
/** 2026-11-03 01:00 UTC; the home curve started at 22:30 the evening before. */
const NOW = Date.UTC(2026, 10, 3, 1, 0)
const HOME_POINTS = [{ time: '22:30', temperature: 85 }, { time: '23:00', temperature: 83 }, { time: '00:00', temperature: 78 }, { time: '03:00', temperature: 80 }]

function session(side: 'left' | 'right', setPoints: unknown, startedAt = NOW - 2.5 * HOUR): number {
  return db.insert(runOnceSessions).values({
    side, setPoints: JSON.stringify(setPoints), wakeTime: '07:00', startedAt: new Date(startedAt), expiresAt: new Date(NOW + 6 * HOUR),
  }).returning({ id: runOnceSessions.id }).get().id
}

function active(side: 'left' | 'right') {
  return db.select().from(runOnceSessions).where(eq(runOnceSessions.side, side)).all().filter(row => row.status === 'active')
}

beforeAll(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  db.insert(deviceSettings).values({ id: 1, timezone: 'UTC' }).onConflictDoNothing().run()
  db.insert(sideSettings).values([{ side: 'left', name: 'Left' }, { side: 'right', name: 'Right' }]).onConflictDoNothing().run()
})
beforeEach(() => {
  closeStore()
  db.delete(runOnceSessions).run()
  for (const fn of Object.values(h)) fn.mockReset()
  // The fakes behave like sleepypod's: a start replaces the side's session, a cancel ends it.
  h.start.mockImplementation(async ({ side, setPoints, wakeTime }: { side: 'left' | 'right', setPoints: unknown, wakeTime: string }) => {
    db.update(runOnceSessions).set({ status: 'cancelled' }).where(eq(runOnceSessions.side, side)).run()
    const id = db.insert(runOnceSessions).values({ side, setPoints: JSON.stringify(setPoints), wakeTime, expiresAt: new Date(NOW + 6 * HOUR) }).returning({ id: runOnceSessions.id }).get().id
    return { sessionId: id }
  })
  h.cancel.mockImplementation(async ({ side }: { side: 'left' | 'right' }) => {
    db.update(runOnceSessions).set({ status: 'cancelled' }).where(eq(runOnceSessions.side, side)).run()
  })
  setSideSettings('left', { smartStart: true })
  setSideSettings('right', { smartStart: false })
})
afterAll(() => {
  closeStore()
  sqlite.close()
})

describe('whose Smart start setting counts', () => {
  const bed = (over: Partial<BedState>): BedState => ({ bedMode: 'two', unusedZoneMode: 'follow', left: { awayMode: false }, right: { awayMode: true }, ...over })

  it('is the home sleeper\'s for an away side that follows them, and nobody\'s otherwise', () => {
    expect(smartSourceOf('left', bed({}))).toBe('left')
    expect(smartSourceOf('right', bed({}))).toBe('left')
    expect(smartSourceOf('right', bed({ unusedZoneMode: 'off' }))).toBeNull()
    expect(smartSourceOf('right', bed({ unusedZoneMode: 'independent' }))).toBeNull()
    expect(smartSourceOf('right', bed({ left: { awayMode: true } }))).toBeNull()
  })

  it('takes the home sleeper\'s on or off, whatever the away side has', () => {
    setSideSettings('left', { smartStart: false })
    setSideSettings('right', { smartStart: true })
    expect(smartStartFor('right', bed({}))).toBe(false)
    setSideSettings('left', { smartStart: true })
    setSideSettings('right', { smartStart: false })
    expect(smartStartFor('right', bed({}))).toBe(true)
  })
})

describe('a copy taken mid-curve', () => {
  it('starts at the curve\'s present temperature and keeps only the points to come', () => {
    const points = pointsFromNow({ id: 1, startedAt: new Date(NOW - 2.5 * HOUR), expiresAt: new Date(NOW + 6 * HOUR), setPoints: HOME_POINTS }, 'UTC', NOW)
    expect(points).toEqual([{ time: '01:00', temperature: 78 }, { time: '03:00', temperature: 80 }])
  })
})

describe('an away side following a home sleeper with Smart start on', () => {
  it('carries a copy of the home side\'s curve from where it is now', async () => {
    session('left', HOME_POINTS)
    expect(await syncFollowing('right', 'left', true, NOW - HOUR, NOW)).toBe(true)
    expect(h.start).toHaveBeenCalledWith({ side: 'right', setPoints: [{ time: '01:00', temperature: 78 }, { time: '03:00', temperature: 80 }], wakeTime: '07:00' })
    expect(followingOf('right')).toBe('left')
  })

  it('copies again only when the home side writes a new session', async () => {
    const first = session('left', HOME_POINTS)
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW)
    expect(await syncFollowing('right', 'left', true, NOW - HOUR, NOW + 30_000)).toBe(false)
    expect(h.start).toHaveBeenCalledOnce()
    db.update(runOnceSessions).set({ status: 'cancelled' }).where(eq(runOnceSessions.id, first)).run()
    session('left', [{ time: '01:01', temperature: 82 }], NOW + 60_000)
    await syncFollowing('right', 'left', true, NOW + 60_000, NOW + 90_000)
    expect(h.start).toHaveBeenCalledTimes(2)
    expect(h.start.mock.calls[1][0].setPoints[0].temperature).toBe(82)
  })

  it('refreshes its timer when the home side refreshes its own', async () => {
    session('left', HOME_POINTS)
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW)
    await syncFollowing('right', 'left', true, NOW + 6 * HOUR, NOW + 30_000)
    expect(h.reconcile).toHaveBeenCalledWith('right', true)
  })

  it('goes off with the home side, and comes back on with its next curve', async () => {
    const home = session('left', HOME_POINTS)
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW)
    db.update(runOnceSessions).set({ status: 'cancelled' }).where(eq(runOnceSessions.id, home)).run()
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW + 30_000)
    expect(active('right')).toHaveLength(0)
    expect(h.powerOff).toHaveBeenCalledWith('right')
    session('left', HOME_POINTS)
    await syncFollowing('right', 'left', true, NOW, NOW + 60_000)
    expect(active('right')).toHaveLength(1)
  })

  it('ends the away sleeper\'s own session when it starts following', async () => {
    session('right', [{ time: '22:30', temperature: 80 }])
    await syncFollowing('right', 'left', true, null, NOW)
    expect(h.cancel).toHaveBeenCalledWith({ side: 'right' })
    expect(h.powerOff).toHaveBeenCalledWith('right')
  })

  it('tries again next tick when a copy fails', async () => {
    session('left', HOME_POINTS)
    h.start.mockRejectedValueOnce(new Error('pump guard'))
    await expect(syncFollowing('right', 'left', true, NOW - HOUR, NOW)).rejects.toThrow('pump guard')
    expect(followingOf('right')).toBeNull()
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW + 30_000)
    expect(active('right')).toHaveLength(1)
    expect(listEvents(0, NOW + HOUR, ['following'])).toHaveLength(1)
  })

  it('keeps its own Smart start commands paused', async () => {
    await syncFollowing('right', 'left', true, null, NOW)
    await expect(runCommand('right', 'start-new', NOW)).rejects.toThrow('paused')
  })
})

describe('when it stops following', () => {
  it('ends the copy once its sleeper is home, and leaves the side on', async () => {
    session('left', HOME_POINTS)
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW)
    h.powerOff.mockReset()
    await syncFollowing('right', 'right', true, null, NOW + HOUR)
    expect(active('right')).toHaveLength(0)
    expect(h.powerOff).not.toHaveBeenCalled()
    expect(followingOf('right')).toBeNull()
    expect(listEvents(0, NOW + 2 * HOUR, ['following-ended'])).toHaveLength(1)
  })

  it('ends the copy and turns the side off once nobody is home', async () => {
    session('left', HOME_POINTS)
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW)
    await syncFollowing('right', null, true, null, NOW + HOUR)
    expect(active('right')).toHaveLength(0)
    expect(h.powerOff).toHaveBeenCalledWith('right')
  })

  it('hands the side to the scheduler when the home sleeper turns Smart start off', async () => {
    session('left', HOME_POINTS)
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW)
    setSideSettings('left', { smartStart: false })
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW + 30_000)
    await syncFollowing('right', 'left', true, NOW - HOUR, NOW + 60_000)
    expect(active('right')).toHaveLength(0)
    expect(h.syncMirroredSide).toHaveBeenCalledOnce()
  })

  it('hands the side to the scheduler while detection isn\'t live', async () => {
    session('left', HOME_POINTS)
    await syncFollowing('right', 'left', false, NOW - HOUR, NOW)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.syncMirroredSide).toHaveBeenCalledWith('right')
  })
})
