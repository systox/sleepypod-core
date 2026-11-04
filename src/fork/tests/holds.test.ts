import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  status: { source: 'manual', holdUntil: 0, blocked: null, targetTemperature: 86, requestId: 'manual' } as Record<string, unknown>,
  baseline: 81 as number | null,
  setManualLocked: vi.fn(),
  target: 86 as number | null,
  turnedOff: false,
}))

vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({
    status: () => h.status,
    baselineTarget: () => h.baseline,
    turnedOff: () => h.turnedOff,
    setManualLocked: h.setManualLocked,
  }),
}))
vi.mock('@/src/hardware/sideLock', () => ({ withSideLock: (_side: string, fn: () => unknown) => fn() }))
const noteSmartPress = vi.hoisted(() => vi.fn())
vi.mock('../smart/runner', () => ({ noteSmartPress }))
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ get: () => ({ target: h.target }) }) }) }),
  },
}))

import { closeStore, listEvents } from '../store'
import { setPodSettings, setSideSettings } from '../settings'
import { clearPressWaits, defaultHoldMs, observePress, settlePress, stepSmoothReturn } from '../holds'
import { runtime } from '../runtime'

const NOW = 1_000_000_000
const MIN = 60_000

beforeEach(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  closeStore()
  runtime.running = true
  h.status = { source: 'manual', holdUntil: NOW + 30_000, blocked: null, targetTemperature: 86, requestId: 'manual' }
  h.baseline = 81
  h.target = 86
  h.turnedOff = false
  h.setManualLocked.mockReset()
  h.setManualLocked.mockImplementation(async (_side, _temperature, ms: number) => ({ holdUntil: NOW + ms }))
})
afterEach(() => {
  runtime.running = false
  closeStore()
})

describe('presses', () => {
  it('turns a press into a hold of the set length at the Pod\'s new target', async () => {
    setPodSettings({ holdMinutes: 60 })
    await settlePress('left', true, ['top', 'top'])
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 86, 60 * MIN)
    expect(listEvents(0, Date.now() + 1, ['press'])).toHaveLength(1)
  })

  it('leaves a press alone with the hold control on Off', async () => {
    setPodSettings({ holdMinutes: 0 })
    await settlePress('left', true, ['top'])
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('leaves a press alone on a side that was off', async () => {
    await settlePress('left', false, ['top'])
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('does not turn a side back on after someone turned it off', async () => {
    h.turnedOff = true
    await settlePress('left', true, ['top'])
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('pulls a press back to the side\'s warmest setting', async () => {
    h.target = 95
    setSideSettings('left', { warmestF: 90 })
    await settlePress('left', true, ['top'])
    expect(h.setManualLocked.mock.calls[0][1]).toBe(90)
  })

  it('moves a press off neutral, which sleepypod reads as off', async () => {
    h.target = null
    await settlePress('left', true, ['top'])
    expect(h.setManualLocked.mock.calls[0][1]).toBe(83)
  })

  it('rounds to a whole degree', async () => {
    h.target = 79.6
    await settlePress('left', true, ['top'])
    expect(h.setManualLocked.mock.calls[0][1]).toBe(80)
  })
})

describe('press reports from the cover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setPodSettings({ holdMinutes: 60 })
    h.status = { source: 'schedule', holdUntil: null, blocked: null, targetTemperature: 84, requestId: 'x' }
    h.target = 87
  })
  afterEach(() => {
    clearPressWaits()
    vi.useRealTimers()
  })

  it('holds after a held press, which the firmware acts on', async () => {
    observePress({ type: 'button-press', left: { button: 'top', type: 'long', count: 1 } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 87, 60 * MIN)
    expect(listEvents(0, Date.now() + 1, ['press'])).toHaveLength(1)
  })

  it('ignores a short click, which the firmware ignores too', async () => {
    observePress({ type: 'button-press', left: { button: 'top', type: 'short', count: 1 } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.setManualLocked).not.toHaveBeenCalled()
    expect(listEvents(0, Date.now() + 1, ['press'])).toHaveLength(0)
  })

  it('passes a short click on an off side to Smart start, as the firmware changes nothing there', async () => {
    h.status = { ...h.status, blocked: 'off' }
    observePress({ type: 'button-press', right: { button: 'top', type: 'short', count: 1 } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(noteSmartPress).toHaveBeenCalledWith('right')
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('still counts a press that arrives without a type', async () => {
    observePress({ type: 'button-press', left: { button: 'bottom', count: 1 } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.setManualLocked).toHaveBeenCalledOnce()
  })
})

describe('hold length', () => {
  it('uses the saved length', () => {
    setPodSettings({ holdMinutes: 60 })
    expect(defaultHoldMs('left')).toBe(60 * MIN)
  })

  it('stands aside while the service isn\'t running', () => {
    runtime.running = false
    expect(defaultHoldMs('left')).toBeUndefined()
  })
})

describe('Smooth return', () => {
  const on = () => setPodSettings({ smoothReturn: true, smoothRatePerHour: 2.7, smoothMaxHours: 3 })

  it('does nothing while the switch is off', async () => {
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('waits until the hold is about to end', async () => {
    on()
    h.status.holdUntil = NOW + 5 * MIN
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('steps 1°F toward the curve at the tested rate', async () => {
    on()
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 85, Math.round(60 / 2.7 * MIN))
  })

  it('steps up as well as down', async () => {
    on()
    h.baseline = 90
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked.mock.calls[0][1]).toBe(87)
  })

  it('lets the hold end once it meets the curve', async () => {
    on()
    h.baseline = 85
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('stays out of a side that\'s off, so a fade can\'t turn it back on', async () => {
    on()
    h.status.blocked = 'off'
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('stops when the hold is gone, as after Resume', async () => {
    on()
    h.status = { ...h.status, source: 'schedule', holdUntil: null }
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('ends after its longest fade, in one step', async () => {
    on()
    await stepSmoothReturn('left', NOW)
    const stepped = NOW + Math.round(60 / 2.7 * MIN)
    h.status.holdUntil = stepped
    h.setManualLocked.mockClear()
    await stepSmoothReturn('left', NOW + 3 * 60 * MIN + 1)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('leaves it to the schedule with no curve underneath', async () => {
    on()
    h.baseline = null
    await stepSmoothReturn('left', NOW)
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })
})
