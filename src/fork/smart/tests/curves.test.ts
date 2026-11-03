import { describe, expect, it } from 'vitest'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { buildCopy, curvePoints, temperatureAt, windowsAround, type CurveRow, type PowerRow } from '../curves'

const MIN = 60_000
const HOURS = { hoursEarly: 1, hoursLate: 5.5 }
const utc = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h, m)

const onDay = (dayOfWeek: PowerRow['dayOfWeek']): { power: PowerRow, temps: CurveRow[] } => ({
  power: { dayOfWeek, onTime: '22:30', offTime: '07:00', onTemperature: 85 },
  temps: [
    { dayOfWeek, time: '22:30', temperature: 85 },
    { dayOfWeek, time: '23:30', temperature: 84 },
    { dayOfWeek, time: '01:00', temperature: 81 },
    { dayOfWeek, time: '07:00', temperature: 85 },
  ],
})

const week = DAYS_OF_WEEK.map(onDay)
const powers = week.map(w => w.power)
const temps = week.flatMap(w => w.temps)

describe('curvePoints', () => {
  it('orders a night from its first point', () => {
    expect(curvePoints(temps, powers[1])).toEqual([
      { offset: 0, temperature: 85 },
      { offset: 60, temperature: 84 },
      { offset: 150, temperature: 81 },
      { offset: 510, temperature: 85 },
    ])
  })

  it('leaves out points before power-on, which never ran', () => {
    const windDown = { dayOfWeek: 'monday' as const, time: '21:45', temperature: 70 }
    expect(curvePoints([...temps, windDown], powers[1]).some(p => p.temperature === 70)).toBe(false)
  })
})

describe('windowsAround', () => {
  it('finds the window around bedtime', () => {
    const { window } = windowsAround(temps, powers, 'UTC', utc(2, 22), HOURS)
    expect(window?.curve.bedtime).toBe(utc(2, 22, 30))
    expect(window?.windowStart).toBe(utc(2, 21, 30))
    expect(window?.windowEnd).toBe(utc(3, 4))
  })

  it('is null between windows', () => {
    const { window, next } = windowsAround(temps, powers, 'UTC', utc(3, 15), HOURS)
    expect(window).toBeNull()
    expect(next?.windowStart).toBe(utc(3, 21, 30))
  })

  it('picks the nearest bedtime when a wide window overlaps two', () => {
    const wide = { hoursEarly: 12, hoursLate: 12 }
    expect(windowsAround(temps, powers, 'UTC', utc(3, 1), wide).window?.curve.bedtime).toBe(utc(2, 22, 30))
    expect(windowsAround(temps, powers, 'UTC', utc(3, 20), wide).window?.curve.bedtime).toBe(utc(3, 22, 30))
  })

  it('places a morning curve on the day after it is saved', () => {
    const power: PowerRow = { dayOfWeek: 'monday', onTime: '05:00', offTime: '14:00', onTemperature: 84 }
    const { window } = windowsAround([], [power], 'UTC', utc(3, 5), { hoursEarly: 3, hoursLate: 11 })
    // 11-02 is a Monday, so Monday's curve runs early Tuesday 11-03.
    expect(window?.curve.bedtime).toBe(utc(3, 5))
  })

  it('has nothing to offer with no curves', () => {
    expect(windowsAround([], [], 'UTC', utc(2, 22), HOURS)).toEqual({ window: null, next: null })
  })
})

describe('temperatureAt', () => {
  it('holds each point until the next', () => {
    const points = curvePoints(temps, powers[1])
    expect(temperatureAt(points, 0)).toBe(85)
    expect(temperatureAt(points, 59)).toBe(85)
    expect(temperatureAt(points, 60)).toBe(84)
    expect(temperatureAt(points, 900)).toBe(85)
    expect(temperatureAt(points, -5)).toBe(85)
  })
})

describe('buildCopy', () => {
  const points = curvePoints(temps, powers[1])

  it('starts now at the first temperature and moves every point by the same amount', () => {
    const now = utc(2, 23, 24)
    const copy = buildCopy(points, now, now, now + 14 * 60 * MIN, 'UTC')
    expect(copy.setPoints).toEqual([
      { time: '23:24', temperature: 85 },
      { time: '00:24', temperature: 84 },
      { time: '01:54', temperature: 81 },
      { time: '07:54', temperature: 85 },
    ])
    expect(copy.wakeTime).toBe('13:24')
  })

  it('runs forward from a run under way, leaving out points already past', () => {
    const zero = utc(2, 22, 30)
    const now = utc(3, 2, 0)
    const copy = buildCopy(points, zero, now, zero + 14 * 60 * MIN, 'UTC')
    expect(copy.setPoints).toEqual([{ time: '02:00', temperature: 81 }, { time: '07:00', temperature: 85 }])
  })

  it('holds the first temperature until bedtime while someone reads', () => {
    const now = utc(2, 21, 45)
    const copy = buildCopy(points, utc(2, 22, 30), now, utc(3, 11, 45), 'UTC')
    expect(copy.setPoints[0]).toEqual({ time: '21:45', temperature: 85 })
    expect(copy.setPoints[1]).toEqual({ time: '23:30', temperature: 84 })
  })

  it('never asks for more than 14 hours or 96 points', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ offset: i * 2, temperature: 70 + (i % 2) }))
    const now = utc(2, 22)
    const copy = buildCopy(many, now, now, now + 30 * 60 * MIN, 'UTC')
    expect(copy.setPoints.length).toBeLessThanOrEqual(96)
    expect(copy.endsAt).toBe(now + 14 * 60 * MIN)
  })

  it('merges points that land in the same minute', () => {
    const now = utc(2, 22)
    const copy = buildCopy([{ offset: 0, temperature: 80 }, { offset: 5, temperature: 81 }, { offset: 5.2, temperature: 82 }], now, now, now + 60 * MIN, 'UTC')
    expect(copy.setPoints.at(-1)).toEqual({ time: '22:05', temperature: 82 })
  })
})
