import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('../smart/runner', () => ({
  tickSide: vi.fn(async (side: string) => {
    calls.push(`tick ${side}`)
  }),
  runStateOf: vi.fn(() => ({ lastWriteAt: 5 })),
  setRunAside: vi.fn(),
  noteSwitchedOn: vi.fn(),
}))
vi.mock('../smart/following', () => ({
  bedState: () => ({}),
  // The right side is away and follows the left.
  smartSourceOf: () => 'left',
  smartStartFor: () => true,
  syncFollowing: vi.fn(async (side: string, _state: unknown, _live: boolean, homeWriteAt: number | null) => {
    calls.push(`follow ${side} ${homeWriteAt}`)
    return side === 'right' ? 'started' : null
  }),
  releaseFollowing: vi.fn(),
}))
vi.mock('../settings', () => ({ getPodSettings: () => ({ detection: 'live', ownershipStaleMinutes: 2 }) }))
vi.mock('../weeks', () => ({ syncRotation: vi.fn() }))
vi.mock('../holds', () => ({ clearPressWaits: vi.fn(), stepSmoothReturn: vi.fn() }))
vi.mock('../presence/collector', () => ({ closeStaleMinute: vi.fn(), sensorsFresh: () => true }))

import { guarded, smartTick } from '../service'
import { setRunAside } from '../smart/runner'

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
  it('settles a home side\'s following before its own rules, then brings the following side in line', async () => {
    await smartTick()
    expect(calls).toEqual(['follow left null', 'tick left', 'follow right 5'])
    expect(setRunAside).toHaveBeenCalledWith('right')
  })
})
