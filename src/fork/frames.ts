/**
 * The one door from the sensor stream into the fork. The stream's only job
 * here is to hand frames over, so nothing may throw back into it.
 */
import { observeCoverFrame } from './coverLink'
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
  // The cover's health shows on every page, so it is followed even without the fork's service.
  safely(() => observeCoverFrame(frame))
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
