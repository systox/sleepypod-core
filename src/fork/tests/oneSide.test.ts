/**
 * One big side's core (docs/fork/one-big-side.md, rules 1 to 5 and 9): who
 * owns each half, the controller's view of the empty half, and the empty
 * half's step in the 1-second tick. The real controller runs over fake
 * hardware; the bed configuration lives in an in-memory database.
 */
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  blocked: { left: false, right: false } as Record<'left' | 'right', boolean>,
}))

vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: (side: 'left' | 'right') => h.blocked[side] }))

import { db, sqlite } from '@/src/db'
import { deviceSettings, deviceState, sideSettings } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import type { BedState } from '@/src/lib/singleSleeper'
import { TemperatureController, type TemperatureRequest } from '@/src/temperature/controller'
import { awayHalfOf, awayHalfReason, bedOwnerOf, clearOwed, controlSideOf, lastWrittenTo, oweWrite, refuseAwayHalfPlan, tickHalf, withOneSide } from '../oneSide'
import { runtime } from '../runtime'

const MIN = 60_000
const live = () => true

const bed = (over: Partial<BedState> = {}): BedState => ({ bedMode: 'two', unusedZoneMode: 'follow', left: { awayMode: false }, right: { awayMode: true }, ...over })

/** The bed as the database has it: right away and following, unless said otherwise. */
function setBed(state: BedState): void {
  db.update(deviceSettings).set({ bedMode: state.bedMode ?? 'two', unusedZoneMode: state.unusedZoneMode ?? 'off' }).where(eq(deviceSettings.id, 1)).run()
  for (const side of ['left', 'right'] as const) {
    db.update(sideSettings).set({ awayMode: Boolean(state[side]?.awayMode) }).where(eq(sideSettings.side, side)).run()
  }
}

/** What the firmware last reported for a half: the stock sync writes this row. */
function report(side: Side, target: number | null, powered = target !== null): void {
  db.insert(deviceState).values({ side, targetTemperature: target, isPowered: powered })
    .onConflictDoUpdate({ target: deviceState.side, set: { targetTemperature: target, isPowered: powered } }).run()
}

function reported(side: Side): number | null {
  return db.select().from(deviceState).where(eq(deviceState.side, side)).get()?.targetTemperature ?? null
}

/** Fake hardware and plan store behind the real controller, wrapped as instance.ts wraps it. */
function rig() {
  const holds: Record<Side, TemperatureRequest | null> = { left: null, right: null }
  const baseline: Record<Side, TemperatureRequest[]> = { left: [], right: [] }
  const powered: Record<Side, boolean> = { left: false, right: false }
  const writes: Array<[Side, number]> = []
  const offs: Side[] = []
  let clock = Date.now()
  const controller = new TemperatureController(withOneSide({
    now: () => clock,
    withSideLock: (_side, fn) => fn(),
    readHold: side => holds[side],
    writeHold: (side, hold) => {
      holds[side] = hold
    },
    readBaseline: side => baseline[side],
    isPowered: side => powered[side],
    readCurrentTarget: side => reported(side),
    readHardwareDeadline: () => null,
    writeHardwareDeadline: () => {},
    isBlocked: side => h.blocked[side],
    defaultHoldMs: side => (side === 'left' ? 60 * MIN : 15 * MIN),
    connect: async () => {},
    apply: async (side, temperature) => {
      powered[side] = true
      writes.push([side, temperature])
      report(side, temperature)
    },
    powerOff: async (side) => {
      powered[side] = false
      offs.push(side)
      report(side, null, false)
    },
    publish: () => {},
  }))
  const curve = (side: Side, temperature: number): TemperatureRequest => ({
    id: `curve:${side}`, source: 'run-once', temperature, startsAt: clock - MIN, expiresAt: clock + 8 * 60 * MIN, createdAt: clock - MIN, priority: 0,
  })
  return {
    controller, holds, baseline, powered, writes, offs, curve,
    advance: (ms: number) => {
      clock += ms
    },
    /** Turn a half on through the controller, as an app power-on would. */
    on: async (side: Side) => {
      await controller.powerOnLocked(side)
    },
  }
}

beforeAll(() => {
  migrate(db, { migrationsFolder: 'src/db/migrations' })
  db.insert(deviceSettings).values({ id: 1, timezone: 'UTC', unusedZoneMode: 'follow' }).onConflictDoNothing().run()
  db.insert(sideSettings).values([{ side: 'left', name: 'Sam' }, { side: 'right', name: 'Alex' }]).onConflictDoNothing().run()
})
beforeEach(() => {
  runtime.running = true
  runtime.disabled = null
  runtime.lastBeat = Date.now()
  runtime.ownershipStaleMs = 2 * MIN
  runtime.pressing.clear()
  h.blocked = { left: false, right: false }
  clearOwed()
  db.delete(deviceState).run()
  setBed(bed())
})
afterAll(() => {
  runtime.running = false
  sqlite.close()
})

describe('whose bed a half is', () => {
  it('is the home sleeper\'s for the empty half that matches them, and its own otherwise', () => {
    expect(bedOwnerOf('right', bed())).toBe('left')
    expect(bedOwnerOf('left', bed())).toBe('left')
    expect(bedOwnerOf('right', bed({ unusedZoneMode: 'off' }))).toBe('right')
    expect(bedOwnerOf('right', bed({ unusedZoneMode: 'independent' }))).toBe('right')
    expect(bedOwnerOf('right', bed({ right: { awayMode: false } }))).toBe('right')
    expect(bedOwnerOf('right', bed({ left: { awayMode: true } }))).toBe('right')
    // A bed set up for one: the unused half is the sleeper's, away or not.
    expect(bedOwnerOf('right', bed({ bedMode: 'solo-left', right: { awayMode: false } }))).toBe('left')
    expect(bedOwnerOf('left', bed({ bedMode: 'solo-right', right: { awayMode: false } }))).toBe('right')
    expect(awayHalfOf('left', bed())).toBe('right')
    expect(awayHalfOf('right', bed())).toBeNull()
  })

  it('reads the bed from the database when not given one', () => {
    expect(bedOwnerOf('right')).toBe('left')
    setBed(bed({ unusedZoneMode: 'off' }))
    expect(bedOwnerOf('right')).toBe('right')
  })

  it('is every half\'s own while the service is stopped, disabled or silent (rule 11)', () => {
    runtime.running = false
    expect(bedOwnerOf('right', bed())).toBe('right')
    runtime.running = true
    runtime.disabled = 'Stopped after 3 failed startups'
    expect(bedOwnerOf('right', bed())).toBe('right')
    runtime.disabled = null
    runtime.lastBeat = Date.now() - 3 * MIN
    expect(bedOwnerOf('right', bed())).toBe('right')
  })
})

describe('controls on the empty half (rule 5)', () => {
  it('act on the home side, except on a half the pump guard holds', () => {
    expect(controlSideOf('right')).toBe('left')
    expect(controlSideOf('left')).toBe('left')
    h.blocked.right = true
    expect(controlSideOf('right')).toBe('right')
  })

  it('cannot start a plan of its own', () => {
    expect(awayHalfReason('left')).toBeNull()
    expect(() => refuseAwayHalfPlan('left')).not.toThrow()
    expect(() => refuseAwayHalfPlan('right')).toThrow('This half is part of Sam\'s bed while its sleeper is away')
  })
})

describe('the controller\'s view of the empty half (rule 1)', () => {
  it('reports the home side\'s hold, plan and hold length, with its own power', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    r.baseline.right = [r.curve('right', 70)]
    await r.on('left')
    await r.controller.setManualLocked('left', 84)
    const away = r.controller.status('right')
    expect(away.targetTemperature).toBe(84)
    expect(away.source).toBe('manual')
    expect(away.holdUntil).toBe(r.controller.status('left').holdUntil)
    expect(away.blocked).toBe('off')
    // Resume on the home side ends the one hold, and the half reads the home curve, not its own.
    await r.controller.resume('left')
    expect(r.controller.status('right').targetTemperature).toBe(80)
  })

  it('refuses a hold written to the empty half, and never ends the home side\'s hold from it', async () => {
    const r = rig()
    await r.on('left')
    await r.controller.setManualLocked('left', 84)
    await expect(r.controller.setManualLocked('right', 70)).rejects.toThrow('part of the left side\'s bed')
    r.controller.clearHoldLocked('right')
    await r.controller.powerOffLocked('right')
    expect(r.holds.left?.temperature).toBe(84)
    expect(r.holds.right).toBeNull()
  })

  it('reads the half\'s own plan again once the bed is two sides', () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    r.baseline.right = [r.curve('right', 70)]
    expect(r.controller.baselineTarget('right')).toBe(80)
    setBed(bed({ right: { awayMode: false } }))
    expect(r.controller.baselineTarget('right')).toBe(70)
  })
})

describe('the empty half\'s step (rules 2 to 4, 9)', () => {
  it('is a plain reconcile for a half that owns itself', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    r.baseline.left = [r.curve('left', 78)]
    await tickHalf(r.controller, 'left', live)
    expect(r.writes.at(-1)).toEqual(['left', 78])
  })

  it('turns the half on with the home side, at the home side\'s target, and off with it', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.at(-1)).toEqual(['right', 80])
    await r.controller.powerOffLocked('left')
    await tickHalf(r.controller, 'right', live)
    expect(r.offs).toEqual(['left', 'right'])
    // Off stays off: nothing more is written.
    await tickHalf(r.controller, 'right', live)
    expect(r.offs).toEqual(['left', 'right'])
  })

  it('never touches the home side', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    const before = r.writes.length
    await tickHalf(r.controller, 'right', live)
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.slice(before).every(([side]) => side === 'right')).toBe(true)
  })

  it('follows a change to the home side\'s target, and is written whenever the home side is (one timer)', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    await r.controller.setManualLocked('left', 83)
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.at(-1)).toEqual(['right', 83])
    // A write to the home side at the same temperature (a timer refresh) still writes the half.
    const count = r.writes.length
    await r.controller.reconcileLocked('left', true)
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.slice(count)).toEqual([['left', 83], ['right', 83]])
    // And then rests.
    await tickHalf(r.controller, 'right', live)
    expect(r.writes).toHaveLength(count + 2)
  })

  it('retries turning the half off when the firmware still reports it on after a failed power-off', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    await r.controller.powerOffLocked('left')
    // The controller believes the half is off, but the firmware's next report says it runs.
    await r.controller.powerOffLocked('right')
    report('right', 80, true)
    await tickHalf(r.controller, 'right', live)
    expect(r.offs).toEqual(['left', 'right', 'right'])
  })

  it('rewrites the half when the home side is rewritten with no plan (always-on keepalive)', async () => {
    const r = rig()
    await r.controller.setManualLocked('left', 86)
    r.holds.left = null
    await tickHalf(r.controller, 'right', live)
    const count = r.writes.length
    await r.controller.reconcileLocked('left', true)
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.slice(count)).toEqual([['left', 86], ['right', 86]])
  })

  it('takes the home side\'s reported temperature when it runs with no plan, not 75', async () => {
    const r = rig()
    await r.controller.setManualLocked('left', 88)
    r.holds.left = null
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.at(-1)).toEqual(['right', 88])
  })

  it('turns the half off while the home side is blocked, and leaves a half the guard holds alone', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    h.blocked.left = true
    await tickHalf(r.controller, 'right', live)
    expect(r.offs).toEqual(['right'])
    h.blocked.left = false
    h.blocked.right = true
    r.powered.right = true
    const count = r.writes.length
    await tickHalf(r.controller, 'right', live)
    expect(r.writes).toHaveLength(count)
    expect(r.offs).toEqual(['right'])
  })

  it('undoes a firmware move on the half once it has lasted, but not at once', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    const count = r.writes.length
    // The firmware moved right to 83 with nothing to turn it into a hold.
    report('right', 83)
    await tickHalf(r.controller, 'right', live)
    expect(r.writes).toHaveLength(count)
    vi.useFakeTimers({ now: Date.now() + 7_000, toFake: ['Date'] })
    try {
      runtime.lastBeat = Date.now()
      await tickHalf(r.controller, 'right', live)
    }
    finally {
      vi.useRealTimers()
      runtime.lastBeat = Date.now()
    }
    expect(r.writes.at(-1)).toEqual(['right', 80])
  })

  it('leaves the half alone while a press waits there, owed writes included', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    const count = r.writes.length
    report('right', 77)
    runtime.pressing.add('right')
    r.baseline.left = [r.curve('left', 82)]
    await r.controller.reconcileLocked('left')
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.slice(count)).toEqual([['left', 82]])
    expect(reported('right')).toBe(77)
    runtime.pressing.delete('right')
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.at(-1)).toEqual(['right', 82])
  })

  it('keeps the last temperature written to each half, which a press is measured from', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    expect(lastWrittenTo('right')).toBe(80)
  })

  it('writes an owed half even when nothing else changed', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    await tickHalf(r.controller, 'right', live)
    const count = r.writes.length
    oweWrite('right')
    await tickHalf(r.controller, 'right', live)
    expect(r.writes.slice(count)).toEqual([['right', 80]])
  })

  it('does nothing once the tick is stopping', async () => {
    const r = rig()
    r.baseline.left = [r.curve('left', 80)]
    await r.on('left')
    const count = r.writes.length
    await tickHalf(r.controller, 'right', () => false)
    expect(r.writes).toHaveLength(count)
  })
})
