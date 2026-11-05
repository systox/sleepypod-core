import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as Store from '../../store'

const h = vi.hoisted(() => ({ writes: [] as string[] }))

vi.mock('../../store', async (importOriginal) => {
  const store = await importOriginal<typeof Store>()
  return {
    ...store,
    writeKey: (key: string, value: unknown) => {
      h.writes.push(key)
      store.writeKey(key, value)
    },
  }
})

import { runtime } from '../../runtime'
import { setPodSettings } from '../../settings'
import { closeStore } from '../../store'
import { closeMinute, markBedEmpty, observeCap, observePiezo, presenceOf } from '../collector'

const MINUTE = 60_000
const START = 29_000_000 * MINUTE
const folder = mkdtempSync(join(tmpdir(), 'fork-presence-'))
const file = join(folder, 'fork-presence.json')

/** One minute of the same empty-bed readings, closed by the first frame of the next. */
function minute(index: number): void {
  const at = START + index * MINUTE
  observeCap([10, 10], [10, 10], at)
  observePiezo({ left1: [0, 5], right1: [0, 5] }, at)
  closeMinute(at + MINUTE)
}

const fileTs = (): number => JSON.parse(readFileSync(file, 'utf8')).ts

beforeAll(() => {
  process.env.FORK_DATABASE_PATH = ':memory:'
  process.env.FORK_PRESENCE_PATH = file
  closeStore()
  setPodSettings({ detection: 'live' })
  runtime.running = true
})
afterAll(() => {
  runtime.running = false
  delete process.env.FORK_PRESENCE_PATH
  closeStore()
  rmSync(folder, { recursive: true })
})

describe('writing to storage', () => {
  it('saves presence once while nothing changes', () => {
    for (let i = 0; i < 5; i++) minute(i)
    h.writes.length = 0
    for (let i = 5; i < 10; i++) minute(i)
    expect(h.writes.filter(key => key === 'presence')).toEqual([])
  })

  it('keeps the file fresh for the Python modules, without writing it every minute', () => {
    const seen: number[] = []
    for (let i = 10; i < 16; i++) {
      minute(i)
      seen.push(fileTs())
    }
    expect(new Set(seen).size).toBe(3)
    expect(seen[5] - seen[0]).toBeGreaterThanOrEqual(240)
  })

  it('saves a drifted empty level late, and only once', () => {
    for (let i = 16; i < 25; i++) minute(i)
    expect(h.writes.filter(key => key === 'presence')).toEqual(['presence'])
  })

  it('saves a marked empty bed at once', () => {
    h.writes.length = 0
    markBedEmpty(START + 26 * MINUTE)
    expect(h.writes).toEqual(['presence'])
  })
})

describe('a return presence is making sure of', () => {
  /** One minute of someone lying on the left side. */
  function body(index: number): void {
    const at = START + index * MINUTE
    observeCap([2000, 2000], [10, 10], at)
    observePiezo({ left1: [0, 3e6], right1: [0, 5] }, at)
    closeMinute(at + MINUTE)
  }

  it('says since when readings show someone back, until presence calls them in', () => {
    for (let i = 30; i < 40; i++) minute(i)
    expect(presenceOf('left')).toMatchObject({ occupied: false, returningSince: null })
    let first: number | null = null
    let i = 40
    while (presenceOf('left').occupied === false && i < 60) {
      body(i)
      first ??= presenceOf('left').returningSince
      i++
    }
    expect(first).not.toBeNull()
    expect(presenceOf('left')).toMatchObject({ occupied: true, since: first, returningSince: null })
  })
})
