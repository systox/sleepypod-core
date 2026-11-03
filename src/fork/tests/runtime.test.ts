import { describe, expect, it } from 'vitest'
import { markPersonPower, takePersonPower } from '../runtime'

const NOW = 1_000_000_000

describe('person power marks', () => {
  it('hands over a fresh mark once', () => {
    markPersonPower('left', true, NOW)
    expect(takePersonPower('left', NOW + 30_000)).toEqual({ on: true, at: NOW })
    expect(takePersonPower('left', NOW + 30_000)).toBeNull()
  })

  it('drops a mark left from before the service was ticking', () => {
    markPersonPower('left', false, NOW)
    expect(takePersonPower('left', NOW + 3 * 60_000)).toBeNull()
    expect(takePersonPower('left', NOW + 3 * 60_000)).toBeNull()
  })
})
