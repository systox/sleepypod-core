import { describe, expect, it } from 'vitest'
import { DEFAULT_SIDE_SETTINGS, type ForkSideSettings } from '../../settings'
import type { TonightWindow } from '../curves'
import { command, INITIAL_RUN, tick, type Action, type RunState, type TickContext } from '../engine'

const MIN = 60_000
const HOUR = 60 * MIN
const BEDTIME = 1_000 * HOUR
const POINTS = [{ offset: 0, temperature: 85 }, { offset: 45, temperature: 84 }, { offset: 150, temperature: 81 }, { offset: 240, temperature: 83 }]

const settings: ForkSideSettings = { ...DEFAULT_SIDE_SETTINGS, smartStart: true, hoursEarly: 1, hoursLate: 6 }

function windowFor(bedtime = BEDTIME, over: Partial<ForkSideSettings> = {}): TonightWindow {
  const s = { ...settings, ...over }
  return {
    curve: { day: 'monday', bedtime, points: POINTS },
    windowStart: bedtime - s.hoursEarly * HOUR,
    windowEnd: bedtime + s.hoursLate * HOUR,
  }
}

function ctx(now: number, over: Partial<TickContext> = {}, sideOver: Partial<ForkSideSettings> = {}): TickContext {
  const s = { ...settings, ...sideOver }
  const inWindow = now >= BEDTIME - s.hoursEarly * HOUR && now < BEDTIME + s.hoursLate * HOUR
  return {
    now,
    elapsedMs: 30_000,
    settings: s,
    occupied: false,
    leftAt: null,
    enteredAt: null,
    otherOpenAndEmpty: false,
    movedAcross: false,
    twoBodies: false,
    sideOn: true,
    away: false,
    personOff: false,
    personOn: false,
    safetyStop: false,
    window: inWindow ? windowFor(BEDTIME, sideOver) : null,
    nextWindow: windowFor(BEDTIME + 24 * HOUR),
    timerRefreshMs: 6 * HOUR,
    ...over,
  }
}

const kinds = (actions: Action[]) => actions.map(a => a.kind)

function started(at = BEDTIME + 10 * MIN, sideOver: Partial<ForkSideSettings> = {}): RunState {
  return tick(INITIAL_RUN, ctx(at, { occupied: true, enteredAt: at }, sideOver)).state
}

/** Step a run minute by minute through a stretch of the same bed state. */
function advance(state: RunState, from: number, minutes: number, over: Partial<TickContext> = {}, sideOver: Partial<ForkSideSettings> = {}) {
  let current = state
  const seen: Action[] = []
  const events: string[] = []
  for (let i = 0; i < minutes; i++) {
    const step = tick(current, ctx(from + i * MIN, { occupied: true, ...over }, sideOver))
    current = step.state
    seen.push(...step.actions)
    events.push(...step.events.map(e => e.kind))
  }
  return { state: current, actions: seen, events }
}

describe('starting', () => {
  it('does nothing with the switch off', () => {
    const step = tick(INITIAL_RUN, ctx(BEDTIME, { occupied: true, enteredAt: BEDTIME }, { smartStart: false }))
    expect(step.actions).toEqual([])
    expect(step.state.phase).toBe('idle')
  })

  it('starts the curve from the top when someone gets in late, moving it all later', () => {
    const at = BEDTIME + HOUR
    const step = tick(INITIAL_RUN, ctx(at, { occupied: true, enteredAt: at }))
    expect(step.state).toMatchObject({ phase: 'running', curveZeroAt: at })
    expect(kinds(step.actions)).toEqual(['write'])
  })

  it('ignores an entry outside the window, so an afternoon nap starts nothing', () => {
    const at = BEDTIME + 12 * HOUR
    const step = tick(INITIAL_RUN, ctx(at, { occupied: true, enteredAt: at, window: null }))
    expect(step.state.phase).toBe('idle')
    expect(step.actions).toEqual([])
  })

  it('counts when they got in, not when the call came', () => {
    const windowEnd = BEDTIME + 6 * HOUR
    const step = tick(INITIAL_RUN, ctx(windowEnd - 2 * MIN, { occupied: true, enteredAt: windowEnd - 7 * MIN }))
    expect(step.state.phase).toBe('running')
  })

  it('with Reading mode, holds the first temperature until bedtime', () => {
    const at = BEDTIME - 40 * MIN
    const step = tick(INITIAL_RUN, ctx(at, { occupied: true, enteredAt: at }, { readingMode: true }))
    expect(step.state).toMatchObject({ phase: 'reading', curveZeroAt: BEDTIME })
    const later = advance(step.state, at + MIN, 41, {}, { readingMode: true })
    expect(later.state.phase).toBe('running')
    expect(kinds(later.actions)).toEqual([])
  })

  it('without Reading mode, moves the whole curve earlier', () => {
    const at = BEDTIME - 40 * MIN
    expect(tick(INITIAL_RUN, ctx(at, { occupied: true, enteredAt: at })).state).toMatchObject({ phase: 'running', curveZeroAt: at })
  })

  it('stays off until the hours-early window opens, then comes on by itself', () => {
    const before = BEDTIME - 2 * HOUR
    const early = tick(INITIAL_RUN, ctx(before, { occupied: true, enteredAt: before }))
    expect(early.state.phase).toBe('idle')
    const opened = tick(early.state, ctx(BEDTIME - HOUR, { occupied: true }, { readingMode: true }))
    expect(opened.state).toMatchObject({ phase: 'reading', curveZeroAt: BEDTIME })
  })

  it('waits when a body is on this side as the window opens and the other side is empty', () => {
    const step = tick(INITIAL_RUN, ctx(BEDTIME - HOUR, { occupied: true, otherOpenAndEmpty: true }))
    expect(step.state.phase).toBe('idle')
    expect(step.state.note).toMatch(/lying across/)
  })

  it('leaves a body alone in a window that was open when the switch came on', () => {
    const step = tick({ ...INITIAL_RUN, windowFor: BEDTIME }, ctx(BEDTIME + HOUR, { occupied: true }))
    expect(step.state.phase).toBe('idle')
    expect(step.actions).toEqual([])
  })

  it('still opens a window for someone in bed once the minimum gap ends', () => {
    const gap = { minimumGapHours: 2 }
    const inside = tick({ ...INITIAL_RUN, fullRunEndedAt: BEDTIME - HOUR }, ctx(BEDTIME, { occupied: true }, gap))
    expect(inside.state.phase).toBe('idle')
    expect(tick(inside.state, ctx(BEDTIME + HOUR, { occupied: true }, gap)).state.phase).toBe('running')
  })

  it('refreshes the firmware timer while someone reads', () => {
    const at = BEDTIME - 40 * MIN
    const step = tick(started(at, { readingMode: true }), ctx(at + 20 * MIN, { occupied: true, timerRefreshMs: 10 * MIN }, { readingMode: true }))
    expect(kinds(step.actions)).toEqual(['refresh'])
  })

  it('Sleep Now begins the curve at once', () => {
    const at = BEDTIME - 40 * MIN
    const reading = started(at, { readingMode: true })
    const step = command(reading, 'sleep-now', ctx(at + 10 * MIN, { occupied: true }, { readingMode: true }))
    expect(step.state).toMatchObject({ phase: 'running', curveZeroAt: at + 10 * MIN })
    expect(kinds(step.actions)).toEqual(['write'])
  })
})

describe('Warm up', () => {
  const warm = { warmUp: true }

  it('comes on at bedtime with nobody in bed and waits at the first temperature', () => {
    const step = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm))
    expect(step.state.phase).toBe('warming')
    expect(step.actions).toEqual([{ kind: 'hold', temperature: 85, endsAt: BEDTIME + 3 * HOUR }])
  })

  it('starts the curve from the top when someone gets in', () => {
    const waiting = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm)).state
    const at = BEDTIME + 24 * MIN
    expect(tick(waiting, ctx(at, { occupied: true, enteredAt: at }, warm)).state).toMatchObject({ phase: 'running', curveZeroAt: at })
  })

  it('turns off after the wait, and a later entry inside the window still starts it', () => {
    const waiting = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm)).state
    const ended = tick(waiting, ctx(BEDTIME + 3 * HOUR, {}, warm))
    expect(ended.state.phase).toBe('idle')
    expect(kinds(ended.actions)).toEqual(['off'])
    const again = tick(ended.state, ctx(BEDTIME + 3 * HOUR + MIN, {}, warm))
    expect(again.state.phase).toBe('idle')
    const at = BEDTIME + 4 * HOUR
    expect(tick(ended.state, ctx(at, { occupied: true, enteredAt: at }, warm)).state.phase).toBe('running')
  })

  it('closes and turns off for Away', () => {
    const waiting = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm)).state
    const step = tick(waiting, ctx(BEDTIME + MIN, { away: true }, warm))
    expect(step.state.phase).toBe('closed')
    expect(kinds(step.actions)).toEqual(['off'])
  })

  it('closes and turns off when a person turns the side off', () => {
    const waiting = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm)).state
    const step = tick(waiting, ctx(BEDTIME + MIN, { sideOn: false, personOff: true }, warm))
    expect(step.state.phase).toBe('closed')
    expect(kinds(step.actions)).toEqual(['off'])
  })

  it('does not start for someone moving across, and starts for the next real entry', () => {
    let at = BEDTIME + 10 * MIN
    let state = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm)).state
    state = tick(state, ctx(at, { occupied: true, enteredAt: at, movedAcross: true }, warm)).state
    expect(state).toMatchObject({ phase: 'warming', movedAcross: true })
    state = tick(state, ctx(at + MIN, { occupied: true }, warm)).state
    expect(state.phase).toBe('warming')
    state = tick(state, ctx(at + 2 * MIN, { occupied: false }, warm)).state
    expect(state).toMatchObject({ phase: 'warming', movedAcross: false })
    at += 30 * MIN
    expect(tick(state, ctx(at, { occupied: true, enteredAt: at }, warm)).state.phase).toBe('running')
  })

  it('still ends at the wait with someone moved across', () => {
    const waiting = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm)).state
    const step = tick({ ...waiting, movedAcross: true }, ctx(BEDTIME + 3 * HOUR, { occupied: true }, warm))
    expect(step.state.phase).toBe('idle')
    expect(kinds(step.actions)).toEqual(['off'])
  })

  it('refreshes the firmware timer while waiting', () => {
    const waiting = tick(INITIAL_RUN, ctx(BEDTIME, {}, warm)).state
    expect(kinds(tick(waiting, ctx(BEDTIME + 2 * HOUR, { timerRefreshMs: HOUR }, warm)).actions)).toEqual(['refresh'])
  })

  it('is skipped inside the minimum gap', () => {
    const state = { ...INITIAL_RUN, fullRunEndedAt: BEDTIME - 2 * HOUR }
    expect(tick(state, ctx(BEDTIME, {}, warm)).state.phase).toBe('idle')
  })
})

describe('trips out of bed', () => {
  const entered = BEDTIME + 10 * MIN
  const leaveAt = entered + 4 * HOUR

  function leftFor(minutes: number) {
    const state = advance(started(entered), entered + MIN, 4 * 60 - 1).state
    return advance(state, leaveAt, minutes, { occupied: false })
  }

  it('changes nothing up to the first step', () => {
    const out = leftFor(19)
    expect(out.actions).toEqual([])
    expect(out.state.pausedAt).toBeNull()
  })

  it('pauses at the first step and holds the current temperature', () => {
    const out = leftFor(21)
    expect(kinds(out.actions)).toEqual(['hold'])
    expect(out.state.pausedAt).toBe(leaveAt + 20 * MIN)
  })

  it('turns the side off at the second step with the run still open', () => {
    const out = leftFor(61)
    expect(kinds(out.actions)).toEqual(['hold', 'off'])
    expect(out.state).toMatchObject({ phase: 'running', offForTrip: true })
  })

  it('still stops the curve at the first step when a missed tick skips the pause', () => {
    const state = advance(started(entered), entered + MIN, 4 * 60 - 1).state
    const left = tick(state, ctx(leaveAt, { occupied: false })).state
    const step = tick(left, ctx(leaveAt + 61 * MIN, { occupied: false }))
    expect(kinds(step.actions)).toEqual(['off'])
    expect(step.state).toMatchObject({ offForTrip: true, pausedAt: leaveAt + 20 * MIN })
  })

  it('picks up where it paused, with the curve later by the pause', () => {
    const out = leftFor(90)
    const zero = out.state.curveZeroAt as number
    const back = tick(out.state, ctx(leaveAt + 90 * MIN, { occupied: true, enteredAt: leaveAt + 90 * MIN, sideOn: false }))
    expect(back.state).toMatchObject({ absentSince: null, pausedAt: null, offForTrip: false })
    expect(back.state.curveZeroAt).toBe(zero + 70 * MIN)
    expect(kinds(back.actions)).toEqual(['write'])
  })

  it('ends the run and closes the side after the third step', () => {
    const out = leftFor(181)
    expect(out.state.phase).toBe('closed')
    expect(out.events).toContain('trip-ended-run')
  })

  it('does not rewrite anything after a short trip', () => {
    const out = leftFor(10)
    const back = tick(out.state, ctx(leaveAt + 10 * MIN, { occupied: true }))
    expect(back.actions).toEqual([])
    expect(back.state.absentSince).toBeNull()
  })

  it('freezes trip timers while sensors are blind', () => {
    const out = leftFor(10)
    const blind = advance(out.state, leaveAt + 10 * MIN, 120, { occupied: null, elapsedMs: MIN })
    expect(blind.actions).toEqual([])
    expect(blind.state.note).toBe('Sensors blind')
    expect(advance(blind.state, leaveAt + 130 * MIN, 5, { occupied: false }).state.pausedAt).toBeNull()
  })
})

describe('blind sensors', () => {
  it('clears the note once sensors return', () => {
    const entered = BEDTIME + 10 * MIN
    const blind = tick(started(entered), ctx(entered + MIN, { occupied: null })).state
    expect(blind.note).toBe('Sensors blind')
    expect(tick(blind, ctx(entered + 2 * MIN, { occupied: true })).state.note).toBeNull()
  })

  it('keeps a real note it did not write', () => {
    const entered = BEDTIME + 10 * MIN
    const noted = { ...started(entered), note: 'Came back on after the side went off' }
    expect(tick(noted, ctx(entered + MIN, { occupied: true })).state.note).toBe(noted.note)
  })
})

describe('ending', () => {
  const entered = BEDTIME

  it('holds until the side has been out 30 minutes after the earliest end, then closes', () => {
    const state = advance(started(entered), entered + MIN, 8 * 60).state
    const leave = entered + 8 * HOUR + MIN
    const trip = advance(state, leave, 29, { occupied: false })
    expect(trip.actions).toEqual([])
    const done = advance(trip.state, leave + 29 * MIN, 2, { occupied: false })
    expect(done.state.phase).toBe('closed')
    expect(kinds(done.actions)).toEqual(['off'])
    expect(done.state.fullRunEndedAt).not.toBeNull()
  })

  it('counts the 30 minutes from when the sleeper got up, not from when presence was sure', () => {
    const state = advance(started(entered), entered + MIN, 8 * 60).state
    const leave = entered + 8 * HOUR + MIN
    // Presence calls the exit 5 minutes late, dated back to when they left.
    const trip = advance(state, leave + 5 * MIN, 24, { occupied: false, leftAt: leave })
    expect(trip.state.absentSince).toBe(leave)
    expect(trip.actions).toEqual([])
    const done = advance(trip.state, leave + 29 * MIN, 2, { occupied: false, leftAt: leave })
    expect(done.state.phase).toBe('closed')
  })

  it('counts the earliest end without time out of bed', () => {
    // In at 23:00 and up from 01:30 to 03:00: 7 hours of curve lands at 07:30, not 06:00.
    let state = advance(started(entered), entered + MIN, 149).state
    state = advance(state, entered + 150 * MIN, 90, { occupied: false }).state
    state = advance(state, entered + 240 * MIN, 1).state
    state = advance(state, entered + 241 * MIN, 264).state
    const early = advance(state, entered + 505 * MIN, 31, { occupied: false })
    expect(early.state.phase).toBe('running')
    state = advance(state, entered + 505 * MIN, 10).state
    const late = advance(state, entered + 515 * MIN, 31, { occupied: false })
    expect(late.state.phase).toBe('closed')
  })

  it('stops at the backstop, which restarts after a long absence', () => {
    const state = advance(started(entered), entered + MIN, 16 * 60 - 1).state
    const step = tick(state, ctx(entered + 16 * HOUR, { occupied: true }))
    expect(step.state.phase).toBe('closed')
    expect(step.events.map(e => e.kind)).toContain('backstop')
  })

  it('renews the 14-hour copy so a long curve reaches the backstop', () => {
    const state = { ...advance(started(entered), entered + MIN, 13 * 60).state, copyEndsAt: entered + 14 * HOUR }
    expect(kinds(tick(state, ctx(entered + 13.75 * HOUR, { occupied: true })).actions)).toEqual(['write'])
  })

  it('keeps a closed side closed whatever the sensors see', () => {
    const closed = { ...INITIAL_RUN, phase: 'closed' as const, closedUntil: BEDTIME + 20 * HOUR, fullRunEndedAt: BEDTIME + 9 * HOUR }
    const step = tick(closed, ctx(BEDTIME + 10 * HOUR, { occupied: true, enteredAt: BEDTIME + 10 * HOUR, window: windowFor() }))
    expect(step.state.phase).toBe('closed')
    expect(step.actions).toEqual([])
  })

  it('reopens at the next window but not inside the minimum gap', () => {
    const closed = { ...INITIAL_RUN, phase: 'closed' as const, closedUntil: BEDTIME - HOUR, fullRunEndedAt: BEDTIME - 2 * HOUR }
    const step = tick(closed, ctx(BEDTIME, { occupied: true, enteredAt: BEDTIME }))
    expect(step.state.phase).toBe('idle')
    expect(step.actions).toEqual([])
  })
})

describe('guards', () => {
  const entered = BEDTIME + 10 * MIN

  it('treats leaving soon after starting as a false start that uses nothing up', () => {
    const state = advance(started(entered), entered + MIN, 9).state
    const out = advance(state, entered + 10 * MIN, 16, { occupied: false })
    expect(out.state.phase).toBe('idle')
    expect(out.state.fullRunEndedAt).toBeNull()
    expect(out.events).toContain('false-start')
    expect(kinds(out.actions)).toEqual(['off'])
  })

  it('goes back to waiting after a false start with Warm up on', () => {
    const warm = { warmUp: true }
    const state = advance(started(entered, warm), entered + MIN, 9, {}, warm).state
    const out = advance(state, entered + 10 * MIN, 16, { occupied: false }, warm)
    expect(out.state.phase).toBe('warming')
    expect(kinds(out.actions)).toEqual(['hold'])
  })

  it('lets a short run go without using up the night', () => {
    const state = advance(started(entered), entered + MIN, 60).state
    const out = advance(state, entered + 61 * MIN, 61, { occupied: false })
    expect(out.state.phase).toBe('idle')
    expect(out.state.fullRunEndedAt).toBeNull()
    const at = entered + 3 * HOUR
    expect(tick(out.state, ctx(at, { occupied: true, enteredAt: at })).state).toMatchObject({ phase: 'running', curveZeroAt: at })
  })

  it('makes a side wait when someone seems to have moved across', () => {
    const step = tick(INITIAL_RUN, ctx(BEDTIME, { occupied: true, enteredAt: BEDTIME, movedAcross: true }))
    expect(step.state).toMatchObject({ phase: 'idle', movedAcross: true })
    expect(step.actions).toEqual([])
    expect(tick(step.state, ctx(BEDTIME + MIN, { occupied: true })).state.phase).toBe('idle')
  })

  it('stops waiting when two bodies show', () => {
    const waiting = tick(INITIAL_RUN, ctx(BEDTIME, { occupied: true, enteredAt: BEDTIME, movedAcross: true })).state
    const at = BEDTIME + 30 * MIN
    expect(tick(waiting, ctx(at, { occupied: true, enteredAt: at, twoBodies: true })).state.phase).toBe('running')
  })
})

describe('a side going off during a run', () => {
  const entered = BEDTIME + 10 * MIN
  const running = () => advance(started(entered), entered + MIN, 120).state
  const at = entered + 121 * MIN

  it('closes when a person turned it off', () => {
    const step = tick(running(), ctx(at, { occupied: true, sideOn: false, personOff: true }))
    expect(step.state.phase).toBe('closed')
    expect(kinds(step.actions)).toEqual(['off'])
  })

  it('comes back on at the current point after a lapse with someone in bed', () => {
    const step = tick(running(), ctx(at, { occupied: true, sideOn: false }))
    expect(kinds(step.actions)).toEqual(['write'])
    expect(step.events.map(e => e.kind)).toContain('came-back-on')
  })

  it('carries on with the trip rules with nobody in bed', () => {
    const step = tick(running(), ctx(at, { occupied: false, sideOn: false }))
    expect(step.actions).toEqual([])
    expect(step.state.absentSince).toBe(at)
  })

  it('stays off for the pump guard', () => {
    const step = tick(running(), ctx(at, { occupied: true, sideOn: false, safetyStop: true }))
    expect(step.actions).toEqual([])
    expect(step.state.note).toMatch(/Safety stop/)
  })

  it('ends the run when Away is set', () => {
    const step = tick(running(), ctx(at, { occupied: true, away: true }))
    expect(step.state.phase).toBe('closed')
    expect(kinds(step.actions)).toEqual(['off'])
  })

  it('refreshes the firmware timer during a flat stretch', () => {
    const out = advance(started(entered), entered + MIN, 6 * 60 + 1)
    expect(kinds(out.actions)).toEqual(['refresh'])
  })
})

describe('deliberate commands', () => {
  it('Stop closes the side until its next window', () => {
    const step = command(started(), 'stop', ctx(BEDTIME + HOUR, { occupied: true }))
    expect(step.state.phase).toBe('closed')
    expect(step.state.closedUntil).toBe(BEDTIME + 23 * HOUR)
    expect(kinds(step.actions)).toEqual(['off'])
  })

  it('Back to Bed inside the gap holds the curve\'s last temperature', () => {
    const closed = { ...INITIAL_RUN, phase: 'closed' as const, closedUntil: BEDTIME + 23 * HOUR, fullRunEndedAt: BEDTIME + 9 * HOUR }
    const now = BEDTIME + 10 * HOUR
    const step = command(closed, 'start-back', ctx(now, { window: windowFor(BEDTIME + 24 * HOUR) }))
    expect(step.state.phase).toBe('running')
    const write = step.actions[0]
    expect(write.kind === 'write' && (now - write.curveZeroAt) / MIN).toBe(240)
  })

  it('New Night starts the curve from the top', () => {
    const closed = { ...INITIAL_RUN, phase: 'closed' as const, fullRunEndedAt: BEDTIME + 9 * HOUR }
    const now = BEDTIME + 10 * HOUR
    const step = command(closed, 'start-new', ctx(now, { window: windowFor(BEDTIME + 24 * HOUR) }))
    expect(step.state).toMatchObject({ phase: 'running', curveZeroAt: now })
  })

  it('turning a closed side on counts as Back to Bed inside the gap', () => {
    const closed = { ...INITIAL_RUN, phase: 'closed' as const, closedUntil: BEDTIME + 23 * HOUR, fullRunEndedAt: BEDTIME + 9 * HOUR }
    const now = BEDTIME + 20 * HOUR
    const step = tick(closed, ctx(now, { personOn: true, window: windowFor(BEDTIME + 24 * HOUR) }))
    expect(step.state.phase).toBe('running')
  })

  it('turning a side on between windows starts the next curve', () => {
    const now = BEDTIME + 12 * HOUR
    const step = tick(INITIAL_RUN, ctx(now, { personOn: true, window: null, sideOn: true }))
    expect(step.state).toMatchObject({ phase: 'running', curveZeroAt: now, points: POINTS })
  })

  it('Start between windows uses the next curve', () => {
    const step = command(INITIAL_RUN, 'start-new', ctx(BEDTIME + 12 * HOUR, { window: null }))
    expect(kinds(step.actions)).toEqual(['write'])
  })

  it('says so when no curve is saved', () => {
    const step = command(INITIAL_RUN, 'start-new', ctx(BEDTIME + 12 * HOUR, { window: null, nextWindow: null }))
    expect(step.actions).toEqual([])
    expect(step.state.note).toMatch(/No curve/)
  })

  it('turning the switch off during a run hands the side back', () => {
    const step = tick(started(), ctx(BEDTIME + HOUR, { occupied: true }, { smartStart: false }))
    expect(step.state.phase).toBe('idle')
    expect(kinds(step.actions)).toEqual(['off'])
  })
})
