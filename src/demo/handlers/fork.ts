import { INITIAL_RUN } from '@/src/fork/smart/engine'
import { DEFAULT_POD_SETTINGS, DEFAULT_RIGHT_SHARE, DEFAULT_SIDE_SETTINGS } from '@/src/fork/settingsSchema'
import type { DemoHandlers } from '../types'

const side = (otherSideShare: number) => ({
  settings: { ...DEFAULT_SIDE_SETTINGS, otherSideShare },
  run: INITIAL_RUN,
  presence: { occupied: false, since: null },
  fade: null,
  tonight: null,
  upcoming: null,
  rotation: null,
  surface: { reading: null, offset: 0 },
})

export const fork: DemoHandlers<'fork'> = {
  overview: () => ({
    now: Date.now(),
    dailyJobs: { prime: false, reboot: false },
    health: { running: true, disabled: null, sensorsFresh: true, lastBeat: Date.now() },
    pod: DEFAULT_POD_SETTINGS,
    noise: { on: false, playing: false, reason: null, since: null, problem: null },
    left: side(DEFAULT_SIDE_SETTINGS.otherSideShare),
    right: side(DEFAULT_RIGHT_SHARE),
  }),
  setSideSettings: input => ({ ...DEFAULT_SIDE_SETTINGS, ...input.patch }),
  setPodSettings: input => ({ ...DEFAULT_POD_SETTINGS, ...input.patch }),
  command: () => INITIAL_RUN,
  markBedEmpty: () => ({ ok: true }),
  nights: () => ({ events: [], wrong: [] }),
  markWrong: () => ({ ok: true }),
  setNoise: input => ({ on: input.on, playing: input.on, reason: input.on ? 'app' as const : null, since: input.on ? Date.now() : null, problem: null }),
  noiseStatus: () => ({ on: false, playing: false, reason: null, since: null, problem: null }),
  coverLink: () => ({ type: 'sensHealth' as const, ts: Date.now() / 1000, left: { connected: true }, right: { connected: true } }),
  suggestions: () => [],
  answerSuggestion: () => ({ ok: true }),
  selfTest: () => [],
  listWeeks: () => [],
  saveWeek: input => ({ ...input, id: input.id ?? 'demo' }),
  deleteWeek: () => ({ ok: true }),
  saveRotation: input => input.rotation,
  swapWeek: () => undefined as never,
}
