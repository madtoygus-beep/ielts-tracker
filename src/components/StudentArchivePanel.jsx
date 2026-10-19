import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'

const getArchive = httpsCallable(functions, 'getMyUnassignedArchive')

function resultLabel(item) {
  const result = item?.result || {}
  const band = result.finalOverall ?? result.reviewedOverall ?? result.overall ??
    result.band ?? result.estimatedBand ?? null
  if (typeof band === 'number' && Number.isFinite(band)) return `Band ${band.toFixed(1)}`
  if (typeof result.correct === 'number' && typeof result.total === 'number') {
    return `${result.correct}/${result.total} correct`
  }
  if (item?.reviewed && typeof item?.review?.overall === 'number') {
    return `Teacher Band ${item.review.overall.toFixed(1)}`
  }
  return 'Submitted — result retained'
}

export default function StudentArchivePanel({ studentId, category }) {
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState({ loading: true, items: [], error: '' })
  useEffect(() => {
    let active = true
    setState({ loading: true, items: [], error: '' })
    if (!studentId || !category) {
      setState({ loading: false, items: [], error: '' })
      return () => { active = false }
    }
    getArchive({ contentType: category }).then(response => {
      if (!active) return
      if (response.data?.ok !== true || !Array.isArray(response.data?.items)) {
        throw new Error('The archive was not verified.')
      }
      setState({ loading: false, items: response.data.items, error: '' })
    }).catch(() => {
      if (active) setState({ loading: false, items: [], error: 'Could not load archived results. Try again.' })
    })
    return () => { active = false }
  }, [studentId, category, refresh])

  return (
    <section aria-label="Removed assignments read-only history" className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <h2 className="text-base font-semibold text-slate-900">Removed Assignments — Read-only History</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Completed results remain available here when a teacher removes the assignment.
          This view cannot restart the test, submit new answers or reveal answer keys.
          Content archived or hidden by your school stays unavailable.
        </p>
        <button type="button" onClick={() => setRefresh(n => n + 1)}
          className="mt-3 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-slate-50">
          Refresh archived results
        </button>
      </div>
      {state.loading && <p className="text-sm text-slate-600">Loading saved results…</p>}
      {state.error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{state.error}</p>}
      {!state.loading && !state.error && !state.items.length && (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
          No completed removed assignments in this category.
        </p>
      )}
      {!state.loading && state.items.map((item, i) => (
        <article key={`${item.contentId}:${item.attemptNumber}:${i}`}
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="break-words font-semibold text-slate-900">{item.title}</h3>
              <p className="mt-1 text-xs text-slate-500">
                Attempt {item.attemptNumber} · Read-only retained result
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">{resultLabel(item)}</span>
          </div>
          {Object.prototype.hasOwnProperty.call(item, 'aiEstimatedBand') && (
            <p className="mt-2 text-xs font-semibold text-indigo-700">
              {item.aiEstimatedBand === null
                ? 'Saved AI development feedback (no numerical band)'
                : `Saved AI Estimated Band ${Number(item.aiEstimatedBand).toFixed(1)}`}
            </p>
          )}
          {item?.review?.generalFeedback && (
            <p className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">
              Teacher feedback: {item.review.generalFeedback}
            </p>
          )}
          {item.excludedFromStats && (
            <p className="mt-2 text-xs text-amber-800">Retained, excluded from statistics</p>
          )}
        </article>
      ))}
    </section>
  )
}
