import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TonightPage } from '@/src/components/Fork/TonightPage'

export const metadata: Metadata = { title: 'Tonight' }

export default function Tonight() {
  return (
    <Suspense>
      <TonightPage />
    </Suspense>
  )
}
