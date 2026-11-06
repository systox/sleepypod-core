/** One presence for a one-side bed (docs/fork/one-big-side.md, rule 7). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ away: null as 'left' | 'right' | null }))

vi.mock('../../oneSide', () => ({ awayHalfOf: () => h.away }))

import { bedPresenceOf, noteEntry, presenceOf, takeEntry } from '../collector'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

interface Half { occupied: boolean | null, since: number | null, run: number, runSince: number | null }
const collector = (globalThis as unknown as { __sp_forkCollector: { presence: Record<string, Half> | null } }).__sp_forkCollector
const half = (occupied: boolean | null, since: number | null, returningSince: number | null = null): Half =>
  ({ occupied, since, run: returningSince === null ? 0 : 1, runSince: returningSince })
const view = (occupied: boolean | null, since: number | null, returningSince: number | null = null) => ({ occupied, since, returningSince })

beforeEach(() => {
  h.away = 'right'
})

describe('the whole bed is the home sleeper\'s', () => {
  it('counts lying on the empty half as being in bed, since the first half someone got into', () => {
    collector.presence = { left: half(false, NOW - HOUR), right: half(true, NOW - 10 * 60_000) }
    expect(bedPresenceOf('left')).toEqual(view(true, NOW - 10 * 60_000))
    // Each half's own reading is unchanged, for rules that need it.
    expect(presenceOf('left')).toEqual(view(false, NOW - HOUR))
  })

  it('is empty only when both halves are, since the last one left, and returning when either shows someone', () => {
    collector.presence = { left: half(false, NOW - HOUR), right: half(false, NOW - 5 * 60_000, NOW - 60_000) }
    expect(bedPresenceOf('left')).toEqual(view(false, NOW - 5 * 60_000, NOW - 60_000))
  })

  it('is the side\'s own while the bed is two sides', () => {
    h.away = null
    collector.presence = { left: half(false, NOW - HOUR), right: half(true, NOW) }
    expect(bedPresenceOf('left')).toEqual(view(false, NOW - HOUR))
  })

  it('records an entry for a returning sleeper as if presence had seen them get in', () => {
    noteEntry('right', NOW)
    expect(takeEntry('right')).toEqual({ at: NOW, movedAcross: false })
    expect(takeEntry('right')).toBeNull()
  })
})
