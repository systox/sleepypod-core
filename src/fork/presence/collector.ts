/**
 * Turns the sensor stream into one reading a minute and feeds the detector.
 * Runs inside the sleepypod server, so nothing here may throw into the stream.
 */
import { renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Side } from '@/src/hardware/types'
import { runtime } from '../runtime'
import { getPodSettings, getSideSettings } from '../settings'
import { forkDbPath, logEvent, readKey, writeKey } from '../store'
import { initialPresence, markEmpty, stepPresence, type MinuteReading, type PresenceConfig, type PresenceEvent, type PresenceState, type SidePresence } from './detector'

const SIDES: Side[] = ['left', 'right']
const STATE_KEY = 'presence'
const SENSORS_STALE_MS = 2 * 60_000
const EMPTY_VIBRATION = 1e5
/** The Python modules treat this file as stale after 5 minutes. */
const PRESENCE_FILE_EVERY_MS = 2 * 60_000
/** The empty level drifts every quiet minute and relearns in 5, so a late save costs nothing. */
const EMPTY_LEVEL_SAVE_EVERY_MS = 15 * 60_000

interface MinuteBucket {
  minute: number
  weight: Record<Side, number[]>
  vibration: Record<Side, number[]>
}

interface CollectorState {
  bucket: MinuteBucket | null
  presence: PresenceState | null
  entries: Map<Side, { at: number, movedAcross: boolean }>
  /** Last minute both sides read empty, which a real exit passes through. */
  bedEmptyAt: number
  lastReading: MinuteReading | null
  savedKey: string | null
  savedLevels: string | null
  savedAt: number
  fileKey: string | null
  fileWrittenAt: number
}

/** What has to survive a restart. The rest rebuilds within minutes. */
interface SavedPresence {
  bedEmptyAt: number
  sides: Record<Side, Pick<SidePresence, 'occupied' | 'since' | 'emptyLevel'>>
}

const globalCollector = globalThis as typeof globalThis & { __sp_forkCollector?: CollectorState }
const collector: CollectorState = globalCollector.__sp_forkCollector ??= {
  bucket: null, presence: null, entries: new Map(), bedEmptyAt: 0, lastReading: null, savedKey: null, savedLevels: null, savedAt: 0, fileKey: null, fileWrittenAt: 0,
}

function presenceConfig(): PresenceConfig {
  const left = getSideSettings('left')
  const right = getSideSettings('right')
  return { left, right, emptyVibration: EMPTY_VIBRATION }
}

function loadPresence(): PresenceState {
  if (collector.presence) return collector.presence
  const saved = readKey<SavedPresence>(STATE_KEY)
  const fresh = initialPresence()
  collector.presence = saved?.sides
    ? { ...fresh, left: { ...fresh.left, ...saved.sides.left }, right: { ...fresh.right, ...saved.sides.right } }
    : fresh
  collector.bedEmptyAt = saved?.bedEmptyAt ?? 0
  return collector.presence
}

/**
 * This runs on the Pod's flash storage, so it writes at once only when someone
 * gets in or out. The empty-bed time moves on every empty minute, and the
 * first of those is the one that matters after a restart: when the last person left.
 */
function savePresence(state: PresenceState, now: number, atOnce = false): void {
  const side = ({ occupied, since, emptyLevel }: SidePresence) => ({ occupied, since, emptyLevel })
  const key = JSON.stringify([state.left.occupied, state.left.since, state.right.occupied, state.right.since])
  const levels = JSON.stringify([state.left.emptyLevel, state.right.emptyLevel])
  const levelsDue = levels !== collector.savedLevels && now - collector.savedAt >= EMPTY_LEVEL_SAVE_EVERY_MS
  if (key === collector.savedKey && !levelsDue && !atOnce) return
  writeKey(STATE_KEY, { bedEmptyAt: collector.bedEmptyAt, sides: { left: side(state.left), right: side(state.right) } } satisfies SavedPresence)
  collector.savedKey = key
  collector.savedLevels = levels
  collector.savedAt = now
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function freshBucket(minute: number): MinuteBucket {
  return { minute, weight: { left: [], right: [] }, vibration: { left: [], right: [] } }
}

function peakToPeak(samples: unknown): number | null {
  if (!Array.isArray(samples) || samples.length === 0) return null
  let low = Infinity
  let high = -Infinity
  for (const sample of samples as number[]) {
    if (sample < low) low = sample
    if (sample > high) high = sample
  }
  return high - low
}

function bucketFor(now: number): MinuteBucket {
  const minute = Math.floor(now / 60_000)
  if (collector.bucket && collector.bucket.minute !== minute) closeMinute()
  collector.bucket ??= freshBucket(minute)
  return collector.bucket
}

export function observeCap(left: number[], right: number[], now = Date.now()): void {
  if (!runtime.running) return
  const bucket = bucketFor(now)
  bucket.weight.left.push(left.reduce((a, b) => a + b, 0))
  bucket.weight.right.push(right.reduce((a, b) => a + b, 0))
}

export function observePiezo(frame: Record<string, unknown>, now = Date.now()): void {
  if (!runtime.running) return
  const bucket = bucketFor(now)
  const left = peakToPeak(frame.left1)
  const right = peakToPeak(frame.right1)
  if (left !== null) bucket.vibration.left.push(left)
  if (right !== null) bucket.vibration.right.push(right)
}

function noteEvents(events: PresenceEvent[], state: PresenceState): void {
  for (const event of events) {
    const other: Side = event.side === 'left' ? 'right' : 'left'
    const otherLeft = state[other].occupied === false ? state[other].since : null
    const within = getSideSettings(event.side).moveAcrossMinutes * 60_000
    const movedAcross = event.kind === 'in' && otherLeft !== null
      && event.at - otherLeft <= within && collector.bedEmptyAt < otherLeft
    if (event.kind === 'in') collector.entries.set(event.side, { at: event.at, movedAcross })
    logEvent(event.side, event.kind, movedAcross ? { movedAcross } : undefined, event.at)
  }
}

function writePresenceFile(state: PresenceState, now: number): void {
  const side = ({ occupied, since }: SidePresence) => ({ occupied, since: since === null ? null : since / 1000 })
  const sides = { left: side(state.left), right: side(state.right) }
  const key = JSON.stringify(sides)
  if (key === collector.fileKey && now - collector.fileWrittenAt < PRESENCE_FILE_EVERY_MS) return
  const path = presenceFilePath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, ts: now / 1000, ...sides }))
  renameSync(tmp, path)
  collector.fileKey = key
  collector.fileWrittenAt = now
}

export function presenceFilePath(): string {
  return process.env.FORK_PRESENCE_PATH ?? join(dirname(forkDbPath()), 'fork-presence.json')
}

/** Close the running minute. Also called on a timer, so a stopped feed still ends a minute. */
export function closeMinute(now = Date.now()): void {
  const bucket = collector.bucket
  if (!bucket) return
  collector.bucket = null
  try {
    const pod = getPodSettings()
    if (pod.detection === 'off') return
    const ts = bucket.minute * 60_000
    const reading: MinuteReading = {
      ts,
      weight: { left: median(bucket.weight.left), right: median(bucket.weight.right) },
      vibration: { left: median(bucket.vibration.left), right: median(bucket.vibration.right) },
    }
    collector.lastReading = reading
    if (SIDES.every(s => reading.weight[s] !== null && reading.vibration[s] !== null)) runtime.sensorsOkAt = now
    const step = stepPresence(loadPresence(), reading, presenceConfig())
    collector.presence = step.state
    if (step.state.left.occupied === false && step.state.right.occupied === false) collector.bedEmptyAt = ts
    noteEvents(step.events, step.state)
    savePresence(step.state, now)
    if (pod.detection === 'live') writePresenceFile(step.state, now)
  }
  catch (error) {
    console.warn('[fork] presence minute failed:', error instanceof Error ? error.message : error)
  }
}

export function closeStaleMinute(now = Date.now()): void {
  if (collector.bucket && collector.bucket.minute < Math.floor(now / 60_000)) closeMinute(now)
}

export function sensorsFresh(now = Date.now()): boolean {
  return now - runtime.sensorsOkAt < SENSORS_STALE_MS
}

export interface PresenceView {
  occupied: boolean | null
  since: number | null
}

export function presenceOf(side: Side): PresenceView {
  const state = collector.presence?.[side]
  return { occupied: state?.occupied ?? null, since: state?.since ?? null }
}

export function takeEntry(side: Side): { at: number, movedAcross: boolean } | null {
  const entry = collector.entries.get(side)
  collector.entries.delete(side)
  return entry ?? null
}

/** Both sides show a body of their own, so a side waiting on a moved sleeper can start. */
export function twoBodies(): boolean {
  const state = collector.presence
  return Boolean(state?.left.occupied && state.right.occupied)
}

export function markBedEmpty(now = Date.now()): void {
  const reading = collector.lastReading
  const next = markEmpty(loadPresence(), { left: reading?.weight.left ?? null, right: reading?.weight.right ?? null }, now)
  collector.presence = next
  savePresence(next, now, true)
  logEvent(null, 'bed-empty-marked')
}
