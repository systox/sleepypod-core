import type * as Drizzle from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  powered: { left: false, right: false } as Record<'left' | 'right', boolean>,
  rows: [] as Array<Record<string, unknown>>,
  synced: true,
  runPowerOnJob: vi.fn(),
}))

// Conditions come through as the side they name, so the fake database can answer per side.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof Drizzle>()
  return { ...actual, eq: (_column: unknown, value: unknown) => value, and: (...conditions: unknown[]) => conditions[0] }
})
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (side: 'left' | 'right') => ({
          get: () => ({ isPowered: h.powered[side] }),
          all: () => h.rows.filter(row => row.side === side),
        }),
      }),
    }),
  },
}))
vi.mock('@/src/hardware/deviceStateSync', () => ({ hasFirmwareSynced: () => h.synced }))
vi.mock('@/src/scheduler/instance', () => ({ getJobManager: async () => ({ runPowerOnJob: h.runPowerOnJob }) }))
vi.mock('../clock', () => ({ deviceTimezone: () => 'UTC' }))

import { activePowerRow, powerResumedAt, resetPowerResume, syncPowerResume } from '../powerResume'
import { setPodSettings } from '../settings'
import { closeStore, listEvents, writeKey } from '../store'

/** Wednesday 4 November 2026, 02:00 UTC: inside Tuesday night's curve. */
const WED_2AM = Date.UTC(2026, 10, 4, 2, 0)
const HOUR = 3_600_000
const tuesday = { id: 7, side: 'left', dayOfWeek: 'tuesday', onTime: '23:00', offTime: '14:00', onTemperature: 82, enabled: true, endAction: 'turn_off' }

beforeEach(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  closeStore()
  resetPowerResume()
  h.powered = { left: false, right: false }
  h.rows = [tuesday]
  h.synced = true
  h.runPowerOnJob.mockReset().mockImplementation(async (row: { side: 'left' | 'right' }) => {
    h.powered[row.side] = true
  })
  setPodSettings({ resumeAfterPowerCut: true })
})

describe('the power window', () => {
  it('holds from a curve\'s start until its end the next day', () => {
    expect(activePowerRow(h.rows as never, 'UTC', WED_2AM)).toMatchObject({ id: 7 })
    expect(activePowerRow(h.rows as never, 'UTC', WED_2AM + 13 * HOUR)).toBeNull()
    expect(activePowerRow(h.rows as never, 'UTC', WED_2AM - 4 * HOUR)).toBeNull()
  })
})

describe('the power window, with more than one row', () => {
  it('goes by the row that started last, even when an older one never ends', () => {
    const friday = { ...tuesday, id: 1, dayOfWeek: 'friday', endAction: 'maintain' }
    const saturday = { ...tuesday, id: 2, dayOfWeek: 'saturday', offTime: '07:00' }
    /** Sunday 8 November 2026, 15:00 UTC: Saturday's curve has ended. */
    const sundayAfternoon = Date.UTC(2026, 10, 8, 15, 0)
    expect(activePowerRow([friday, saturday] as never, 'UTC', sundayAfternoon)).toBeNull()
    expect(activePowerRow([friday, saturday] as never, 'UTC', Date.UTC(2026, 10, 8, 3, 0))).toMatchObject({ id: 2 })
  })
})

describe('after a restart', () => {
  it('waits for the clock before checking', async () => {
    writeKey('power-seen', { left: { powered: true, at: WED_2AM - HOUR } })
    await syncPowerResume(Date.UTC(2010, 0, 1))
    await syncPowerResume(WED_2AM - 2 * HOUR)
    expect(h.runPowerOnJob).not.toHaveBeenCalled()
    await syncPowerResume(WED_2AM)
    expect(h.runPowerOnJob).toHaveBeenCalledOnce()
  })

  it('tries a power-on that failed a few more times', async () => {
    writeKey('power-seen', { left: { powered: true, at: WED_2AM - HOUR } })
    h.runPowerOnJob.mockRejectedValueOnce(new Error('not connected yet'))
    await syncPowerResume(WED_2AM)
    await syncPowerResume(WED_2AM + 15_000)
    expect(h.runPowerOnJob).toHaveBeenCalledTimes(2)
    expect(powerResumedAt('left')).toBe(WED_2AM + 15_000)
  })

  it('turns a side back on that was on and is still inside its curve', async () => {
    writeKey('power-seen', { left: { powered: true, at: WED_2AM - HOUR } })
    await syncPowerResume(WED_2AM)
    expect(h.runPowerOnJob).toHaveBeenCalledWith(tuesday)
    expect(powerResumedAt('left')).toBe(WED_2AM)
    expect(listEvents(0, WED_2AM + 1, ['power-resumed'])).toHaveLength(1)
  })

  it('leaves a side off that someone turned off before the restart', async () => {
    writeKey('power-seen', { left: { powered: false, at: WED_2AM - HOUR } })
    await syncPowerResume(WED_2AM)
    expect(h.runPowerOnJob).not.toHaveBeenCalled()
  })

  it('leaves a side off once its curve has ended', async () => {
    writeKey('power-seen', { left: { powered: true, at: WED_2AM - HOUR } })
    await syncPowerResume(WED_2AM + 13 * HOUR)
    expect(h.runPowerOnJob).not.toHaveBeenCalled()
  })

  it('does nothing with the setting off, or before the firmware reports in', async () => {
    writeKey('power-seen', { left: { powered: true, at: WED_2AM - HOUR } })
    h.synced = false
    await syncPowerResume(WED_2AM)
    setPodSettings({ resumeAfterPowerCut: false })
    h.synced = true
    await syncPowerResume(WED_2AM)
    expect(h.runPowerOnJob).not.toHaveBeenCalled()
  })

  it('checks only once, then just notes each side\'s power', async () => {
    writeKey('power-seen', { left: { powered: true, at: WED_2AM - HOUR } })
    h.runPowerOnJob.mockImplementation(async () => {})
    await syncPowerResume(WED_2AM)
    await syncPowerResume(WED_2AM + 15_000)
    expect(h.runPowerOnJob).toHaveBeenCalledOnce()
    expect(powerResumedAt('left')).toBeNull()
  })
})
