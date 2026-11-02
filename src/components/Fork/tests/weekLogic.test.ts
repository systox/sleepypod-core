import { describe, expect, it } from 'vitest'
import { barFor, dayDate, dayRange, EMPTY_WEEK, makeThisWeek, mondayOf, moveStep, repeatText, sparkline, weekDates, weekSummary } from '../weekLogic'
import { describeSide, groupNights, nextStep, type SideView } from '../tonightLogic'
import { INITIAL_RUN } from '@/src/fork/smart/engine'
import { DEFAULT_SIDE_SETTINGS } from '@/src/fork/settings'

describe('week strip', () => {
  it('places an evening curve across midnight on the 6 PM to 6 PM bar', () => {
    expect(barFor({ bedtime: '22:30', wake: '06:30' })).toEqual({ top: expect.closeTo(18.75), height: expect.closeTo(33.33, 1) })
  })

  it('places a morning curve lower on the bar', () => {
    expect(barFor({ bedtime: '04:00', wake: '12:00' }).top).toBeCloseTo(41.67, 1)
  })

  it('keeps a curve past the bar\'s end on the bar', () => {
    const bar = barFor({ bedtime: '12:00', wake: '20:00' })
    expect(bar.top + bar.height).toBeCloseTo(100)
  })

  it('is empty with no curve', () => {
    expect(barFor(undefined)).toEqual({ top: 0, height: 0 })
  })
})

describe('day labels', () => {
  it('joins runs of days', () => {
    expect(dayRange(['friday', 'monday', 'tuesday', 'wednesday'])).toBe('Mon–Wed, Fri')
    expect(dayRange(['saturday', 'sunday'])).toBe('Sat–Sun')
  })

  it('summarises a week', () => {
    const curves = new Map([[1, { name: 'Late Monday' }], [2, { name: 'Day shift' }]])
    const days = { ...EMPTY_WEEK, monday: 1, tuesday: 2, wednesday: 2, thursday: 2, friday: 2, saturday: 2, sunday: 9 }
    expect(weekSummary(days, curves)).toBe('Mon · Late Monday, Tue–Sat · Day shift, Sun · Missing')
  })

  it('says when a day has no curve', () => {
    expect(weekSummary(EMPTY_WEEK, new Map())).toBe('Mon–Sun · No curve')
  })
})

describe('rotation order', () => {
  it('finds this week\'s Monday', () => {
    expect(mondayOf(new Date(2026, 10, 2))).toBe('2026-11-02')
    expect(mondayOf(new Date(2026, 10, 8))).toBe('2026-11-02')
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

  it('never moves this week', () => {
    expect(moveStep(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b'])
    expect(moveStep(['a', 'b', 'c'], 1, 0)).toEqual(['a', 'b', 'c'])
    expect(moveStep(['a', 'b', 'c'], 0, 1)).toEqual(['a', 'b', 'c'])
    expect(moveStep(['a', 'b', 'c'], 1, 3)).toEqual(['a', 'b', 'c'])
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
