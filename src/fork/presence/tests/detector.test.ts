import { describe, expect, it } from 'vitest'
import { initialPresence, markEmpty, stepPresence, type MinuteReading, type PresenceConfig, type PresenceEvent, type PresenceState } from '../detector'

const side = { minutesToCall: 5, weightRise: 1000, vibrationLimit: 1.2e6 }
const config: PresenceConfig = {
  left: { ...side, otherSideShare: 0 },
  right: { ...side, otherSideShare: 0.3 },
  emptyVibration: 1e5,
}

const EMPTY = { w: 5000, v: 2e4 }
const SLEEPER = { w: 8300, v: 2.3e6 }
const CROSSED = { w: 5300, v: 7e5 }

type Pair = [{ w: number | null, v: number | null }, { w: number | null, v: number | null }]

function replay(start: PresenceState, spans: Array<[number, ...Pair]>): { state: PresenceState, events: Array<PresenceEvent & { minute: number }> } {
  let state = start
  let minute = 0
  const events: Array<PresenceEvent & { minute: number }> = []
  for (const [count, left, right] of spans) {
    for (let i = 0; i < count; i++) {
      const reading: MinuteReading = {
        ts: minute * 60_000,
        weight: { left: left.w, right: right.w },
        vibration: { left: left.v, right: right.v },
      }
      const step = stepPresence(state, reading, config)
      state = step.state
      events.push(...step.events.map(e => ({ ...e, minute: e.at / 60_000 })))
      minute++
    }
  }
  return { state, events }
}

describe('in-bed detection', () => {
  it('starts the count again after a gap in the readings, so a call is never dated across it', () => {
    const blind = { w: null, v: null }
    const { events } = replay(initialPresence(), [[10, EMPTY, EMPTY], [20, EMPTY, SLEEPER], [4, EMPTY, EMPTY], [30, blind, blind], [8, EMPTY, EMPTY]])
    const out = events.find(e => e.kind === 'out')
    // Out from minute 30, blind 34 to 63: the call counts only the minutes after the gap.
    expect(out?.minute).toBeGreaterThanOrEqual(64)
  })

  it('calls someone in once both signals agree, dated from the start of the run', () => {
    const { events } = replay(initialPresence(), [[10, EMPTY, EMPTY], [10, EMPTY, SLEEPER]])
    expect(events).toEqual([expect.objectContaining({ side: 'right', kind: 'in' })])
    // Rolling vibration crosses on the third minute after entry.
    expect(events[0].minute).toBe(12)
  })

  it('stays in while a still sleeper reads below the vibration limit', () => {
    const still = { w: 8300, v: 8.5e5 }
    const { events, state } = replay(initialPresence(), [[10, EMPTY, EMPTY], [10, EMPTY, SLEEPER], [30, EMPTY, still]])
    expect(events.filter(e => e.kind === 'out')).toEqual([])
    expect(state.right.occupied).toBe(true)
  })

  it('ignores vibration on an empty side when no weight arrives', () => {
    const burst = { w: 5100, v: 3e6 }
    const { events } = replay(initialPresence(), [[10, EMPTY, EMPTY], [10, EMPTY, SLEEPER], [8, burst, SLEEPER]])
    expect(events.filter(e => e.side === 'left')).toEqual([])
  })

  it('waits for vibration when weight falls while someone is awake in bed', () => {
    const sittingUp = { w: 6000, v: 2e6 }
    const { events } = replay(initialPresence(), [
      [10, EMPTY, EMPTY], [10, SLEEPER, SLEEPER], [17, SLEEPER, sittingUp], [10, SLEEPER, CROSSED],
    ])
    const out = events.find(e => e.side === 'right' && e.kind === 'out')
    expect(out?.minute).toBeGreaterThan(36)
  })

  it('takes the other side\'s weight off before judging a side', () => {
    const pressed = { w: 5300 + 800, v: 7e5 }
    const { events } = replay(initialPresence(), [[10, EMPTY, EMPTY], [20, SLEEPER, pressed]])
    expect(events.filter(e => e.side === 'right')).toEqual([])
  })

  it('never reads missing data as an empty bed', () => {
    const gone = { w: null, v: null }
    const { events, state } = replay(initialPresence(), [[10, EMPTY, EMPTY], [10, SLEEPER, EMPTY], [30, gone, gone]])
    expect(events.filter(e => e.kind === 'out')).toEqual([])
    expect(state.left.occupied).toBe(true)
  })

  it('relearns the empty level only on proof that the bed is empty', () => {
    const drifted = { w: 5900, v: 2e4 }
    const empty = replay(initialPresence(), [[10, drifted, drifted]])
    expect(empty.state.left.emptyLevel).toBe(5900)
    const occupied = replay(initialPresence(), [[10, EMPTY, EMPTY], [30, { w: 8300, v: 2e6 }, EMPTY]])
    expect(occupied.state.left.emptyLevel).toBe(5000)
  })

  it('marks the bed empty on request', () => {
    const { state } = replay(initialPresence(), [[10, SLEEPER, SLEEPER]])
    const marked = markEmpty(state, { left: 6200, right: 6100 }, 1000)
    expect(marked.left).toMatchObject({ occupied: false, emptyLevel: 6200, since: 1000 })
    expect(marked.right).toMatchObject({ occupied: false, emptyLevel: 6100 })
  })
})
