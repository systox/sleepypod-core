/**
 * White noise from the base's speaker, made on the Pod with no audio files:
 * ffmpeg generates it and paplay plays it. A session starts from the app, the
 * web page, a middle-button press, or at bedtime when that's switched on. It
 * ends when the bed has been empty a while, at its longest length, or when
 * someone stops it. A volume change reaches the playing stream directly, so
 * the sound doesn't break.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { Side } from '@/src/hardware/types'
import { presenceOf, sensorsFresh } from './presence/collector'
import type { ForkPodSettings } from './settings'
import { getPodSettings } from './settings'
import { windowsOf } from './smart/runner'
import { logEvent, readKey, removeKey, writeKey } from './store'

const MINUTE = 60_000
const PAPLAY_FULL = 65536
/** The player's name in PulseAudio, so a volume change finds its stream. */
export const NOISE_CLIENT = 'sleepypod-noise'
const PACTL_TIMEOUT_MS = 5_000
const execFileAsync = promisify(execFile)
/** A player that keeps failing is retried this often, not every tick. */
const RETRY_MS = 5 * MINUTE
/** A bedtime missed by longer than this, say while the Pod was off, doesn't start noise late. */
const BEDTIME_LATE_MS = 60 * MINUTE
const SESSION_KEY = 'noise-session'
/** Bedtimes that already started noise, so a stop or a second side's bedtime can't start it again. */
const BEDTIMES_KEY = 'noise-bedtimes-done'
/** Bedtimes closer than this belong to the same night, so the second side's doesn't start noise again. */
const SAME_NIGHT_MS = 12 * 60 * MINUTE
/** A player still running this long after it started has got past whatever failed before. */
const SETTLED_MS = 10_000
/** A fade lowers the volume this often. */
const FADE_STEP_MS = 1_000

export type NoiseReason = 'app' | 'button' | 'bedtime'

interface NoiseSession {
  reason: NoiseReason
  startedAt: number
}

interface NoiseState {
  child: ChildProcess | null
  /** The sound the running player makes. Volume isn't part of it: that changes in place. */
  key: string | null
  /** The volume, 0 to 100, last sent to the running player. */
  volume: number | null
  problem: string | null
  failedKey: string | null
  failedAt: number
  /** Kept in memory only: it changes every tick someone is in bed. */
  occupiedAt: number | null
  session: NoiseSession | null | undefined
  childStartedAt: number
  /** A player whose session has ended, fading out before it is stopped. */
  fading: ChildProcess | null
}

const globalNoise = globalThis as typeof globalThis & { __sp_forkNoise?: NoiseState }
const state: NoiseState = globalNoise.__sp_forkNoise ??= {
  child: null, key: null, volume: null, problem: null, failedKey: null, failedAt: 0, occupiedAt: null, session: undefined, childStartedAt: 0, fading: null,
}

type NoiseSound = Pick<ForkPodSettings, 'noiseColor' | 'noiseVolume'>
type NoiseTiming = Pick<ForkPodSettings, 'noiseWaitMinutes' | 'noiseEmptyMinutes' | 'noiseMaxHours'>
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** PulseAudio's volume scale, where 65536 is full. */
function paVolume(volume: number): number {
  return Math.round(Math.max(0, Math.min(100, volume)) / 100 * PAPLAY_FULL)
}

/** The shell pipeline. Colour and volume come from validated settings only. */
export function noiseCommand(pod: NoiseSound): string {
  return `ffmpeg -nostdin -loglevel error -f lavfi -i anoisesrc=color=${pod.noiseColor}:amplitude=0.5 -f s16le -ac 2 -ar 44100 - `
    + `| paplay --raw --rate=44100 --channels=2 --format=s16le --volume=${paVolume(pod.noiseVolume)} --client-name=${NOISE_CLIENT}`
}

/** The PulseAudio streams the player owns, read from `pactl list sink-inputs`. */
export function playerStreams(listing: string): string[] {
  const streams: string[] = []
  let index: string | null = null
  for (const line of listing.split('\n')) {
    const head = /^Sink Input #(\d+)/.exec(line)
    if (head) index = head[1]
    else if (index !== null && line.trim() === `application.name = "${NOISE_CLIENT}"`) streams.push(index)
  }
  return streams
}

let volumeQueue: Promise<void> = Promise.resolve()

/**
 * Set the running player's volume without restarting it. Changes run one at
 * a time and each sends the latest volume, so a quick run of them settles on
 * the last. If the stream can't be reached, the player restarts at the new
 * volume instead.
 */
function changeVolume(volume: number): void {
  state.volume = volume
  const child = state.child
  volumeQueue = volumeQueue.then(async () => {
    if (state.child !== child || state.volume === null) return
    const { stdout } = await execFileAsync('pactl', ['list', 'sink-inputs'], { timeout: PACTL_TIMEOUT_MS })
    const streams = playerStreams(stdout)
    if (streams.length === 0) throw new Error('the player has no stream yet')
    // A stop or fade can begin while the listing runs.
    if (state.child !== child || state.volume === null) return
    const level = String(paVolume(state.volume))
    for (const stream of streams) await execFileAsync('pactl', ['set-sink-input-volume', stream, level], { timeout: PACTL_TIMEOUT_MS })
  }).catch((error) => {
    if (state.child !== child) return
    console.warn('[fork] white noise volume change failed, restarting the player:', error instanceof Error ? error.message : error)
    stopNoise()
    syncNoise()
  })
}

/**
 * Why a session should end now, or null. The bed counts as empty once both
 * sides read empty for the set minutes, counted from when someone was last in
 * it, or from the end of the wait when nobody has been in it yet.
 */
export function endReason(session: NoiseSession, timing: NoiseTiming, now: number, bed: { empty: boolean | null, occupiedAt: number | null }): string | null {
  if (now - session.startedAt >= timing.noiseMaxHours * 60 * MINUTE) return 'longest length'
  if (bed.empty !== true) return null
  const from = bed.occupiedAt ?? session.startedAt + timing.noiseWaitMinutes * MINUTE
  return now - from >= timing.noiseEmptyMinutes * MINUTE ? 'bed empty' : null
}

/** Bedtimes that have just passed: the chosen side's curve, or both sides' for whoever goes first. */
export function dueBedtimes(pod: Pick<ForkPodSettings, 'noiseSide'>, now: number, bedtimeOf: (side: Side) => number | null = side => windowsOf(side, now).window?.curve.bedtime ?? null): number[] {
  const sides: Side[] = pod.noiseSide === 'either' ? ['left', 'right'] : [pod.noiseSide]
  return sides.map(bedtimeOf).filter((at): at is number => at !== null && at <= now && now - at < BEDTIME_LATE_MS)
}

function loadSession(now = Date.now()): NoiseSession | null {
  if (state.session === undefined) {
    state.session = readKey<NoiseSession>(SESSION_KEY)
    // Who was in bed before a restart isn't known, so the empty-bed count starts afresh.
    if (state.session) state.occupiedAt = now
  }
  return state.session
}

function saveSession(session: NoiseSession | null, why: string): void {
  const before = loadSession()
  state.session = session
  if (session) writeKey(SESSION_KEY, session)
  else removeKey(SESSION_KEY)
  if (session && !before) logEvent(null, 'noise-start', { reason: session.reason })
  // The bedtime check below uses this too, so a session saved here is also the one it sees.
  if (!session && before) logEvent(null, 'noise-stop', { why })
}

function bedNow(now: number): { empty: boolean | null, any: boolean } {
  if (!sensorsFresh(now)) return { empty: null, any: false }
  const left = presenceOf('left').occupied
  const right = presenceOf('right').occupied
  return { empty: left === false && right === false, any: left === true || right === true }
}

export function setNoise(on: boolean, reason: NoiseReason, now = Date.now()): void {
  if (!on) {
    // A stop sent while it is already fading out cuts the fade short.
    if (!loadSession()) stopNoise()
    saveSession(null, reason)
  }
  else if (!loadSession()) {
    state.occupiedAt = bedNow(now).any ? now : null
    saveSession({ reason, startedAt: now }, reason)
  }
  syncNoise(now)
}

export function toggleNoise(reason: NoiseReason, now = Date.now()): void {
  setNoise(!loadSession(), reason, now)
}

function killPlayer(child: ChildProcess | null): void {
  if (!child) return
  try {
    if (!child.pid) throw new Error('no process group')
    process.kill(-child.pid, 'SIGTERM')
  }
  catch {
    child.kill('SIGTERM')
  }
}

/** Stop the player at once, and any player still fading out. */
export function stopNoise(): void {
  const child = state.child
  state.child = null
  state.key = null
  state.volume = null
  killPlayer(child)
  const fading = state.fading
  state.fading = null
  killPlayer(fading)
}

/**
 * Lower the ended session's player to silence over the set seconds, then stop
 * it. It no longer counts as playing, so a new session starts a fresh player,
 * which stops this one.
 */
function fadeOutNoise(seconds: number): void {
  const child = state.child
  const from = state.volume ?? 0
  state.child = null
  state.key = null
  state.volume = null
  if (!child) return
  killPlayer(state.fading)
  state.fading = child
  void (async () => {
    try {
      const { stdout } = await execFileAsync('pactl', ['list', 'sink-inputs'], { timeout: PACTL_TIMEOUT_MS })
      const streams = playerStreams(stdout)
      if (streams.length === 0) throw new Error('the player has no stream to fade')
      const steps = Math.max(1, Math.round(seconds * 1000 / FADE_STEP_MS))
      for (let step = steps - 1; step >= 0 && state.fading === child; step--) {
        await sleep(FADE_STEP_MS)
        if (state.fading !== child) break
        const level = String(paVolume(from * step / steps))
        for (const stream of streams) await execFileAsync('pactl', ['set-sink-input-volume', stream, level], { timeout: PACTL_TIMEOUT_MS })
      }
    }
    catch (error) {
      console.warn('[fork] white noise fade failed, stopping it at once:', error instanceof Error ? error.message : error)
    }
    finally {
      if (state.fading === child) {
        state.fading = null
        killPlayer(child)
      }
    }
  })()
}

function start(command: string, key: string, volume: number): void {
  const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let lastError = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    lastError = chunk.toString().trim().split('\n').pop() ?? lastError
  })
  const failed = (code: number | null) => {
    if (state.child !== child) return
    state.child = null
    state.problem = `The noise player stopped${code === null ? '' : ` (exit ${code})`}${lastError ? `: ${lastError}` : ''}`
    // A retry that fails the same way isn't news, so only the first is logged.
    if (state.failedKey !== state.key) logEvent(null, 'noise-failed', { code, error: lastError })
    state.failedKey = state.key
    state.failedAt = Date.now()
    state.key = null
  }
  // A launch that fails may never report an exit, so its error counts as one.
  child.on('error', (error) => {
    lastError = error.message
    failed(null)
  })
  child.on('exit', failed)
  if (state.failedKey !== key) state.problem = null
  state.child = child
  state.key = key
  state.volume = volume
  state.childStartedAt = Date.now()
}

/** Start at a bedtime that has just passed, once per bedtime. A broken curve can't stop the rest. */
function startAtBedtime(pod: ForkPodSettings, now: number): void {
  try {
    const due = dueBedtimes(pod, now)
    const done = readKey<number[]>(BEDTIMES_KEY) ?? []
    const fresh = due.filter(at => !done.includes(at))
    if (fresh.length === 0) return
    writeKey(BEDTIMES_KEY, [...done, ...fresh].slice(-8))
    if (fresh.every(at => done.some(d => Math.abs(at - d) < SAME_NIGHT_MS))) return
    if (!loadSession(now)) {
      state.occupiedAt = null
      saveSession({ reason: 'bedtime', startedAt: now }, 'bedtime')
    }
  }
  catch (error) {
    console.warn('[fork] white noise bedtime check failed:', error instanceof Error ? error.message : error)
  }
}

/** One check: start at bedtime, end on an empty bed, and keep the player matching the session. */
export function syncNoise(now = Date.now()): void {
  const pod = getPodSettings()
  if (pod.noiseAuto) startAtBedtime(pod, now)
  const session = loadSession(now)
  if (session) {
    const bed = bedNow(now)
    if (bed.any) state.occupiedAt = now
    const why = endReason(session, pod, now, { empty: bed.empty, occupiedAt: state.occupiedAt })
    if (why) saveSession(null, why)
  }
  if (!loadSession() || pod.noiseVolume === 0) {
    state.failedKey = null
    // A fade already under way is left to finish.
    if (state.child && loadSession() === null && pod.noiseFadeSeconds > 0) fadeOutNoise(pod.noiseFadeSeconds)
    // Volume 0 silences a fade too.
    else if (state.child || pod.noiseVolume === 0) stopNoise()
    return
  }
  const key = pod.noiseColor
  if (state.child && state.key === key) {
    if (state.volume !== pod.noiseVolume) changeVolume(pod.noiseVolume)
    if (state.problem && now - state.childStartedAt >= SETTLED_MS) state.problem = null
    return
  }
  if (state.failedKey === key && now - state.failedAt < RETRY_MS) return
  stopNoise()
  start(noiseCommand(pod), key, pod.noiseVolume)
}

export function noiseStatus(): { on: boolean, playing: boolean, reason: NoiseReason | null, since: number | null, problem: string | null } {
  const session = loadSession()
  return { on: session !== null, playing: state.child !== null, reason: session?.reason ?? null, since: session?.startedAt ?? null, problem: state.problem }
}

/** For tests and a service restart: forget what's cached in memory. */
export function resetNoiseMemory(): void {
  stopNoise()
  state.session = undefined
  state.occupiedAt = null
  state.problem = null
  state.failedKey = null
}

/**
 * Stops a player left by an earlier run of the service. The player runs in its
 * own process group, so a crash leaves it playing with nothing to stop it.
 */
export function stopLeftoverPlayers(): void {
  spawnSync('pkill', ['-f', `client-name=${NOISE_CLIENT}`], { stdio: 'ignore', timeout: PACTL_TIMEOUT_MS })
}

/** Clears a stored session, so an old one can't restart noise after a long outage. */
export function clearStaleNoise(now = Date.now()): void {
  const session = loadSession()
  if (session && now - session.startedAt >= getPodSettings().noiseMaxHours * 60 * MINUTE) saveSession(null, 'longest length')
}
