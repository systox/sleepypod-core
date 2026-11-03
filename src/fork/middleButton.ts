/**
 * The cover's middle button. A burst of presses becomes one gesture (single,
 * double, triple or long), and each gesture does what its setting says.
 * Presses are counted both ways the cover might report them: one record with
 * a count, or one record per press.
 */
import type { Side } from '@/src/hardware/types'
import { toggleNoise } from './noise'
import type { ForkPodSettings } from './settings'
import { getPodSettings } from './settings'
import { logEvent } from './store'

/** Presses closer together than this belong to one gesture. */
const GESTURE_GAP_MS = 1500

export type Gesture = 'single' | 'double' | 'triple' | 'long'
export interface MiddlePress { type?: string, count?: number }

interface Burst {
  timer: ReturnType<typeof setTimeout>
  presses: MiddlePress[]
}

const globalMiddle = globalThis as typeof globalThis & { __sp_forkMiddle?: Map<Side, Burst> }
const bursts = globalMiddle.__sp_forkMiddle ??= new Map<Side, Burst>()

/**
 * Clicks in a burst. A record's count may be its own presses or a running
 * total, so the larger of the highest count and the number of records is used.
 */
export function gestureOf(presses: MiddlePress[]): Gesture {
  const counted = Math.max(0, ...presses.map(p => (typeof p.count === 'number' && p.count > 0 ? p.count : 1)))
  const clicks = Math.max(counted, presses.length)
  if (clicks === 1 && presses[0]?.type === 'long') return 'long'
  return clicks === 1 ? 'single' : clicks === 2 ? 'double' : 'triple'
}

export function actionFor(pod: Pick<ForkPodSettings, 'middleSingle' | 'middleDouble' | 'middleTriple' | 'middleLong'>, gesture: Gesture): ForkPodSettings['middleSingle'] {
  return { single: pod.middleSingle, double: pod.middleDouble, triple: pod.middleTriple, long: pod.middleLong }[gesture]
}

export function settleMiddle(side: Side, presses: MiddlePress[]): void {
  const gesture = gestureOf(presses)
  const action = actionFor(getPodSettings(), gesture)
  logEvent(side, 'middle-press', { gesture, action })
  if (action === 'noise') toggleNoise('button')
}

export function observeMiddle(side: Side, press: MiddlePress): void {
  const burst = bursts.get(side)
  if (burst) clearTimeout(burst.timer)
  const presses = [...(burst?.presses ?? []), press]
  const timer = setTimeout(() => {
    bursts.delete(side)
    try {
      settleMiddle(side, presses)
    }
    catch (error) {
      console.warn(`[fork] ${side} middle button failed:`, error instanceof Error ? error.message : error)
    }
  }, GESTURE_GAP_MS)
  timer.unref()
  bursts.set(side, { timer, presses })
}

export function clearMiddleWaits(): void {
  for (const burst of bursts.values()) clearTimeout(burst.timer)
  bursts.clear()
}
