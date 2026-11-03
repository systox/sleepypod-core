/**
 * The fork's service. It runs inside the sleepypod server, so an uncaught
 * error here would stop the web page and the weekly schedule too: every step
 * catches its own errors, and repeated failed startups turn it off.
 */
import type { Side } from '@/src/hardware/types'
import { clearPressWaits, stepSmoothReturn } from './holds'
import { noteNightStart } from './nights'
import { stopNoise, syncNoise } from './noise'
import { closeStaleMinute, sensorsFresh } from './presence/collector'
import { runtime } from './runtime'
import { getPodSettings, getSideSettings } from './settings'
import { syncSelfTest } from './selftest'
import { checkFollow, tickSide } from './smart/runner'
import { closeStore, dailyHousekeeping, readKey, storeProblem, writeKey } from './store'
import { clearSurfaces, stepSurface } from './surface'
import { syncRotation } from './weeks'

const SIDES: Side[] = ['left', 'right']
const FAST_TICK_MS = 15_000
const SMART_TICK_MS = 30_000
const ROTATION_TICK_MS = 60_000
const HOUSEKEEPING_TICK_MS = 3_600_000
const HEALTHY_AFTER_MS = 10 * 60_000
const FAILED_STARTS_KEY = 'failed-startups'

interface ServiceTimers {
  timers: Array<ReturnType<typeof setInterval>>
  settled: ReturnType<typeof setTimeout> | null
}

const globalService = globalThis as typeof globalThis & { __sp_forkService?: ServiceTimers }

/** One step at a time: a slow one must not overlap itself and act twice on the same state. */
export function guarded(label: string, step: () => void | Promise<void>): () => void {
  let busy = false
  return () => {
    if (busy) return
    busy = true
    void Promise.resolve().then(step).catch((error) => {
      console.warn(`[fork] ${label} failed:`, error instanceof Error ? error.message : error)
    }).finally(() => {
      busy = false
    })
  }
}

function refreshFlags(): void {
  const pod = getPodSettings()
  runtime.detectionOn = pod.detection !== 'off'
  runtime.detectionLive = pod.detection === 'live'
  runtime.ownershipStaleMs = pod.ownershipStaleMinutes * 60_000
  runtime.smartSides = { left: getSideSettings('left').smartStart, right: getSideSettings('right').smartStart }
  runtime.lastBeat = Date.now()
}

function warnFailed(what: string) {
  return (error: unknown) => {
    console.warn(`[fork] ${what} failed:`, error instanceof Error ? error.message : error)
  }
}

const smartTick = async (): Promise<void> => {
  refreshFlags()
  if (!runtime.detectionLive || runtime.disabled) return
  await checkFollow().catch(warnFailed('move-across check'))
  for (const side of SIDES) {
    // A side that keeps failing must not hold up the other one.
    await tickSide(side).catch((error) => {
      console.warn(`[fork] ${side} tick failed:`, error instanceof Error ? error.message : error)
    })
  }
}

const fastTick = async (): Promise<void> => {
  closeStaleMinute()
  for (const side of SIDES) {
    await stepSmoothReturn(side).catch(warnFailed(`${side} smooth return`))
    await stepSurface(side).catch(warnFailed(`${side} surface range`))
  }
  syncNoise()
}

const rotationTick = async (): Promise<void> => {
  for (const side of SIDES) {
    await syncRotation(side).catch(warnFailed(`${side} rotation`))
    await syncSelfTest(side).catch(warnFailed(`${side} self-test nights`))
    try {
      noteNightStart(side)
    }
    catch (error) {
      warnFailed(`${side} night record`)(error)
    }
  }
}

export function startForkService(): void {
  if (runtime.running) return
  const problem = storeProblem()
  if (problem) {
    runtime.disabled = problem
    console.error('[fork] not starting:', problem)
    return
  }
  try {
    const failures = (readKey<number>(FAILED_STARTS_KEY) ?? 0) + 1
    writeKey(FAILED_STARTS_KEY, failures)
    runtime.disabled = failures > getPodSettings().maxFailedStartups ? `Stopped after ${failures - 1} failed startups` : null
    if (runtime.disabled) console.error('[fork]', runtime.disabled)
    refreshFlags()
    runtime.running = true
    const timers = [
      setInterval(guarded('tick', fastTick), FAST_TICK_MS),
      setInterval(guarded('smart start', smartTick), SMART_TICK_MS),
      setInterval(guarded('rotation', rotationTick), ROTATION_TICK_MS),
      setInterval(guarded('housekeeping', () => dailyHousekeeping()), HOUSEKEEPING_TICK_MS),
    ]
    for (const timer of timers) timer.unref()
    const settled = setTimeout(guarded('startup count', () => writeKey(FAILED_STARTS_KEY, 0)), HEALTHY_AFTER_MS)
    settled.unref()
    globalService.__sp_forkService = { timers, settled }
    guarded('housekeeping', () => dailyHousekeeping())()
    guarded('rotation', rotationTick)()
    console.log('[fork] service started')
  }
  catch (error) {
    runtime.running = false
    console.error('[fork] service failed to start:', error instanceof Error ? error.message : error)
  }
}

export function stopForkService(): void {
  const service = globalService.__sp_forkService
  if (service) {
    service.timers.forEach(clearInterval)
    if (service.settled) clearTimeout(service.settled)
    globalService.__sp_forkService = undefined
  }
  runtime.running = false
  clearPressWaits()
  clearSurfaces()
  stopNoise()
  try {
    closeStore()
  }
  catch (error) {
    console.warn('[fork] closing the data file failed:', error instanceof Error ? error.message : error)
  }
}

export interface ServiceHealth {
  running: boolean
  disabled: string | null
  sensorsFresh: boolean
  lastBeat: number
}

export function serviceHealth(): ServiceHealth {
  return { running: runtime.running, disabled: runtime.disabled, sensorsFresh: sensorsFresh(), lastBeat: runtime.lastBeat }
}
