import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  occupied: { left: false as boolean | null, right: false as boolean | null },
  bedtimes: { left: null as number | null, right: null as number | null },
  away: { left: false, right: false },
  runs: { left: { phase: 'idle', startedAt: null }, right: { phase: 'idle', startedAt: null } } as Record<'left' | 'right', { phase: string, startedAt: number | null }>,
}))

/** A curve 8 hours long, its window opening an hour before it starts and closing after the hours late asked for. */
const windowFor = (bedtime: number, hoursLate = 5) => ({ curve: { bedtime, points: [{ offset: 0, temperature: 80 }, { offset: 480, temperature: 82 }] }, windowStart: bedtime - 60 * 60_000, windowEnd: bedtime + hoursLate * 60 * 60_000 })

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return { ...actual, default: { ...actual, spawn: h.spawn, execFile: h.execFile }, spawn: h.spawn, execFile: h.execFile }
})
vi.mock('@/src/temperature/instance', () => ({ getTemperatureController: () => ({ status: () => ({ blocked: null }) }) }))
vi.mock('../presence/collector', () => ({
  presenceOf: (side: 'left' | 'right') => ({ occupied: h.occupied[side], since: null }),
  sensorsFresh: () => true,
}))
vi.mock('../smart/following', () => ({
  bedState: () => ({ bedMode: 'two', left: { awayMode: h.away.left }, right: { awayMode: h.away.right } }),
}))
vi.mock('../smart/runner', () => ({
  windowsOf: (side: 'left' | 'right', now: number, hours?: { hoursLate: number }) => {
    const bedtime = h.bedtimes[side]
    const window = bedtime === null ? null : windowFor(bedtime, hours?.hoursLate)
    return { window: window && now >= window.windowStart && now < window.windowEnd ? window : null, next: null }
  },
  runStateOf: (side: 'left' | 'right') => h.runs[side],
}))

import { observePress } from '../holds'
import { clearMiddleWaits } from '../middleButton'
import { noiseStatus, resetNoiseMemory, setNoise, syncNoise } from '../noise'

/** What a server restart forgets: the cache, not the stored session. */
function resetNoiseMemoryKeepingStore(): void {
  resetNoiseMemory()
}
import { runtime } from '../runtime'
import { setPodSettings, setSideSettings } from '../settings'
import { closeStore, listEvents } from '../store'

const MIN = 60_000
const NOW = 1_800_000_000_000

function fakeChild() {
  return { pid: undefined, on: vi.fn(), stderr: { on: vi.fn() }, kill: vi.fn() }
}

beforeEach(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  closeStore()
  resetNoiseMemory()
  h.spawn.mockReset().mockImplementation(fakeChild)
  h.execFile.mockReset().mockImplementation((_file: string, args: string[], _options: unknown, done: (error: Error | null, result?: unknown) => void) => {
    done(null, { stdout: args[0] === 'list' ? 'Sink Input #6\n\t\tapplication.name = "sleepypod-noise"\n' : '', stderr: '' })
  })
  h.occupied = { left: false, right: false }
  h.bedtimes = { left: null, right: null }
  h.away = { left: false, right: false }
  h.runs = { left: { phase: 'idle', startedAt: null }, right: { phase: 'idle', startedAt: null } }
  runtime.running = true
})
afterEach(() => {
  clearMiddleWaits()
  vi.useRealTimers()
  runtime.running = false
})

describe('a white noise session', () => {
  it('plays when turned on, and stops when turned off', () => {
    setNoise(true, 'app', NOW)
    expect(noiseStatus()).toMatchObject({ on: true, playing: true, reason: 'app', since: NOW })
    expect(h.spawn).toHaveBeenCalledOnce()
    setNoise(false, 'app', NOW + MIN)
    expect(noiseStatus()).toMatchObject({ on: false, playing: false })
  })

  it('ends by itself once the bed has been empty a while after someone was in it', () => {
    h.occupied.left = true
    setNoise(true, 'app', NOW)
    h.occupied.left = false
    syncNoise(NOW + 9 * MIN)
    expect(noiseStatus().on).toBe(true)
    syncNoise(NOW + 11 * MIN)
    expect(noiseStatus().on).toBe(false)
    expect(listEvents(0, NOW + 60 * MIN, ['noise-stop'])).toHaveLength(1)
  })

  it('starts once at bedtime, and not again after a stop when the other side\'s bedtime passes', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.bedtimes = { left: NOW - MIN, right: null }
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
    setNoise(false, 'app', NOW + 10 * MIN)
    h.bedtimes = { left: null, right: NOW + 20 * MIN }
    syncNoise(NOW + 30 * MIN)
    expect(noiseStatus().on).toBe(false)
  })

  it('skips an away sleeper\'s bedtime when either side can start it', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.away.left = true
    h.bedtimes = { left: NOW - MIN, right: NOW + 30 * MIN }
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    h.bedtimes = { left: NOW - 31 * MIN, right: NOW - MIN }
    syncNoise(NOW + 30 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('with Smart start, waits for someone to get in rather than the start time', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'either', detection: 'live' })
    setSideSettings('right', { smartStart: true })
    h.away.left = true
    h.bedtimes = { left: null, right: NOW - MIN }
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    h.occupied.right = true
    h.runs.right = { phase: 'running', startedAt: NOW + 5 * MIN }
    syncNoise(NOW + 5 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'smart-start' })
  })

  it('starts with a Reading mode hold, and once per run', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    setSideSettings('right', { smartStart: true })
    h.occupied.right = true
    h.runs.right = { phase: 'reading', startedAt: NOW }
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'smart-start' })
    setNoise(false, 'app', NOW + MIN)
    h.runs.right = { phase: 'running', startedAt: NOW }
    syncNoise(NOW + 2 * MIN)
    expect(noiseStatus().on).toBe(false)
  })

  it('uses the start time for a sleeper without Smart start', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: null, right: NOW - MIN }
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('doesn\'t start for a run already well under way when the service starts', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    setSideSettings('right', { smartStart: true })
    h.occupied.right = true
    h.runs.right = { phase: 'running', startedAt: NOW - 2 * 60 * MIN }
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
  })

  it('starts again when someone gets back into bed while the curve runs', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.bedtimes = { left: NOW, right: null }
    h.occupied.left = true
    syncNoise(NOW)
    h.occupied.left = false
    syncNoise(NOW + 11 * MIN)
    expect(noiseStatus().on).toBe(false)
    h.occupied.left = true
    syncNoise(NOW + 20 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'return' })
  })

  it('starts again after the watch hours close, while a long curve still runs', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'left' })
    h.bedtimes = { left: NOW, right: null }
    h.occupied.left = true
    syncNoise(NOW)
    syncNoise(NOW + 7 * 60 * MIN)
    h.occupied.left = false
    syncNoise(NOW + 7 * 60 * MIN + 11 * MIN)
    expect(noiseStatus().on).toBe(false)
    h.occupied.left = true
    syncNoise(NOW + 7 * 60 * MIN + 20 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'return' })
  })

  it('doesn\'t start again for a stop from an earlier night', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'right', detection: 'live' })
    setSideSettings('right', { smartStart: true })
    h.occupied.right = true
    setNoise(true, 'app', NOW - 15 * 60 * MIN)
    h.occupied.right = false
    syncNoise(NOW - 15 * 60 * MIN + 11 * MIN)
    expect(noiseStatus().on).toBe(false)
    // Tonight Smart start begins the curve early; the start-time setting waits for the start time.
    h.bedtimes = { left: null, right: NOW + 45 * MIN }
    h.occupied.right = true
    h.runs.right = { phase: 'running', startedAt: NOW }
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    syncNoise(NOW + 46 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('starts again only for a sleeper back on their own side', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'right' })
    h.bedtimes = { left: null, right: NOW }
    h.occupied.right = true
    syncNoise(NOW)
    h.occupied.right = false
    syncNoise(NOW + 11 * MIN)
    h.occupied.left = true
    syncNoise(NOW + 20 * MIN)
    expect(noiseStatus().on).toBe(false)
    h.occupied.right = true
    syncNoise(NOW + 25 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'return' })
  })

  it('doesn\'t start again after the curve has ended', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.bedtimes = { left: NOW, right: null }
    h.occupied.left = true
    syncNoise(NOW)
    h.occupied.left = false
    syncNoise(NOW + 11 * MIN)
    h.occupied.left = true
    syncNoise(NOW + 9 * 60 * MIN)
    expect(noiseStatus().on).toBe(false)
  })

  it('never starts by itself again that night after a stop by hand', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.bedtimes = { left: NOW, right: NOW + 30 * MIN }
    h.occupied.left = true
    syncNoise(NOW)
    setNoise(false, 'button', NOW + 5 * MIN)
    h.occupied.left = false
    syncNoise(NOW + 20 * MIN)
    h.occupied.left = true
    syncNoise(NOW + 40 * MIN)
    expect(noiseStatus().on).toBe(false)
  })

  it('starts again on getting back in when someone started it by hand after their stop', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.bedtimes = { left: NOW, right: null }
    h.occupied.left = true
    syncNoise(NOW)
    setNoise(false, 'button', NOW + 5 * MIN)
    setNoise(true, 'app', NOW + 6 * MIN)
    h.occupied.left = false
    syncNoise(NOW + 17 * MIN)
    expect(noiseStatus().on).toBe(false)
    h.occupied.left = true
    syncNoise(NOW + 25 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'return' })
  })

  it('still starts at the start time after a stop by hand earlier in the evening', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'left' })
    setNoise(true, 'app', NOW - 3 * 60 * MIN)
    setNoise(false, 'app', NOW - 2 * 60 * MIN)
    h.bedtimes = { left: NOW, right: null }
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('fades in from silence when it starts by itself, but not from Play', async () => {
    vi.useFakeTimers()
    setPodSettings({ noiseStart: 'clock', noiseSide: 'left', noiseVolume: 60, noiseFadeSeconds: 3 })
    h.bedtimes = { left: NOW, right: null }
    syncNoise(NOW)
    expect(h.spawn.mock.calls[0][1][1]).toContain('--volume=0 ')
    await vi.advanceTimersByTimeAsync(5_000)
    const levels = h.execFile.mock.calls.filter(call => call[1][0] === 'set-sink-input-volume').map(call => call[1][2])
    expect(levels).toEqual(['13107', '26214', '39322'])
    // Ticks during the fade leave the volume to it.
    syncNoise(NOW + 1_000)
    expect(h.spawn).toHaveBeenCalledOnce()
    setNoise(false, 'app', NOW + MIN)
    setPodSettings({ noiseFadeSeconds: 0 })
    setNoise(true, 'app', NOW + 2 * MIN)
    expect(h.spawn.mock.calls[1][1][1]).toContain('--volume=39322 ')
  })

  it('gives an empty bed its full grace after a restart', () => {
    h.occupied.left = true
    setNoise(true, 'app', NOW)
    resetNoiseMemoryKeepingStore()
    h.occupied.left = false
    syncNoise(NOW + 3 * 60 * MIN)
    expect(noiseStatus().on).toBe(true)
  })

  it('changes the volume of the playing stream without restarting it', async () => {
    setNoise(true, 'app', NOW)
    setPodSettings({ noiseVolume: 50 })
    syncNoise(NOW + 1_000)
    await vi.waitFor(() => expect(h.execFile).toHaveBeenCalledWith('pactl', ['set-sink-input-volume', '6', '32768'], expect.anything(), expect.any(Function)))
    expect(h.spawn).toHaveBeenCalledOnce()
    syncNoise(NOW + 2_000)
    expect(h.execFile).toHaveBeenCalledTimes(2)
  })

  it('restarts the player at the new volume when its stream can\'t be reached', async () => {
    h.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, done: (error: Error | null) => void) => done(new Error('no pactl')))
    setNoise(true, 'app', NOW)
    setPodSettings({ noiseVolume: 50 })
    syncNoise(NOW + 1_000)
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2))
    expect(h.spawn.mock.calls[1][1][1]).toContain('--volume=32768')
  })

  it('fades out over the set seconds when the session ends, then stops the player', async () => {
    vi.useFakeTimers()
    setPodSettings({ noiseVolume: 60, noiseFadeSeconds: 3 })
    setNoise(true, 'app', NOW)
    const child = h.spawn.mock.results[0].value
    setNoise(false, 'app', NOW + MIN)
    expect(noiseStatus()).toMatchObject({ on: false, playing: false })
    expect(child.kill).not.toHaveBeenCalled()
    syncNoise(NOW + MIN + 1_000)
    await vi.advanceTimersByTimeAsync(3_000)
    const levels = h.execFile.mock.calls.filter(call => call[1][0] === 'set-sink-input-volume').map(call => call[1][2])
    expect(levels).toEqual(['26214', '13107', '0'])
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('stops a player still fading out when a new session starts', async () => {
    vi.useFakeTimers()
    setPodSettings({ noiseFadeSeconds: 30 })
    setNoise(true, 'app', NOW)
    const first = h.spawn.mock.results[0].value
    setNoise(false, 'app', NOW + MIN)
    setNoise(true, 'app', NOW + MIN + 1_000)
    expect(first.kill).toHaveBeenCalledOnce()
    expect(h.spawn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.spawn.mock.results[1].value.kill).not.toHaveBeenCalled()
    expect(noiseStatus().playing).toBe(true)
  })

  it('stops at once with no fade set', () => {
    setNoise(true, 'app', NOW)
    const child = h.spawn.mock.results[0].value
    setNoise(false, 'app', NOW + MIN)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('stays silent at zero volume', () => {
    setPodSettings({ noiseVolume: 0 })
    setNoise(true, 'app', NOW)
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('turns on and off from the middle button gesture it is set to', () => {
    vi.useFakeTimers()
    setPodSettings({ middleDouble: 'noise' })
    observePress({ type: 'button-press', left: { button: 'middle', type: 'short', count: 1 } })
    observePress({ type: 'button-press', left: { button: 'middle', type: 'short', count: 1 } })
    vi.advanceTimersByTime(2000)
    expect(noiseStatus().on).toBe(true)
    observePress({ type: 'button-press', right: { button: 'middle', type: 'short', count: 1 } })
    vi.advanceTimersByTime(2000)
    expect(noiseStatus().on).toBe(true)
    expect(listEvents(0, Date.now() + 1, ['middle-press'])).toHaveLength(2)
  })

  it('never counts the middle button as a temperature press', () => {
    vi.useFakeTimers()
    observePress({ type: 'button-press', left: { button: 'middle', type: 'short', count: 1 } })
    vi.advanceTimersByTime(30_000)
    expect(listEvents(0, Date.now() + 1, ['press'])).toHaveLength(0)
  })
})
