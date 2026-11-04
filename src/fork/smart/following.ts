/**
 * Smart start for an empty side that follows the sleeper at home: a side
 * whose sleeper is away, or the unused side of a bed set up for one, when
 * the away side is set to match the other side (device_settings
 * unusedZoneMode 'follow', on the Schedule page's Away card) and the pod
 * setting followSmartStart is on. The home sleeper's Smart start setting then
 * decides for both sides, and the empty side's own is set aside. With the
 * setting off, every side keeps its own Smart start setting, as before.
 *
 * With the home sleeper's Smart start on and acting, the empty side is
 * brought in line with the home side on every tick: it carries a copy of the
 * home side's current session, taken up from the present point of the curve,
 * and is off when the home side has none. A hold on the home side is a
 * session too, so the empty side holds with it; a button press changes only
 * the home side, as sleepypod's own mirror does. Otherwise sleepypod's
 * scheduler mirrors the weekly schedule as it always has.
 *
 * A person who turns the empty side off, or ends its curve, has it stay that
 * way until the home side's curve is over or they turn it back on.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceSettings, runOnceSessions, sideSettings } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import { activeSleeperSides, scheduleSourceSide, type BedState } from '@/src/lib/singleSleeper'
import { getJobManager } from '@/src/scheduler/instance'
import { sessionTarget } from '@/src/temperature/baseline'
import { getTemperatureController } from '@/src/temperature/instance'
import { timeToDate } from '@/src/scheduler/timeUtils'
import { caller } from '../caller'
import { deviceTimezone } from '../clock'
import { presenceOf, sensorsFresh } from '../presence/collector'
import { takePersonPower } from '../runtime'
import { getPodSettings, getSideSettings } from '../settings'
import { logEvent, readKey, removeKey, writeKey } from '../store'
import { clockIn } from './curves'

const SIDES: Side[] = ['left', 'right']

/** What the Tonight and Sides cards say about a side that follows the other. */
export interface FollowView {
  leader: Side
  /** Its sleeper is away, or the bed is set up for one. */
  why: 'away' | 'unused'
  /** A person turned it off or ended its curve, so it sits out the rest of the home curve. */
  dismissed: boolean
}

interface FollowMark {
  leader: Side
  /** Who drives the side: Smart start's copies, or the scheduler's mirror. */
  mode: 'smart' | 'schedule' | null
  /** The home session last copied, and the copy made of it. */
  copyOf: number | null
  copyId: number | null
  /** The home side's last write or timer refresh that reached this side. */
  refreshedAt: number | null
  dismissed: boolean
}

interface SetPoint { time: string, temperature: number }

/** What a tick's sync asks of the side's own Smart start run. */
export type FollowResult = 'started' | 'back-in-bed' | null

const followKey = (side: Side) => `following:${side}`

export function bedState(): BedState {
  const device = db.select({ bedMode: deviceSettings.bedMode, unusedZoneMode: deviceSettings.unusedZoneMode }).from(deviceSettings).limit(1).get()
  const away = db.select({ side: sideSettings.side, awayMode: sideSettings.awayMode }).from(sideSettings).all()
  return { ...device, ...Object.fromEntries(away.map(row => [row.side, { awayMode: row.awayMode }])) }
}

/** Whose Smart start setting governs a side: the home sleeper's while it follows them, otherwise its own. */
export function smartSourceOf(side: Side, state: BedState = bedState()): Side {
  if (!getPodSettings().followSmartStart || activeSleeperSides(state).includes(side)) return side
  return scheduleSourceSide(side, state) ?? side
}

/** Whether Smart start is on for a side, by that rule. */
export function smartStartFor(side: Side, state: BedState = bedState()): boolean {
  return getSideSettings(smartSourceOf(side, state)).smartStart
}

/** The home side this side follows, and why, or null. */
export function followingOf(side: Side, state: BedState = bedState()): FollowView | null {
  const leader = smartSourceOf(side, state)
  if (leader === side) return null
  const mark = readKey<FollowMark>(followKey(side))
  return { leader, why: state[side]?.awayMode ? 'away' : 'unused', dismissed: mark?.leader === leader && mark.dismissed }
}

/**
 * A session's set points re-based to `now`: the temperature it holds now,
 * then the points still to come. A copy started from the session's own first
 * point would sit at that early temperature, and push the points already past
 * to tomorrow.
 */
export function pointsFromNow(session: { id: number, startedAt: Date, expiresAt: Date, setPoints: SetPoint[] }, timezone: string, now: number): SetPoint[] | null {
  const current = sessionTarget(session, timezone, now)
  if (!current) return null
  const later = session.setPoints.slice(1).filter((point) => {
    const at = timeToDate(point.time, timezone, session.startedAt).getTime()
    return at > now && at < session.expiresAt.getTime()
  })
  return [{ time: clockIn(timezone, now), temperature: current.temperature }, ...later]
}

function activeSession(side: Side, now: number) {
  const row = db.select().from(runOnceSessions).where(and(eq(runOnceSessions.side, side), eq(runOnceSessions.status, 'active'))).get()
  return row && row.expiresAt.getTime() > now ? row : null
}

function copyRunning(side: Side, mark: FollowMark, now: number): boolean {
  return mark.copyId !== null && activeSession(side, now)?.id === mark.copyId
}

/** End the copy this side was given, if it still runs. */
async function endCopy(side: Side, mark: FollowMark, now: number): Promise<void> {
  if (copyRunning(side, mark, now)) await (await caller()).runOnce.cancel({ side })
  mark.copyOf = null
  mark.copyId = null
}

async function followSmart(side: Side, leader: Side, mark: FollowMark, homeWriteAt: number | null, now: number): Promise<void> {
  const entering = mark.mode !== 'smart'
  mark.mode = 'smart'
  const home = activeSession(leader, now)
  const person = takePersonPower(side, now)
  if (!home) {
    // The home curve is over, and a person's off with it.
    mark.dismissed = false
    // Coming from the scheduler's mirror, the side may be on with nothing left to turn it off.
    if (mark.copyId !== null || entering) {
      await endCopy(side, mark, now)
      await getTemperatureController().powerOff(side)
    }
    return
  }
  const copyGone = mark.copyId !== null && !copyRunning(side, mark, now)
  if (copyGone) {
    mark.copyOf = null
    mark.copyId = null
  }
  if (person?.on === true) mark.dismissed = false
  else if (person?.on === false || copyGone) {
    // A person turned the side off or ended its curve: it stays that way for tonight.
    if (!mark.dismissed) logEvent(side, 'following-dismissed', null, now)
    mark.dismissed = true
    await endCopy(side, mark, now)
    return
  }
  if (mark.dismissed) return
  if (mark.copyOf !== home.id || mark.copyId === null) {
    const setPoints = pointsFromNow({ ...home, setPoints: JSON.parse(home.setPoints) as SetPoint[] }, deviceTimezone(), now)
    if (!setPoints) return
    const { sessionId } = await (await caller()).runOnce.start({ side, setPoints, wakeTime: home.wakeTime })
    mark.copyOf = home.id
    mark.copyId = sessionId
    mark.refreshedAt = homeWriteAt
  }
  else if (homeWriteAt !== mark.refreshedAt) {
    // The home side refreshed its timer; this side's needs the same.
    await getTemperatureController().reconcile(side, true)
    mark.refreshedAt = homeWriteAt
  }
}

/** The side no longer follows: hand it to whatever governs it now. */
async function stopFollowing(side: Side, mark: FollowMark, state: BedState, live: boolean, now: number): Promise<FollowResult> {
  const source = scheduleSourceSide(side, state)
  let result: FollowResult = null
  if (source === null) {
    // Nobody is home, so nothing else would turn this side off.
    await endCopy(side, mark, now)
    await getTemperatureController().powerOff(side)
  }
  else if (source !== side) {
    // Still away, with the setting turned off: the scheduler mirrors the home sleeper again.
    await endCopy(side, mark, now)
    await (await getJobManager()).syncMirroredSide(side)
  }
  else if (live && getSideSettings(side).smartStart && copyRunning(side, mark, now)) {
    // Its sleeper is back, under their own Smart start.
    if (sensorsFresh(now) && presenceOf(side).occupied === true) {
      // Already in bed: the copy runs on to its end, and tonight counts as started so their curve doesn't begin again.
      result = 'back-in-bed'
    }
    else {
      await endCopy(side, mark, now)
      await getTemperatureController().powerOff(side)
    }
  }
  else {
    await endCopy(side, mark, now)
  }
  removeKey(followKey(side))
  logEvent(side, 'following-ended', null, now)
  return result
}

/**
 * Called on every Smart start tick, for both sides, after the home sides'
 * own rules. `homeWriteAt` is the home side's last write or timer refresh.
 */
export async function syncFollowing(side: Side, state: BedState, live: boolean, homeWriteAt: number | null, now = Date.now()): Promise<FollowResult> {
  const leader = smartSourceOf(side, state)
  const saved = readKey<FollowMark>(followKey(side))
  if (leader === side) return saved ? stopFollowing(side, saved, state, live, now) : null

  const started = saved?.leader !== leader
  const mark: FollowMark = !saved || started
    ? { leader, mode: null, copyOf: null, copyId: null, refreshedAt: null, dismissed: false }
    : { ...saved }
  // The away sleeper's own session was for them, not for the curve this side now follows.
  if (started && activeSession(side, now)) await (await caller()).runOnce.cancel({ side })

  if (live && getSideSettings(leader).smartStart) await followSmart(side, leader, mark, homeWriteAt, now)
  else if (mark.mode !== 'schedule') {
    mark.mode = 'schedule'
    await endCopy(side, mark, now)
    // The scheduler mirrors the weekly schedule, now that Smart start doesn't hold this side.
    await (await getJobManager()).syncMirroredSide(side)
  }

  // Saved only once it has worked, so a failure is tried again next tick, and only when it changed: this is flash.
  if (JSON.stringify(mark) !== JSON.stringify(saved)) writeKey(followKey(side), mark)
  if (started) logEvent(side, 'following', { leader }, now)
  return started ? 'started' : null
}

/**
 * The service has turned itself off: end the copies it made, which nothing
 * would keep in line any more, and give the bed back to sleepypod's rules.
 */
export async function releaseFollowing(now = Date.now()): Promise<void> {
  let released = false
  for (const side of SIDES) {
    const mark = readKey<FollowMark>(followKey(side))
    if (!mark) continue
    await endCopy(side, mark, now)
    removeKey(followKey(side))
    logEvent(side, 'following-ended', null, now)
    released = true
  }
  if (released) await (await getJobManager()).applyBedConfiguration()
}
