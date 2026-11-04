import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  settings: undefined as unknown,
  overview: undefined as unknown,
  saveSide: vi.fn(),
  saveDevice: vi.fn(),
}))

vi.mock('../useFork', () => ({
  useForkOverview: () => ({ data: h.overview }),
  useForkRefresh: () => async () => {},
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ settings: { getAll: { invalidate: async () => {} } } }),
    settings: {
      getAll: { useQuery: () => ({ data: h.settings }) },
      updateSide: { useMutation: () => ({ mutate: h.saveSide, isPending: false, error: null }) },
      updateDevice: { useMutation: () => ({ mutate: h.saveDevice, isPending: false, error: null }) },
    },
  },
}))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '12h' }))

vi.unmock('@/src/components/Fork/AwayCard')

import { AwayCard, type AwayFacts, zoneLine, zoneOptions } from '../AwayCard'

const sides = (leftAway: boolean, awayReturn: string | null = null) => ({
  left: { name: 'Sam', awayMode: leftAway, awayReturn },
  right: { name: 'Alex', awayMode: false, awayReturn: null },
})

const facts = (over: Partial<AwayFacts> = {}): AwayFacts => ({
  sleepers: { left: { name: 'Sam', away: true, awayReturn: null }, right: { name: 'Alex', away: false, awayReturn: null } },
  zoneMode: 'follow',
  followsSmartStart: true,
  smartStart: { left: false, right: true },
  ...over,
})

beforeEach(() => {
  h.saveSide.mockReset()
  h.saveDevice.mockReset()
  h.settings = { sides: sides(false), device: { bedMode: 'two', unusedZoneMode: 'off' } }
  h.overview = { pod: { followSmartStart: true }, left: { settings: { smartStart: true } }, right: { settings: { smartStart: true } } }
})

describe('what the away side does', () => {
  it('names the sleepers when one is away', () => {
    expect(zoneLine(facts())).toBe('Sam\'s side runs Alex\'s curve, starting and ending with Alex\'s Smart start, until Sam is back.')
    expect(zoneLine(facts({ smartStart: { left: true, right: false } }))).toBe('Sam\'s side runs Alex\'s curve at its set times until Sam is back.')
    expect(zoneLine(facts({ zoneMode: 'off' }))).toBe('Sam\'s side stays off until Sam is back.')
    expect(zoneOptions(facts()).map(o => o.label)).toEqual(['Turns off', 'Matches Alex\'s side', 'Keeps its own curve'])
  })

  it('speaks generally when nobody is away, and says both away means off', () => {
    const home = facts({ sleepers: { left: { name: 'Sam', away: false, awayReturn: null }, right: { name: 'Alex', away: false, awayReturn: null } } })
    expect(zoneLine(home)).toBe('Nobody is away. When someone is, their side runs the same temperatures as the sleeper at home.')
    expect(zoneOptions(home)[1].label).toBe('Matches the other side')
    const gone = facts({ sleepers: { left: { name: 'Sam', away: true, awayReturn: null }, right: { name: 'Alex', away: true, awayReturn: null } } })
    expect(zoneLine(gone)).toBe('Both sleepers are away, so both sides stay off whatever this is set to.')
  })
})

describe('the Away card', () => {
  it('shows only the sleeper picked on the page, and saves away for them', () => {
    render(<AwayCard side="left" both={false} />)
    expect(screen.queryByRole('switch', { name: 'Alex is away' })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Sam is away' }))
    expect(h.saveSide).toHaveBeenCalledWith({ side: 'left', awayMode: true })
  })

  it('lists the away sleeper too while the page is locked to the one at home', () => {
    h.settings = { sides: sides(true, '2099-01-01T21:00:00.000Z'), device: { bedMode: 'two', unusedZoneMode: 'follow' } }
    render(<AwayCard side="right" both={false} />)
    expect(screen.getByRole('switch', { name: 'Alex is away' })).toBeTruthy()
    expect(screen.getByText(/^Away until .+\. Then Sam's own curve and settings apply again\.$/)).toBeTruthy()
    // Switching back also clears the return time, so its job can't switch the side on later.
    fireEvent.click(screen.getByRole('switch', { name: 'Sam is away' }))
    expect(h.saveSide).toHaveBeenCalledWith({ side: 'left', awayMode: false, awayReturn: null })
  })

  it('saves the away side\'s choice for the whole bed', () => {
    render(<AwayCard side="left" both={false} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'The away sleeper\'s side' }), { target: { value: 'follow' } })
    expect(h.saveDevice).toHaveBeenCalledWith({ unusedZoneMode: 'follow' })
  })
})
