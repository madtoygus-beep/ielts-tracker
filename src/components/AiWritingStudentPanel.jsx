import { useCallback, useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import {
  aiWritingCriterionRows,
  canRequestAiWriting,
  formatAiBand,
  isPersonalCreditAiSelection,
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
        <span className="font-semibold text-indigo-700">{report.feedbackOnly ? 'Development feedback - no band' : `Estimated Band ${formatAiBand(report.estimatedBand)}`}</span>
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
              {row.band !== null && <span className="text-sm font-bold text-indigo-700">{formatAiBand(row.band)}</span>}
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

// Read-only rendering for the server-authorized EXACT historical attempt.
// The calling history service matches the original submission fingerprint and
// job identity; this component performs NO callable, retry or credit action.
export function AiWritingSavedReport({ aiResult }) {
  const report = aiResult?.status === 'completed' ? aiResult.report : null
  if (!report || report.isAiEstimate !== true || report.context !== 'homework') return null
  return (
    <section className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4 sm:p-5 text-left"
      aria-label="Saved AI Writing feedback">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900">AI Writing Feedback</h3>
          <p className="mt-1 text-xs text-gray-600">Saved estimate for this attempt, not an official IELTS score or a teacher grade.</p>
        </div>
        {aiResult.institutionFunded === true && (
          <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-700">Institution funded</span>
        )}
      </div>
      <div className="mb-4 rounded-xl bg-indigo-900 p-4 text-white">
        <p className="text-xs uppercase tracking-wider text-indigo-200">
          {report.estimatedBand === null ? 'Development feedback only' : 'Estimated IELTS Writing Band'}
        </p>
        <p className="mt-1 text-3xl font-bold">
          {report.estimatedBand === null ? 'No band estimate' : formatAiBand(report.estimatedBand)}
        </p>
      </div>
      {report.feedbackOnly && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          A numeric band was withheld because the submitted answer was too short for a full estimate.
        </p>
      )}
      <div className="space-y-4">
        <TaskAiReport taskNumber={1} report={report.task1} />
        <TaskAiReport taskNumber={2} report={report.task2} />
      </div>
      <p className="mt-4 text-xs text-gray-600">This is your previously saved AI report. Viewing it does not use AI credits. Any teacher score is separate.</p>
    </section>
  )
}

// Mounted only for an approved Maxima institution student's submitted Writing
// or Mock attempt. Backend callables own identity, submission, access and billing.
export default function AiWritingStudentPanel({ contentId, attemptNumber, context = 'homework', wordCounts = {}, teacherBand = null, submittedChoice = 'teacher', submittedBillingMode = 'none' }) {
  const [access, setAccess] = useState(null)
  const [envelope, setEnvelope] = useState({ status: 'not_started' })
  const [loading, setLoading] = useState(true)
  const [requesting, setRequesting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const requestSerial = useRef(0)
  const requestingRef = useRef(false)
  const mounted = useRef(false)
  const personalCreditSelected = isPersonalCreditAiSelection(context, submittedChoice, submittedBillingMode)

  const getPayload = useCallback(() => context === 'mock'
    ? ({ context: 'mock', contentId })
    : ({ context: 'homework', contentId }), [context, contentId])
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const serial = ++requestSerial.current
    if (!quiet) setLoading(true)
    // The report read can reconcile/refund an expired credit hold. Read the
    // access balance AFTER the report so an eligible retry is not blocked by
    // a stale, pre-refund credit count. Keep failures independent.
    const [reportResult] = await Promise.allSettled([
      getMyAiWritingReportCall(getPayload())
    ])
    const [accessResult] = await Promise.allSettled([
      getMyAiWritingAccessCall({})
    ])
    if (!mounted.current || serial !== requestSerial.current) return
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
        !(envelope.institutionFunded === true && envelope.status === 'not_started') &&
        !(submittedChoice === 'ai' && envelope.status === 'not_started')) return undefined
    const timer = setInterval(() => {
      if (!requesting) refresh({ quiet: true })
    }, 8000)
    return () => clearInterval(timer)
  }, [envelope.status, envelope.institutionFunded, requesting, refresh, submittedChoice])

  const startEvaluation = async () => {
    if (requestingRef.current || !personalCreditSelected ||
        !canRequestAiWriting(access, envelope, requesting || loading)) return
    const confirmed = window.confirm(
      'Check this submitted Writing attempt with AI? One personal AI credit is used only if a new result is saved. A completed report is reused without extra credit. Task 1 needs 50+ words and Task 2 needs 100+ words for feedback; bands require 150/250 words.'
    )
    if (!confirmed) return
    // An immediate ref lock prevents a second click before React re-renders.
    requestingRef.current = true
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
      requestingRef.current = false
      if (mounted.current) setRequesting(false)
    }
  }

  if (loading && !access && envelope.status !== 'completed') return null
  if (!shouldShowAiWritingPanel(access, envelope) && submittedChoice !== 'ai') return null
  // A teacher-submitted Writing with no saved AI result is not an invitation
  // to buy a later AI check; the decision belongs in the original submit UI.
  if (!personalCreditSelected && submittedChoice !== 'ai' &&
      envelope.status !== 'completed' && envelope.institutionFunded !== true) return null
  // Mock evaluation is sponsored/read-only. Never offer manual credit spending.
  if (context === 'mock' && !envelope.institutionFunded && envelope.status !== 'completed') return null
  const canEvaluate = personalCreditSelected &&
    canRequestAiWriting(access, envelope, requesting || loading)
  const report = envelope.status === 'completed' ? envelope.report : null
  const validTeacherBand = context === 'mock' && typeof teacherBand === 'number' &&
    Number.isFinite(teacherBand) && teacherBand >= 1 && teacherBand <= 9
    ? teacherBand : null
  const shortTasks = [
    { label: 'Task 1', actual: wordCounts.task1, minimum: 50, active: wordCounts.task1Enabled },
    { label: 'Task 2', actual: wordCounts.task2, minimum: 100, active: wordCounts.task2Enabled }
  ].filter(t => t.active && Number.isInteger(t.actual) && t.actual < t.minimum)

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
              <p className="text-xs uppercase tracking-widest opacity-75">{report.estimatedBand === null ? 'Writing development report - band withheld' : 'Estimated IELTS Writing Band'}</p>
              <p className="text-4xl font-bold mt-1">{report.estimatedBand === null ? 'Development feedback only' : formatAiBand(report.estimatedBand)}</p>
            </div>
            {context === 'mock' ? (
              <div className="sm:text-right text-left sm:ml-auto sm:border-l sm:border-white/25 sm:pl-4">
                {validTeacherBand !== null ? (
                  <>
                    <p className="text-xs text-indigo-200">Teacher score</p>
                    <p className="text-sm font-semibold mt-1">Band {formatAiBand(validTeacherBand)}</p>
                    <p className="text-xs text-indigo-200 mt-1">Priority for Mock Overall</p>
                  </>
                ) : (
                  <p className="text-xs text-indigo-100 max-w-xs leading-5">
                    Teacher grading is optional. A valid numeric AI estimate contributes to Mock Overall until a teacher band is provided.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm max-w-sm opacity-90">Task 2 counts twice as much as Task 1 when both tasks are present. This report does not replace a teacher's assessment.</p>
            )}
          </div>
          {report.feedbackOnly && (
            <p role="status" className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
              At least one Writing task is too short for a full IELTS band estimate.
              Eligible tasks may still receive development feedback. Your teacher can review the full submission.
            </p>
          )}
          <div className="space-y-4">
            <TaskAiReport taskNumber={1} report={report.task1} />
            <TaskAiReport taskNumber={2} report={report.task2} />
            {shortTasks.map(task => <p key={task.label} role="status" className="text-sm text-amber-900 bg-amber-50 p-3 rounded-lg">
              {task.label}: {task.actual} words (minimum {task.minimum} for AI feedback). This task was not sent for AI evaluation.
            </p>)}
          </div>
          <p className="text-xs text-gray-600 mt-4">{context === 'mock'
            ? 'Your institution funded this AI report. A teacher band, when available, takes priority for Mock Overall. Teacher feedback, if available, appears below.'
            : envelope.institutionFunded
              ? 'Your institution has funded this AI assessment. No personal AI credits were used. Your teacher’s assessment stays separate.'
              : 'Opening this saved report again does not use another AI credit. Teacher feedback is available separately.'}</p>
        </>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          {envelope.status === 'too_short' ? (
            <p role="status" className="text-sm text-amber-900">
              Your Writing answer is below the AI feedback minimum (Task 1: 50 words; Task 2: 100 words).
              No AI model was called, and no student credit or institution quota was used.
              Your exam submission remains complete and your teacher can review it.
            </p>
          ) : envelope.institutionFunded ? (
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
                    ? 'AI feedback needs at least 50 words in Task 1 or 100 in Task 2. A band estimate requires 150 / 250 words respectively. Very short answers cannot use an AI credit.'
                    : 'You have no AI credits left. Contact your school administrator if you need additional evaluations.'}
              </p>
              {personalCreditSelected && envelope.canRetry === true && access?.canEvaluate === true ? (
                <button type="button" disabled={!canEvaluate} aria-busy={requesting} onClick={startEvaluation}
                  className="rounded-lg bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">
                  {requesting ? 'Evaluating...' : envelope.status === 'failed'
                    ? 'Retry AI check for this attempt (1 credit if saved)'
                    : 'Start AI check for this attempt (1 credit if saved)'}
                </button>
              ) : personalCreditSelected ? (
                <p role="status" className="text-sm text-indigo-800">
                  {envelope.canRetry === true && access?.canEvaluate !== true
                    ? 'AI retry is not available while your school pilot, account access, or personal credit balance is disabled.'
                    : 'Refresh the AI report status. If your selected AI check failed and no retry becomes available, contact your school.'}
                </p>
              ) : submittedChoice === 'ai' ? (
                <p role="status" className="text-sm text-indigo-800">AI was selected at submission. Only an original personal-credit choice can be retried here. Institution-funded checks are managed by your school.</p>
              ) : null}
            </>
          ) : null}
        </div>
      )}
      {errorMessage && <p role="alert" className="text-sm text-amber-800 mt-3">{errorMessage}</p>}
      <div className="flex justify-end mt-3">
        <button type="button" disabled={loading || requesting} aria-busy={loading} onClick={() => refresh()}
          className="text-sm font-medium text-indigo-700 disabled:cursor-not-allowed disabled:text-gray-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
          {loading ? 'Refreshing AI status…' : 'Refresh AI status'}
        </button>
      </div>
    </section>
  )
}
