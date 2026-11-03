/**
 * Runs the Smart start rules for real: reads the bed, the curve and the side,
 * then carries out what the rules ask for through sleepypod's own run-once
 * sessions and temperature controller.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { powerSchedules, sideSettings, temperatureSchedules } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'
import { getTemperatureController } from '@/src/temperature/instance'
import { presenceOf, sensorsFresh, takeEntry, twoBodies } from '../presence/collector'
import { takePersonPower } from '../runtime'
import { getPodSettings, getSideSettings } from '../settings'
import { deviceTimezone } from '../clock'
import { logEvent, readKey, writeKey } from '../store'
import { buildCopy, windowsAround, type CurveRow, type PowerRow, type TonightWindow } from './curves'
import { command, INITIAL_RUN, tick, type Action, type Command, type Decision, type RunState, type TickContext } from './engine'

const HOUR = 3_600_000

const globalRunner = globalThis as typeof globalThis & { __sp_forkLastTick?: Partial<Record<Side, number>> }
const lastTick = globalRunner.__sp_forkLastTick ??= {}

function key(side: Side): string {
  return `run:${side}`
}

export function runStateOf(side: Side): RunState {
  return { ...INITIAL_RUN, ...readKey<RunState>(key(side)) }
}

function curveRows(side: Side): { temps: CurveRow[], powers: PowerRow[] } {
  const temps = db.select().from(temperatureSchedules).where(and(eq(temperatureSchedules.side, side), eq(temperatureSchedules.enabled, true))).all()
  const powers = db.select().from(powerSchedules).where(and(eq(powerSchedules.side, side), eq(powerSchedules.enabled, true))).all()
  return {
    temps,
    powers: powers.map(p => ({ dayOfWeek: p.dayOfWeek, onTime: p.onTime, offTime: p.offTime, onTemperature: p.onTemperature ?? 75 })),
  }
}

export function windowsOf(side: Side, now: number): { window: TonightWindow | null, next: TonightWindow | null } {
  const { temps, powers } = curveRows(side)
  return windowsAround(temps, powers, deviceTimezone(), now, getSideSettings(side))
}

function buildContext(side: Side, state: RunState, now: number): TickContext {
  const settings = getSideSettings(side)
  const other: Side = side === 'left' ? 'right' : 'left'
  const { window, next } = windowsOf(side, now)
  const status = getTemperatureController().status(side)
  const presence = presenceOf(side)
  const otherPresence = presenceOf(other)
  const entry = takeEntry(side)
  const person = takePersonPower(side, now)
  const away = db.select({ away: sideSettings.awayMode }).from(sideSettings).where(eq(sideSettings.side, side)).get()?.away ?? false
  const otherRun = runStateOf(other)
  return {
    now,
    elapsedMs: now - (lastTick[side] ?? now),
    settings,
    occupied: sensorsFresh(now) ? presence.occupied : null,
    enteredAt: entry?.at ?? null,
    movedAcross: entry?.movedAcross ?? false,
    otherOpenAndEmpty: otherRun.phase === 'running' && otherPresence.occupied === false,
    twoBodies: twoBodies(),
    sideOn: status.blocked === null,
    away,
    personOff: person?.on === false,
    personOn: person?.on === true,
    safetyStop: status.blocked === 'safety',
    window,
    nextWindow: next,
    timerRefreshMs: getPodSettings().timerRefreshHours * HOUR,
  }
}

async function caller() {
  const { getCaller } = await import('@/src/mcp/caller')
  return getCaller()
}

async function carryOut(side: Side, action: Action, state: RunState, now: number): Promise<RunState> {
  switch (action.kind) {
    case 'write':
    case 'hold': {
      const copy = action.kind === 'write'
        ? buildCopy(action.points, action.curveZeroAt, now, action.endsAt, deviceTimezone())
        : buildCopy([{ offset: 0, temperature: action.temperature }], now, now, action.endsAt, deviceTimezone())
      await (await caller()).runOnce.start({ side, setPoints: copy.setPoints, wakeTime: copy.wakeTime })
      return { ...state, copyEndsAt: copy.endsAt, offOwed: false }
    }
    case 'off':
      await (await caller()).runOnce.cancel({ side })
      await getTemperatureController().powerOff(side)
      return { ...state, copyEndsAt: null, offOwed: false }
    case 'refresh':
      await getTemperatureController().reconcile(side, true)
      return state
  }
}

async function apply(side: Side, decision: Decision, now: number): Promise<RunState> {
  // Saved first, so a failed off is retried on the next tick and not forgotten.
  let state = decision.actions.some(a => a.kind === 'off') ? { ...decision.state, offOwed: true } : decision.state
  writeKey(key(side), state)
  for (const event of decision.events) logEvent(side, `smart:${event.kind}`, event.detail)
  for (const action of decision.actions) {
    state = await carryOut(side, action, state, now)
  }
  writeKey(key(side), state)
  return state
}

export async function tickSide(side: Side, now = Date.now()): Promise<void> {
  let state = runStateOf(side)
  if (state.offOwed) {
    state = await carryOut(side, { kind: 'off' }, state, now)
    writeKey(key(side), state)
  }
  const decision = tick(state, buildContext(side, state, now))
  lastTick[side] = now
  const unchanged = decision.actions.length === 0 && decision.events.length === 0
    && JSON.stringify(decision.state) === JSON.stringify(state)
  // Most ticks change nothing, and this runs on the Pod's flash storage.
  if (!unchanged) await apply(side, decision, now)
}

/**
 * Smart start was just switched on or went live. A window already open counts
 * as seen, so someone asleep in bed doesn't get their curve restarted.
 */
export function noteSwitchedOn(side: Side, now = Date.now()): void {
  const { window } = windowsOf(side, now)
  if (window) writeKey(key(side), { ...runStateOf(side), windowFor: window.curve.bedtime })
}

export async function runCommand(side: Side, name: Command, now = Date.now()): Promise<RunState> {
  const state = runStateOf(side)
  return apply(side, command(state, name, buildContext(side, state, now)), now)
}

/**
 * A press on an off side: while someone reads in bed it's the deliberate step
 * back onto a closed side. It can't start anything before the bench test shows
 * an off side still sends a press record, so a setting keeps it off until then.
 */
export async function noteSmartPress(side: Side): Promise<void> {
  if (!getPodSettings().pressStartsClosedSide || !getSideSettings(side).smartStart) return
  if (presenceOf(side).occupied !== true) return
  const phase = runStateOf(side).phase
  if (phase === 'closed' || phase === 'idle') await runCommand(side, 'start-back')
}
