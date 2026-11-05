/**
 * White noise from the base's speaker, made on the Pod with no audio files:
 * ffmpeg generates it and paplay plays it. A session starts from the app, the
 * web page or a middle-button press, or by itself as noiseStart says.
 * Scheduled noise plays while a curve runs by its set times, whoever is in
 * bed. Smart noise starts once a sleeper has been in bed a few minutes during
 * their night, and so starts again the same way after the bed has been empty
 * long enough to stop it. Smart noise, and noise started by hand, ends when
 * the bed has been empty a while or at its longest length. A stop by hand
 * keeps it off until the next night. A session that starts by itself fades
 * in. A volume change reaches the playing stream directly, so the sound
 * doesn't break.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { Side } from '@/src/hardware/types'
import { activeSleeperSides } from '@/src/lib/singleSleeper'
import { presenceOf, sensorsFresh } from './presence/collector'
import type { ForkPodSettings } from './settings'
import { getPodSettings, getSideSettings } from './settings'
import { bedState } from './smart/following'
import { runStateOf, windowsOf } from './smart/runner'
import { logEvent, readKey, removeKey, writeKey } from './store'

const MINUTE = 60_000
const PAPLAY_FULL = 65536
/** The player's name in PulseAudio, so a volume change finds its stream. */
export const NOISE_CLIENT = 'sleepypod-noise'
const PACTL_TIMEOUT_MS = 5_000
const execFileAsync = promisify(execFile)
/** A player that keeps failing is retried this often, not every tick. */
const RETRY_MS = 5 * MINUTE
const SESSION_KEY = 'noise-session'
/** A player still running this long after it started has got past whatever failed before. */
const SETTLED_MS = 10_000
/** A fade lowers the volume this often. */
const FADE_STEP_MS = 1_000
/** When someone last stopped the noise by hand: nothing starts it by itself again that night. */
const HAND_STOP_KEY = 'noise-hand-stop'
/** Why and when the last session ended, so a sleeper in bed since before it ended by itself doesn't start it again. */
const LAST_STOP_KEY = 'noise-last-stop'
/** Longer than any curve runs: the start checks look this far past a curve's start time. */
const LONGEST_NIGHT_HOURS = 24
/** How many seconds a new player waits for its stream to appear before fading in. */
const STREAM_WAIT_STEPS = 5

/** By hand from the app or the middle button; or by itself, during bed hours or on getting into bed. */
export type NoiseReason = 'app' | 'button' | 'bedtime' | 'smart-start'

const BY_HAND: string[] = ['app', 'button'] satisfies NoiseReason[]

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
  /** When a session was read back after a restart: presence's minute-by-minute picture is rebuilding. */
  reloadedAt: number | null
  session: NoiseSession | null | undefined
  childStartedAt: number
  /** A player whose session has ended, fading out before it is stopped. */
  fading: ChildProcess | null
  /** A new player fading in: its volume belongs to the fade until it's done. */
  rising: ChildProcess | null
}

const globalNoise = globalThis as typeof globalThis & { __sp_forkNoise?: NoiseState }
const state: NoiseState = globalNoise.__sp_forkNoise ??= {
  child: null, key: null, volume: null, problem: null, failedKey: null, failedAt: 0, reloadedAt: null, session: undefined, childStartedAt: 0, fading: null, rising: null,
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
 * sides read empty for the set minutes, counted from when the last sleeper
 * got up, or from the end of the wait when nobody has been in it since the
 * session started.
 */
export function endReason(session: NoiseSession, timing: NoiseTiming, now: number, bed: { empty: boolean | null, leftAt: number | null }): string | null {
  if (now - session.startedAt >= timing.noiseMaxHours * 60 * MINUTE) return 'longest length'
  if (bed.empty !== true) return null
  const from = bed.leftAt !== null && bed.leftAt > session.startedAt ? bed.leftAt : session.startedAt + timing.noiseWaitMinutes * MINUTE
  return now - from >= timing.noiseEmptyMinutes * MINUTE ? 'bed empty' : null
}

/**
 * The sleepers whose curves can start noise: the chosen side, or both for
 * whoever goes first, leaving out anyone away and the unused side of a bed
 * set up for one.
 */
export function noiseSides(pod: Pick<ForkPodSettings, 'noiseSide'>, home: Side[]): Side[] {
  const chosen: Side[] = pod.noiseSide === 'either' ? ['left', 'right'] : [pod.noiseSide]
  return chosen.filter(side => home.includes(side))
}

function loadSession(now = Date.now()): NoiseSession | null {
  if (state.session === undefined) {
    state.session = readKey<NoiseSession>(SESSION_KEY)
    // Presence can't yet see someone who got back in just before a restart, so the empty-bed count starts afresh.
    state.reloadedAt = state.session ? now : null
  }
  return state.session
}

function saveSession(session: NoiseSession | null, why: string, now = Date.now()): void {
  const before = loadSession()
  state.session = session
  if (session) writeKey(SESSION_KEY, session)
  else removeKey(SESSION_KEY)
  if (session && !before) {
    logEvent(null, 'noise-start', { reason: session.reason })
    removeKey(LAST_STOP_KEY)
  }
  // The start checks use this too, so a session saved here is also the one they see.
  if (!session && before) {
    logEvent(null, 'noise-stop', { why })
    writeKey(LAST_STOP_KEY, { why, at: now })
  }
}

/**
 * Whether the bed is empty, and if so when the last sleeper got up. Presence
 * calls an exit only after some minutes empty, and dates it back to then. It
 * is as slow to call a return, so a side showing someone back while presence
 * makes sure doesn't count as empty.
 */
function bedNow(now: number): { empty: boolean | null, leftAt: number | null } {
  if (!sensorsFresh(now)) return { empty: null, leftAt: null }
  const left = presenceOf('left')
  const right = presenceOf('right')
  const empty = left.occupied === false && right.occupied === false && !left.returningSince && !right.returningSince
  const times = [left.since, right.since, state.reloadedAt].filter((at): at is number => at !== null)
  return { empty, leftAt: empty && times.length > 0 ? Math.max(...times) : null }
}

export function setNoise(on: boolean, reason: NoiseReason, now = Date.now()): void {
  if (!on) {
    // A stop sent while it is already fading out cuts the fade short.
    if (!loadSession()) stopNoise()
    saveSession(null, reason, now)
    if (BY_HAND.includes(reason)) writeKey(HAND_STOP_KEY, now)
  }
  else if (!loadSession()) {
    saveSession({ reason, startedAt: now }, reason, now)
    // Starting it again by hand takes back an earlier stop by hand.
    if (BY_HAND.includes(reason)) removeKey(HAND_STOP_KEY)
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
  state.rising = null
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
  state.rising = null
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

/**
 * Raise a new player from silence to the set volume over the set seconds. A
 * volume change during the fade is picked up by the next step. If the stream
 * can't be reached, the next check sets the volume at once instead.
 */
function fadeInNoise(seconds: number): void {
  const child = state.child
  if (!child) return
  state.rising = child
  void (async () => {
    try {
      let streams: string[] = []
      for (let tries = 0; tries < STREAM_WAIT_STEPS && streams.length === 0 && state.rising === child; tries++) {
        await sleep(FADE_STEP_MS)
        const { stdout } = await execFileAsync('pactl', ['list', 'sink-inputs'], { timeout: PACTL_TIMEOUT_MS })
        streams = playerStreams(stdout)
      }
      if (state.rising !== child) return
      if (streams.length === 0) throw new Error('the player has no stream to fade in')
      const steps = Math.max(1, Math.round(seconds * 1000 / FADE_STEP_MS))
      for (let step = 1; step <= steps && state.rising === child; step++) {
        await sleep(FADE_STEP_MS)
        if (state.rising !== child) break
        const volume = getPodSettings().noiseVolume * step / steps
        for (const stream of streams) await execFileAsync('pactl', ['set-sink-input-volume', stream, String(paVolume(volume))], { timeout: PACTL_TIMEOUT_MS })
        // A stop or a new player during the step owns the volume now.
        if (state.rising !== child) break
        state.volume = volume
      }
    }
    catch (error) {
      console.warn('[fork] white noise fade-in failed, playing at the set volume:', error instanceof Error ? error.message : error)
    }
    finally {
      if (state.rising === child) {
        state.rising = null
        // Sets the volume if the fade didn't reach it, or the setting changed at its end.
        syncNoise()
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

/** One sleeper's night as the start checks see it, read once a check. */
interface SideNight {
  side: Side
  /** When tonight's watch hours opened, while tonight lasts; null between nights. */
  opensAt: number | null
  /** The curve runs now by its set times: the bed hours Scheduled noise plays in. */
  scheduled: boolean
}

/**
 * Tonight for one sleeper. The curve is looked up with watch hours long
 * enough to keep it until it ends: the side's own watch hours can close while
 * a long curve still runs. Tonight lasts while the watch hours are open, the
 * curve runs by its set times, or Smart start is running it.
 */
function nightOf(side: Side, now: number): SideNight {
  const settings = getSideSettings(side)
  const curve = windowsOf(side, now, { hoursEarly: settings.hoursEarly, hoursLate: LONGEST_NIGHT_HOURS }).window?.curve ?? null
  const run = runStateOf(side)
  const early = settings.hoursEarly * 60 * MINUTE
  const runStart = (run.phase === 'reading' || run.phase === 'running') ? run.startedAt : null
  if (runStart !== null) return { side, opensAt: (run.bedtime ?? runStart) - early, scheduled: curveRuns(curve, now) }
  if (!curve) return { side, opensAt: null, scheduled: false }
  const scheduled = curveRuns(curve, now)
  const watching = now >= curve.bedtime - early && now < curve.bedtime + settings.hoursLate * 60 * MINUTE
  return { side, opensAt: watching || scheduled ? curve.bedtime - early : null, scheduled }
}

function curveRuns(curve: { bedtime: number, points: { offset: number }[] } | null, now: number): boolean {
  if (!curve) return false
  return now >= curve.bedtime && now < curve.bedtime + (curve.points.at(-1)?.offset ?? 0) * MINUTE
}

/**
 * Someone stopped the noise by hand since tonight's earliest watch hours
 * opened, and hasn't started it by hand since, so nothing starts it by itself
 * until the next night. A stop earlier in the evening doesn't count.
 */
function handStoppedTonight(nights: SideNight[]): boolean {
  const stoppedAt = readKey<number>(HAND_STOP_KEY)
  if (stoppedAt === null) return false
  const opens = nights.map(night => night.opensAt).filter((at): at is number => at !== null)
  return opens.length > 0 && stoppedAt >= Math.min(...opens)
}

function startByItself(reason: NoiseReason, now: number): void {
  if (loadSession(now)) return
  saveSession({ reason, startedAt: now }, reason, now)
}

/**
 * Start once a sleeper has been in their own side for their Smart start
 * minutes during their night. Someone in bed since before the last session
 * ended by itself, at its longest length say, doesn't start it again.
 */
function startWhenInBed(nights: SideNight[], now: number): void {
  if (!sensorsFresh(now)) return
  const last = readKey<{ why: string, at: number }>(LAST_STOP_KEY)
  const endedAt = last && !BY_HAND.includes(last.why) ? last.at : null
  const settled = nights.some(({ side, opensAt }) => {
    const { occupied, since } = presenceOf(side)
    if (opensAt === null || occupied !== true || since === null) return false
    return now - since >= getSideSettings(side).minutesToCall * MINUTE && (endedAt === null || since > endedAt)
  })
  if (settled) startByItself('smart-start', now)
}

/**
 * Start the noise by itself as noiseStart says, and say whether the schedule
 * holds it on now: null when a broken curve leaves that unknown, so it can't
 * end Scheduled noise either.
 */
function startNoiseByItself(pod: ForkPodSettings, now: number): boolean | null {
  try {
    const nights = noiseSides(pod, activeSleeperSides(bedState())).map(side => nightOf(side, now))
    if (nights.length === 0 || handStoppedTonight(nights)) return false
    if (pod.noiseStart === 'clock') {
      const bedHours = nights.some(night => night.scheduled)
      if (bedHours) startByItself('bedtime', now)
      return bedHours
    }
    if (pod.detection === 'live') startWhenInBed(nights, now)
  }
  catch (error) {
    console.warn('[fork] white noise start check failed:', error instanceof Error ? error.message : error)
    return null
  }
  return false
}

/**
 * One check: start by itself, end, and keep the player matching the session.
 * Bed hours hold any session on. Scheduled noise ends with them; the rest ends
 * on an empty bed or at its longest length.
 */
export function syncNoise(now = Date.now()): void {
  const pod = getPodSettings()
  const bedHours = pod.noiseStart !== 'off' && startNoiseByItself(pod, now)
  const session = loadSession(now)
  if (session) {
    if (bedHours !== true) {
      const hoursOver = bedHours === false ? 'bed hours over' : null
      const why = session.reason === 'bedtime' ? hoursOver : endReason(session, pod, now, bedNow(now))
      if (why) saveSession(null, why, now)
    }
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
    if (state.volume !== pod.noiseVolume && state.rising !== state.child) changeVolume(pod.noiseVolume)
    if (state.problem && now - state.childStartedAt >= SETTLED_MS) state.problem = null
    return
  }
  if (state.failedKey === key && now - state.failedAt < RETRY_MS) return
  stopNoise()
  // A session that has just started by itself fades in; one started by hand plays at once.
  const playing = loadSession() as NoiseSession
  const fadeIn = !BY_HAND.includes(playing.reason) && now - playing.startedAt < MINUTE && pod.noiseFadeSeconds > 0
  start(noiseCommand({ ...pod, noiseVolume: fadeIn ? 0 : pod.noiseVolume }), key, fadeIn ? 0 : pod.noiseVolume)
  if (fadeIn) fadeInNoise(pod.noiseFadeSeconds)
}

export function noiseStatus(): { on: boolean, playing: boolean, reason: NoiseReason | null, since: number | null, problem: string | null } {
  const session = loadSession()
  return { on: session !== null, playing: state.child !== null, reason: session?.reason ?? null, since: session?.startedAt ?? null, problem: state.problem }
}

/** For tests and a service restart: forget what's cached in memory. */
export function resetNoiseMemory(): void {
  stopNoise()
  state.session = undefined
  state.reloadedAt = null
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
  if (session && now - session.startedAt >= getPodSettings().noiseMaxHours * 60 * MINUTE) saveSession(null, 'longest length', now)
}
