import { describe, expect, it } from 'vitest'
import { anchorAfter, barsFor, dayBars, dayDate, EMPTY_WEEK, makeThisWeek, mondayOf, moveSpot, repeatText, sparkline, stepOf, stepsFrom, weekDates, weekSummary } from '../weekLogic'
import { describeSide, groupNights, nextStep, type SideView } from '../tonightLogic'
import { INITIAL_RUN } from '@/src/fork/smart/engine'
import { DEFAULT_SIDE_SETTINGS } from '@/src/fork/settings'

describe('week strip', () => {
  const overnight = { bedtime: '22:30', wake: '06:00' }
  const morning = { bedtime: '06:00', wake: '15:00' }

  it('places a morning curve on its own day', () => {
    expect(barsFor(morning, undefined)).toEqual([{ top: 25, height: 37.5 }])
  })

  it('runs an evening curve to the end of its day', () => {
    const [bar] = barsFor(overnight, undefined)
    expect(bar.top).toBeCloseTo(93.75)
    expect(bar.top + bar.height).toBeCloseTo(100)
  })

  it('shows the end of the day before\'s curve', () => {
    expect(barsFor(undefined, overnight)).toEqual([{ top: 0, height: 25 }])
    expect(barsFor(overnight, overnight)).toHaveLength(2)
  })

  it('shows nothing from a day before that ended that day', () => {
    expect(barsFor(undefined, morning)).toEqual([])
  })

  it('wraps Monday round to the Sunday before', () => {
    const curves = new Map([[1, overnight]])
    expect(dayBars({ ...EMPTY_WEEK, sunday: 1 }, 'monday', curves)).toEqual([{ top: 0, height: 25 }])
  })

  it('is empty with no curve', () => {
    expect(dayBars(EMPTY_WEEK, 'monday', new Map())).toEqual([])
  })
})

describe('day labels', () => {
  it('summarises a week', () => {
    const curves = new Map([[1, { name: 'Late Monday' }], [2, { name: 'Day shift' }]])
    const days = { ...EMPTY_WEEK, monday: 1, tuesday: 2, wednesday: 2, thursday: 2, friday: 2, saturday: 2, sunday: 9 }
    expect(weekSummary(days, curves)).toBe('Mon · Late Monday, Tue–Sat · Day shift, Sun · Missing')
  })

  it('says when a day has no curve', () => {
    expect(weekSummary(EMPTY_WEEK, new Map())).toBe('Every day · No curve')
  })
})

describe('rotation order', () => {
  it('finds this week\'s Monday', () => {
    expect(mondayOf(new Date(2026, 10, 2))).toBe('2026-11-02')
    expect(mondayOf(new Date(2026, 10, 8))).toBe('2026-11-02')
  })

  it('finds a later week\'s Monday', () => {
    expect(anchorAfter('2026-11-02', 5)).toBe('2026-12-07')
  })

  it('wraps weeks onto the order, counting back before the anchor', () => {
    expect([0, 3, 4, -1].map(week => stepOf(week, 3))).toEqual([0, 0, 1, 2])
  })

  it('dates each step, across a month', () => {
    expect(weekDates('2026-11-02', 0)).toBe('Nov 2 – 8')
    expect(weekDates('2026-11-02', 4)).toBe('Nov 30 – Dec 6')
    expect(dayDate('2026-11-02', 3)).toBe('Nov 23')
  })

  it('counts the weeks it repeats over', () => {
    expect(repeatText(1)).toBe('Repeats every week')
    expect(repeatText(4)).toBe('Repeats every 4 weeks')
  })

  it('moves a week into a slot, and the later weeks move on one', () => {
    const lists = { active: ['a', 'b', 'c'], inactive: ['d'] }
    const active = (index: number) => ({ list: 'active' as const, index })
    const inactive = (index: number) => ({ list: 'inactive' as const, index })
    expect(moveSpot(lists, active(2), active(0))).toEqual({ active: ['c', 'a', 'b'], inactive: ['d'] })
    expect(moveSpot(lists, active(0), active(2))).toEqual({ active: ['b', 'c', 'a'], inactive: ['d'] })
    expect(moveSpot(lists, inactive(0), active(1))).toEqual({ active: ['a', 'd', 'b', 'c'], inactive: [] })
    expect(moveSpot(lists, inactive(0), active(3))).toEqual({ active: ['a', 'b', 'c', 'd'], inactive: [] })
    expect(moveSpot(lists, active(1), inactive(1))).toEqual({ active: ['a', 'c'], inactive: ['d', 'b'] })
  })

  it('changes nothing for a drop in place, between inactive weeks, or of the last rotation week', () => {
    const lists = { active: ['a'], inactive: ['b', 'c'] }
    expect(moveSpot(lists, { list: 'active', index: 0 }, { list: 'active', index: 0 })).toBeNull()
    expect(moveSpot(lists, { list: 'inactive', index: 0 }, { list: 'inactive', index: 1 })).toBeNull()
    expect(moveSpot(lists, { list: 'active', index: 0 }, { list: 'inactive', index: 2 })).toBeNull()
  })

  it('keeps a week used twice out of Inactive until its last copy leaves', () => {
    expect(moveSpot({ active: ['a', 'b', 'a'], inactive: [] }, { list: 'active', index: 2 }, { list: 'inactive', index: 0 }))
      .toEqual({ active: ['a', 'b'], inactive: [] })
  })

  it('stores a new order so this week keeps its place in the rotation', () => {
    // Week 4 of a 3-step rotation is step 1, so the shown order starts there.
    const steps = stepsFrom(['c', 'a', 'b'], 4)
    expect(steps[stepOf(4, 3)]).toBe('c')
    expect(makeThisWeek(steps, stepOf(4, 3))).toEqual(['c', 'a', 'b'])
    expect(makeThisWeek(stepsFrom(['a', 'b', 'c', 'd'], 4), stepOf(4, 4))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps the order when another step becomes this week', () => {
    expect(makeThisWeek(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a'])
  })
})

describe('sparkline', () => {
  it('draws within its box and copes with one point', () => {
    expect(sparkline([{ temperature: 80 }, { temperature: 84 }], 100, 20)).toBe('0.0,18.0 100.0,2.0')
    expect(sparkline([{ temperature: 80 }], 100, 20)).toBe('0.0,2.0')
    expect(sparkline([], 100, 20)).toBe('')
  })
})

const NOW = 1_000_000_000_000
const clock = (at: number) => `t${(at - NOW) / 60_000}`

function view(over: Partial<SideView>): SideView {
  return {
    settings: { ...DEFAULT_SIDE_SETTINGS, smartStart: true },
    run: INITIAL_RUN,
    presence: { occupied: false, since: null },
    fade: null,
    tonight: null,
    upcoming: null,
    rotation: null,
    surface: { reading: null, offset: 0 },
    resumedAt: null,
    following: null,
    ...over,
  }
}

describe('side state in words', () => {
  it('says when Smart start is off', () => {
    expect(describeSide(view({ settings: DEFAULT_SIDE_SETTINGS }), NOW, clock)).toBe('On the weekly schedule')
  })

  it('says when someone got in', () => {
    const v = view({ run: { ...INITIAL_RUN, phase: 'running' }, presence: { occupied: true, since: NOW - 60_000 } })
    expect(describeSide(v, NOW, clock)).toBe('In bed since t-1')
  })

  it('says when a closed side reopens', () => {
    expect(describeSide(view({ run: { ...INITIAL_RUN, phase: 'closed', closedUntil: NOW + 60_000 } }), NOW, clock)).toBe('Closed until t1')
  })

  it('says when the window opens and closes', () => {
    const upcoming = { bedtime: NOW + 120_000, windowStart: NOW + 60_000, windowEnd: NOW + 180_000, firstTemperature: 85 }
    expect(describeSide(view({ upcoming }), NOW, clock)).toBe('Opens at t1')
    expect(describeSide(view({ upcoming: { ...upcoming, windowStart: NOW - 60_000 } }), NOW, clock)).toBe('Waiting for someone until t3')
  })

  it('finds the curve\'s next change', () => {
    const points = [{ offset: 0, temperature: 85 }, { offset: 60, temperature: 84 }]
    const run = { ...INITIAL_RUN, phase: 'running' as const, points, curveZeroAt: NOW - 30 * 60_000 }
    expect(nextStep({ run }, NOW)).toEqual({ at: NOW + 30 * 60_000, temperature: 84 })
    expect(nextStep({ run: { ...run, pausedAt: NOW } }, NOW)).toBeNull()
  })
})

describe('nights', () => {
  it('groups events by side and noon-to-noon night', () => {
    const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime()
    const rows = groupNights([
      { id: 1, ts: at(1, 23), side: 'right', kind: 'in' },
      { id: 2, ts: at(2, 2), side: 'right', kind: 'press' },
      { id: 3, ts: at(2, 7), side: 'right', kind: 'out' },
      { id: 4, ts: at(2, 5), side: 'left', kind: 'in' },
      { id: 5, ts: at(2, 5), side: null, kind: 'in' },
    ])
    expect(rows.map(r => [r.side, r.presses, r.events.length])).toEqual([['left', 0, 1], ['right', 1, 2]])
  })
})
