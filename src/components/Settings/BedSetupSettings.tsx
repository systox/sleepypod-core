'use client'

import { Card, CardHeader, InlineError, SelectValue, SettingRow } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import type { BedConfiguration } from '@/src/lib/singleSleeper'

export function BedSetupSettings({ device, names }: {
  device: BedConfiguration
  names: { left: string, right: string }
}) {
  const utils = trpc.useUtils()
  const mutation = trpc.settings.updateDevice.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })
  return (
    <Card>
      <CardHeader title="Bed setup" subtitle="Choose who normally sleeps here. Away, and what an empty side does, are at the bottom of the Schedule page." />
      <SettingRow label="Sleepers" className="flex-col items-stretch min-[600px]:flex-row min-[600px]:items-center">
        <SelectValue
          className="min-w-0 max-w-full [&>select]:max-w-full"
          label="Bed setup"
          value={device.bedMode ?? 'two'}
          options={[
            { value: 'two', label: 'Two sleepers' },
            { value: 'solo-left', label: `Solo · ${names.left} (left)` },
            { value: 'solo-right', label: `Solo · ${names.right} (right)` },
          ]}
          onChange={bedMode => mutation.mutate({ bedMode })}
          disabled={mutation.isPending}
        />
      </SettingRow>
      <p className="text-xs text-fg-2">One active sleeper gets one sleep record using sensors across the bed. Manual temperature and power controls remain available for both zones.</p>
      {mutation.error && <InlineError>{mutation.error.message}</InlineError>}
    </Card>
  )
}
