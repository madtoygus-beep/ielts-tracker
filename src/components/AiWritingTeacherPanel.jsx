import { useCallback, useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { isCurrentSavedAttemptMismatch } from '../services/p7uiReviewPresentation'
import {
  aiWritingCriterionRows,
  formatAiBand,
  readableAiWritingError,
  safeAiWritingEnvelope
} from '../services/aiWritingStudentPolicy'

const getManagedAiWritingReportCall = httpsCallable(functions, 'getManagedAiWritingReport')

function TaskReport({ taskNumber, report }) {
  if (!report) return null
  const rows = aiWritingCriterionRows(report, taskNumber)
  return (
    <section className="rounded-xl border border-indigo-100 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="font-semibold text-slate-900">Task {taskNumber} AI feedback</h4>
        <span className="text-sm font-semibold text-indigo-700">
          {report.feedbackOnly ? 'Development feedback - no band' : `AI estimate ${formatAiBand(report.estimatedBand)}`}
        </span>
      </div>
      <p className="text-xs text-slate-500 mb-3">{report.wordCount} words</p>
      {report.overview && <p className="text-sm whitespace-pre-wrap leading-6 text-slate-700 mb-3">{report.overview}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map(row => (
          <div key={row.key} className="rounded-lg bg-slate-50 p-3">
            <div className="flex items-start justify-between gap-2 mb-1">
              <p className="text-sm font-semibold text-slate-800">{row.label}</p>
              {row.band !== null && <span className="text-sm font-bold text-indigo-700">{formatAiBand(row.band)}</span>}
            </div>
            <p className="text-sm whitespace-pre-wrap text-slate-700">{row.explanation}</p>
            {row.evidence && <p className="text-xs text-slate-500 mt-2">Evidence: {row.evidence}</p>}
          </div>
        ))}
      </div>
      {Array.isArray(report.strengths) && report.strengths.length > 0 && (
        <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-3">
          <p className="text-sm font-semibold text-emerald-900">Strengths</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-emerald-900 space-y-1">
            {report.strengths.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {Array.isArray(report.priorities) && report.priorities.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">Improvement priorities</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-amber-900 space-y-1">
            {report.priorities.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {Array.isArray(report.corrections) && report.corrections.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-semibold text-slate-900">Suggested corrections</p>
          {report.corrections.map((item, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="text-rose-700 whitespace-pre-wrap">Original: {item.original}</p>
              <p className="text-emerald-700 mt-1 whitespace-pre-wrap">Suggestion: {item.suggestion}</p>
              <p className="text-slate-600 mt-1 whitespace-pre-wrap">Why: {item.reason}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// Purely a reader: never invokes evaluateMyAiWriting or any credit operation.
// The callable checks staff, assignment, student, attempt and report fingerprint.
export default function AiWritingTeacherPanel({ studentId, contentId, context, attemptNumber, compact = false, teacherBand = null }) {
  const [envelope, setEnvelope] = useState({ status: 'not_started' })
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const requestSerial = useRef(0)
  const mounted = useRef(false)

  const refresh = useCallback(async () => {
    const serial = ++requestSerial.current
    setLoading(true)
    setErrorMessage('')
    try {
      const response = await getManagedAiWritingReportCall({
        studentId, contentId, context, attemptNumber
      })
      if (mounted.current && serial === requestSerial.current) {
        setEnvelope(safeAiWritingEnvelope(response.data, attemptNumber, context))
      }
    } catch (error) {
      if (mounted.current && serial === requestSerial.current) {
        if (isCurrentSavedAttemptMismatch(error)) {
          // The backend must continue to reject an unverified or old attempt.
          // Explain the unavailable AI report without presenting it as a failed
          // teacher review. No alternative lookup or paid evaluation is made.
          setEnvelope({ status: 'attempt_mismatch' })
          setErrorMessage('')
        } else {
          setEnvelope({ status: 'unavailable' })
          setErrorMessage(readableAiWritingError(error))
        }
      }
    } finally {
      if (mounted.current && serial === requestSerial.current) setLoading(false)
    }
  }, [studentId, contentId, context, attemptNumber])

  useEffect(() => {
    mounted.current = true
    refresh()
    return () => { mounted.current = false; requestSerial.current += 1 }
  }, [refresh])

  const report = envelope.status === 'completed' ? envelope.report : null

  // List preview is independent of optional teacher review. A saved AI report is
  // fetched with the same staff-authorized, read-only callable used by the modal.
  if (compact) {
    const hasTeacherBand = teacherBand !== null && teacherBand !== undefined && teacherBand !== ''
    const numericTeacherBand = hasTeacherBand ? Number(teacherBand) : null
    const formattedTeacherBand = Number.isFinite(numericTeacherBand)
      ? formatAiBand(numericTeacherBand) : '-'
    const aiBandLabel = loading ? 'Loading saved report...'
      : report ? (report.estimatedBand === null ? 'Development feedback only' : formatAiBand(report.estimatedBand))
        : envelope.status === 'processing' ? 'AI assessment processing'
          : envelope.status === 'too_short' ? 'Answer too short for AI feedback'
            : envelope.status === 'not_started' ? 'No saved AI report'
              : envelope.status === 'failed' ? 'AI assessment not completed'
              : envelope.status === 'attempt_mismatch' ? 'No verified AI report for this attempt'
                : 'AI report unavailable'

    return (
      <section className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3"
        aria-label="Teacher and AI Writing band comparison">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded-lg bg-white px-3 py-2.5 border border-slate-100">
            <p className="text-xs text-slate-500">Teacher Writing Band (optional)</p>
            <p className="text-lg font-bold text-slate-800">
              {hasTeacherBand && formattedTeacherBand !== '-' ? formattedTeacherBand : 'Not graded'}
            </p>
          </div>
          <div className="rounded-lg bg-white px-3 py-2.5 border border-indigo-100">
            <p className="text-xs text-indigo-600">AI estimated Writing Band (separate)</p>
            <p className="text-lg font-bold text-indigo-800">{aiBandLabel}</p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-600">
            AI feedback is independent of optional teacher grading.
            {envelope.institutionFunded ? ' Institution-funded.' : ''}
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={refresh} disabled={loading}
              className="text-xs font-semibold text-indigo-700 hover:underline disabled:opacity-50">
              {loading ? 'Loading...' : 'Refresh AI status'}
            </button>
            {report && (
              <button type="button" onClick={() => setShowDetails(current => !current)}
                aria-expanded={showDetails} className="text-xs font-semibold text-indigo-700 hover:underline">
                {showDetails ? 'Hide AI report' : 'View AI report'}
              </button>
            )}
          </div>
        </div>
        {errorMessage && <p role="alert" className="mt-2 text-xs text-rose-700">{errorMessage}</p>}
        {envelope.status === 'attempt_mismatch' && (
          <p className="mt-2 text-xs text-slate-600">
            This older or unmatched submission cannot be verified as the current saved attempt for an AI report. The teacher review remains unchanged.
          </p>
        )}
        {showDetails && report && (
          <div className="mt-3 space-y-3" aria-label="Saved AI Writing feedback details">
            <TaskReport taskNumber={1} report={report.task1} />
            <TaskReport taskNumber={2} report={report.task2} />
            <p className="text-xs text-slate-600">Read-only AI estimate; not an official IELTS score or a teacher grade.</p>
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5" aria-label="Read-only AI Writing report">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Saved AI Writing Report</h3>
          <p className="text-xs text-slate-600 mt-1">
            Read-only AI estimate. Not an official IELTS score and not the teacher's final Writing band.
          </p>
        </div>
        <button type="button" onClick={refresh} disabled={loading}
          className="text-sm text-indigo-700 font-semibold hover:underline disabled:opacity-50">
          {loading ? 'Loading...' : 'Refresh saved report'}
        </button>
      </div>
      {errorMessage && <p role="alert" className="text-sm text-rose-700 mb-3">{errorMessage}</p>}
      {report ? (
        <>
          <div className="rounded-xl bg-indigo-900 text-white p-4 mb-4">
            <p className="text-xs uppercase tracking-wide opacity-80">AI estimated Writing band (not teacher grade)</p>
            <p className="text-3xl font-bold mt-1">
              {report.estimatedBand === null ? 'Development feedback only' : formatAiBand(report.estimatedBand)}
            </p>
            {report.feedbackOnly && (
              <p className="text-xs mt-2 opacity-90">At least one task is below the minimum word count for a numeric band estimate.</p>
            )}
          </div>
          <div className="space-y-3">
            <TaskReport taskNumber={1} report={report.task1} />
            <TaskReport taskNumber={2} report={report.task2} />
          </div>
          <p className="text-xs text-slate-600 mt-3">
            {envelope.institutionFunded ? 'Institution-funded report.' : 'Student-credit report.'}
            {' '}Viewing this saved report consumes no credits and does not update any teacher review fields.
          </p>
        </>
      ) : !loading && !errorMessage ? (
        <p className="rounded-lg bg-white p-3 text-sm text-slate-700">
          {envelope.status === 'not_started'
            ? 'No saved AI assessment exists for this submission.'
            : envelope.status === 'too_short'
              ? 'The submitted answers are too short for AI feedback.'
              : envelope.status === 'processing'
                ? 'AI assessment is still processing; refresh to check its saved status.'
                : envelope.status === 'failed'
                  ? 'The AI assessment was not completed.'
                  : envelope.status === 'attempt_mismatch'
                    ? 'No verified AI report can be shown for this older or unmatched attempt. The teacher review is preserved.'
                    : 'The AI report is not available for this attempt.'}
        </p>
      ) : null}
    </section>
  )
}
