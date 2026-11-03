import { describe, expect, it } from 'vitest'
import { dueBedtimes, endReason, noiseCommand } from '../noise'
import { actionFor, gestureOf } from '../middleButton'

const MIN = 60_000
const NOW = 1_800_000_000_000
const timing = { noiseWaitMinutes: 60, noiseEmptyMinutes: 10, noiseMaxHours: 12 }

describe('when white noise ends', () => {
  const session = { reason: 'bedtime' as const, startedAt: NOW }

  it('waits for someone when it starts on an empty bed', () => {
    expect(endReason(session, timing, NOW + 30 * MIN, { empty: true, occupiedAt: null })).toBeNull()
    expect(endReason(session, timing, NOW + 70 * MIN, { empty: true, occupiedAt: null })).toBe('bed empty')
  })

  it('stops once the bed has been empty a while after someone was in it', () => {
    const left = NOW + 5 * 60 * MIN
    expect(endReason(session, timing, left + 9 * MIN, { empty: true, occupiedAt: left })).toBeNull()
    expect(endReason(session, timing, left + 10 * MIN, { empty: true, occupiedAt: left })).toBe('bed empty')
  })

  it('keeps going while anyone is in bed or the sensors are blind, up to its longest', () => {
    expect(endReason(session, timing, NOW + 5 * 60 * MIN, { empty: false, occupiedAt: NOW })).toBeNull()
    expect(endReason(session, timing, NOW + 5 * 60 * MIN, { empty: null, occupiedAt: null })).toBeNull()
    expect(endReason(session, timing, NOW + 12 * 60 * MIN, { empty: null, occupiedAt: null })).toBe('longest length')
  })
})

describe('the bedtime that starts it', () => {
  const bedtimes = { left: NOW - 5 * MIN, right: NOW - 20 * MIN }

  it('uses the chosen side, or both sides for whoever goes first', () => {
    expect(dueBedtimes({ noiseSide: 'left' }, NOW, side => bedtimes[side])).toEqual([bedtimes.left])
    expect(dueBedtimes({ noiseSide: 'either' }, NOW, side => bedtimes[side])).toEqual([bedtimes.left, bedtimes.right])
  })

  it('ignores a bedtime still to come or long missed', () => {
    expect(dueBedtimes({ noiseSide: 'left' }, NOW, () => NOW + MIN)).toEqual([])
    expect(dueBedtimes({ noiseSide: 'left' }, NOW, () => NOW - 2 * 60 * MIN)).toEqual([])
    expect(dueBedtimes({ noiseSide: 'right' }, NOW, () => null)).toEqual([])
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
  })
})
