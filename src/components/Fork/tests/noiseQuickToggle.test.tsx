import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  overview: undefined as unknown,
  save: vi.fn(),
  saveError: null as { message: string } | null,
}))

vi.mock('../useFork', () => ({
  useForkOverview: () => ({ data: h.overview }),
  useForkRefresh: () => async () => {},
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ fork: { noiseStatus: { invalidate: async () => {} } } }),
    fork: {
      setNoise: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
      setPodSettings: { useMutation: () => ({ mutate: h.save, isPending: false, error: h.saveError }) },
    },
  },
}))

vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Left', rightName: 'Right' }) }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '12h' }))

vi.unmock('@/src/components/Fork/NoiseCard')

import { DEFAULT_POD_SETTINGS } from '@/src/fork/settingsSchema'
import { NoiseQuickToggle, NoiseSection } from '../NoiseCard'

const noise = (over: Record<string, unknown>) => ({ on: true, playing: true, reason: 'app', since: 1, problem: null, ...over })

beforeEach(() => {
  h.save.mockReset()
  h.saveError = null
  h.overview = { pod: { noiseVolume: 20 }, noise: noise({}) }
})

describe('the Temp screen noise button', () => {
  it('shows the volume while noise plays, and saves it once let go', () => {
    render(<NoiseQuickToggle />)
    const slider = screen.getByRole('slider', { name: 'White noise volume' })
    fireEvent.change(slider, { target: { value: '35' } })
    expect(screen.getByText('Vol 35')).toBeTruthy()
    fireEvent.pointerUp(slider)
    expect(h.save).toHaveBeenCalledWith({ patch: { noiseVolume: 35 } }, expect.anything())
  })

  it('has no slider while noise is off', () => {
    h.overview = { pod: { noiseVolume: 20 }, noise: noise({ on: false, playing: false }) }
    render(<NoiseQuickToggle />)
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('says why noise is on but not playing', () => {
    h.overview = { pod: { noiseVolume: 20 }, noise: noise({ playing: false, problem: 'The noise player stopped (exit 1): Access denied' }) }
    render(<NoiseQuickToggle />)
    expect(screen.getByText('White noise isn\'t playing. The noise player stopped (exit 1): Access denied')).toBeTruthy()
    h.overview = { pod: { noiseVolume: 20 }, noise: noise({ playing: false, problem: 'Access denied' }) }
    render(<NoiseQuickToggle className="pill" />)
    expect(screen.getByRole('alert').textContent).toBe('Not playing')
  })

  it('says when a volume change wasn\'t saved', () => {
    h.saveError = { message: 'offline' }
    render(<NoiseQuickToggle />)
    expect(screen.getByText('Not saved')).toBeTruthy()
  })
})

describe('the white noise section of the Temp screen', () => {
  const sides = (left: number, right: number) => ({ left: { settings: { minutesToCall: left } }, right: { settings: { minutesToCall: right } } })

  it('offers every sound, the trigger, the empty-bed stop and the fade', () => {
    h.overview = { pod: DEFAULT_POD_SETTINGS, noise: noise({ on: false, playing: false }), ...sides(5, 5) }
    render(<NoiseSection />)
    expect(screen.getByRole('region', { name: 'White noise' })).toBeTruthy()
    expect(screen.getByText('Trigger')).toBeTruthy()
    expect(screen.getByText('Stops once everyone is out of bed for, minutes')).toBeTruthy()
    expect(screen.getByText('Fades in and out over, seconds')).toBeTruthy()
    // Manual by default: whose curve only matters once it starts by itself. The wait still covers Play with nobody in bed.
    expect(screen.queryByText('Whose curve')).toBeNull()
    expect(screen.getByText('Waits for someone to get in, minutes')).toBeTruthy()
  })

  it('says what Scheduled and Smart do, with the sleepers\' minutes, and when Smart needs Detection on Live', () => {
    h.overview = { pod: { ...DEFAULT_POD_SETTINGS, noiseStart: 'clock' }, noise: noise({ on: false, playing: false }), ...sides(5, 5) }
    const first = render(<NoiseSection />)
    expect(screen.getByText('Whose curve')).toBeTruthy()
    expect(screen.getByText('Runs during bed hours.')).toBeTruthy()
    first.unmount()
    h.overview = { pod: { ...DEFAULT_POD_SETTINGS, noiseStart: 'smart', detection: 'live' }, noise: noise({ on: false, playing: false }), ...sides(5, 5) }
    const second = render(<NoiseSection />)
    expect(screen.getByText('Starts 5 minutes after you get into bed. Pauses and resumes with presence detection. Maximum 12 hours.')).toBeTruthy()
    second.unmount()
    h.overview = { pod: { ...DEFAULT_POD_SETTINGS, noiseStart: 'smart', noiseSide: 'either' }, noise: noise({ on: false, playing: false }), ...sides(5, 8) }
    render(<NoiseSection />)
    expect(screen.getByText(/^Starts 5 to 8 minutes after you get into bed\..* Needs Detection set to Live in Tonight settings\.$/)).toBeTruthy()
  })

  it('says Scheduled noise stops when bed hours end', () => {
    h.overview = { pod: { ...DEFAULT_POD_SETTINGS, noiseStart: 'clock' }, noise: noise({ reason: 'bedtime' }), ...sides(5, 5) }
    render(<NoiseSection />)
    expect(screen.getByText('It stops when bed hours end.')).toBeTruthy()
  })
})
