'use client'

import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Plus, RotateCcw, X } from 'lucide-react'
import { useMemo, useState, type DragEvent } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, GhostIcon, InlineError, SelectValue, Toggle } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import { useCurveTemplates, type SavedCurve } from '@/src/hooks/useCurveTemplates'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { trpc } from '@/src/utils/trpc'
import { useForkOverview, useForkRefresh } from './useFork'
import { WeekBars } from './WeekBars'
import { dayDate, makeThisWeek, mondayOf, moveStep, repeatText, weekDates, type WeekDays } from './weekLogic'

const CHANGE_TIMES = ['12:00', '14:00', '16:00', '18:00']

interface Preset { id: string, name: string, days: WeekDays }

function Choices({ label, presets, curves, onPick, onCancel }: {
  label: string
  presets: Preset[]
  curves: ReadonlyMap<number, SavedCurve>
  onPick: (id: string) => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-seg border border-line-2 p-2.5">
      <span className="text-[13px] text-fg-2">{label}</span>
      <div className="grid gap-1.5 @min-[520px]:grid-cols-3">
        {presets.map(preset => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onPick(preset.id)}
            className="flex cursor-pointer flex-col gap-1.5 rounded-ctl border border-line bg-app px-2.5 py-2 text-left text-sm text-fg"
          >
            {preset.name}
            <WeekBars days={preset.days} curves={curves} height={18} />
          </button>
        ))}
      </div>
      {presets.length === 0 && <span className="text-[13px] text-fg-2">Create a week first, under Weeks below.</span>}
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  )
}

/** A side's week presets in an order that repeats. It answers "what's on this week" first. */
export function RotationCard({ side, sideName }: { side: Side, sideName: string }) {
  const overview = useForkOverview()
  const refresh = useForkRefresh()
  const { formatTime } = useTimeFormatter()
  const weeks = trpc.fork.listWeeks.useQuery()
  const { templates } = useCurveTemplates()
  const curves = useMemo(() => new Map((templates ?? []).map(t => [t.id, t])), [templates])
  const save = trpc.fork.saveRotation.useMutation({ onSuccess: refresh })
  const swap = trpc.fork.swapWeek.useMutation({ onSuccess: refresh })
  const [draft, setDraft] = useState<string[] | null>(null)
  const [draftTime, setDraftTime] = useState<string | null>(null)
  const [inserting, setInserting] = useState<number | null>(null)
  const [swapping, setSwapping] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)

  const view = overview.data?.[side].rotation ?? null
  const presets = weeks.data ?? []
  const nameOf = (id: string) => presets.find(p => p.id === id)?.name ?? 'Missing'
  const presetOf = (id: string) => presets.find(p => p.id === id)

  if (!view) {
    return (
      <Card className="gap-2">
        <span className="sp-label">Rotation</span>
        <span className="text-[13px] text-fg-2">{`${sideName} has no rotation yet. Add your first week to start one.`}</span>
        <Button
          icon={Plus}
          disabled={presets.length === 0}
          onClick={() => {
            const first = presets[0]
            if (first) {
              save.mutate({ side, rotation: { steps: [first.id], anchorDate: mondayOf(new Date()), changeTime: '16:00', paused: true, swap: null } })
            }
          }}
        >
          Start a rotation
        </Button>
        {presets.length === 0 && <span className="text-[13px] text-fg-2">Create a week first, under Weeks below.</span>}
      </Card>
    )
  }

  const { rotation, week, thisPresetId } = view
  const n = rotation.steps.length
  const stepAt = ((week % n) + n) % n
  const shown = makeThisWeek(rotation.steps, stepAt)
  const editing = draft !== null
  const list = draft ?? shown
  const anchor = weekAnchor(rotation.anchorDate, week)
  const changeTime = draftTime ?? rotation.changeTime
  const swapped = rotation.swap?.week === week
  const nextName = nameOf(shown[1 % shown.length])

  const stopEditing = () => {
    setDraft(null)
    setDraftTime(null)
    setInserting(null)
  }

  const done = () => {
    if (!draft) return
    save.mutate(
      { side, rotation: { ...rotation, steps: draft, anchorDate: anchor, changeTime, swap: draft[0] === shown[0] && rotation.swap ? { ...rotation.swap, week: rotation.swap.week - week } : null } },
      { onSuccess: stopEditing },
    )
  }

  const dragProps = (index: number) => (index === 0 || !editing
    ? {}
    : {
        draggable: true,
        onDragStart: () => setDragging(index),
        onDragOver: (e: DragEvent) => e.preventDefault(),
        onDrop: () => {
          if (dragging !== null) setDraft(moveStep(list, dragging, index))
          setDragging(null)
        },
      })

  return (
    <Card className="@container gap-3">
      <div className="flex items-center gap-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="sp-label">Rotation</span>
          <span className="text-[15px] font-medium">{`${rotation.paused ? 'Paused on' : 'This week:'} ${nameOf(thisPresetId)}`}</span>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <span className="hidden font-mono text-xs text-fg-2 @min-[520px]:inline">
            {rotation.paused ? `${nameOf(thisPresetId)} stays on` : `Next: ${nextName} · Mon ${dayDate(anchor, 1)}, ${formatTime(changeTime)}`}
          </span>
          <Toggle
            size="md"
            on={!rotation.paused}
            label="Run this rotation"
            onChange={on => save.mutate({ side, rotation: { ...rotation, paused: !on } })}
          />
        </div>
      </div>

      <div className={cn('flex flex-col gap-2 @min-[520px]:flex-row @min-[520px]:overflow-x-auto', rotation.paused && !editing && 'opacity-50')}>
        {list.map((id, i) => {
          const current = i === 0
          const preset = presetOf(current && swapped ? thisPresetId : id)
          return (
            <div key={`${id}-${i}`} className="flex flex-col gap-2 @min-[520px]:flex-1 @min-[520px]:flex-row @min-[520px]:items-center @min-[520px]:gap-2">
              <div
                {...dragProps(i)}
                className={cn(
                  'flex min-w-[150px] flex-1 flex-col gap-1.5 rounded-seg border p-2.5',
                  current ? 'border-ok-line' : 'border-line',
                  editing && !current && 'min-[900px]:cursor-grab',
                )}
              >
                <div className="flex items-center gap-1.5">
                  {editing && !current && <GripVertical size={14} className="hidden shrink-0 text-fg-3 min-[900px]:block" aria-hidden />}
                  <span className="whitespace-nowrap text-sm font-medium">{preset?.name ?? 'Missing'}</span>
                  {current && <span className="ml-auto font-mono text-[10px] tracking-[0.06em] text-ok">THIS WEEK</span>}
                  {editing && !current && (
                    <GhostIcon
                      icon={X}
                      className="ml-auto"
                      label={`Remove ${preset?.name ?? 'week'}`}
                      onClick={() => {
                        setDraft(list.filter((_, j) => j !== i))
                        setInserting(null)
                      }}
                    />
                  )}
                </div>
                {preset && <WeekBars days={preset.days} curves={curves} todayIndex={current ? ((new Date().getDay() + 6) % 7) : -1} />}
                <span className="font-mono text-xs text-fg-2">{weekDates(anchor, i)}</span>
                {current && swapped && <span className="text-xs text-fg-2">{`Swapped for this week. ${nextName} follows as usual.`}</span>}
                {editing && !current && (
                  <div className="flex items-center gap-1.5">
                    <GhostIcon className="min-[900px]:hidden" icon={ArrowUp} label={`Move ${preset?.name ?? 'week'} up`} disabled={i <= 1} onClick={() => setDraft(moveStep(list, i, i - 1))} />
                    <GhostIcon className="min-[900px]:hidden" icon={ArrowDown} label={`Move ${preset?.name ?? 'week'} down`} disabled={i === list.length - 1} onClick={() => setDraft(moveStep(list, i, i + 1))} />
                    <Button full onClick={() => setDraft(makeThisWeek(list, i))}>Make this week</Button>
                  </div>
                )}
              </div>
              {editing && inserting !== i && (
                <Button
                  variant="dashed"
                  icon={Plus}
                  title={`Add a week after ${preset?.name ?? 'this one'}`}
                  aria-label={`Add a week after ${preset?.name ?? 'this one'}`}
                  onClick={() => setInserting(i)}
                  className="@min-[520px]:shrink-0"
                >
                  <span className="@min-[520px]:hidden">{`Add a week after ${preset?.name ?? 'this one'}`}</span>
                </Button>
              )}
              {!editing && i < list.length - 1 && <ChevronRight size={12} className="hidden shrink-0 text-fg-3 @min-[520px]:block" aria-hidden />}
            </div>
          )
        })}
      </div>

      {editing && inserting !== null && (
        <Choices
          label={`Add after ${nameOf(list[inserting])}:`}
          presets={presets}
          curves={curves}
          onCancel={() => setInserting(null)}
          onPick={(id) => {
            setDraft([...list.slice(0, inserting + 1), id, ...list.slice(inserting + 1)])
            setInserting(null)
          }}
        />
      )}

      <span className="flex items-center gap-2 font-mono text-xs text-fg-2">
        <RotateCcw size={12} aria-hidden />
        {`${repeatText(list.length)} · ${nameOf(list[0])} again ${dayDate(anchor, list.length)}`}
      </span>

      {editing
        ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[13px] text-fg-2">
              Changes Mondays at
              <SelectValue label="Change time" value={changeTime} options={CHANGE_TIMES.map(value => ({ value, label: formatTime(value) }))} onChange={setDraftTime} />
              <span className="ml-auto flex gap-2">
                <Button onClick={stopEditing}>Cancel</Button>
                <Button variant="primary" disabled={save.isPending} onClick={done}>Done</Button>
              </span>
            </div>
          )
        : (
            <div className="grid grid-cols-2 gap-2 border-t border-line pt-3 @min-[520px]:flex">
              <Button
                disabled={swap.isPending}
                onClick={() => (swapped ? swap.mutate({ side, presetId: null }) : setSwapping(!swapping))}
              >
                {swapped ? 'Undo swap' : 'Swap this week'}
              </Button>
              <Button
                onClick={() => {
                  setSwapping(false)
                  setDraft(shown)
                }}
              >
                Edit rotation
              </Button>
            </div>
          )}

      {swapping && !editing && (
        <Choices
          label="For this week only, use:"
          presets={presets.filter(p => p.id !== shown[0])}
          curves={curves}
          onCancel={() => setSwapping(false)}
          onPick={(id) => {
            swap.mutate({ side, presetId: id })
            setSwapping(false)
          }}
        />
      )}

      {!editing && !rotation.paused && <span className="text-xs text-fg-2">Moving a curve&apos;s days by hand lasts until the next change.</span>}

      {(save.error ?? swap.error) && <InlineError>{(save.error ?? swap.error)?.message}</InlineError>}
    </Card>
  )
}

/** The Monday this week's change belongs to, so the order reads from this week. */
function weekAnchor(anchorDate: string, week: number): string {
  const d = new Date(`${anchorDate}T12:00:00`)
  d.setDate(d.getDate() + week * 7)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
