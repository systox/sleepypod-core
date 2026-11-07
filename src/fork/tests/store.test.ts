import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeStore, dailyHousekeeping, logEvent } from '../store'

const DAY = 86_400_000
const now = Date.UTC(2026, 10, 7, 12)
let dir: string
let path: string

function rowsIn(file: string): number {
  const copy = new Database(file, { readonly: true })
  try {
    return (copy.prepare('select count(*) as n from events').get() as { n: number }).n
  }
  finally {
    copy.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fork-store-'))
  path = join(dir, 'fork.db')
  process.env.FORK_DATABASE_PATH = path
  closeStore()
})
afterEach(() => {
  closeStore()
  delete process.env.FORK_DATABASE_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('the daily copy', () => {
  it('holds every record, replaces the day before, and leaves no partial file', () => {
    writeFileSync(`${path}.daily.tmp`, 'left over from a crash')
    logEvent('right', 'in', undefined, now)
    dailyHousekeeping(now)
    expect(rowsIn(`${path}.daily`)).toBe(1)

    logEvent('right', 'out', undefined, now + DAY)
    dailyHousekeeping(now + DAY)
    expect(rowsIn(`${path}.daily`)).toBe(2)
    expect(existsSync(`${path}.daily.tmp`)).toBe(false)
  })
})
