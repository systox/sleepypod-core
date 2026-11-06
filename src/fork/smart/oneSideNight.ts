/**
 * The fork's part of one big side (see ../oneSide.ts for the core): what
 * happens to the empty half when the bed becomes one side and when it stops
 * being one, what the app says about it, and Smart start's view of it.
 *
 * Starting and ending are noticed on the Smart start tick by comparing who
 * owns each half with a saved mark. Rules 1 to 5 hold from the moment the
 * setting changes, because the core reads the bed configuration directly;
 * only this cleanup waits for the tick. The reasoning is in
 * docs/fork/one-big-side.md, section 5.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState, runOnceSessions, temperatureHolds } from '@/src/db/schema'
import { withSideLock } from '@/src/hardware/sideLock'
import type { Side } from '@/src/hardware/types'
import { activeSleeperSides, type BedState } from '@/src/lib/singleSleeper'
import { getTemperatureController } from '@/src/temperature/instance'
import { caller } from '../caller'
import { clearFade } from '../holds'
import { bedConfiguration, bedOwnerOf, clearOwed, oweWrite } from '../oneSide'
import { noteEntry, presenceOf, sensorsFresh } from '../presence/collector'
import { getSideSettings } from '../settings'
import { logEvent, readKey, removeKey, writeKey } from '../store'
import { clearSurface } from '../surface'
import { setRunAside } from './runner'

const SIDES: Side[] = ['left', 'right']

/** What the Tonight and Sides cards say about the empty half of a one-side bed. */
export interface FollowView {
  leader: Side
  /** Its sleeper is away, or the bed is set up for one. */
  why: 'away' | 'unused'
}

interface OneSideMark {
  home: Side
}

const markKey = (side: Side) => `one-side:${side}`
/** The mark the copying design used before one big side replaced it. */
const legacyKey = (side: Side) => `following:${side}`

/** The home side whose bed this half is part of, and why, or null when the half is its own. */
export function followingOf(side: Side, state: BedState = bedConfiguration()): FollowView | null {
  const leader = bedOwnerOf(side, state)
  if (leader === side) return null
  return { leader, why: state[side]?.awayMode ? 'away' : 'unused' }
}

function activeSession(side: Side) {
  return db.select({ id: runOnceSessions.id }).from(runOnceSessions)
    .where(and(eq(runOnceSessions.side, side), eq(runOnceSessions.status, 'active'))).get() ?? null
}

/**
 * The bed has just become one side: whatever the away sleeper's half was
 * doing was for a night they aren't here for, so it ends, and the half is
 * written from the home side's plan at once.
 */
async function startOneSide(side: Side, home: Side, now: number): Promise<void> {
  if (activeSession(side)) await (await caller()).runOnce.cancel({ side })
  await withSideLock(side, async () => {
    // The controller no longer sees this half's own hold, so it can't end it.
    db.delete(temperatureHolds).where(eq(temperatureHolds.side, side)).run()
    // A deadline left from an app change with a duration would turn the half off partway through the night.
    db.update(deviceState).set({ hardwareDeadline: null }).where(eq(deviceState.side, side)).run()
  })
  clearFade(side)
  clearSurface(side)
  setRunAside(side)
  oweWrite(side)
  removeKey(legacyKey(side))
  writeKey(markKey(side), { home } satisfies OneSideMark)
  logEvent(side, 'one-side', { home }, now)
}

/**
 * The half is its own again. A sleeper back under live Smart start who is
 * already lying on their half starts their own curve as if they had just got
 * in; one who isn't in bed has the half off until they get in. Anything else
 * is left as sleepypod leaves it (its own return job turns the side on).
 */
async function endOneSide(side: Side, state: BedState, live: boolean, now: number): Promise<void> {
  if (live && activeSleeperSides(state).includes(side) && getSideSettings(side).smartStart && sensorsFresh(now)) {
    const occupied = presenceOf(side).occupied
    if (occupied === true) noteEntry(side, now)
    else if (occupied === false) await getTemperatureController().powerOff(side)
  }
  clearOwed(side)
  removeKey(markKey(side))
  logEvent(side, 'one-side-ended', null, now)
}

/**
 * Called on every Smart start tick, for both halves, before Smart start's own
 * rules, so a sleeper just back has their own rules see the result.
 */
export async function syncOneSide(side: Side, state: BedState, live: boolean, now = Date.now()): Promise<void> {
  const owner = bedOwnerOf(side, state, now)
  const mark = readKey<OneSideMark>(markKey(side))
  if (owner === side) {
    if (mark) await endOneSide(side, state, live, now)
    return
  }
  if (mark?.home === owner) return
  if (mark) await endOneSide(side, state, live, now)
  await startOneSide(side, owner, now)
}

/**
 * The bed was stock while the service was silent, so anything could have
 * been set on the empty half meanwhile: forget the marks, so the start steps
 * run again on this tick.
 */
export function forgetOneSide(): void {
  for (const side of SIDES) {
    if (!readKey(markKey(side))) continue
    clearOwed(side)
    removeKey(markKey(side))
  }
}

/**
 * The service has turned itself off, so the bed is stock again: drop the
 * marks, so a later start runs the start steps afresh, and give the bed back
 * to sleepypod's rules.
 */
export async function releaseOneSide(now = Date.now()): Promise<void> {
  let released = false
  for (const side of SIDES) {
    if (readKey(legacyKey(side))) {
      removeKey(legacyKey(side))
      released = true
    }
    if (!readKey(markKey(side))) continue
    clearOwed(side)
    removeKey(markKey(side))
    logEvent(side, 'one-side-ended', null, now)
    released = true
  }
  if (released) {
    const { getJobManager } = await import('@/src/scheduler/instance')
    await (await getJobManager()).applyBedConfiguration()
  }
}
