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
vi.mock('../presence/collector', () => ({ presenceOf: () => ({ occupied: false, since: null }) }))

import { db, sqlite } from '@/src/db'
import { curveTemplates, temperatureSchedules } from '@/src/db/schema'
import { setSideSettings } from '../settings'
import { closeStore, logEvent } from '../store'
import { acceptSuggestion, dismissSuggestion, shiftPart, suggestionsFor } from '../suggestions'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const BED = Date.UTC(2026, 10, 1, 4, 0)

describe('moving one hour of a curve', () => {
  const points = { '23:00': 84, '00:00': 82, '01:00': 80, '05:00': 84 }

  it('adds edges so the rest of the curve keeps its temperatures', () => {
    expect(shiftPart(points, '23:00', '05:00', 180, 240, 1, 55, 90)).toEqual({
      '23:00': 84, '00:00': 82, '01:00': 80, '02:00': 81, '03:00': 80, '05:00': 84,
    })
  })

  it('moves points already in the hour and keeps the allowed range', () => {
    expect(shiftPart(points, '23:00', '05:00', 0, 60, 8, 55, 90)).toEqual({ '23:00': 90, '00:00': 82, '01:00': 80, '05:00': 84 })
  })

  it('leaves a curve alone past its end', () => {
    expect(shiftPart(points, '23:00', '05:00', 600, 660, 1, 55, 90)).toEqual(points)
  })

  it('leaves a wind-down point before bedtime alone and adds nothing after wake', () => {
    const windDown = { '22:30': 84, '01:00': 80, '07:00': 84, '21:45': 82 }
    expect(shiftPart(windDown, '22:30', '07:00', 480, 540, 1, 55, 90)).toEqual({ ...windDown, '06:30': 81 })
    expect(shiftPart(windDown, '22:30', '07:00', 510, 570, 1, 55, 90)).toEqual(windDown)
  })
})

describe('morning suggestions', () => {
  let curveId: number

  function night(n: number, presses: number[] = [], top = true): void {
    const bedtime = BED + n * DAY
    logEvent('left', 'night', { bedtime, curveId, curveName: 'Off week' }, bedtime)
    for (const at of presses) logEvent('left', 'press', { buttons: top ? ['top', 'top'] : ['bottom'] }, bedtime + at)
  }

  beforeAll(() => {
    migrate(db, { migrationsFolder: 'src/db/migrations' })
  })
  beforeEach(() => {
    process.env.FORK_DATABASE_PATH = ':memory:'
    closeStore()
    db.delete(temperatureSchedules).run()
    db.delete(curveTemplates).run()
    curveId = db.insert(curveTemplates).values({
      name: 'Off week', bedtime: '23:00', wake: '05:00', points: { '23:00': 84, '00:00': 82, '01:00': 80, '05:00': 84 },
      reasoning: '', leftDays: ['monday'], rightDays: [], active: true, createdAt: new Date(), updatedAt: new Date(),
    } as never).returning().get().id
    setSideSettings('left', { suggestOn: true })
  })
  afterAll(() => {
    closeStore()
    sqlite.close()
  })

  it('offers a degree for an hour that drew presses the same way on 2 of 3 nights', () => {
    night(0, [2.5 * HOUR])
    night(1, [])
    night(2, [2.2 * HOUR, 2.4 * HOUR])
    const [suggestion, ...rest] = suggestionsFor('left', BED + 3 * DAY)
    expect(rest).toEqual([])
    expect(suggestion).toMatchObject({ side: 'left', curveId, from: '01:00', to: '02:00', delta: 1, nights: 2, of: 3 })
  })

  it('ignores presses just after the other person gets in', () => {
    night(0, [2.5 * HOUR])
    night(2, [2.5 * HOUR])
    logEvent('right', 'in', undefined, BED + 2 * DAY + 2.5 * HOUR - 5 * MIN)
    expect(suggestionsFor('left', BED + 3 * DAY)).toEqual([])
  })

  it('says nothing with presses both ways, or with the setting off', () => {
    night(0, [2.5 * HOUR])
    logEvent('left', 'press', { buttons: ['bottom'] }, BED + 2.6 * HOUR)
    night(1, [2.5 * HOUR])
    night(2, [2.5 * HOUR], false)
    expect(suggestionsFor('left', BED + 3 * DAY)).toEqual([])
    setSideSettings('left', { suggestOn: false })
    expect(suggestionsFor('left', BED + 3 * DAY)).toEqual([])
  })

  it('changes the saved curve when accepted, and only once', async () => {
    night(0, [2.5 * HOUR])
    night(2, [2.5 * HOUR])
    const now = BED + 3 * DAY
    const [suggestion] = suggestionsFor('left', now)
    await acceptSuggestion('left', suggestion.id, now)
    const saved = db.select().from(curveTemplates).where(eq(curveTemplates.id, curveId)).get()
    expect(saved?.points).toMatchObject({ '01:00': 81, '02:00': 80 })
    expect(db.select().from(temperatureSchedules).where(eq(temperatureSchedules.time, '02:00')).all()).toHaveLength(1)
    expect(suggestionsFor('left', now)).toEqual([])
  })

  it('starts afresh after a change, so the same shift is not offered again', async () => {
    night(0, [2.5 * HOUR])
    night(1, [2.5 * HOUR])
    const accepted = BED + 2 * DAY
    await acceptSuggestion('left', suggestionsFor('left', accepted)[0].id, accepted)
    night(2, [2.5 * HOUR])
    expect(suggestionsFor('left', BED + 3 * DAY)).toEqual([])
  })

  it('stays away once dismissed', () => {
    night(0, [2.5 * HOUR])
    night(2, [2.5 * HOUR])
    const now = BED + 3 * DAY
    dismissSuggestion('left', suggestionsFor('left', now)[0].id)
    expect(suggestionsFor('left', now)).toEqual([])
  })
})
