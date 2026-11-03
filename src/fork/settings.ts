/**
 * Every number in the fork is a setting, kept in the fork's own data file.
 * The repo ships with the switches off; a Pod's own values live on the Pod.
 */
import type { Side } from '@/src/hardware/types'
import {
  DEFAULT_POD_SETTINGS, DEFAULT_RIGHT_SHARE, DEFAULT_SIDE_SETTINGS, podSettingsSchema, sideSettingsSchema,
  type ForkPodSettings, type ForkSideSettings,
} from './settingsSchema'
import { readKey, writeKey } from './store'

export { DEFAULT_POD_SETTINGS, DEFAULT_SIDE_SETTINGS, podSettingsSchema, sideSettingsSchema }
export type { ForkPodSettings, ForkSideSettings }

const sideDefault = (side: Side): ForkSideSettings => ({
  ...DEFAULT_SIDE_SETTINGS,
  otherSideShare: side === 'right' ? DEFAULT_RIGHT_SHARE : DEFAULT_SIDE_SETTINGS.otherSideShare,
})

export function getSideSettings(side: Side): ForkSideSettings {
  const saved = readKey<Partial<ForkSideSettings>>(`settings:${side}`)
  return sideSettingsSchema.parse({ ...sideDefault(side), ...saved })
}

export function setSideSettings(side: Side, patch: Partial<ForkSideSettings>): ForkSideSettings {
  const next = sideSettingsSchema.parse({ ...getSideSettings(side), ...patch })
  if (next.surfaceLowF >= next.surfaceHighF) throw new Error('The surface range\'s low must be below its high')
  if (next.suggestNeeded > next.suggestNights) throw new Error('Suggestions can\'t need more nights than they look at')
  writeKey(`settings:${side}`, next)
  return next
}

export function getPodSettings(): ForkPodSettings {
  const saved = readKey<Partial<ForkPodSettings>>('settings:pod')
  return podSettingsSchema.parse({ ...DEFAULT_POD_SETTINGS, ...saved })
}

export function setPodSettings(patch: Partial<ForkPodSettings>): ForkPodSettings {
  const next = podSettingsSchema.parse({ ...getPodSettings(), ...patch })
  writeKey('settings:pod', next)
  return next
}
