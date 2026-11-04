/**
 * Whether each side of the cover is talking, judged on the Pod's own clock.
 *
 * Newer cover firmware sends a `sensHealth` frame each minute with a
 * `connected` flag per side, but Pod 5's cover sends `connected: false` on
 * every frame while its capacitance readings keep arriving twice a second.
 * So a `false` counts only once that side's readings have stopped too.
 * Readings are timed against now, not against the health frame, because an
 * unplugged cover can stop sending both at once.
 */
import type { Side } from '@/src/hardware/types'

const SIDES: Side[] = ['left', 'right']
/** Readings this recent prove a side of the cover is talking. */
export const COVER_READING_FRESH_MS = 120_000

interface CoverLinkState {
  /** The latest sensHealth flags, or null until one arrives. Older firmware never sends one. */
  health: { ts: number, flags: Record<Side, boolean | null> } | null
  readingAt: Partial<Record<Side, number>>
  startedAt: number
}

const globalCover = globalThis as typeof globalThis & { __sp_forkCoverLink?: CoverLinkState }
const state: CoverLinkState = globalCover.__sp_forkCoverLink ??= { health: null, readingAt: {}, startedAt: Date.now() }

function flagOf(value: unknown): boolean | null {
  const connected = (value as { connected?: unknown } | null | undefined)?.connected
  return typeof connected === 'boolean' ? connected : null
}

/** Called for every live frame from the sensor stream. Cheap: it runs twice a second. */
export function observeCoverFrame(frame: Record<string, unknown>, now = Date.now()): void {
  if (frame.type === 'capSense' || frame.type === 'capSense2') {
    for (const side of SIDES) if (frame[side] != null) state.readingAt[side] = now
  }
  else if (frame.type === 'sensHealth') {
    state.health = { ts: typeof frame.ts === 'number' ? frame.ts : now / 1000, flags: { left: flagOf(frame.left), right: flagOf(frame.right) } }
  }
}

/**
 * The cover's health in the shape of a sensHealth frame, with a `false` that
 * fresh readings disprove turned to `true`. Null until a sensHealth frame
 * arrives, so older firmware still shows nothing.
 */
export function coverLink(now = Date.now()): { type: 'sensHealth', ts: number, left: { connected: boolean }, right: { connected: boolean } } | null {
  const health = state.health
  if (!health) return null
  // Just after a restart no reading has had time to arrive, so none is missing yet.
  const talking = (side: Side) => now - (state.readingAt[side] ?? state.startedAt) <= COVER_READING_FRESH_MS
  // As before, only an explicit false warns; a missing flag reads as no problem.
  const connected = (side: Side) => health.flags[side] !== false || talking(side)
  return { type: 'sensHealth', ts: health.ts, left: { connected: connected('left') }, right: { connected: connected('right') } }
}

/** For tests: forget what has been seen. */
export function resetCoverLink(now = Date.now()): void {
  state.health = null
  state.readingAt = {}
  state.startedAt = now
}
