/** The fork's settings and their defaults, with no storage, so the browser can use them. */
import { z } from 'zod'

export const sideSettingsSchema = z.object({
  smartStart: z.boolean(),
  warmUp: z.boolean(),
  warmUpWaitHours: z.number().min(0.5).max(12),
  readingMode: z.boolean(),
  hoursEarly: z.number().min(0).max(12),
  hoursLate: z.number().min(0).max(14),
  minutesToCall: z.number().int().min(1).max(30),
  /** Weight above the side's empty level that counts as a body. */
  weightRise: z.number().min(100).max(10_000),
  /** A side's own vibration above this counts as a body, not what crosses over. */
  vibrationLimit: z.number().min(1e4).max(1e8),
  /** Share of the other side's rise that lands on this side. */
  otherSideShare: z.number().min(0).max(1),
  warmestF: z.number().min(55).max(110),
  tripStepMinutes: z.tuple([z.number().min(1), z.number().min(1), z.number().min(1)]),
  endOutMinutes: z.number().min(1).max(240),
  earliestEndHours: z.number().min(0).max(14),
  backstopHours: z.number().min(1).max(16),
  minimumGapHours: z.number().min(0).max(24),
  falseStartWithinMinutes: z.number().min(0).max(240),
  falseStartOutMinutes: z.number().min(0).max(240),
  shortRunHours: z.number().min(0).max(14),
  moveAcrossMinutes: z.number().min(0).max(120),
  /** Hold the cover's surface in a range: off, log only, or nudge the water. Needs detection. */
  surfaceMode: z.enum(['off', 'watch', 'on']),
  surfaceLowF: z.number().min(60).max(100),
  surfaceHighF: z.number().min(60).max(100),
  surfaceMaxOffsetF: z.number().min(0).max(8),
  surfaceStepMinutes: z.number().min(5).max(120),
  suggestOn: z.boolean(),
  suggestNights: z.number().int().min(2).max(7),
  suggestNeeded: z.number().int().min(1).max(7),
  suggestStepF: z.number().min(1).max(3),
  suggestIgnoreMinutes: z.number().min(0).max(60),
  selfTestOn: z.boolean(),
  selfTestCurveA: z.number().int().nullable(),
  selfTestCurveB: z.number().int().nullable(),
})

export const podSettingsSchema = z.object({
  detection: z.enum(['off', 'watch', 'live']),
  /** Minutes a change holds. 0 is Off: it lasts until the curve's next change. */
  holdMinutes: z.number().int().min(0).max(1440),
  smoothReturn: z.boolean(),
  smoothRatePerHour: z.number().min(0.5).max(20),
  smoothMaxHours: z.number().min(0.5).max(12),
  pressWaitSeconds: z.number().min(1).max(60),
  /** Needs a passed bench test: can a press on an off side be seen at all? */
  pressStartsClosedSide: z.boolean(),
  ownershipStaleMinutes: z.number().min(1).max(30),
  timerRefreshHours: z.number().min(1).max(7.5),
  maxFailedStartups: z.number().int().min(1).max(20),
  /** After a power cut or restart, turn a side back on that was on and is still inside its curve. */
  resumeAfterPowerCut: z.boolean(),
  /** White noise starts at the bedtime of this side's curve, or whichever comes first. */
  noiseAuto: z.boolean(),
  noiseSide: z.enum(['left', 'right', 'either']),
  noiseVolume: z.number().int().min(0).max(100),
  noiseColor: z.enum(['white', 'pink', 'brown']),
  /** Started with nobody in bed, it waits this long for someone. */
  noiseWaitMinutes: z.number().min(5).max(240),
  /** It stops once the bed has been empty this long. */
  noiseEmptyMinutes: z.number().min(1).max(120),
  noiseMaxHours: z.number().min(1).max(16),
  /** When a session ends, the sound fades out over this many seconds. 0 stops it at once. */
  noiseFadeSeconds: z.number().int().min(0).max(300),
  middleSingle: z.enum(['none', 'noise']),
  middleDouble: z.enum(['none', 'noise']),
  middleTriple: z.enum(['none', 'noise']),
  middleLong: z.enum(['none', 'noise']),
})

export type ForkSideSettings = z.infer<typeof sideSettingsSchema>
export type ForkPodSettings = z.infer<typeof podSettingsSchema>

export const DEFAULT_SIDE_SETTINGS: ForkSideSettings = {
  smartStart: false,
  warmUp: false,
  warmUpWaitHours: 3,
  readingMode: false,
  hoursEarly: 1,
  hoursLate: 6,
  minutesToCall: 5,
  weightRise: 1000,
  vibrationLimit: 1.2e6,
  otherSideShare: 0,
  warmestF: 90,
  tripStepMinutes: [20, 60, 180],
  endOutMinutes: 30,
  earliestEndHours: 7,
  backstopHours: 16,
  minimumGapHours: 6,
  falseStartWithinMinutes: 30,
  falseStartOutMinutes: 15,
  shortRunHours: 2,
  moveAcrossMinutes: 10,
  surfaceMode: 'off',
  surfaceLowF: 86,
  surfaceHighF: 88,
  surfaceMaxOffsetF: 4,
  surfaceStepMinutes: 20,
  suggestOn: false,
  suggestNights: 3,
  suggestNeeded: 2,
  suggestStepF: 1,
  suggestIgnoreMinutes: 10,
  selfTestOn: false,
  selfTestCurveA: null,
  selfTestCurveB: null,
}

export const DEFAULT_RIGHT_SHARE = 0.3

export const DEFAULT_POD_SETTINGS: ForkPodSettings = {
  detection: 'off',
  holdMinutes: 30,
  smoothReturn: false,
  smoothRatePerHour: 2.7,
  smoothMaxHours: 3,
  pressWaitSeconds: 10,
  pressStartsClosedSide: false,
  ownershipStaleMinutes: 2,
  timerRefreshHours: 6,
  maxFailedStartups: 3,
  resumeAfterPowerCut: false,
  noiseAuto: false,
  noiseSide: 'either',
  noiseVolume: 20,
  noiseColor: 'pink',
  noiseWaitMinutes: 60,
  noiseEmptyMinutes: 10,
  noiseMaxHours: 12,
  noiseFadeSeconds: 0,
  middleSingle: 'none',
  middleDouble: 'none',
  middleTriple: 'none',
  middleLong: 'none',
}
