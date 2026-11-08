import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SideProvider, useSide } from '@/src/providers/SideProvider'

const state = vi.hoisted(() => ({
  device: { bedMode: 'two', unusedZoneMode: 'follow' } as { bedMode: 'two' | 'solo-left' | 'solo-right', unusedZoneMode: 'off' | 'follow' | 'independent' },
  sides: { left: { awayMode: true }, right: { awayMode: false } },
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { settings: { getAll: { useQuery: () => ({ data: { sides: state.sides, device: state.device } }) } } },
}))

const side = () => renderHook(useSide, { wrapper: SideProvider }).result.current

afterEach(cleanup)

describe('the Schedule page while a sleeper is away', () => {
  it('stays on whoever was picked, while the other screens follow the sleeper at home', () => {
    const ctx = side()
    expect(ctx.singleScheduleSide).toBeNull()
    expect(ctx.singleSleeperSide).toBe('right')
  })

  it('still locks to the one side of a bed set up for one', () => {
    state.device = { bedMode: 'solo-left', unusedZoneMode: 'follow' }
    state.sides = { left: { awayMode: false }, right: { awayMode: false } }
    expect(side().singleScheduleSide).toBe('left')
  })
})
