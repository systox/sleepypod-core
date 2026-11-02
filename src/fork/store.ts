/**
 * The fork's own small database, beside sleepypod's. It has no numbered
 * migrations, so it can't collide with upstream's, and stock sleepypod ignores
 * it. A missing file is created; a damaged one leaves the store unavailable,
 * which turns Smart start off and hands the bed back to the weekly schedule.
 */
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ForkEvent {
  id: number
  ts: number
  side: string | null
  kind: string
  detail: string | null
}

interface StoreState {
  sqlite: Database.Database | null
  failed: string | null
  backupDay: string | null
}

const globalStore = globalThis as typeof globalThis & { __sp_forkStore?: StoreState }
const state: StoreState = globalStore.__sp_forkStore ??= { sqlite: null, failed: null, backupDay: null }

const EVENT_KEEP_MS = 120 * 86_400_000

export function forkDbPath(): string {
  if (process.env.FORK_DATABASE_PATH) return process.env.FORK_DATABASE_PATH
  if (process.env.NODE_ENV === 'test') return ':memory:'
  const main = process.env.DATABASE_URL?.replace('file:', '') || './sleepypod.dev.db'
  return join(dirname(main), 'fork.db')
}

function open(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 2000')
  sqlite.pragma('synchronous = NORMAL')
  // Reads the file for real, so a damaged one fails here and not mid-night.
  const check = sqlite.pragma('quick_check', { simple: true })
  if (check !== 'ok') throw new Error(`fork database failed its check: ${String(check)}`)
  sqlite.exec(`
    create table if not exists kv (key text primary key, value text not null, updated_at integer not null);
    create table if not exists events (
      id integer primary key autoincrement,
      ts integer not null,
      side text,
      kind text not null,
      detail text
    );
    create index if not exists events_ts on events (ts);
  `)
  return sqlite
}

function handle(): Database.Database {
  if (state.sqlite) return state.sqlite
  if (state.failed) throw new Error(state.failed)
  try {
    state.sqlite = open(forkDbPath())
    return state.sqlite
  }
  catch (error) {
    state.failed = error instanceof Error ? error.message : String(error)
    console.error('[fork] data file unavailable:', state.failed)
    throw error
  }
}

/** Null while the data file is healthy, otherwise why it isn't. */
export function storeProblem(): string | null {
  try {
    handle()
    return null
  }
  catch {
    return state.failed ?? 'fork data file unavailable'
  }
}

export function readKey<T>(key: string): T | null {
  const row = handle().prepare('select value from kv where key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as T
  }
  catch {
    console.warn(`[fork] ignoring unreadable value for ${key}`)
    return null
  }
}

export function writeKey(key: string, value: unknown): void {
  handle().prepare('insert into kv (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), Date.now())
}

export function removeKey(key: string): void {
  handle().prepare('delete from kv where key = ?').run(key)
}

export function logEvent(side: string | null, kind: string, detail?: unknown, ts = Date.now()): void {
  handle().prepare('insert into events (ts, side, kind, detail) values (?, ?, ?, ?)')
    .run(ts, side, kind, detail === undefined ? null : JSON.stringify(detail))
}

export function listEvents(from: number, to: number, kinds?: string[]): ForkEvent[] {
  const rows = handle().prepare('select id, ts, side, kind, detail from events where ts >= ? and ts < ? order by ts, id').all(from, to) as ForkEvent[]
  return kinds ? rows.filter(row => kinds.includes(row.kind)) : rows
}

/** Oldest-first prune and one copy a day beside the file. Nothing else backs it up. */
export function dailyHousekeeping(now = Date.now()): void {
  const path = forkDbPath()
  const day = new Date(now).toISOString().slice(0, 10)
  if (state.backupDay === day) return
  const sqlite = handle()
  sqlite.prepare('delete from events where ts < ?').run(now - EVENT_KEEP_MS)
  if (path !== ':memory:' && existsSync(path)) {
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
    copyFileSync(path, `${path}.daily`)
  }
  state.backupDay = day
}

export function closeStore(): void {
  state.sqlite?.close()
  state.sqlite = null
  state.failed = null
  state.backupDay = null
}
