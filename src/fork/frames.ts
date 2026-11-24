/**
 * The one door from the sensor stream into the fork. The stream's only job
 * here is to hand frames over, so nothing may throw back into it.
 */
import { observePress } from './holds'
import { observeCap, observePiezo } from './presence/collector'
import { runtime } from './runtime'

function safely(step: () => void): void {
  try {
    step()
  }
  catch (error) {
    console.warn('[fork] frame failed:', error instanceof Error ? error.message : error)
  }
}

export function observeSensorFrame(frame: Record<string, unknown>): void {
  if (!runtime.running) return
  if (frame.type === 'piezo-dual') {
    if (runtime.detectionOn) safely(() => observePiezo(frame))
  }
  else if (frame.type === 'button-press') safely(() => observePress(frame))
}

export function observeCapFrame(left: number[], right: number[]): void {
  if (!runtime.running || !runtime.detectionOn) return
  safely(() => observeCap(left, right))
}
