import { describe, expect, it } from 'vitest'
import { phaseName } from '../phaseNames'

const names = (count: number) => Array.from({ length: count }, (_, i) => phaseName(i, count).name)

describe('the names of a curve\'s points', () => {
  it('runs bedtime, the night, pre-wake and wake', () => {
    expect(names(5)).toEqual(['Bedtime', 'Deep', 'Late night', 'Pre-wake', 'Wake'])
    expect(names(7)).toEqual(['Bedtime', 'Deep', 'Late night', 'Phase 4', 'Phase 5', 'Pre-wake', 'Wake'])
  })

  it('leaves out pre-wake on short curves', () => {
    expect(names(1)).toEqual(['Bedtime'])
    expect(names(2)).toEqual(['Bedtime', 'Wake'])
    expect(names(3)).toEqual(['Bedtime', 'Deep', 'Wake'])
  })
})
