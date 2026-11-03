import { describe, expect, it } from 'vitest'
import { noiseCommand, wantsNoise } from '../noise'

const pod = { noiseMode: 'in-bed' as const, noiseSide: 'either' as const, noiseVolume: 20, noiseColor: 'pink' as const }

describe('white noise', () => {
  it('plays while the chosen side is in bed', () => {
    expect(wantsNoise(pod, { left: true, right: false })).toBe(true)
    expect(wantsNoise({ ...pod, noiseSide: 'right' }, { left: true, right: false })).toBe(false)
    expect(wantsNoise({ ...pod, noiseSide: 'right' }, { left: false, right: true })).toBe(true)
  })

  it('stays off with blind sensors, at zero volume or with the setting off', () => {
    expect(wantsNoise(pod, { left: null, right: null })).toBe(false)
    expect(wantsNoise({ ...pod, noiseVolume: 0 }, { left: true, right: true })).toBe(false)
    expect(wantsNoise({ ...pod, noiseMode: 'off' }, { left: true, right: true })).toBe(false)
    expect(wantsNoise({ ...pod, noiseMode: 'on' }, { left: false, right: false })).toBe(true)
  })

  it('builds the player from the colour and a scaled volume', () => {
    const command = noiseCommand({ noiseColor: 'brown', noiseVolume: 50 })
    expect(command).toContain('anoisesrc=color=brown')
    expect(command).toContain('--volume=32768')
  })
})
