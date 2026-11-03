/**
 * Smart start's rules, as plain logic: given a side's saved state and what's
 * true now, say what to do next. All hardware and storage live in the runner,
 * so the same rules can be tested against every case in the design.
 *
 * Times are epoch ms and all timing is elapsed time; clock times only appear
 * in the written copy.
 */
import type { ForkSideSettings } from '../settings'
import { temperatureAt, type Curve, type CurvePoint, type TonightWindow } from './curves'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export type Phase = 'idle' | 'warming' | 'reading' | 'running' | 'closed'

export interface RunState {
  phase: Phase
  points: CurvePoint[] | null
  /** Bedtime of the curve this run or wait belongs to. */
  bedtime: number | null
  /** Moment the curve's first point falls on. Moves later by each pause. */
  curveZeroAt: number | null
  /** When the side came on for this run. */
  startedAt: number | null
  /** When the curve began, for the backstop. Restarts after a long absence. */
  backstopFrom: number | null
  /** When the side last read empty during this run. */
  absentSince: number | null
  /** Curve position frozen by a trip. */
  pausedAt: number | null
  /** The side is off for a long trip, with the run still open. */
  offForTrip: boolean
  /** Time out of bed the curve ran through, which doesn't count toward the earliest end. */
  outMs: number
  closedUntil: number | null
  /** The last full run's end, for the minimum gap. */
  fullRunEndedAt: number | null
  /** Curve bedtime already warmed for, so a lapsed wait doesn't start again. */
  warmedFor: number | null
  /** Bedtime of the window last seen open. */
  windowFor: number | null
  /** A body that probably moved across, so this side waits. */
  movedAcross: boolean
  copyEndsAt: number | null
  lastWriteAt: number | null
  /** The rules asked for the side off and that hasn't gone through yet. */
  offOwed: boolean
  note: string | null
}

export const INITIAL_RUN: RunState = {
  phase: 'idle', points: null, bedtime: null, curveZeroAt: null, startedAt: null, backstopFrom: null,
  absentSince: null, pausedAt: null, offForTrip: false, outMs: 0, closedUntil: null, fullRunEndedAt: null,
  warmedFor: null, windowFor: null, movedAcross: false, copyEndsAt: null, lastWriteAt: null, offOwed: false, note: null,
}

export interface TickContext {
  now: number
  /** Time since the last tick, so trip timers can freeze while sensors are blind. */
  elapsedMs: number
  settings: ForkSideSettings
  /** Null when sensors are blind: missing data never counts as an empty bed. */
  occupied: boolean | null
  /** When this side's body arrived, if it did since the last tick. */
  enteredAt: number | null
  /** The other side's run is open and it reads empty: a body here may be its owner. */
  otherOpenAndEmpty: boolean
  /** This entry looks like someone moving across, not getting in. */
  movedAcross: boolean
  /** Two bodies now show, so a waiting side can start. */
  twoBodies: boolean
  sideOn: boolean
  away: boolean
  /** A person turned this side off since the last tick. */
  personOff: boolean
  /** A person turned this side on since the last tick. */
  personOn: boolean
  safetyStop: boolean
  window: TonightWindow | null
  /** The next window, used to close a side and for a Start between windows. */
  nextWindow: TonightWindow | null
  timerRefreshMs: number
}

export type Command = 'start-new' | 'start-back' | 'sleep-now' | 'stop'

export type Action
  = | { kind: 'write', curveZeroAt: number, endsAt: number, points: CurvePoint[] }
    | { kind: 'hold', temperature: number, endsAt: number }
    | { kind: 'off' }
    | { kind: 'refresh' }

export interface Decision {
  state: RunState
  actions: Action[]
  events: Array<{ kind: string, detail?: unknown }>
}

const MOVED_ACROSS_NOTE = 'Waiting: this looks like someone moving across'
const BLIND_NOTE = 'Sensors blind'

function position(state: RunState, now: number): number {
  const at = state.pausedAt ?? now
  return (at - (state.curveZeroAt ?? at)) / MINUTE
}

/** Time on the curve so far, not counting time out of bed. */
function curveMs(state: RunState, now: number): number {
  if (state.curveZeroAt === null) return 0
  const away = state.absentSince === null ? 0 : now - state.absentSince
  return now - state.curveZeroAt - state.outMs - away
}

function refreshDue(state: RunState, ctx: TickContext): boolean {
  return state.lastWriteAt !== null && ctx.now - state.lastWriteAt >= ctx.timerRefreshMs
}

function writeFrom(state: RunState, settings: ForkSideSettings, now: number): Action {
  const backstopAt = (state.backstopFrom ?? now) + settings.backstopHours * HOUR
  return { kind: 'write', curveZeroAt: state.curveZeroAt as number, endsAt: backstopAt, points: state.points as CurvePoint[] }
}

function beginCurve(state: RunState, curve: Pick<Curve, 'points' | 'bedtime'>, ctx: Pick<TickContext, 'now'>, zeroAt: number): RunState {
  return {
    ...state,
    phase: zeroAt > ctx.now ? 'reading' : 'running',
    points: curve.points,
    bedtime: curve.bedtime,
    curveZeroAt: zeroAt,
    startedAt: ctx.now,
    backstopFrom: Math.max(zeroAt, ctx.now),
    absentSince: null,
    pausedAt: null,
    offForTrip: false,
    outMs: 0,
    movedAcross: false,
    lastWriteAt: ctx.now,
    note: null,
  }
}

function endRun(state: RunState): RunState {
  return {
    ...state, points: null, bedtime: null, curveZeroAt: null, startedAt: null, backstopFrom: null,
    absentSince: null, pausedAt: null, offForTrip: false, outMs: 0, copyEndsAt: null, lastWriteAt: null,
  }
}

function close(state: RunState, ctx: Pick<TickContext, 'now' | 'nextWindow'>, reason: string, full: boolean): RunState {
  return {
    ...endRun(state),
    phase: 'closed',
    closedUntil: ctx.nextWindow?.windowStart ?? ctx.now + 12 * HOUR,
    fullRunEndedAt: full ? ctx.now : state.fullRunEndedAt,
    note: reason,
  }
}

function inGap(state: RunState, ctx: TickContext): boolean {
  return state.fullRunEndedAt !== null && ctx.now < state.fullRunEndedAt + ctx.settings.minimumGapHours * HOUR
}

function startFromEntry(state: RunState, ctx: TickContext, enteredAt: number, events: Decision['events']): Decision {
  const window = ctx.window as TonightWindow
  const reading = ctx.settings.readingMode && enteredAt < window.curve.bedtime
  const zeroAt = reading ? window.curve.bedtime : ctx.now
  const next = beginCurve(state, window.curve, ctx, zeroAt)
  events.push({ kind: reading ? 'reading' : 'start', detail: { enteredAt } })
  return { state: next, actions: [writeFrom(next, ctx.settings, ctx.now)], events }
}

/** A deliberate Start. Back to Bed holds the curve's last temperature. */
export function command(state: RunState, name: Command, ctx: TickContext): Decision {
  const events: Decision['events'] = [{ kind: `command:${name}` }]
  if (name === 'stop') {
    const running = state.phase === 'running' || state.phase === 'reading' || state.phase === 'warming'
    return { state: close(state, ctx, 'Stopped for tonight', running && curveMs(state, ctx.now) >= ctx.settings.shortRunHours * HOUR), actions: [{ kind: 'off' }], events }
  }
  if (name === 'sleep-now') {
    if (state.phase !== 'reading') return { state, actions: [], events }
    const next = { ...state, phase: 'running' as const, curveZeroAt: ctx.now, backstopFrom: ctx.now, lastWriteAt: ctx.now }
    return { state: next, actions: [writeFrom(next, ctx.settings, ctx.now)], events }
  }
  const window = ctx.window ?? ctx.nextWindow
  const points = window?.curve.points ?? state.points
  if (!points) return { state: { ...state, note: 'No curve saved for this side' }, actions: [], events }
  const curve = { points, bedtime: window?.curve.bedtime ?? ctx.now }
  if (name === 'start-back' && inGap(state, ctx)) {
    const last = points[points.length - 1]
    const next = { ...beginCurve(state, curve, ctx, ctx.now - last.offset * MINUTE), phase: 'running' as const, backstopFrom: ctx.now }
    return { state: next, actions: [writeFrom(next, ctx.settings, ctx.now)], events }
  }
  const next = beginCurve(state, curve, ctx, ctx.now)
  return { state: next, actions: [writeFrom(next, ctx.settings, ctx.now)], events }
}

/** One tick of a side that has no run: wait for a window, a body or bedtime. */
function tickWaiting(state: RunState, ctx: TickContext, events: Decision['events']): Decision {
  const { now, settings, window } = ctx
  if (ctx.personOn) {
    const decided = command(state, inGap(state, ctx) ? 'start-back' : 'start-new', ctx)
    return { ...decided, events: [...events, ...decided.events] }
  }
  let next = state
  if (next.phase === 'closed') {
    if (next.closedUntil !== null && now < next.closedUntil) return { state: next, actions: [], events }
    next = { ...next, phase: 'idle', closedUntil: null, note: null }
  }
  if (ctx.away || !window) return { state: { ...next, windowFor: window ? next.windowFor : null }, actions: [], events }

  const opened = next.windowFor !== window.curve.bedtime
  const gap = inGap(next, ctx)
  // During the gap the window hasn't opened for this side, so it still can once the gap ends.
  if (!gap) next = { ...next, windowFor: window.curve.bedtime }

  if (next.movedAcross) {
    if (ctx.occupied === false || ctx.twoBodies) next = { ...next, movedAcross: false, note: null }
    else return { state: next, actions: [], events }
  }

  if (ctx.enteredAt !== null && ctx.enteredAt >= window.windowStart) {
    if (ctx.movedAcross) return { state: { ...next, movedAcross: true, note: MOVED_ACROSS_NOTE }, actions: [], events }
    if (!gap) return startFromEntry(next, ctx, ctx.enteredAt, events)
  }
  if (opened && ctx.occupied === true && !gap) {
    if (ctx.otherOpenAndEmpty) return { state: { ...next, note: 'Waiting: the other side may be lying across' }, actions: [], events }
    return startFromEntry(next, ctx, now, events)
  }
  if (settings.warmUp && now >= window.curve.bedtime && next.warmedFor !== window.curve.bedtime && !gap
    && now < window.curve.bedtime + settings.warmUpWaitHours * HOUR) {
    const endsAt = window.curve.bedtime + settings.warmUpWaitHours * HOUR
    const warming: RunState = { ...endRun(next), phase: 'warming', warmedFor: window.curve.bedtime, copyEndsAt: endsAt, lastWriteAt: now, note: null }
    events.push({ kind: 'warm-up' })
    return { state: warming, actions: [{ kind: 'hold', temperature: window.curve.points[0].temperature, endsAt }], events }
  }
  return { state: next, actions: [], events }
}

function tickWarming(state: RunState, ctx: TickContext, events: Decision['events']): Decision {
  if (ctx.away) return { state: close(state, ctx, 'Away', false), actions: [{ kind: 'off' }], events }
  if (ctx.personOff) {
    events.push({ kind: 'person-off' })
    return { state: close(state, ctx, 'Turned off for tonight', false), actions: [{ kind: 'off' }], events }
  }
  let next = state
  if (ctx.movedAcross) next = { ...next, movedAcross: true, note: MOVED_ACROSS_NOTE }
  else if (next.movedAcross && (ctx.occupied === false || ctx.twoBodies)) next = { ...next, movedAcross: false, note: null }
  const entered = ctx.enteredAt ?? (ctx.occupied === true ? ctx.now : null)
  if (!next.movedAcross && entered !== null && ctx.window) {
    return startFromEntry({ ...next, phase: 'idle' }, ctx, entered, events)
  }
  if (next.copyEndsAt !== null && ctx.now >= next.copyEndsAt) {
    events.push({ kind: 'warm-up-ended' })
    return { state: { ...endRun(next), phase: 'idle', note: null }, actions: [{ kind: 'off' }], events }
  }
  if (refreshDue(next, ctx)) return { state: { ...next, lastWriteAt: ctx.now }, actions: [{ kind: 'refresh' }], events }
  return { state: next, actions: [], events }
}

function tickRun(state: RunState, ctx: TickContext, events: Decision['events']): Decision {
  const { now, settings } = ctx
  let next = state

  if (ctx.away) return { state: close(next, ctx, 'Away', true), actions: [{ kind: 'off' }], events }
  if (ctx.personOff) {
    events.push({ kind: 'person-off' })
    // The off itself leaves the run-once session active, so end that too.
    return { state: close(next, ctx, 'Turned off for tonight', curveMs(next, now) >= settings.shortRunHours * HOUR), actions: [{ kind: 'off' }], events }
  }
  if (next.backstopFrom !== null && now >= next.backstopFrom + settings.backstopHours * HOUR && next.phase === 'running') {
    events.push({ kind: 'backstop' })
    return { state: close(next, ctx, 'Reached the backstop', true), actions: [{ kind: 'off' }], events }
  }
  if (next.phase === 'reading' && now >= (next.curveZeroAt as number)) {
    next = { ...next, phase: 'running', backstopFrom: next.curveZeroAt }
  }

  // Sensors blind: hold everything, with trip timers frozen.
  if (ctx.occupied === null) {
    if (next.absentSince !== null) next = { ...next, absentSince: next.absentSince + ctx.elapsedMs }
    return { state: next.note === BLIND_NOTE ? next : { ...next, note: BLIND_NOTE }, actions: [], events }
  }
  if (next.note === BLIND_NOTE) next = { ...next, note: null }

  // An unplanned off: the 8-hour timer, a reboot or a firmware reset.
  if (!ctx.sideOn && !next.offForTrip) {
    if (ctx.safetyStop) return { state: { ...next, note: 'Safety stop: the pump guard turned this side off' }, actions: [], events }
    if (ctx.occupied) {
      events.push({ kind: 'came-back-on' })
      next = { ...next, note: 'Came back on after the side went off', lastWriteAt: now }
      return { state: next, actions: [writeFrom(next, settings, now)], events }
    }
  }

  if (ctx.occupied) {
    if (next.absentSince !== null) return returnToBed(next, ctx, events)
  }
  else {
    if (next.absentSince === null) next = { ...next, absentSince: now }
    const absentSince = next.absentSince as number
    const out = now - absentSince
    const [firstStep, secondStep, thirdStep] = settings.tripStepMinutes.map(m => m * MINUTE)
    const leftQuickly = absentSince - (next.startedAt ?? absentSince) <= settings.falseStartWithinMinutes * MINUTE
    if (leftQuickly && out >= settings.falseStartOutMinutes * MINUTE) {
      events.push({ kind: 'false-start' })
      const waitEndsAt = ctx.window ? ctx.window.curve.bedtime + settings.warmUpWaitHours * HOUR : 0
      if (settings.warmUp && waitEndsAt > now) {
        const endsAt = waitEndsAt
        const temperature = (next.points as CurvePoint[])[0].temperature
        return { state: { ...endRun(next), phase: 'warming', copyEndsAt: endsAt, lastWriteAt: now, note: null }, actions: [{ kind: 'hold', temperature, endsAt }], events }
      }
      return { state: { ...endRun(next), phase: 'idle', note: null }, actions: [{ kind: 'off' }], events }
    }
    const curveSoFar = curveMs(next, now)
    if (curveSoFar < settings.shortRunHours * HOUR && out >= secondStep) {
      events.push({ kind: 'short-run' })
      return { state: { ...endRun(next), phase: 'idle', note: null }, actions: [{ kind: 'off' }], events }
    }
    if (curveSoFar >= settings.earliestEndHours * HOUR) {
      if (out >= settings.endOutMinutes * MINUTE) {
        events.push({ kind: 'end-of-night' })
        return { state: close(next, ctx, 'Finished for tonight', true), actions: [{ kind: 'off' }], events }
      }
    }
    else {
      if (out >= thirdStep) {
        events.push({ kind: 'trip-ended-run' })
        return { state: close(next, ctx, 'Out of bed too long', true), actions: next.offForTrip ? [] : [{ kind: 'off' }], events }
      }
      if (out >= secondStep && !next.offForTrip && next.phase === 'running') {
        events.push({ kind: 'trip-off' })
        // A missed tick can skip the pause step, so the curve still stops where it should.
        next = { ...next, offForTrip: true, pausedAt: next.pausedAt ?? absentSince + firstStep, note: 'Off, waiting for someone to come back' }
        return { state: next, actions: [{ kind: 'off' }], events }
      }
      if (out >= firstStep && next.pausedAt === null && next.phase === 'running') {
        events.push({ kind: 'trip-pause' })
        next = { ...next, pausedAt: now, lastWriteAt: now, note: 'Paused while the side is empty' }
        const temperature = temperatureAt(next.points as CurvePoint[], position(next, now))
        return { state: next, actions: [{ kind: 'hold', temperature, endsAt: absentSince + thirdStep }], events }
      }
    }
  }

  if (next.pausedAt === null && !next.offForTrip) {
    const backstopAt = (next.backstopFrom as number) + settings.backstopHours * HOUR
    const copyEnding = next.phase === 'running' && next.copyEndsAt !== null
      && next.copyEndsAt - now < 30 * MINUTE && next.copyEndsAt < backstopAt
    if (copyEnding) {
      next = { ...next, lastWriteAt: now }
      return { state: next, actions: [writeFrom(next, settings, now)], events }
    }
    if (refreshDue(next, ctx)) return { state: { ...next, lastWriteAt: now }, actions: [{ kind: 'refresh' }], events }
  }
  return { state: next, actions: [], events }
}

function returnToBed(state: RunState, ctx: TickContext, events: Decision['events']): Decision {
  const { now, settings } = ctx
  const out = now - (state.absentSince as number)
  const paused = state.pausedAt
  const moved = paused === null ? 0 : now - paused
  const longAbsence = out >= settings.tripStepMinutes[1] * MINUTE
  const next: RunState = {
    ...state,
    absentSince: null,
    pausedAt: null,
    offForTrip: false,
    curveZeroAt: (state.curveZeroAt as number) + moved,
    outMs: state.outMs + out - moved,
    backstopFrom: longAbsence ? now : state.backstopFrom,
    lastWriteAt: paused === null && !state.offForTrip ? state.lastWriteAt : now,
    note: null,
  }
  events.push({ kind: 'returned', detail: { outMinutes: Math.round(out / MINUTE) } })
  if (paused === null && !state.offForTrip) return { state: next, actions: [], events }
  return { state: next, actions: [writeFrom(next, settings, now)], events }
}

export interface FollowContext {
  now: number
  /** The settings of the side the sleeper moved to, and of the side they left. */
  settings: ForkSideSettings
  sourceSettings: ForkSideSettings
  sourceNextWindow: TonightWindow | null
}

/**
 * A lone sleeper moved across and stayed: their curve carries on under them
 * on this side from the point it had reached, and the side they left closes.
 */
export function follow(target: RunState, source: RunState, ctx: FollowContext): { target: Decision, source: Decision } {
  const { now } = ctx
  const reached = position(source, now)
  const begun = beginCurve(target, { points: source.points as CurvePoint[], bedtime: source.bedtime ?? now }, ctx, now - reached * MINUTE)
  const moved: RunState = { ...begun, phase: 'running', backstopFrom: source.backstopFrom ?? now, outMs: source.outMs, note: 'Followed from the other side' }
  const full = curveMs(source, now) >= ctx.sourceSettings.shortRunHours * HOUR
  return {
    target: { state: moved, actions: [writeFrom(moved, ctx.settings, now)], events: [{ kind: 'follow-in' }] },
    source: {
      state: close(source, { now, nextWindow: ctx.sourceNextWindow }, 'Moved to the other side', full),
      actions: source.offForTrip ? [] : [{ kind: 'off' }],
      events: [{ kind: 'follow-out' }],
    },
  }
}

export function tick(state: RunState, ctx: TickContext): Decision {
  const events: Decision['events'] = []
  if (!ctx.settings.smartStart) {
    if (state.phase === 'idle' || state.phase === 'closed') return { state, actions: [], events }
    return { state: { ...endRun(state), phase: 'idle', note: null }, actions: [{ kind: 'off' }], events: [{ kind: 'switched-off' }] }
  }
  switch (state.phase) {
    case 'idle':
    case 'closed':
      return tickWaiting(state, ctx, events)
    case 'warming':
      return tickWarming(state, ctx, events)
    default:
      return tickRun(state, ctx, events)
  }
}
