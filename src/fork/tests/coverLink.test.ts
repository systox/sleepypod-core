import { beforeEach, describe, expect, it } from 'vitest'
import { COVER_READING_FRESH_MS, coverLink, observeCoverFrame, resetCoverLink } from '../coverLink'

const START = 1_000_000_000_000
const health = (left: unknown, right: unknown) => ({ type: 'sensHealth', ts: START / 1000, version: 1, left: { connected: left }, right: { connected: right } })
const cap = { type: 'capSense', ts: START / 1000, left: { out: 1, cen: 2, in: 3, status: 'good' }, right: { out: 1, cen: 2, in: 3, status: 'good' } }
const linked = (now: number) => {
  const link = coverLink(now)
  return link && [link.left.connected, link.right.connected]
}

beforeEach(() => resetCoverLink(START))

describe('cover link', () => {
  it('reports nothing until a sensHealth frame arrives, as on older firmware', () => {
    observeCoverFrame(cap, START)
    expect(coverLink(START)).toBeNull()
  })

  it('trusts readings still arriving over a false flag, as Pod 5 sends false throughout', () => {
    observeCoverFrame(health(false, false), START)
    observeCoverFrame(cap, START + 60_000)
    expect(linked(START + 61_000)).toEqual([true, true])
  })

  it('warns once a side\'s readings stop, even when the health frames stop with them', () => {
    observeCoverFrame(health(false, false), START)
    observeCoverFrame(cap, START + 1_000)
    // Unplugged: nothing more arrives at all.
    expect(linked(START + 1_000 + COVER_READING_FRESH_MS + 1)).toEqual([false, false])
    observeCoverFrame({ type: 'capSense2', ts: 0, left: { values: [1] } }, START + 200_000)
    expect(linked(START + 201_000)).toEqual([true, false])
  })

  it('gives readings time to arrive after a restart', () => {
    observeCoverFrame(health(false, false), START)
    expect(linked(START + 5_000)).toEqual([true, true])
    expect(linked(START + COVER_READING_FRESH_MS + 1)).toEqual([false, false])
  })

  it('passes a true or missing flag through, warning only on an explicit false', () => {
    observeCoverFrame(health(true, null), START)
    expect(linked(START + 10 * COVER_READING_FRESH_MS)).toEqual([true, true])
  })
})
