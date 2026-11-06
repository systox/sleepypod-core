import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  status: { source: 'manual', holdUntil: 0, blocked: null, targetTemperature: 86, requestId: 'manual' } as Record<string, unknown>,
  baseline: 81 as number | null,
  setManualLocked: vi.fn(),
  target: 86 as number | null,
  turnedOff: false,
  /** The home side while the bed is one side, or null. */
  home: null as 'left' | 'right' | null,
  /** A half the pump guard holds, which keeps its own controls. */
  guarded: null as 'left' | 'right' | null,
  lastWritten: {} as Record<string, number>,
  oweWrite: vi.fn(),
  sideStatus: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({
    status: (side: string) => h.sideStatus[side] ?? h.status,
    baselineTarget: () => h.baseline,
    turnedOff: () => h.turnedOff,
    setManualLocked: h.setManualLocked,
  }),
}))
vi.mock('@/src/hardware/sideLock', () => ({ withSideLock: (_side: string, fn: () => unknown) => fn() }))
const noteSmartPress = vi.hoisted(() => vi.fn())
vi.mock('../smart/runner', () => ({ noteSmartPress }))
vi.mock('../oneSide', () => {
  const owner = (side: 'left' | 'right') => (h.home && side !== h.home ? h.home : side)
  return {
    bedOwnerOf: owner,
    controlSideOf: (side: 'left' | 'right') => (side === h.guarded ? side : owner(side)),
    awayHalfOf: (side: 'left' | 'right') => (h.home === side ? (side === 'left' ? 'right' : 'left') : null),
    lastWrittenTo: (side: string) => h.lastWritten[side] ?? null,
    noteMeasured: (side: string, temperature: number) => {
      h.lastWritten[side] = temperature
    },
    oweWrite: h.oweWrite,
  }
})
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
  h.home = null
  h.guarded = null
  h.lastWritten = {}
  h.oweWrite.mockReset()
  h.sideStatus = {}
  h.baseline = 81
  h.target = 86
  h.turnedOff = false
  h.setManualLocked.mockReset()
  noteSmartPress.mockReset()
  h.setManualLocked.mockImplementation(async (_side, _temperature, ms: number) => ({ holdUntil: NOW + ms }))
})
afterEach(() => {
  runtime.running = false
  closeStore()
})

describe('presses on the empty half of a one-side bed (rule 5)', () => {
  // Right is away, so the bed is left's: both at 84, and sleepypod last wrote 84 to right. The press took right to 87.
  const oneSide = () => {
    h.home = 'left'
    h.target = 87
    h.lastWritten = { right: 84 }
    h.sideStatus = {
      right: { source: 'run-once', holdUntil: null, blocked: null, targetTemperature: 84, requestId: 'curve' },
      left: { source: 'run-once', holdUntil: null, blocked: null, targetTemperature: 84, requestId: 'curve' },
    }
  }

  it('moves the home side by as much as the firmware moved the pressed half, holds it, and rewrites the half', async () => {
    oneSide()
    setPodSettings({ holdMinutes: 60 })
    await settlePress('right', true, ['top'])
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 87, 60 * MIN)
    expect(h.oweWrite).toHaveBeenCalledWith('right')
    // Logged once, as the home sleeper's press, with the half it came from.
    const presses = listEvents(0, Date.now() + 1, ['press'])
    expect(presses).toHaveLength(1)
    expect(presses[0].side).toBe('left')
    expect(JSON.parse(presses[0].detail as string)).toEqual({ buttons: ['top'], from: 'right' })
  })

  it('does not count a change to the bed during the wait as part of the press', async () => {
    oneSide()
    // The curve moved the bed to 86 during the wait, and that write to right erased the firmware's move.
    h.sideStatus.left = { ...h.sideStatus.left, targetTemperature: 86 }
    h.lastWritten = { right: 86 }
    h.target = 86
    setPodSettings({ holdMinutes: 60 })
    await settlePress('right', true, ['top'], 84)
    // Measured against the plan at the first press, this would have read as a 2°F press and held 88.
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 86, 60 * MIN)
  })

  it('counts a quick second press only for its own move, before the half is rewritten', async () => {
    oneSide()
    h.lastWritten = { right: 80 }
    h.sideStatus.left = { ...h.sideStatus.left, targetTemperature: 80 }
    h.target = 83
    setPodSettings({ holdMinutes: 60 })
    await settlePress('right', true, ['top'])
    expect(h.setManualLocked).toHaveBeenLastCalledWith('left', 83, 60 * MIN)
    // The home side now holds 83; the half hasn't been rewritten yet when the next press moves it to 86.
    h.sideStatus.left = { ...h.sideStatus.left, targetTemperature: 83 }
    h.target = 86
    await settlePress('right', true, ['top'])
    expect(h.setManualLocked).toHaveBeenLastCalledWith('left', 86, 60 * MIN)
  })

  it('measures from the bed\'s plan at the first press before anything was written since the server started', async () => {
    oneSide()
    h.lastWritten = {}
    setPodSettings({ holdMinutes: 60 })
    await settlePress('right', true, ['top'], 84)
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 87, 60 * MIN)
  })

  it('counts a press resting on neutral as the neutral temperature, as on the home side', async () => {
    oneSide()
    h.target = null
    setPodSettings({ holdMinutes: 60 })
    await settlePress('right', true, ['bottom'])
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 83, 60 * MIN)
  })

  it('pulls the home side\'s hold back to its warmest setting', async () => {
    oneSide()
    h.target = 95
    setPodSettings({ holdMinutes: 60 })
    setSideSettings('left', { warmestF: 88 })
    await settlePress('right', true, ['top'])
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 88, 60 * MIN)
  })

  it('drops the press while the home side is off, turned off or blocked, as the half follows it off', async () => {
    oneSide()
    setPodSettings({ holdMinutes: 60 })
    h.sideStatus.left = { ...h.sideStatus.left, blocked: 'off' }
    await settlePress('right', true, ['top'])
    h.sideStatus.left = { ...h.sideStatus.left, blocked: 'safety' }
    await settlePress('right', true, ['top'])
    h.sideStatus.left = { ...h.sideStatus.left, blocked: null }
    h.turnedOff = true
    await settlePress('right', true, ['top'])
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('passes a press on an off half to the home sleeper\'s Smart start', async () => {
    oneSide()
    await settlePress('right', false, ['top'])
    expect(noteSmartPress).toHaveBeenCalledWith('left')
  })

  it('leaves a half the pump guard holds to the guard', async () => {
    oneSide()
    h.guarded = 'right'
    h.sideStatus.right = { ...h.sideStatus.right, blocked: 'safety' }
    setPodSettings({ holdMinutes: 60 })
    await settlePress('right', true, ['top'])
    expect(h.setManualLocked).not.toHaveBeenCalled()
  })

  it('holds even with Hold after adjustment off, since a move left standing would reach one half only', async () => {
    oneSide()
    setPodSettings({ holdMinutes: 0 })
    await settlePress('right', true, ['top'])
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 87, undefined)
    // The home side's own buttons too.
    h.setManualLocked.mockClear()
    h.target = 86
    await settlePress('left', true, ['top'])
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 86, undefined)
  })

  it('bases the hold on the home side\'s reported temperature when it runs with no plan', async () => {
    oneSide()
    h.sideStatus.left = { ...h.sideStatus.left, source: null, targetTemperature: null }
    h.lastWritten = { right: 77 }
    h.target = 80
    setPodSettings({ holdMinutes: 60 })
    await settlePress('right', true, ['top'])
    // Step +3 from the last write, on the home side's reported 80.
    expect(h.setManualLocked).toHaveBeenCalledWith('left', 83, 60 * MIN)
  })
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
    // The half is marked while the press waits, so its one-side step leaves the firmware's move alone.
    expect(runtime.pressing.has('left')).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(runtime.pressing.has('left')).toBe(false)
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

  it('leaves the steps of the one hold to the home side on the empty half of a one-side bed', async () => {
    on()
    h.home = 'right'
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
