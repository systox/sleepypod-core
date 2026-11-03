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
}
