import { describe, expect, it } from 'vitest'
import { phaseNames } from '../phaseNames'

const names = (times: string[]) => phaseNames(times).map(p => p.name)

describe('the names of a curve\'s points', () => {
  it('names a night by how far each point sits into the sleep', () => {
    expect(names(['22:30', '00:30', '04:30', '06:00', '07:30'])).toEqual(['Bedtime', 'Deep', 'Light', 'Pre-wake', 'Wake'])
    expect(names(['23:00', '01:00', '04:30', '07:00', '08:00', '09:00', '14:00'])).toEqual(['Bedtime', 'Deep', 'Light', 'Light', 'Light', 'Light', 'Wake'])
  })

  it('fits a daytime sleep the same way', () => {
    expect(names(['05:00', '07:00', '08:30', '09:00', '10:00', '15:00'])).toEqual(['Bedtime', 'Deep', 'Deep', 'Light', 'Light', 'Wake'])
  })

  it('leaves the other points\' names alone when one is added', () => {
    const before = names(['22:30', '00:30', '04:30', '06:00', '07:30'])
    const after = names(['22:30', '00:30', '03:00', '04:30', '06:00', '07:30'])
    expect(after.filter((_, i) => i !== 2)).toEqual(before)
  })

  it('handles short curves', () => {
    expect(names([])).toEqual([])
    expect(names(['22:00'])).toEqual(['Bedtime'])
    expect(names(['22:00', '06:00'])).toEqual(['Bedtime', 'Wake'])
  })
})
