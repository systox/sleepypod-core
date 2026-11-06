/**
 * One big side: while one sleeper is away (or the bed is set up for one) and
 * the empty half is set to "Matches the other side", the whole bed belongs to
 * the sleeper at home. The empty half has no plan of its own: the controller
 * reads the home side's hold, sessions and schedule for it, every control on
 * it acts on the home side, and its step in the 1-second tick keeps its power,
 * temperature and firmware timer with the home side's.
 *
 * This is upstream's own follow mode, finished: upstream's mirror copies only
 * the weekly schedule and scheduled power. The reasoning and the rules this
 * code must keep are in docs/fork/one-big-side.md.
 *
 * Everything here sits on hot paths (the controller asks on every status
 * read), so it reads the database through prepared statements and imports
 * nothing heavy.
 */
import { TRPCError } from '@trpc/server'
import type { Statement } from 'better-sqlite3'
import { sqlite } from '@/src/db'
import { shouldBlock } from '@/src/hardware/pumpStallGuard'
import { withSideLock } from '@/src/hardware/sideLock'
import type { Side } from '@/src/hardware/types'
import { scheduleSourceSide, type BedState } from '@/src/lib/singleSleeper'
import type { TemperatureController, TemperatureControllerDeps } from '@/src/temperature/controller'
import { runtime } from './runtime'

/**
 * One firmware button step is 2.75 °F. A difference of more than this between
 * the away half's target and its due temperature is a move nobody planned;
 * less is rounding between °F and the firmware's levels.
 */
const DRIFT_F = 1

/**
 * A firmware move on the empty half is undone only once it has lasted this
 * long. The firmware status poll and the button-press stream are separate,
 * so the moved level can show before the press that caused it; correcting at
 * once would erase the press before it is measured.
 */
const DRIFT_SETTLE_MS = 6_000

const globalOneSide = globalThis as typeof globalThis & {
  __sp_forkOneSideStatements?: WeakMap<object, Map<string, Statement>>
  __sp_forkOwedWrites?: Set<Side>
  __sp_forkLastWritten?: Map<Side, number>
  __sp_forkDriftSince?: Map<Side, number>
}
const statementCache = globalOneSide.__sp_forkOneSideStatements ??= new WeakMap<object, Map<string, Statement>>()
/** Away halves owed a hardware write because the home side was just written. */
const owedWrites = globalOneSide.__sp_forkOwedWrites ??= new Set<Side>()
/** The last temperature sleepypod wrote to each half, which a firmware press moves away from. */
const lastWritten = globalOneSide.__sp_forkLastWritten ??= new Map<Side, number>()
/** When each empty half was first seen away from its due temperature. */
const driftSince = globalOneSide.__sp_forkDriftSince ??= new Map<Side, number>()

function statement(sql: string): Statement {
  let cache = statementCache.get(sqlite)
  if (!cache) {
    cache = new Map()
    statementCache.set(sqlite, cache)
  }
  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = sqlite.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}

/** The bed as sleepypod has it set up: who sleeps here, who is away, and what an empty half does. */
export function bedConfiguration(): BedState {
  const device = statement('select bed_mode as bedMode, unused_zone_mode as unusedZoneMode from device_settings').get() as BedState | undefined
  const away = statement('select side, away_mode as awayMode from side_settings').all() as { side: Side, awayMode: number }[]
  return { ...device, ...Object.fromEntries(away.map(row => [row.side, { awayMode: row.awayMode }])) }
}

/** The fork service is running and has reported in lately. If it stops or hangs, the bed goes back to stock. */
export function serviceLive(now = Date.now()): boolean {
  return runtime.running && !runtime.disabled && now - runtime.lastBeat < runtime.ownershipStaleMs
}

/** Whose bed a half is: the home side's, for the empty half while the bed is one side, otherwise its own. */
export function bedOwnerOf(side: Side, state?: BedState, now = Date.now()): Side {
  if (!serviceLive(now)) return side
  const source = scheduleSourceSide(side, state ?? bedConfiguration())
  return source ?? side
}

/** The empty half that belongs to this side's bed, or null. */
export function awayHalfOf(side: Side, state?: BedState, now = Date.now()): Side | null {
  const other: Side = side === 'left' ? 'right' : 'left'
  return bedOwnerOf(other, state, now) === side ? other : null
}

/**
 * The half a control acts on. A control on the empty half acts on the home
 * side, except while the pump guard holds the empty half: the guard's own
 * parking of a faulty half must stay on that half.
 */
export function controlSideOf(side: Side): Side {
  try {
    const owner = bedOwnerOf(side)
    return owner !== side && !shouldBlock(side) ? owner : side
  }
  catch (error) {
    console.warn(`[fork] ${side} bed owner unreadable:`, error instanceof Error ? error.message : error)
    return side
  }
}

function sideName(side: Side): string {
  const row = statement('select name from side_settings where side = ?').get(side) as { name: string | null } | undefined
  return row?.name || (side === 'left' ? 'Left' : 'Right')
}

/** Why the empty half of a one-side bed can't have a plan of its own, in words for the app, or null. */
export function awayHalfReason(side: Side): string | null {
  const state = bedConfiguration()
  const home = bedOwnerOf(side, state)
  if (home === side) return null
  const why = state[side]?.awayMode ? 'its sleeper is away' : 'the bed is set up for one'
  return `This half is part of ${sideName(home)}'s bed while ${why}, so it has no curve or Smart start of its own.`
}

/** Sessions are plans, and the empty half of a one-side bed has none of its own. */
export function refuseAwayHalfPlan(side: Side): void {
  const reason = awayHalfReason(side)
  if (reason) throw new TRPCError({ code: 'BAD_REQUEST', message: `${reason} Start it on ${sideName(bedOwnerOf(side))}'s side.` })
}

/**
 * The controller's dependencies, with the empty half reading the home side's
 * plan. A hold written to the empty half means a control was not redirected:
 * it fails loudly rather than acting on half the bed.
 */
export function withOneSide(deps: TemperatureControllerDeps): TemperatureControllerDeps {
  const { defaultHoldMs } = deps
  return {
    ...deps,
    readHold: side => deps.readHold(bedOwnerOf(side)),
    writeHold: (side, hold) => {
      const owner = bedOwnerOf(side)
      if (owner === side) return deps.writeHold(side, hold)
      // Turning the empty half off, or a hold ending on it, must not end the home side's hold.
      if (hold) throw new Error(`The ${side} half is part of the ${owner} side's bed; its hold belongs there`)
    },
    readBaseline: (side, now) => deps.readBaseline(bedOwnerOf(side), now),
    defaultHoldMs: defaultHoldMs && (side => defaultHoldMs(bedOwnerOf(side))),
    apply: async (side, temperature, durationSec) => {
      await deps.apply(side, temperature, durationSec)
      lastWritten.set(side, temperature)
      // Every write restarts the home half's 8-hour firmware timer; the empty half's needs the same.
      try {
        const away = awayHalfOf(side)
        if (away) owedWrites.add(away)
      }
      catch (error) {
        console.warn(`[fork] ${side} follow mark failed:`, error instanceof Error ? error.message : error)
      }
    },
  }
}

/** The last temperature sleepypod wrote to a half since the server started, or null. */
export function lastWrittenTo(side: Side): number | null {
  return lastWritten.get(side) ?? null
}

/** A press on the half has been measured at this temperature: the next press counts from here. */
export function noteMeasured(side: Side, temperature: number): void {
  lastWritten.set(side, temperature)
}

/** Ask for the empty half to be written from the plan on its next step. */
export function oweWrite(side: Side): void {
  owedWrites.add(side)
}

function reportedPowered(side: Side): boolean {
  const row = statement('select is_powered as powered from device_state where side = ?').get(side) as { powered: number | null } | undefined
  return Boolean(row?.powered)
}

function reportedTarget(side: Side): number | null {
  const row = statement('select target_temperature as target from device_state where side = ?').get(side) as { target: number | null } | undefined
  return row?.target ?? null
}

/**
 * One half's turn in upstream's 1-second tick. A half that owns itself is
 * reconciled as upstream always did. The empty half of a one-side bed follows
 * the home side: on when it is on, off when it is off, at the same target,
 * written whenever the home side is.
 */
export async function tickHalf(controller: TemperatureController, side: Side, isCurrent: () => boolean): Promise<unknown> {
  const home = bedOwnerOf(side)
  if (home === side) return controller.reconcile(side, false, isCurrent)
  return withSideLock(side, async () => {
    if (!isCurrent() || bedOwnerOf(side) !== home) return
    const away = controller.status(side)
    // The pump guard owns a half it blocks.
    if (away.blocked === 'safety') return
    const homeStatus = controller.status(home)
    if (homeStatus.blocked !== null) {
      // The firmware's report too: a power-off that failed leaves the controller saying off while the half runs.
      if (away.blocked === null || reportedPowered(side)) await controller.powerOffLocked(side)
      return
    }
    // The firmware's move on this half is the press being measured.
    if (runtime.pressing.has(side)) {
      driftSince.delete(side)
      return
    }
    const homeTarget = reportedTarget(home)
    const due = away.targetTemperature ?? homeTarget
    const current = reportedTarget(side)
    const now = Date.now()
    if (due !== null && current !== null && Math.abs(current - due) > DRIFT_F) {
      if (!driftSince.has(side)) driftSince.set(side, now)
    }
    else driftSince.delete(side)
    const drifted = now - (driftSince.get(side) ?? now) >= DRIFT_SETTLE_MS
    if (away.blocked === 'off' || owedWrites.has(side) || drifted) {
      await controller.powerOnLocked(side, homeTarget ?? undefined, isCurrent)
      owedWrites.delete(side)
      driftSince.delete(side)
      return
    }
    await controller.reconcileLocked(side, false, isCurrent)
  })
}

/** Clear marks left for a half, when one side starts or ends. */
export function clearOwed(side?: Side): void {
  if (side) {
    owedWrites.delete(side)
    driftSince.delete(side)
  }
  else {
    owedWrites.clear()
    driftSince.clear()
  }
}
