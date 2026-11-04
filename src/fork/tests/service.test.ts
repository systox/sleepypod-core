import { describe, expect, it, vi } from 'vitest'

vi.mock('../smart/runner', () => ({ tickSide: vi.fn(), runStateOf: vi.fn(), setRunAside: vi.fn() }))
vi.mock('../weeks', () => ({ syncRotation: vi.fn() }))
vi.mock('../holds', () => ({ clearPressWaits: vi.fn(), stepSmoothReturn: vi.fn() }))
vi.mock('../presence/collector', () => ({ closeStaleMinute: vi.fn(), sensorsFresh: () => true }))

import { guarded } from '../service'

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
