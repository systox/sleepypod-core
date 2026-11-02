import type { Metadata } from 'next'
import { WeekEditor } from '@/src/components/Fork/WeekEditor'

export const metadata: Metadata = { title: 'Week' }

export default async function WeekPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <WeekEditor id={id} />
}
