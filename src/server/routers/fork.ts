import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { sideSchema } from '@/src/server/validation-schemas'
import { markBedEmpty, presenceOf } from '@/src/fork/presence/collector'
import { coverLink } from '@/src/fork/coverLink'
import { fadeOf } from '@/src/fork/holds'
import { noiseStatus, setNoise, syncNoise } from '@/src/fork/noise'
import { powerResumedAt } from '@/src/fork/powerResume'
import { selfTestSummary } from '@/src/fork/selftest'
import { acceptSuggestion, dismissSuggestion, suggestionsFor } from '@/src/fork/suggestions'
import { surfaceView } from '@/src/fork/surface'
import { serviceHealth } from '@/src/fork/service'
import { getPodSettings, getSideSettings, podSettingsSchema, setPodSettings, setSideSettings, sideSettingsSchema } from '@/src/fork/settings'
import { noteSwitchedOn, runCommand, runStateOf, windowsOf } from '@/src/fork/smart/runner'
import { deviceTimezone } from '@/src/fork/clock'
import { listEvents, logEvent, readKey, writeKey } from '@/src/fork/store'
import { deletePreset, getRotation, listPresets, rotationSchema, rotationView, savePreset, saveRotation, syncRotation, weekNumber, weekPresetSchema } from '@/src/fork/weeks'
import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'
import type { Side } from '@/src/hardware/types'

const SIDES: Side[] = ['left', 'right']
const NIGHT_KINDS = ['in', 'out', 'press']

function failed(action: string, error: unknown): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message: `Could not ${action}: ${error instanceof Error ? error.message : 'unknown error'}` })
}

function sideView(side: Side, now: number) {
  const { window, next } = windowsOf(side, now)
  const shownWindow = window ?? next
  return {
    settings: getSideSettings(side),
    run: runStateOf(side),
    presence: presenceOf(side),
    fade: fadeOf(side),
    tonight: window
      ? { bedtime: window.curve.bedtime, windowStart: window.windowStart, windowEnd: window.windowEnd, points: window.curve.points }
      : null,
    upcoming: shownWindow
      ? { bedtime: shownWindow.curve.bedtime, windowStart: shownWindow.windowStart, windowEnd: shownWindow.windowEnd, firstTemperature: shownWindow.curve.points[0].temperature }
      : null,
    rotation: rotationView(side, now),
    surface: surfaceView(side, now),
    resumedAt: powerResumedAt(side),
  }
}

const NO_WRONG: number[] = []

export const forkRouter = router({
  /** Everything the Tonight page and the Schedule cards show, in one read. */
  overview: publicProcedure
    .input(z.object({}).optional())
    .query(() => {
      const now = Date.now()
      const device = db.select().from(deviceSettings).limit(1).all()[0]
      return {
        now,
        dailyJobs: { prime: Boolean(device?.primePodDaily), reboot: Boolean(device?.rebootDaily) },
        health: serviceHealth(),
        pod: getPodSettings(),
        noise: noiseStatus(),
        left: sideView('left', now),
        right: sideView('right', now),
      }
    }),

  setSideSettings: publicProcedure
    .input(z.object({ side: sideSchema, patch: sideSettingsSchema.partial() }).strict())
    .mutation(({ input }) => {
      try {
        const wasOn = getSideSettings(input.side).smartStart
        const saved = setSideSettings(input.side, input.patch)
        if (saved.smartStart && !wasOn) noteSwitchedOn(input.side)
        return saved
      }
      catch (error) {
        failed('save the setting', error)
      }
    }),

  setPodSettings: publicProcedure
    .input(z.object({ patch: podSettingsSchema.partial() }).strict())
    .mutation(({ input }) => {
      try {
        const wasLive = getPodSettings().detection === 'live'
        const saved = setPodSettings(input.patch)
        if (saved.detection === 'live' && !wasLive) SIDES.forEach(side => noteSwitchedOn(side))
        // A noise volume or sound change reaches the player now, not at the next tick.
        if (Object.keys(input.patch).some(key => key.startsWith('noise'))) {
          try {
            syncNoise()
          }
          catch (error) {
            console.warn('[fork] white noise update after a setting change failed:', error instanceof Error ? error.message : error)
          }
        }
        return saved
      }
      catch (error) {
        failed('save the setting', error)
      }
    }),

  command: publicProcedure
    .input(z.object({ side: sideSchema, command: z.enum(['start-new', 'start-back', 'sleep-now', 'stop']) }).strict())
    .mutation(async ({ input }) => {
      try {
        return await runCommand(input.side, input.command)
      }
      catch (error) {
        failed('do that', error)
      }
    }),

  markBedEmpty: publicProcedure
    .input(z.object({}).optional())
    .mutation(() => {
      markBedEmpty()
      return { ok: true }
    }),

  /** In and out events and presses for the Nights page. */
  nights: publicProcedure
    .input(z.object({ from: z.number(), to: z.number() }).strict())
    .query(({ input }) => ({
      events: listEvents(input.from, input.to, NIGHT_KINDS),
      wrong: readKey<number[]>('wrong-events') ?? NO_WRONG,
    })),

  /** The "wrong" button: a mistaken in or out, kept for the watch-only review. */
  markWrong: publicProcedure
    .input(z.object({ id: z.number().int() }).strict())
    .mutation(({ input }) => {
      const wrong = readKey<number[]>('wrong-events') ?? []
      if (!wrong.includes(input.id)) writeKey('wrong-events', [...wrong, input.id])
      logEvent(null, 'marked-wrong', { id: input.id })
      return { ok: true }
    }),

  /** White noise on or off now, from the app or the web page. */
  setNoise: publicProcedure
    .input(z.object({ on: z.boolean() }).strict())
    .mutation(({ input }) => {
      try {
        setNoise(input.on, 'app')
        return noiseStatus()
      }
      catch (error) {
        failed('change the white noise', error)
      }
    }),

  /** The cover's health as a sensHealth frame, checked against its readings. Null on older firmware. */
  coverLink: publicProcedure
    .input(z.object({}).optional())
    .query(() => coverLink()),

  /** Light enough for the iPhone app's Temp screen to ask often. */
  noiseStatus: publicProcedure
    .input(z.object({}).optional())
    .query(() => noiseStatus()),

  /** Morning suggestions for both sides. */
  suggestions: publicProcedure
    .input(z.object({}).optional())
    .query(() => SIDES.flatMap(side => suggestionsFor(side))),

  answerSuggestion: publicProcedure
    .input(z.object({ side: sideSchema, id: z.string().min(1).max(200), accept: z.boolean() }).strict())
    .mutation(async ({ input }) => {
      try {
        if (input.accept) await acceptSuggestion(input.side, input.id)
        else dismissSuggestion(input.side, input.id)
        return { ok: true }
      }
      catch (error) {
        failed('change the curve', error)
      }
    }),

  /** How each self-test curve's nights went. */
  selfTest: publicProcedure
    .input(z.object({ side: sideSchema }).strict())
    .query(({ input }) => selfTestSummary(input.side)),

  listWeeks: publicProcedure
    .input(z.object({}).optional())
    .query(() => listPresets()),

  saveWeek: publicProcedure
    .input(weekPresetSchema.partial({ id: true }).strict())
    .mutation(async ({ input }) => {
      try {
        const saved = savePreset(input)
        // A week that's on now changes its side's curves straight away.
        for (const side of SIDES) {
          if (rotationView(side)?.thisPresetId === saved.id) await syncRotation(side, Date.now(), true)
        }
        return saved
      }
      catch (error) {
        failed('save the week', error)
      }
    }),

  deleteWeek: publicProcedure
    .input(z.object({ id: z.string().min(1).max(64) }).strict())
    .mutation(({ input }) => {
      try {
        deletePreset(input.id)
        return { ok: true }
      }
      catch (error) {
        failed('delete the week', error)
      }
    }),

  /** Save a rotation. Turning one on is what changes the schedule. */
  saveRotation: publicProcedure
    .input(z.object({ side: sideSchema, rotation: rotationSchema }).strict())
    .mutation(async ({ input }) => {
      try {
        const before = getRotation(input.side)
        const saved = saveRotation(input.side, input.rotation)
        await syncRotation(input.side, Date.now(), before?.paused !== false)
        return saved
      }
      catch (error) {
        failed('save the rotation', error)
      }
    }),

  /** Use another preset for this week only, or null to undo. */
  swapWeek: publicProcedure
    .input(z.object({ side: sideSchema, presetId: z.string().min(1).max(64).nullable() }).strict())
    .mutation(async ({ input }) => {
      const rotation = getRotation(input.side)
      if (!rotation) failed('swap the week', new Error('This side has no rotation'))
      try {
        const week = weekNumber(rotation, Date.now(), deviceTimezone())
        const saved = saveRotation(input.side, { ...rotation, swap: input.presetId ? { week, presetId: input.presetId } : null })
        await syncRotation(input.side, Date.now(), true)
        return saved
      }
      catch (error) {
        failed('swap the week', error)
      }
    }),
})
