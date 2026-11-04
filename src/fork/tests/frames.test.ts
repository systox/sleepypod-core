import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ cap: vi.fn(), piezo: vi.fn(), press: vi.fn() }))

vi.mock('../presence/collector', () => ({ observeCap: h.cap, observePiezo: h.piezo }))
vi.mock('../holds', () => ({ observePress: h.press }))

import { observeCapFrame, observeSensorFrame } from '../frames'
import { runtime } from '../runtime'

beforeEach(() => {
  runtime.running = true
  vi.clearAllMocks()
})
afterEach(() => {
  runtime.running = false
  runtime.detectionOn = false
})

describe('with detection off', () => {
  it('does no sensor work, and presses still count', () => {
    runtime.detectionOn = false
    observeCapFrame([1], [1])
    observeSensorFrame({ type: 'piezo-dual' })
    observeSensorFrame({ type: 'button-press' })
    expect(h.cap).not.toHaveBeenCalled()
    expect(h.piezo).not.toHaveBeenCalled()
    expect(h.press).toHaveBeenCalledOnce()
  })
})

describe('with detection on', () => {
  it('passes sensor frames along', () => {
    runtime.detectionOn = true
    observeCapFrame([1], [1])
    observeSensorFrame({ type: 'piezo-dual' })
    expect(h.cap).toHaveBeenCalledOnce()
    expect(h.piezo).toHaveBeenCalledOnce()
  })
})

describe('cover health', () => {
  it('follows the cover even while the fork\'s service is stopped', async () => {
    const { coverLink, resetCoverLink } = await import('../coverLink')
    resetCoverLink()
    runtime.running = false
    observeSensorFrame({ type: 'sensHealth', ts: 1, left: { connected: true }, right: { connected: true } })
    expect(coverLink()).not.toBeNull()
  })
})
