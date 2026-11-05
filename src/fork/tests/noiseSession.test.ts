import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  occupied: { left: false as boolean | null, right: false as boolean | null },
  since: { left: null as number | null, right: null as number | null },
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
  presenceOf: (side: 'left' | 'right') => ({ occupied: h.occupied[side], since: h.since[side] }),
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
import { setPodSettings } from '../settings'
import { closeStore, listEvents } from '../store'

const MIN = 60_000
const NOW = 1_800_000_000_000

function inBed(side: 'left' | 'right', at: number): void {
  h.occupied[side] = true
  h.since[side] = at
}

function outOfBed(side: 'left' | 'right', at: number): void {
  h.occupied[side] = false
  h.since[side] = at
}

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
  h.since = { left: null, right: null }
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

  it('Scheduled plays through bed hours whoever is in bed, and stops when they end', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.bedtimes = { left: NOW, right: null }
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
    syncNoise(NOW + 3 * 60 * MIN)
    expect(noiseStatus().on).toBe(true)
    h.occupied.left = true
    syncNoise(NOW + 4 * 60 * MIN)
    h.occupied.left = false
    syncNoise(NOW + 5 * 60 * MIN)
    expect(noiseStatus().on).toBe(true)
    syncNoise(NOW + 8 * 60 * MIN)
    expect(noiseStatus().on).toBe(false)
    expect(listEvents(0, NOW + 9 * 60 * MIN, ['noise-stop'])[0].detail).toContain('bed hours over')
  })

  it('Scheduled starts part way through bed hours, after a restart say', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'left' })
    h.bedtimes = { left: NOW - 3 * 60 * MIN, right: null }
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('Scheduled skips an away sleeper\'s bed hours when either side counts', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.away.left = true
    h.bedtimes = { left: NOW - MIN, right: NOW + 30 * MIN }
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    syncNoise(NOW + 31 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('Scheduled stays off for the night after a stop by hand, and plays the next night', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'either' })
    h.bedtimes = { left: NOW, right: NOW + 30 * MIN }
    syncNoise(NOW)
    setNoise(false, 'button', NOW + 5 * MIN)
    syncNoise(NOW + 40 * MIN)
    expect(noiseStatus().on).toBe(false)
    h.bedtimes = { left: NOW + 24 * 60 * MIN, right: null }
    syncNoise(NOW + 24 * 60 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('Scheduled still plays after a stop by hand earlier in the evening', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'left' })
    setNoise(true, 'app', NOW - 3 * 60 * MIN)
    setNoise(false, 'app', NOW - 2 * 60 * MIN)
    h.bedtimes = { left: NOW, right: null }
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'bedtime' })
  })

  it('bed hours hold noise started by hand, which then ends as noise by hand does', () => {
    setPodSettings({ noiseStart: 'clock', noiseSide: 'left' })
    setNoise(true, 'app', NOW - 30 * MIN)
    h.bedtimes = { left: NOW, right: null }
    syncNoise(NOW + 2 * 60 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'app' })
    syncNoise(NOW + 8 * 60 * MIN)
    expect(noiseStatus().on).toBe(false)
  })

  it('Smart starts once a sleeper has been in their side their Smart start minutes', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'either', detection: 'live' })
    h.away.left = true
    h.bedtimes = { left: NOW, right: NOW }
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    inBed('left', NOW)
    syncNoise(NOW + 10 * MIN)
    expect(noiseStatus().on).toBe(false)
    inBed('right', NOW + 10 * MIN)
    syncNoise(NOW + 14 * MIN)
    expect(noiseStatus().on).toBe(false)
    syncNoise(NOW + 15 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'smart-start' })
  })

  it('Smart waits for the night, and needs Detection on Live', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: null, right: NOW + 5 * 60 * MIN }
    inBed('right', NOW - 10 * MIN)
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    h.bedtimes = { left: null, right: NOW }
    setPodSettings({ detection: 'watch' })
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    setPodSettings({ detection: 'live' })
    syncNoise(NOW)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'smart-start' })
  })

  it('Smart pauses on an empty bed and resumes once someone is back for their minutes', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: null, right: NOW }
    inBed('right', NOW - 5 * MIN)
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(true)
    outOfBed('right', NOW + MIN)
    syncNoise(NOW + 11 * MIN)
    expect(noiseStatus().on).toBe(false)
    inBed('right', NOW + 20 * MIN)
    syncNoise(NOW + 24 * MIN)
    expect(noiseStatus().on).toBe(false)
    syncNoise(NOW + 25 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'smart-start' })
  })

  it('Smart starts only for a sleeper on a side that counts', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: NOW, right: NOW }
    inBed('left', NOW - 10 * MIN)
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    inBed('right', NOW - 5 * MIN)
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(true)
  })

  it('Smart doesn\'t start again for someone in bed since it reached its longest length', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live', noiseMaxHours: 1 })
    h.bedtimes = { left: null, right: NOW }
    inBed('right', NOW - 5 * MIN)
    syncNoise(NOW)
    syncNoise(NOW + 60 * MIN)
    expect(noiseStatus().on).toBe(false)
    syncNoise(NOW + 70 * MIN)
    expect(noiseStatus().on).toBe(false)
    inBed('right', NOW + 80 * MIN)
    syncNoise(NOW + 85 * MIN)
    expect(noiseStatus().on).toBe(true)
  })

  it('Smart resumes while Smart start still runs the curve past its set end', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: null, right: NOW - 9 * 60 * MIN }
    inBed('right', NOW - 5 * MIN)
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
    h.runs.right = { phase: 'running', startedAt: NOW - 9 * 60 * MIN }
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(true)
  })

  it('Smart never starts by itself again that night after a stop by hand', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: null, right: NOW }
    inBed('right', NOW - 5 * MIN)
    syncNoise(NOW)
    setNoise(false, 'button', NOW + 5 * MIN)
    outOfBed('right', NOW + 6 * MIN)
    inBed('right', NOW + 20 * MIN)
    syncNoise(NOW + 40 * MIN)
    expect(noiseStatus().on).toBe(false)
  })

  it('Smart resumes on getting back in when someone started it by hand after their stop', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: null, right: NOW }
    inBed('right', NOW - 5 * MIN)
    syncNoise(NOW)
    setNoise(false, 'button', NOW + 5 * MIN)
    setNoise(true, 'app', NOW + 6 * MIN)
    outOfBed('right', NOW + 7 * MIN)
    syncNoise(NOW + 17 * MIN)
    expect(noiseStatus().on).toBe(false)
    inBed('right', NOW + 20 * MIN)
    syncNoise(NOW + 25 * MIN)
    expect(noiseStatus()).toMatchObject({ on: true, reason: 'smart-start' })
  })

  it('Smart doesn\'t start after the night is over', () => {
    setPodSettings({ noiseStart: 'smart', noiseSide: 'right', detection: 'live' })
    h.bedtimes = { left: null, right: NOW - 9 * 60 * MIN }
    inBed('right', NOW - 10 * MIN)
    syncNoise(NOW)
    expect(noiseStatus().on).toBe(false)
  })

  it('fades in from silence when it starts by itself, but not from Play', async () => {
    vi.useFakeTimers()
    // The fade's last check reads the clock, which must still be in bed hours.
    vi.setSystemTime(NOW)
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
