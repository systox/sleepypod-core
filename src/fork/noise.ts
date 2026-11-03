/**
 * White noise from the base's speaker, made on the Pod with no audio files:
 * ffmpeg generates it and paplay plays it. Off by default. "In bed" plays
 * while the chosen side reads occupied, and stops when nobody is.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Side } from '@/src/hardware/types'
import { presenceOf, sensorsFresh } from './presence/collector'
import type { ForkPodSettings } from './settings'
import { getPodSettings } from './settings'
import { logEvent } from './store'

const PAPLAY_FULL = 65536
/** A player that keeps failing is retried this often, not every tick. */
const RETRY_MS = 5 * 60_000

interface NoiseState {
  child: ChildProcess | null
  key: string | null
  problem: string | null
  failedKey: string | null
  failedAt: number
}

const globalNoise = globalThis as typeof globalThis & { __sp_forkNoise?: NoiseState }
const state: NoiseState = globalNoise.__sp_forkNoise ??= { child: null, key: null, problem: null, failedKey: null, failedAt: 0 }

type NoisePick = Pick<ForkPodSettings, 'noiseMode' | 'noiseSide' | 'noiseVolume' | 'noiseColor'>

/** The shell pipeline. Colour and volume come from validated settings only. */
export function noiseCommand(pod: Pick<NoisePick, 'noiseColor' | 'noiseVolume'>): string {
  const volume = Math.round(Math.max(0, Math.min(100, pod.noiseVolume)) / 100 * PAPLAY_FULL)
  return `ffmpeg -nostdin -loglevel error -f lavfi -i anoisesrc=color=${pod.noiseColor}:amplitude=0.5 -f s16le -ac 2 -ar 44100 - `
    + `| paplay --raw --rate=44100 --channels=2 --format=s16le --volume=${volume}`
}

export function wantsNoise(pod: NoisePick, occupied: Record<Side, boolean | null>): boolean {
  if (pod.noiseMode === 'off' || pod.noiseVolume === 0) return false
  if (pod.noiseMode === 'on') return true
  return pod.noiseSide === 'either' ? occupied.left === true || occupied.right === true : occupied[pod.noiseSide] === true
}

export function stopNoise(): void {
  const child = state.child
  state.child = null
  state.key = null
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    }
    catch {
      child.kill('SIGTERM')
    }
  }
}

function start(command: string, now: number): void {
  const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let lastError = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    lastError = chunk.toString().trim().split('\n').pop() ?? lastError
  })
  child.on('error', (error) => {
    lastError = error.message
  })
  child.on('exit', (code) => {
    if (state.child !== child) return
    state.child = null
    state.problem = `The noise player stopped${code === null ? '' : ` (exit ${code})`}${lastError ? `: ${lastError}` : ''}`
    // A retry that fails the same way isn't news, so only the first is logged.
    if (state.failedKey !== state.key) logEvent(null, 'noise-failed', { code, error: lastError })
    state.failedKey = state.key
    state.failedAt = Date.now()
    state.key = null
  })
  const retry = state.failedKey === command
  state.child = child
  state.key = command
  if (!retry) {
    state.problem = null
    logEvent(null, 'noise-on', { at: now })
  }
}

/** One check: play or stop to match the setting and the bed. */
export function syncNoise(now = Date.now()): void {
  const pod = getPodSettings()
  const fresh = sensorsFresh(now)
  // In-bed mode can't judge the bed while sensors are blind, so it keeps what's playing.
  if (!fresh && pod.noiseMode === 'in-bed' && state.child && state.key === noiseCommand(pod)) return
  const occupied = { left: fresh ? presenceOf('left').occupied : null, right: fresh ? presenceOf('right').occupied : null }
  if (!wantsNoise(pod, occupied)) {
    state.failedKey = null
    if (state.child) logEvent(null, 'noise-off')
    stopNoise()
    return
  }
  const command = noiseCommand(pod)
  if (state.child && state.key === command) return
  if (state.failedKey === command && now - state.failedAt < RETRY_MS) return
  stopNoise()
  start(command, now)
}

export function noiseStatus(): { playing: boolean, problem: string | null } {
  return { playing: state.child !== null, problem: state.problem }
}
