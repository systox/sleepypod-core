/**
 * Smart start when one sleeper is away and the other zone follows the one at
 * home. The away side runs the home sleeper's curve, so the home sleeper's
 * Smart start setting decides for both sides and the away side's own is set
 * aside.
 *
 * With the home sleeper's Smart start on and acting, the away side is brought
 * in line with the home side on every tick: it carries a copy of the home
 * side's current session, taken up from the present point of the curve, and
 * is off when the home side has none. Otherwise sleepypod's scheduler mirrors
 * the weekly schedule as it always has. Once the side stops following, the
 * copy it was given is ended.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceSettings, runOnceSessions, sideSettings } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import { activeSleeperSides, scheduleSourceSide, type BedState } from '@/src/lib/singleSleeper'
import { getJobManager } from '@/src/scheduler/instance'
import { nowInTimezone, timeToDate } from '@/src/scheduler/timeUtils'
import { sessionTarget } from '@/src/temperature/baseline'
import { getTemperatureController } from '@/src/temperature/instance'
import { deviceTimezone } from '../clock'
import { getSideSettings } from '../settings'
import { logEvent, readKey, removeKey, writeKey } from '../store'

interface FollowMark {
  leader: Side
  /** Who drives the side: Smart start's copies, or the scheduler's mirror. */
  mode: 'smart' | 'schedule' | null
  /** The home session last copied, and the copy made of it. */
  copyOf: number | null
  copyId: number | null
  /** The home side's last write or timer refresh that reached this side. */
  refreshedAt: number | null
}

interface SetPoint { time: string, temperature: number }

const followKey = (side: Side) => `following:${side}`

export function bedState(): BedState {
  const device = db.select({ bedMode: deviceSettings.bedMode, unusedZoneMode: deviceSettings.unusedZoneMode }).from(deviceSettings).limit(1).get()
  const away = db.select({ side: sideSettings.side, awayMode: sideSettings.awayMode }).from(sideSettings).all()
  return { ...device, ...Object.fromEntries(away.map(row => [row.side, { awayMode: row.awayMode }])) }
}

/** Whose Smart start setting governs a side: its own while home, the home sleeper's while following them, or nobody's. */
export function smartSourceOf(side: Side, state: BedState = bedState()): Side | null {
  if (activeSleeperSides(state).includes(side)) return side
  const source = scheduleSourceSide(side, state)
  return source !== null && source !== side ? source : null
}

/** Whether Smart start is on for a side, by that rule. */
export function smartStartFor(side: Side, state: BedState = bedState()): boolean {
  const source = smartSourceOf(side, state)
  return source !== null && getSideSettings(source).smartStart
}

/** The home side this away side is following, or null. */
export function followingOf(side: Side): Side | null {
  return readKey<FollowMark>(followKey(side))?.leader ?? null
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
  const { hour, minute } = nowInTimezone(timezone, new Date(now))
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const later = session.setPoints.slice(1).filter((point) => {
    const at = timeToDate(point.time, timezone, session.startedAt).getTime()
    return at > now && at < session.expiresAt.getTime()
  })
  return [{ time, temperature: current.temperature }, ...later]
}

async function caller() {
  const { getCaller } = await import('@/src/mcp/caller')
  return getCaller()
}

function activeSession(side: Side, now: number) {
  const row = db.select().from(runOnceSessions).where(and(eq(runOnceSessions.side, side), eq(runOnceSessions.status, 'active'))).get()
  return row && row.expiresAt.getTime() > now ? row : null
}

/** End the copy this side was given, if it still runs. */
async function endCopy(side: Side, mark: FollowMark, now: number): Promise<void> {
  if (mark.copyId !== null && activeSession(side, now)?.id === mark.copyId) await (await caller()).runOnce.cancel({ side })
  mark.copyOf = null
  mark.copyId = null
}

/**
 * Called on every Smart start tick, for both sides, before their own rules.
 * `leader` is whose Smart start setting governs the side; `homeWriteAt` is the
 * home side's last write or timer refresh. Returns true when the side has just
 * started following, so the caller can set its own run aside.
 */
export async function syncFollowing(side: Side, leader: Side | null, live: boolean, homeWriteAt: number | null, now = Date.now()): Promise<boolean> {
  const saved = readKey<FollowMark>(followKey(side))
  if (leader === null || leader === side) {
    if (!saved) return false
    await endCopy(side, saved, now)
    // With nobody home to follow, the side goes off.
    if (leader === null) await getTemperatureController().powerOff(side)
    removeKey(followKey(side))
    logEvent(side, 'following-ended', null, now)
    return false
  }

  const started = saved?.leader !== leader
  const mark: FollowMark = !saved || started ? { leader, mode: null, copyOf: null, copyId: null, refreshedAt: null } : { ...saved }
  const api = await caller()
  // The away sleeper's own session was for them, not for the curve this side now follows.
  if (started && activeSession(side, now)) await api.runOnce.cancel({ side })

  if (live && getSideSettings(leader).smartStart) {
    mark.mode = 'smart'
    const home = activeSession(leader, now)
    if (!home) {
      if (mark.copyId !== null || started) {
        await endCopy(side, mark, now)
        await getTemperatureController().powerOff(side)
      }
    }
    else if (mark.copyOf !== home.id || activeSession(side, now)?.id !== mark.copyId) {
      const setPoints = pointsFromNow({ ...home, setPoints: JSON.parse(home.setPoints) as SetPoint[] }, deviceTimezone(), now)
      if (setPoints) {
        const { sessionId } = await api.runOnce.start({ side, setPoints, wakeTime: home.wakeTime })
        mark.copyOf = home.id
        mark.copyId = sessionId
        mark.refreshedAt = homeWriteAt
      }
    }
    else if (homeWriteAt !== mark.refreshedAt) {
      // The home side refreshed its timer; this side's needs the same.
      await getTemperatureController().reconcile(side, true)
      mark.refreshedAt = homeWriteAt
    }
  }
  else if (mark.mode !== 'schedule') {
    mark.mode = 'schedule'
    await endCopy(side, mark, now)
    // The scheduler mirrors the weekly schedule, now that Smart start doesn't hold this side.
    await (await getJobManager()).syncMirroredSide(side)
  }

  // Saved only once it has worked, so a failure is tried again next tick.
  writeKey(followKey(side), mark)
  if (started) logEvent(side, 'following', { leader }, now)
  return started
}
