import { describe, expect, it } from 'vitest'
import { nightDay, nightOrder, nightRows, runsNextDay } from '../nightDay'

const evening = { onTime: '22:30', offTime: '07:00' }
const lateFinish = { onTime: '22:00', offTime: '13:00' }
const morning = { onTime: '04:00', offTime: '12:00' }
const afternoon = { onTime: '13:00', offTime: '16:00' }

describe('nightOrder', () => {
  const order = (...times: number[]) => nightOrder(times.map(h => ({ minutes: h * 60 }))).map(p => p.minutes / 60)

  it('carries an overnight curve past midnight', () => {
    expect(order(1, 7, 22.5, 23)).toEqual([22.5, 23, 25, 31])
  })

  it('accepts a timeline already past midnight', () => {
    expect(order(22.5, 25, 31)).toEqual([22.5, 25, 31])
  })

  it('puts a curve that starts in the morning on the next day', () => {
    expect(order(4, 8, 12)).toEqual([28, 32, 36])
  })

  it('leaves an afternoon curve on its own day', () => {
    expect(order(13, 16)).toEqual([13, 16])
  })

  it('keeps a long late curve whose biggest gap is under 12 hours in order', () => {
    expect(order(2, 8, 13, 22)).toEqual([22, 26, 32, 37])
    expect(order(2, 8, 19, 22)).toEqual([19, 22, 26, 32])
  })

  it('copes with one point and none', () => {
    expect(order(22)).toEqual([22])
    expect(order()).toEqual([])
  })
})

describe('runsNextDay', () => {
  it('keeps the evening of an overnight curve on its own day', () => {
    expect(runsNextDay('22:30', evening)).toBe(false)
    expect(runsNextDay('23:45', evening)).toBe(false)
  })

  it('moves the part after midnight and the off time to the morning after', () => {
    expect(runsNextDay('00:12', evening)).toBe(true)
    expect(runsNextDay('07:00', evening)).toBe(true)
  })

  it('moves a whole curve that starts before noon', () => {
    expect(runsNextDay('04:00', morning)).toBe(true)
    expect(runsNextDay('12:00', morning)).toBe(true)
  })

  it('follows an overnight curve past noon to its off time', () => {
    expect(runsNextDay('12:30', lateFinish)).toBe(true)
    expect(runsNextDay('13:00', lateFinish)).toBe(true)
    expect(runsNextDay('21:45', lateFinish)).toBe(false)
  })

  it('leaves an afternoon curve and rows with no power row alone', () => {
    expect(runsNextDay('14:00', afternoon)).toBe(false)
    expect(runsNextDay('02:00', null)).toBe(false)
  })
})

describe('nightDay', () => {
  it('wraps Saturday night into Sunday', () => {
    expect(nightDay('saturday', '02:00', evening)).toBe('sunday')
  })

  it('names the calendar day a mixed week really fires on', () => {
    expect(nightDay('monday', '04:00', morning)).toBe('tuesday')
    expect(nightDay('monday', '23:30', evening)).toBe('monday')
    expect(nightDay('monday', '07:00', evening)).toBe('tuesday')
  })
})

describe('nightRows', () => {
  it('keeps a mixed week from running the next day\'s curve after midnight', () => {
    const power = new Map([
      ['monday', { onTime: '23:30', offTime: '07:30' }],
      ['tuesday', { onTime: '22:30', offTime: '06:30' }],
    ])
    const rows = [
      { dayOfWeek: 'monday' as const, time: '02:00', temperature: 80 },
      { dayOfWeek: 'tuesday' as const, time: '02:00', temperature: 70 },
    ]
    expect(nightRows(rows, power).map(r => [r.dayOfWeek, r.temperature])).toEqual([['tuesday', 80], ['wednesday', 70]])
  })

  it('leaves an all-days curve firing at the same moments', () => {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
    const power = new Map(days.map(d => [d as string, evening]))
    const fired = nightRows(days.map(dayOfWeek => ({ dayOfWeek, time: '02:00' })), power).map(r => r.dayOfWeek).sort()
    expect(fired).toEqual([...days].sort())
  })
})
