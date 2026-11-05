import { describe, expect, it } from 'vitest'
import { endReason, noiseCommand, noiseSides, playerStreams } from '../noise'
import { actionFor, gestureOf } from '../middleButton'

const MIN = 60_000
const NOW = 1_800_000_000_000
const timing = { noiseWaitMinutes: 60, noiseEmptyMinutes: 10, noiseMaxHours: 12 }

describe('when white noise ends', () => {
  const session = { reason: 'app' as const, startedAt: NOW }

  it('waits for someone when it starts on an empty bed', () => {
    expect(endReason(session, timing, NOW + 30 * MIN, { empty: true, leftAt: null })).toBeNull()
    expect(endReason(session, timing, NOW + 70 * MIN, { empty: true, leftAt: null })).toBe('bed empty')
    // Out of bed since before it started: nobody has been in since, so the wait still applies.
    expect(endReason(session, timing, NOW + 30 * MIN, { empty: true, leftAt: NOW - 2 * 60 * MIN })).toBeNull()
  })

  it('stops once the bed has been empty a while, counted from when the last sleeper got up', () => {
    const left = NOW + 5 * 60 * MIN
    expect(endReason(session, timing, left + 9 * MIN, { empty: true, leftAt: left })).toBeNull()
    expect(endReason(session, timing, left + 10 * MIN, { empty: true, leftAt: left })).toBe('bed empty')
  })

  it('keeps going while anyone is in bed or the sensors are blind, up to its longest', () => {
    expect(endReason(session, timing, NOW + 5 * 60 * MIN, { empty: false, leftAt: null })).toBeNull()
    expect(endReason(session, timing, NOW + 5 * 60 * MIN, { empty: null, leftAt: null })).toBeNull()
    expect(endReason(session, timing, NOW + 12 * 60 * MIN, { empty: null, leftAt: null })).toBe('longest length')
  })
})

describe('whose curve counts', () => {
  it('uses the chosen side, or both sides for whoever goes first', () => {
    expect(noiseSides({ noiseSide: 'left' }, ['left', 'right'])).toEqual(['left'])
    expect(noiseSides({ noiseSide: 'either' }, ['left', 'right'])).toEqual(['left', 'right'])
  })

  it('leaves out a sleeper who is away', () => {
    expect(noiseSides({ noiseSide: 'either' }, ['right'])).toEqual(['right'])
    expect(noiseSides({ noiseSide: 'left' }, ['right'])).toEqual([])
  })
})

describe('the middle button', () => {
  it('reads a burst either as one counted record or as one record per press', () => {
    expect(gestureOf([{ type: 'short', count: 1 }])).toBe('single')
    expect(gestureOf([{ type: 'long', count: 1 }])).toBe('long')
    expect(gestureOf([{ type: 'short', count: 2 }])).toBe('double')
    expect(gestureOf([{ type: 'short' }, { type: 'short' }, { type: 'short' }])).toBe('triple')
    expect(gestureOf([{ type: 'long' }, { type: 'short' }])).toBe('double')
    // One record per press with a running count is still a double.
    expect(gestureOf([{ type: 'short', count: 1 }, { type: 'short', count: 2 }])).toBe('double')
  })

  it('does what each gesture is set to', () => {
    const pod = { middleSingle: 'none' as const, middleDouble: 'noise' as const, middleTriple: 'none' as const, middleLong: 'none' as const }
    expect(actionFor(pod, 'double')).toBe('noise')
    expect(actionFor(pod, 'single')).toBe('none')
  })
})

describe('the player', () => {
  it('builds the pipeline from the colour and a scaled volume', () => {
    const command = noiseCommand({ noiseColor: 'brown', noiseVolume: 50 })
    expect(command).toContain('anoisesrc=color=brown')
    expect(command).toContain('--volume=32768')
    expect(command).toContain('--client-name=sleepypod-noise')
  })

  it('finds its own streams in the PulseAudio listing', () => {
    const listing = [
      'Sink Input #3', '\tVolume: front-left: 0', '\tProperties:', '\t\tapplication.name = "other-app"',
      'Sink Input #6', '\tProperties:', '\t\tapplication.name = "sleepypod-noise"',
    ].join('\n')
    expect(playerStreams(listing)).toEqual(['6'])
    expect(playerStreams('')).toEqual([])
  })
})
