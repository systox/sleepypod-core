/** Starting and ending one big side (docs/fork/one-big-side.md, section 5 and rule 10). */
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  occupied: null as boolean | null,
  powerOff: vi.fn(),
  cancel: vi.fn(),
  applyBedConfiguration: vi.fn(),
  setRunAside: vi.fn(),
  clearFade: vi.fn(),
  clearSurface: vi.fn(),
  noteEntry: vi.fn(),
}))

vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: () => false }))
vi.mock('@/src/temperature/instance', () => ({ getTemperatureController: () => ({ powerOff: h.powerOff }) }))
vi.mock('@/src/scheduler/instance', () => ({ getJobManager: async () => ({ applyBedConfiguration: h.applyBedConfiguration }) }))
vi.mock('../../caller', () => ({ caller: async () => ({ runOnce: { cancel: h.cancel } }) }))
vi.mock('../../presence/collector', () => ({
  presenceOf: () => ({ occupied: h.occupied, since: null, returningSince: null }),
  sensorsFresh: () => true,
  noteEntry: h.noteEntry,
}))
vi.mock('../runner', () => ({ setRunAside: h.setRunAside }))
vi.mock('../../holds', () => ({ clearFade: h.clearFade }))
vi.mock('../../surface', () => ({ clearSurface: h.clearSurface }))

import { db, sqlite } from '@/src/db'
import { deviceSettings, deviceState, runOnceSessions, sideSettings, temperatureHolds } from '@/src/db/schema'
import type { BedState } from '@/src/lib/singleSleeper'
import { runtime } from '../../runtime'
import { setSideSettings } from '../../settings'
import { closeStore, listEvents, readKey, writeKey } from '../../store'
import { followingOf, releaseOneSide, syncOneSide } from '../oneSideNight'

const NOW = Date.now()
const MIN = 60_000

const bed = (over: Partial<BedState> = {}): BedState => ({ bedMode: 'two', unusedZoneMode: 'follow', left: { awayMode: false }, right: { awayMode: true }, ...over })
const AWAY = bed()
const HOME = bed({ right: { awayMode: false } })
const BOTH_AWAY = bed({ left: { awayMode: true } })

/** What the away sleeper's half was doing before the bed became one side. */
function leftovers(): void {
  db.insert(runOnceSessions).values({ side: 'right', setPoints: '[]', wakeTime: '07:00', expiresAt: new Date(NOW + 6 * 60 * MIN) }).run()
  db.insert(temperatureHolds).values({ side: 'right', temperature: 70, startedAt: NOW, expiresAt: NOW + 60 * MIN }).run()
  db.insert(deviceState).values({ side: 'right', hardwareDeadline: NOW + 60 * MIN }).run()
}

beforeAll(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  db.insert(deviceSettings).values({ id: 1, timezone: 'UTC', unusedZoneMode: 'follow' }).onConflictDoNothing().run()
  db.insert(sideSettings).values([{ side: 'left', name: 'Sam' }, { side: 'right', name: 'Alex' }]).onConflictDoNothing().run()
})
beforeEach(() => {
  closeStore()
  runtime.running = true
  runtime.disabled = null
  runtime.lastBeat = Date.now()
  runtime.ownershipStaleMs = 2 * MIN
  h.occupied = null
  for (const fn of [h.powerOff, h.cancel, h.applyBedConfiguration, h.setRunAside, h.clearFade, h.clearSurface, h.noteEntry]) fn.mockReset()
  db.delete(runOnceSessions).run()
  db.delete(temperatureHolds).run()
  db.delete(deviceState).run()
  setSideSettings('right', { smartStart: true })
})
afterAll(() => {
  runtime.running = false
  closeStore()
  sqlite.close()
})

describe('the bed becomes one side', () => {
  it('ends what the away sleeper\'s half was doing and sets its run aside, once', async () => {
    leftovers()
    writeKey('following:right', { leader: 'left' })
    await syncOneSide('right', AWAY, true, NOW)
    expect(h.cancel).toHaveBeenCalledWith({ side: 'right' })
    expect(db.select().from(temperatureHolds).where(eq(temperatureHolds.side, 'right')).get()).toBeUndefined()
    expect(db.select().from(deviceState).where(eq(deviceState.side, 'right')).get()?.hardwareDeadline).toBeNull()
    expect(h.clearFade).toHaveBeenCalledWith('right')
    expect(h.clearSurface).toHaveBeenCalledWith('right')
    expect(h.setRunAside).toHaveBeenCalledWith('right')
    expect(readKey('following:right')).toBeNull()
    expect(listEvents(0, NOW + 1, ['one-side'])).toHaveLength(1)
    // Nothing more on the next tick.
    await syncOneSide('right', AWAY, true, NOW + 30_000)
    expect(h.setRunAside).toHaveBeenCalledOnce()
    // The home side has nothing to start or end.
    await syncOneSide('left', AWAY, true, NOW)
    expect(listEvents(0, NOW + 60_000, ['one-side', 'one-side-ended'])).toHaveLength(1)
  })

  it('says whose bed the half is part of, for the app', () => {
    expect(followingOf('right', AWAY)).toEqual({ leader: 'left', why: 'away' })
    expect(followingOf('right', bed({ bedMode: 'solo-left', right: { awayMode: false } }))).toEqual({ leader: 'left', why: 'unused' })
    expect(followingOf('left', AWAY)).toBeNull()
    expect(followingOf('right', HOME)).toBeNull()
  })
})

describe('the bed is two sides again (rule 10)', () => {
  it('starts the returning sleeper\'s curve when they are already lying on their half', async () => {
    await syncOneSide('right', AWAY, true, NOW)
    h.occupied = true
    await syncOneSide('right', HOME, true, NOW + MIN)
    expect(h.noteEntry).toHaveBeenCalledWith('right', NOW + MIN)
    expect(h.powerOff).not.toHaveBeenCalled()
    expect(listEvents(0, NOW + 2 * MIN, ['one-side-ended'])).toHaveLength(1)
  })

  it('turns the half off until they get in, when they aren\'t in bed', async () => {
    await syncOneSide('right', AWAY, true, NOW)
    h.occupied = false
    await syncOneSide('right', HOME, true, NOW + MIN)
    expect(h.powerOff).toHaveBeenCalledWith('right')
    expect(h.noteEntry).not.toHaveBeenCalled()
  })

  it('leaves the half on when presence can\'t tell whether they are lying on it', async () => {
    await syncOneSide('right', AWAY, true, NOW)
    h.occupied = null
    await syncOneSide('right', HOME, true, NOW + MIN)
    expect(h.powerOff).not.toHaveBeenCalled()
    expect(h.noteEntry).not.toHaveBeenCalled()
  })

  it('leaves the half to sleepypod when both are away, Smart start is off, or detection isn\'t live', async () => {
    // The ticks span minutes; the service's heartbeat must count as fresh throughout.
    runtime.ownershipStaleMs = 60 * MIN
    await syncOneSide('right', AWAY, true, NOW)
    await syncOneSide('right', BOTH_AWAY, true, NOW + MIN)
    await syncOneSide('right', AWAY, true, NOW + 2 * MIN)
    setSideSettings('right', { smartStart: false })
    await syncOneSide('right', HOME, true, NOW + 3 * MIN)
    setSideSettings('right', { smartStart: true })
    await syncOneSide('right', AWAY, true, NOW + 4 * MIN)
    await syncOneSide('right', HOME, false, NOW + 5 * MIN)
    expect(h.powerOff).not.toHaveBeenCalled()
    expect(h.noteEntry).not.toHaveBeenCalled()
    expect(listEvents(0, NOW + 6 * MIN, ['one-side-ended'])).toHaveLength(3)
  })

  it('ends when the service goes quiet, so the bed falls back to stock (rule 11)', async () => {
    await syncOneSide('right', AWAY, true, NOW)
    runtime.lastBeat = NOW - 3 * MIN
    await syncOneSide('right', AWAY, true, NOW)
    expect(readKey('one-side:right')).toBeNull()
  })

  it('drops the marks and hands the bed back to sleepypod when the service disables itself', async () => {
    await syncOneSide('right', AWAY, true, NOW)
    await releaseOneSide(NOW + MIN)
    expect(readKey('one-side:right')).toBeNull()
    expect(h.applyBedConfiguration).toHaveBeenCalledOnce()
    // A later start runs the start steps again.
    await syncOneSide('right', AWAY, true, NOW + 2 * MIN)
    expect(h.setRunAside).toHaveBeenCalledTimes(2)
  })
})
