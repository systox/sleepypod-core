/**
 * Upstream's component tests build their own fake tRPC client, which has no
 * fork section. Standing the fork's small cards aside here leaves those test
 * files untouched, so upstream's changes to them keep merging cleanly. The
 * fork's own tests cover its logic directly.
 */
import { vi } from 'vitest'

vi.mock('@/src/components/Fork/RotationCard', () => ({ RotationCard: () => null }))
vi.mock('@/src/components/Fork/BothRotation', () => ({ BothRotation: () => null }))
vi.mock('@/src/components/Fork/SwitchCard', () => ({ SwitchCard: () => null }))
vi.mock('@/src/components/Fork/WeeksSection', () => ({ WeeksSection: () => null }))
vi.mock('@/src/components/Fork/useRunCurve', () => ({ useRunCurve: () => null }))
vi.mock('@/src/components/Fork/usePhoneTabHidden', () => ({ usePhoneTabHidden: () => 'tonight' }))
vi.mock('@/src/components/Fork/HoldSetting', async () => {
  const { useState } = await import('react')
  const { createElement } = await import('react')
  return {
    useHoldSetting: () => useState(30),
    HoldRow: ({ holdMinutes, onDurationChange }: { holdMinutes: number, onDurationChange: (minutes: number) => void }) => createElement(
      'select',
      { 'aria-label': 'Temperature hold duration', 'value': holdMinutes, 'onChange': (e: { target: { value: string } }) => onDurationChange(Number(e.target.value)) },
      [15, 30, 60, 120].map(value => createElement('option', { key: value, value }, value)),
    ),
  }
})
