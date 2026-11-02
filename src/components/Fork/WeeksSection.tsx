'use client'

import { Pencil, Plus } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo } from 'react'
import { Button, SectionLabel } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { useCurveTemplates } from '@/src/hooks/useCurveTemplates'
import { trpc } from '@/src/utils/trpc'
import { WeekBars } from './WeekBars'
import { weekSummary } from './weekLogic'

/** The saved week presets. A card opens its editor. */
export function WeeksSection() {
  const lang = langFromPath(usePathname())
  const weeks = trpc.fork.listWeeks.useQuery()
  const { templates } = useCurveTemplates()
  const curves = useMemo(() => new Map((templates ?? []).map(t => [t.id, t])), [templates])
  const base = `/${lang}/schedule/weeks`

  return (
    <>
      <SectionLabel
        className="mt-1"
        right={(
          <Link href={`${base}/new`} className="text-fg no-underline hover:no-underline">
            <Button variant="ghost" icon={Plus} tabIndex={-1}>Create week</Button>
          </Link>
        )}
      >
        Weeks
      </SectionLabel>
      <div className="grid gap-3.5 min-[900px]:grid-cols-3 min-[900px]:gap-3">
        {(weeks.data ?? []).map(week => (
          <Link
            key={week.id}
            href={`${base}/${week.id}`}
            className="flex flex-col gap-2 rounded-card border border-line px-4 py-3 text-fg no-underline hover:no-underline"
          >
            <span className="flex items-center gap-2 text-[15px] font-medium min-[900px]:text-sm">
              {week.name}
              <Pencil size={15} className="ml-auto text-icon" aria-hidden />
            </span>
            <WeekBars days={week.days} curves={curves} height={48} labels />
            <span className="font-mono text-xs leading-[1.4] text-fg-2">{weekSummary(week.days, curves)}</span>
          </Link>
        ))}
      </div>
    </>
  )
}
