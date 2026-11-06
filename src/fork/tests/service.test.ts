import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const h = vi.hoisted(() => ({ live: true }))

vi.mock('../smart/runner', () => ({
  tickSide: vi.fn(async (side: string) => {
    calls.push(`tick ${side}`)
  }),
}))
vi.mock('../oneSide', () => ({
  serviceLive: () => h.live,
  bedConfiguration: () => ({}),
  // The right side is away, so the whole bed is the left's.
  bedOwnerOf: () => 'left',
}))
vi.mock('../smart/oneSideNight', () => ({
  forgetOneSide: vi.fn(() => {
    calls.push('forget')
  }),
  syncOneSide: vi.fn(async (side: string) => {
    calls.push(`one side ${side}`)
  }),
  releaseOneSide: vi.fn(),
}))
vi.mock('../settings', () => ({ getPodSettings: () => ({ detection: 'live', ownershipStaleMinutes: 2 }), getSideSettings: () => ({ smartStart: true }) }))
vi.mock('../weeks', () => ({ syncRotation: vi.fn() }))
vi.mock('../holds', () => ({ clearPressWaits: vi.fn(), stepSmoothReturn: vi.fn() }))
vi.mock('../presence/collector', () => ({ closeStaleMinute: vi.fn(), sensorsFresh: () => true }))

import { guarded, smartTick } from '../service'

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

describe('a guarded step', () => {
  it('does not run again while the last run is still going', async () => {
    let finish = () => {}
    const step = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const run = guarded('test', step)
    run()
    await settled()
    run()
    await settled()
    expect(step).toHaveBeenCalledTimes(1)
    finish()
    await settled()
    run()
    await settled()
    expect(step).toHaveBeenCalledTimes(2)
  })

  it('catches an error and runs again next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const step = vi.fn(() => {
      throw new Error('bad step')
    })
    const run = guarded('test', step)
    run()
    await settled()
    run()
    await settled()
    expect(step).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('a Smart start tick', () => {
  it('settles one side for both halves before Smart start\'s rules, and runs no rules for the empty half', async () => {
    calls.length = 0
    await smartTick()
    expect(calls).toEqual(['one side left', 'one side right', 'tick left'])
  })

  it('runs the start steps afresh after a silent spell, when the bed was stock (rule 11)', async () => {
    calls.length = 0
    h.live = false
    await smartTick()
    h.live = true
    expect(calls).toEqual(['forget', 'one side left', 'one side right', 'tick left'])
  })
})
