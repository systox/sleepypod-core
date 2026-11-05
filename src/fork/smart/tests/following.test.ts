import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  powerOff: vi.fn(),
  reconcile: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  syncMirroredSide: vi.fn(),
  applyBedConfiguration: vi.fn(),
  occupied: null as boolean | null,
  presence: {} as Record<string, { occupied: boolean | null, since: number | null, returningSince: number | null }>,
  clock: 0,
  holds: { left: null, right: null } as Record<'left' | 'right', { temperature: number, until: number } | null>,
  off: { left: false, right: false } as Record<'left' | 'right', boolean>,
  setManualLocked: vi.fn(),
  resume: vi.fn(),
}))

vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
vi.mock('@/src/temperature/instance', () => {
  const status = (side: 'left' | 'right') => {
    const hold = h.holds[side]
    return { source: hold ? 'manual' : null, requestId: null, targetTemperature: hold?.temperature ?? null, holdUntil: hold?.until ?? null, blocked: h.off[side] ? 'off' : null }
  }
  return {
    getTemperatureController: () => ({
      status, powerOff: h.powerOff, reconcile: h.reconcile, setManualLocked: h.setManualLocked, resume: h.resume,
      clearHoldLocked: (side: 'left' | 'right') => { h.holds[side] = null },
    }),
    status,
  }
})
vi.mock('@/src/mcp/caller', () => ({
  getCaller: () => ({ runOnce: { cancel: h.cancel, start: h.start } }),
}))
vi.mock('@/src/scheduler/instance', () => ({
  getJobManager: async () => ({ syncMirroredSide: h.syncMirroredSide, applyBedConfiguration: h.applyBedConfiguration }),
}))
vi.mock('../../presence/collector', () => ({
  presenceOf: (side: string) => h.presence[side] ?? { occupied: h.occupied, since: null, returningSince: null },
  sensorsFresh: () => true,
  takeEntry: () => null,
  twoBodies: () => false,
}))

import { db, sqlite } from '@/src/db'
import { deviceSettings, runOnceSessions, sideSettings } from '@/src/db/schema'
import type { BedState } from '@/src/lib/singleSleeper'
import { markPersonPower, runtime } from '../../runtime'
import { setPodSettings, setSideSettings } from '../../settings'
import { closeStore, listEvents } from '../../store'
import { bedPresenceOf, carriesHomeHold, followingOf, pointsFromNow, releaseFollowing, smartSourceOf, smartStartFor, syncFollowing } from '../following'
import { runCommand } from '../runner'

const HOUR = 3_600_000
/** 2026-11-03 01:00 UTC; the home curve started at 22:30 the evening before. */
const NOW = Date.UTC(2026, 10, 3, 1, 0)
const HOME_POINTS = [{ time: '22:30', temperature: 85 }, { time: '23:00', temperature: 83 }, { time: '00:00', temperature: 78 }, { time: '03:00', temperature: 80 }]
const COPY_POINTS = [{ time: '01:00', temperature: 78 }, { time: '03:00', temperature: 80 }]

const bed = (over: Partial<BedState> = {}): BedState => ({ bedMode: 'two', unusedZoneMode: 'follow', left: { awayMode: false }, right: { awayMode: true }, ...over })
const AWAY = bed()
const HOME = bed({ right: { awayMode: false } })
const BOTH_AWAY = bed({ left: { awayMode: true } })

function session(side: 'left' | 'right', setPoints: unknown, startedAt = NOW - 2.5 * HOUR): number {
  return db.insert(runOnceSessions).values({
    side, setPoints: JSON.stringify(setPoints), wakeTime: '07:00', startedAt: new Date(startedAt), expiresAt: new Date(NOW + 6 * HOUR),
  }).returning({ id: runOnceSessions.id }).get().id
}

function active(side: 'left' | 'right') {
  return db.select().from(runOnceSessions).where(eq(runOnceSessions.side, side)).all().filter(row => row.status === 'active')
}

function endSessions(side: 'left' | 'right') {
  db.update(runOnceSessions).set({ status: 'cancelled' }).where(eq(runOnceSessions.side, side)).run()
}

/** The away side follows the home curve, with the copy running. */
async function following() {
  session('left', HOME_POINTS)
  await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
  expect(active('right')).toHaveLength(1)
}

beforeAll(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  db.insert(deviceSettings).values({ id: 1, timezone: 'UTC', unusedZoneMode: 'follow' }).onConflictDoNothing().run()
  db.insert(sideSettings).values([{ side: 'left', name: 'Sam' }, { side: 'right', name: 'Alex' }]).onConflictDoNothing().run()
})
beforeEach(() => {
  closeStore()
  db.delete(runOnceSessions).run()
  runtime.personPower.clear()
  h.occupied = null
  h.presence = {}
  h.clock = NOW
  h.holds = { left: null, right: null }
  h.off = { left: false, right: false }
  for (const fn of [h.powerOff, h.reconcile, h.start, h.cancel, h.syncMirroredSide, h.applyBedConfiguration, h.setManualLocked, h.resume]) fn.mockReset()
  h.setManualLocked.mockImplementation(async (side: 'left' | 'right', temperature: number, ms: number) => {
    h.holds[side] = { temperature, until: h.clock + ms }
    return { holdUntil: h.clock + ms }
  })
  h.resume.mockImplementation(async (side: 'left' | 'right') => {
    h.holds[side] = null
  })
  // The fakes behave like sleepypod's: a start replaces the side's session, a cancel ends it.
  h.start.mockImplementation(async ({ side, setPoints, wakeTime }: { side: 'left' | 'right', setPoints: unknown, wakeTime: string }) => {
    endSessions(side)
    const id = db.insert(runOnceSessions).values({ side, setPoints: JSON.stringify(setPoints), wakeTime, expiresAt: new Date(NOW + 6 * HOUR) }).returning({ id: runOnceSessions.id }).get().id
    return { sessionId: id }
  })
  h.cancel.mockImplementation(async ({ side }: { side: 'left' | 'right' }) => endSessions(side))
  setPodSettings({ followSmartStart: true })
  setSideSettings('left', { smartStart: true })
  setSideSettings('right', { smartStart: false })
})
afterAll(() => {
  closeStore()
  sqlite.close()
})

describe('whose Smart start setting counts', () => {
  it('is the home sleeper\'s for an empty side that follows them, and the side\'s own otherwise', () => {
    expect(smartSourceOf('left', AWAY)).toBe('left')
    expect(smartSourceOf('right', AWAY)).toBe('left')
    expect(smartSourceOf('right', bed({ unusedZoneMode: 'off' }))).toBe('right')
    expect(smartSourceOf('right', bed({ unusedZoneMode: 'independent' }))).toBe('right')
    expect(smartSourceOf('right', BOTH_AWAY)).toBe('right')
  })

  it('is always the side\'s own with the setting off', () => {
    setPodSettings({ followSmartStart: false })
    expect(smartSourceOf('right', AWAY)).toBe('right')
    expect(followingOf('right', AWAY)).toBeNull()
  })

  it('takes the home sleeper\'s on or off, whatever the away side has', () => {
    setSideSettings('left', { smartStart: false })
    setSideSettings('right', { smartStart: true })
    expect(smartStartFor('right', AWAY)).toBe(false)
    setSideSettings('left', { smartStart: true })
    setSideSettings('right', { smartStart: false })
    expect(smartStartFor('right', AWAY)).toBe(true)
  })

  it('says whether the side is away or unused', () => {
    expect(followingOf('right', AWAY)).toEqual({ leader: 'left', why: 'away', dismissed: false })
    expect(followingOf('right', bed({ bedMode: 'solo-left', right: { awayMode: false } }))).toEqual({ leader: 'left', why: 'unused', dismissed: false })
    expect(followingOf('left', AWAY)).toBeNull()
  })
})

describe('a copy taken mid-curve', () => {
  it('starts at the curve\'s present temperature and keeps only the points to come', () => {
    const points = pointsFromNow({ id: 1, startedAt: new Date(NOW - 2.5 * HOUR), expiresAt: new Date(NOW + 6 * HOUR), setPoints: HOME_POINTS }, 'UTC', NOW)
    expect(points).toEqual(COPY_POINTS)
  })
})

describe('an away side following a home sleeper with Smart start on', () => {
  it('carries a copy of the home side\'s curve from where it is now', async () => {
    session('left', HOME_POINTS)
    expect(await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)).toBe('started')
    expect(h.start).toHaveBeenCalledWith({ side: 'right', setPoints: COPY_POINTS, wakeTime: '07:00' })
    expect(followingOf('right', AWAY)?.leader).toBe('left')
  })

  it('copies again only when the home side writes a new session', async () => {
    const first = session('left', HOME_POINTS)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
    expect(await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 30_000)).toBeNull()
    expect(h.start).toHaveBeenCalledOnce()
    db.update(runOnceSessions).set({ status: 'cancelled' }).where(eq(runOnceSessions.id, first)).run()
    session('left', [{ time: '01:01', temperature: 82 }], NOW + 60_000)
    await syncFollowing('right', AWAY, true, NOW + 60_000, NOW + 90_000)
    expect(h.start).toHaveBeenCalledTimes(2)
    expect(h.start.mock.calls[1][0].setPoints[0].temperature).toBe(82)
  })

  it('refreshes its timer when the home side refreshes its own', async () => {
    await following()
    await syncFollowing('right', AWAY, true, NOW + 6 * HOUR, NOW + 30_000)
    expect(h.reconcile).toHaveBeenCalledWith('right', true)
  })

  it('goes off with the home side, and comes back on with its next curve', async () => {
    await following()
    endSessions('left')
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 30_000)
    expect(active('right')).toHaveLength(0)
    expect(h.powerOff).toHaveBeenCalledWith('right')
    session('left', HOME_POINTS)
    await syncFollowing('right', AWAY, true, NOW, NOW + 60_000)
    expect(active('right')).toHaveLength(1)
  })

  it('ends the away sleeper\'s own session when it starts following', async () => {
    session('right', [{ time: '22:30', temperature: 80 }])
    await syncFollowing('right', AWAY, true, null, NOW)
    expect(h.cancel).toHaveBeenCalledWith({ side: 'right' })
    expect(h.powerOff).toHaveBeenCalledWith('right')
  })

  it('turns the side off when Smart start takes it over from the scheduler with no curve running', async () => {
    await syncFollowing('right', AWAY, false, null, NOW)
    expect(h.syncMirroredSide).toHaveBeenCalledWith('right')
    h.powerOff.mockReset()
    await syncFollowing('right', AWAY, true, null, NOW + 30_000)
    expect(h.powerOff).toHaveBeenCalledWith('right')
  })

  it('tries again next tick when a copy fails', async () => {
    session('left', HOME_POINTS)
    h.start.mockRejectedValueOnce(new Error('pump guard'))
    await expect(syncFollowing('right', AWAY, true, NOW - HOUR, NOW)).rejects.toThrow('pump guard')
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 30_000)
    expect(active('right')).toHaveLength(1)
    expect(listEvents(0, NOW + HOUR, ['following'])).toHaveLength(1)
  })

  it('keeps its own Smart start commands paused from the moment it is away, naming whom it follows', async () => {
    db.update(sideSettings).set({ awayMode: true }).where(eq(sideSettings.side, 'right')).run()
    try {
      await expect(runCommand('right', 'start-new', NOW)).rejects.toThrow('This side follows Sam\'s curve and Smart start while its sleeper is away')
    }
    finally {
      db.update(sideSettings).set({ awayMode: false }).where(eq(sideSettings.side, 'right')).run()
    }
  })
})

describe('a person who doesn\'t want the empty side on', () => {
  it('ends its curve, and it stays off until the home curve is over', async () => {
    await following()
    endSessions('right')
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 30_000)
    expect(h.start).toHaveBeenCalledOnce()
    expect(followingOf('right', AWAY)?.dismissed).toBe(true)
    // A hold on the home side is a new session, and still doesn't bring it back.
    session('left', [{ time: '01:01', temperature: 80 }], NOW + 60_000)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 90_000)
    expect(h.start).toHaveBeenCalledOnce()
    expect(listEvents(0, NOW + HOUR, ['following-dismissed'])).toHaveLength(1)
    // Once the home curve is over, the next one is followed again.
    endSessions('left')
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 120_000)
    expect(followingOf('right', AWAY)?.dismissed).toBe(false)
    session('left', HOME_POINTS)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 150_000)
    expect(h.start).toHaveBeenCalledTimes(2)
  })

  it('turns it off, and it follows again once they turn it back on', async () => {
    await following()
    markPersonPower('right', false, NOW + 20_000)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 30_000)
    expect(active('right')).toHaveLength(0)
    expect(followingOf('right', AWAY)?.dismissed).toBe(true)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 60_000)
    expect(h.start).toHaveBeenCalledOnce()
    markPersonPower('right', true, NOW + 80_000)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 90_000)
    expect(h.start).toHaveBeenCalledTimes(2)
    expect(active('right')).toHaveLength(1)
  })
})

describe('when it stops following', () => {
  it('turns the side off for a sleeper back but not in bed, so their own Smart start begins it', async () => {
    setSideSettings('right', { smartStart: true })
    await following()
    h.occupied = false
    expect(await syncFollowing('right', HOME, true, null, NOW + HOUR)).toBeNull()
    expect(active('right')).toHaveLength(0)
    expect(h.powerOff).toHaveBeenCalledWith('right')
    expect(followingOf('right', HOME)).toBeNull()
    expect(listEvents(0, NOW + 2 * HOUR, ['following-ended'])).toHaveLength(1)
  })

  it('lets the copy run on for a sleeper back and already in bed', async () => {
    setSideSettings('right', { smartStart: true })
    await following()
    h.occupied = true
    expect(await syncFollowing('right', HOME, true, null, NOW + HOUR)).toBe('back-in-bed')
    expect(active('right')).toHaveLength(1)
    expect(h.powerOff).not.toHaveBeenCalled()
  })

  it('ends the copy and leaves the side to the scheduler for a sleeper back without Smart start', async () => {
    await following()
    await syncFollowing('right', HOME, true, null, NOW + HOUR)
    expect(active('right')).toHaveLength(0)
    expect(h.powerOff).not.toHaveBeenCalled()
  })

  it('ends the copy and turns the side off once nobody is home', async () => {
    await following()
    await syncFollowing('right', BOTH_AWAY, true, null, NOW + HOUR)
    expect(active('right')).toHaveLength(0)
    expect(h.powerOff).toHaveBeenCalledWith('right')
  })

  it('hands a side still away back to the scheduler\'s mirror once the setting is off', async () => {
    await following()
    setPodSettings({ followSmartStart: false })
    await syncFollowing('right', AWAY, true, null, NOW + HOUR)
    expect(active('right')).toHaveLength(0)
    expect(h.syncMirroredSide).toHaveBeenCalledWith('right')
  })

  it('hands the side to the scheduler when the home sleeper turns Smart start off', async () => {
    await following()
    setSideSettings('left', { smartStart: false })
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 30_000)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + 60_000)
    expect(active('right')).toHaveLength(0)
    expect(h.syncMirroredSide).toHaveBeenCalledOnce()
  })

  it('hands the side to the scheduler while detection isn\'t live', async () => {
    session('left', HOME_POINTS)
    await syncFollowing('right', AWAY, false, NOW - HOUR, NOW)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.syncMirroredSide).toHaveBeenCalledWith('right')
  })

  it('ends the copies and gives the bed back to sleepypod when the service turns itself off', async () => {
    await following()
    await releaseFollowing(NOW + 30_000)
    expect(active('right')).toHaveLength(0)
    expect(followingOf('right', HOME)).toBeNull()
    expect(h.applyBedConfiguration).toHaveBeenCalledOnce()
  })
})

describe('holds on the home side', () => {
  const MIN = 60_000

  it('hold the away side too, once, with the same end', async () => {
    await following()
    h.holds.left = { temperature: 79, until: NOW + HOUR }
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
    expect(h.setManualLocked).toHaveBeenCalledWith('right', 79, HOUR + MIN)
    expect(h.holds.right).toEqual({ temperature: 79, until: NOW + HOUR + MIN })
    expect(carriesHomeHold('right', NOW + HOUR + MIN)).toBe(true)
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + MIN)
    expect(h.setManualLocked).toHaveBeenCalledOnce()
  })

  it('carry each Smooth return step across, and end with the home side', async () => {
    await following()
    h.holds.left = { temperature: 79, until: NOW + HOUR }
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
    h.holds.left = { temperature: 80, until: NOW + HOUR + 22 * MIN }
    h.clock = NOW + HOUR - MIN
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + HOUR - MIN)
    expect(h.holds.right).toEqual({ temperature: 80, until: NOW + HOUR + 23 * MIN })
    h.holds.left = null
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + HOUR + MIN)
    expect(h.resume).toHaveBeenCalledWith('right')
    expect(h.holds.right).toBeNull()
  })

  it('match the home side while it holds, and leave the away side its own hold after', async () => {
    await following()
    h.holds.left = { temperature: 79, until: NOW + HOUR }
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
    h.holds.right = null
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
    expect(h.holds.right).toEqual({ temperature: 79, until: NOW + HOUR + MIN })
    h.holds.right = { temperature: 84, until: NOW + 30 * MIN }
    h.holds.left = null
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW + MIN)
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.holds.right).toEqual({ temperature: 84, until: NOW + 30 * MIN })
  })

  it('reach the away side under the weekly schedule too', async () => {
    setSideSettings('left', { smartStart: false })
    h.holds.left = { temperature: 88, until: NOW + HOUR }
    await syncFollowing('right', AWAY, true, null, NOW)
    expect(h.holds.right).toEqual({ temperature: 88, until: NOW + HOUR + MIN })
  })

  it('never turn on an away side that is off', async () => {
    h.off.right = true
    await following()
    h.holds.left = { temperature: 79, until: NOW + HOUR }
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('end on the away side once its sleeper is home', async () => {
    await following()
    h.holds.left = { temperature: 79, until: NOW + HOUR }
    await syncFollowing('right', AWAY, true, NOW - HOUR, NOW)
    await syncFollowing('right', HOME, true, null, NOW + MIN)
    expect(h.holds.right).toBeNull()
  })
})

describe('the whole bed is the home sleeper’s', () => {
  const view = (occupied: boolean | null, since: number | null, returningSince: number | null = null) => ({ occupied, since, returningSince })

  it('counts lying on the away side as being in bed', () => {
    h.presence = { left: view(false, NOW - HOUR), right: view(true, NOW - 10 * 60_000) }
    expect(bedPresenceOf('left', AWAY)).toEqual(view(true, NOW - 10 * 60_000))
  })

  it('is empty only when both sides are, since the last one left', () => {
    h.presence = { left: view(false, NOW - HOUR), right: view(false, NOW - 5 * 60_000, NOW - 60_000) }
    expect(bedPresenceOf('left', AWAY)).toEqual(view(false, NOW - 5 * 60_000, NOW - 60_000))
  })

  it('is the side’s own while nobody is away', () => {
    h.presence = { left: view(false, NOW - HOUR), right: view(true, NOW) }
    expect(bedPresenceOf('left', HOME)).toEqual(view(false, NOW - HOUR))
  })
})
