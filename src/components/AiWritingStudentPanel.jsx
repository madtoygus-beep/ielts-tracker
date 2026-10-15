import { useCallback, useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import {
  aiWritingCriterionRows,
  canRequestAiWriting,
  formatAiBand,
  readableAiWritingError,
  safeAiWritingAccess,
  safeAiWritingEnvelope,
  shouldShowAiWritingPanel
} from '../services/aiWritingStudentPolicy'

const getMyAiWritingAccessCall = httpsCallable(functions, 'getMyAiWritingAccess')
const getMyAiWritingReportCall = httpsCallable(functions, 'getMyAiWritingReport')
const evaluateMyAiWritingCall = httpsCallable(functions, 'evaluateMyAiWriting', { timeout: 180000 })

function TaskAiReport({ taskNumber, report }) {
  if (!report) return null
  const rows = aiWritingCriterionRows(report, taskNumber)
  const wordMinimum = taskNumber === 1 ? 150 : 250
  return (
    <section className="border border-indigo-100 rounded-xl p-4 text-left bg-white">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h4 className="text-base font-semibold text-gray-900">Writing Task {taskNumber}</h4>
        <span className="font-semibold text-indigo-700">Estimated Band {formatAiBand(report.estimatedBand)}</span>
      </div>
      <div className="text-xs text-gray-500 mb-3">
        {Number.isInteger(report.wordCount) ? `${report.wordCount} words` : ''}
        {report.belowRecommendedLength === true && ` - Under the recommended ${wordMinimum} words`}
      </div>
      {typeof report.overview === 'string' && report.overview && (
        <p className="text-sm text-gray-700 leading-6 mb-4 whitespace-pre-wrap">{report.overview}</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {rows.map(row => (
          <article key={row.key} className="rounded-lg bg-gray-50 border border-gray-100 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h5 className="text-xs font-semibold text-gray-800">{row.label}</h5>
              <span className="text-sm font-bold text-indigo-700">{formatAiBand(row.band)}</span>
            </div>
            <p className="text-sm text-gray-700 leading-5 whitespace-pre-wrap">{row.explanation}</p>
            {row.evidence && <p className="mt-2 text-xs text-gray-500">Evidence: "{row.evidence}"</p>}
          </article>
        ))}
      </div>
      {Array.isArray(report.strengths) && report.strengths.length > 0 && (
        <section className="mt-4 bg-emerald-50 border border-emerald-100 rounded-lg p-3">
          <h5 className="text-sm font-semibold text-emerald-900 mb-2">What you did well</h5>
          <ul className="text-sm text-emerald-900 list-disc pl-5 space-y-1">
            {report.strengths.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
          </ul>
        </section>
      )}
      {Array.isArray(report.priorities) && report.priorities.length > 0 && (
        <section className="mt-3 bg-amber-50 border border-amber-100 rounded-lg p-3">
          <h5 className="text-sm font-semibold text-amber-900 mb-2">How to improve</h5>
          <ul className="text-sm text-amber-900 list-disc pl-5 space-y-1">
            {report.priorities.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
          </ul>
        </section>
      )}
      {Array.isArray(report.corrections) && report.corrections.length > 0 && (
        <section className="mt-4">
          <h5 className="text-sm font-semibold text-gray-900 mb-2">Suggested corrections</h5>
          <div className="space-y-2">
            {report.corrections.map((item, index) => (
              <article key={index} className="p-3 border border-gray-200 rounded-lg text-sm text-left">
                <p className="text-rose-700 whitespace-pre-wrap">Original: {item.original}</p>
                <p className="text-emerald-700 whitespace-pre-wrap mt-1">Suggestion: {item.suggestion}</p>
                <p className="text-gray-600 whitespace-pre-wrap mt-1">Why: {item.reason}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  )
}

// Mounted only for an approved Maxima institution student's submitted Writing
// or Mock attempt. Backend callables own identity, submission, access and billing.
export default function AiWritingStudentPanel({ contentId, attemptNumber, context = 'homework' }) {
  const [access, setAccess] = useState(null)
  const [envelope, setEnvelope] = useState({ status: 'not_started' })
  const [loading, setLoading] = useState(true)
  const [requesting, setRequesting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const requestSerial = useRef(0)
  const mounted = useRef(false)

  const getPayload = useCallback(() => context === 'mock'
    ? ({ context: 'mock', contentId })
    : ({ context: 'homework', contentId }), [context, contentId])
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const serial = ++requestSerial.current
    if (!quiet) setLoading(true)
    const results = await Promise.allSettled([
      getMyAiWritingAccessCall({}),
      getMyAiWritingReportCall(getPayload())
    ])
    if (!mounted.current || serial !== requestSerial.current) return
    const [accessResult, reportResult] = results
    if (accessResult.status === 'fulfilled') {
      setAccess(safeAiWritingAccess(accessResult.value?.data))
    } else {
      setAccess(null)
    }
    if (reportResult.status === 'fulfilled') {
      setEnvelope(safeAiWritingEnvelope(reportResult.value?.data, attemptNumber, context))
      setErrorMessage('')
    } else {
      // Do not discard a completed report if a temporary refresh failed.
      setEnvelope(previous => previous.status === 'completed' ? previous : { status: 'unavailable' })
      setErrorMessage(readableAiWritingError(reportResult.reason))
    }
    if (!quiet) setLoading(false)
  }, [getPayload, attemptNumber, context])

  useEffect(() => {
    mounted.current = true
    refresh()
    return () => { mounted.current = false; requestSerial.current += 1 }
  }, [refresh])

  useEffect(() => {
    if (envelope.status !== 'processing' &&
        !(envelope.institutionFunded === true && envelope.status === 'not_started')) return undefined
    const timer = setInterval(() => {
      if (!requesting) refresh({ quiet: true })
    }, 8000)
    return () => clearInterval(timer)
  }, [envelope.status, envelope.institutionFunded, requesting, refresh])

  const startEvaluation = async () => {
    if (context !== 'homework' ||
        !canRequestAiWriting(access, envelope, requesting || loading)) return
    const confirmed = window.confirm(
      'Evaluate this submitted Writing attempt with AI? This uses 1 AI credit only if a result is successfully saved.'
    )
    if (!confirmed) return
    setRequesting(true)
    setErrorMessage('')
    try {
      const response = await evaluateMyAiWritingCall(getPayload())
      const next = safeAiWritingEnvelope(response?.data, attemptNumber, context)
      if (!mounted.current) return
      setEnvelope(next)
      if (next.status === 'unavailable' || next.status === 'stale_attempt') {
        setErrorMessage('The AI response could not be matched to this attempt. Please reload the report.')
      }
      // Refresh the authoritative remaining balance and stored result.
      await refresh({ quiet: true })
    } catch (error) {
      if (!mounted.current) return
      const message = readableAiWritingError(error)
      // A lost response might still represent a saved evaluation: check before retry.
      await refresh({ quiet: true })
      if (mounted.current) setErrorMessage(message)
    } finally {
      if (mounted.current) setRequesting(false)
    }
  }

  if (loading && !access && envelope.status !== 'completed') return null
  if (!shouldShowAiWritingPanel(access, envelope)) return null
  // Mock evaluation is sponsored/read-only. Never offer manual credit spending.
  if (context === 'mock' && !envelope.institutionFunded && envelope.status !== 'completed') return null
  const canEvaluate = context === 'homework' &&
    canRequestAiWriting(access, envelope, requesting || loading)
  const report = envelope.status === 'completed' ? envelope.report : null

  return (
    <section className="mt-7 border border-indigo-200 rounded-2xl p-5 md:p-6 bg-indigo-50/50 text-left" aria-label="AI Writing feedback">
      <div className="flex flex-wrap gap-3 justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900">AI Writing Feedback</h3>
          <p className="text-xs text-gray-600 mt-1">AI estimates for IELTS preparation - not official IELTS scores.</p>
        </div>
        <div className="rounded-full px-3 py-1 text-xs bg-white border border-indigo-100 text-indigo-700 font-semibold">
          {envelope.institutionFunded ? 'Included by your institution' :
            access ? `${access.creditsRemaining} AI ${access.creditsRemaining === 1 ? 'credit' : 'credits'} remaining` : 'AI report'}
        </div>
      </div>

      {report ? (
        <>
          <div className="rounded-xl bg-indigo-900 text-white p-5 mb-4 flex flex-wrap justify-between gap-3 items-center">
            <div>
              <p className="text-xs uppercase tracking-widest opacity-75">Estimated IELTS Writing Band</p>
              <p className="text-4xl font-bold mt-1">{formatAiBand(report.estimatedBand)}</p>
            </div>
            <p className="text-sm max-w-sm opacity-90">Task 2 counts twice as much as Task 1 when both tasks are present. This report does not replace a teacher's assessment. Official Mock scores remain separate.</p>
          </div>
          <div className="space-y-4">
            <TaskAiReport taskNumber={1} report={report.task1} />
            <TaskAiReport taskNumber={2} report={report.task2} />
          </div>
          <p className="text-xs text-gray-600 mt-4">{envelope.institutionFunded
            ? 'Your institution has funded this AI assessment. No personal AI credits were used. Your teacher’s assessment stays separate.'
            : 'Opening this saved report again does not use another AI credit. Your existing teacher feedback is shown separately above.'}</p>
        </>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          {envelope.institutionFunded ? (
            <p role="status" className="text-sm text-indigo-900">
              {envelope.status === 'failed'
                ? 'The institution-funded assessment could not be completed. Your teacher can review this; no student credit was deducted.'
                : envelope.status === 'processing'
                  ? 'Your institution-funded AI assessment is being prepared. Your personal credits will not be used.'
                  : 'Your teacher selected this submitted attempt for institution-funded AI assessment. If enabled, the result will appear here automatically.'}
            </p>
          ) : envelope.status === 'processing' ? (
            <p role="status" className="text-sm text-indigo-900">Your AI evaluation is being prepared. The report will appear here when ready.</p>
          ) : context === 'homework' ? (
            <>
              <p className="text-sm text-gray-700 mb-3">
                {envelope.status === 'unavailable' || envelope.status === 'stale_attempt'
                  ? 'The AI report service cannot confirm this attempt right now. Refresh the report before requesting another evaluation.'
                  : access?.creditsRemaining > 0
                    ? 'Your submitted Writing can be evaluated using one AI credit. The report will include estimated band scores, four IELTS criteria and detailed corrections.'
                    : 'You have no AI credits left. Contact your school administrator if you need additional evaluations.'}
              </p>
              <button type="button" disabled={!canEvaluate} onClick={startEvaluation}
                className="bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-indigo-800">
                {requesting ? 'Evaluating...' : 'Evaluate with AI (1 credit)'}
              </button>
            </>
          ) : null}
        </div>
      )}
      {errorMessage && <p role="alert" className="text-sm text-amber-800 mt-3">{errorMessage}</p>}
      <div className="flex justify-end mt-3">
        <button type="button" disabled={loading || requesting} onClick={() => refresh()}
          className="text-sm font-medium text-indigo-700 disabled:text-gray-400 hover:underline">
          Refresh AI status
        </button>
      </div>
    </section>
  )
}
