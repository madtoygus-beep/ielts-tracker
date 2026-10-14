// P5B-2: UI policy only. Cloud Functions remain the authority for student
// ownership, institution membership, credit accounting and report access.
export const MAXIMA_PILOT_SCHOOL_ID = 'maxima'

const AI_REPORT_STATUSES = new Set(['not_started', 'processing', 'completed', 'failed'])
const CRITERIA = Object.freeze([
  ['taskAchievementOrResponse', 'Task Achievement / Task Response'],
  ['coherenceAndCohesion', 'Coherence and Cohesion'],
  ['lexicalResource', 'Lexical Resource'],
  ['grammaticalRangeAndAccuracy', 'Grammatical Range and Accuracy']
])

export function isInstitutionWritingStudent(profile) {
  return Boolean(profile && profile.role === 'student' &&
    profile.status === 'approved' && profile.deleted !== true &&
    profile.archived !== true && profile.schoolId === MAXIMA_PILOT_SCHOOL_ID &&
    (profile.accountType === 'institution' || profile.accountType == null))
}

export function safeAiWritingAccess(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.schoolId !== MAXIMA_PILOT_SCHOOL_ID || value.accountType !== 'institution') return null
  const balance = Number.isSafeInteger(value.creditsRemaining) &&
    value.creditsRemaining >= 0 && value.creditsRemaining <= 1000
    ? value.creditsRemaining : 0
  const pilotEnabled = value.pilotEnabled === true
  const studentEnabled = value.studentEnabled === true
  return {
    pilotEnabled,
    studentEnabled,
    creditsRemaining: balance,
    canEvaluate: value.canEvaluate === true && pilotEnabled && studentEnabled && balance > 0
  }
}

export function safeAiWritingEnvelope(value, currentAttemptNumber) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !AI_REPORT_STATUSES.has(value.status)) {
    return { status: 'unavailable' }
  }
  if (value.status !== 'completed') {
    return { status: value.status, canRetry: value.canRetry === true }
  }
  const attempt = Number(value.attemptNumber)
  if (!Number.isSafeInteger(currentAttemptNumber) || currentAttemptNumber < 1 ||
      !Number.isSafeInteger(attempt) || attempt !== currentAttemptNumber) {
    return { status: 'stale_attempt' }
  }
  const report = value.report
  if (!report || typeof report !== 'object' || report.isAiEstimate !== true ||
      typeof report.estimatedBand !== 'number' || !Number.isFinite(report.estimatedBand) ||
      report.estimatedBand < 0 || report.estimatedBand > 9 ||
      report.context !== 'homework' ||
      (!report.task1 && !report.task2)) {
    return { status: 'unavailable' }
  }
  return { status: 'completed', report, attemptNumber: attempt, reused: value.reused === true }
}

export function shouldShowAiWritingPanel(access, envelope) {
  return Boolean(envelope?.status === 'completed' ||
    (access?.pilotEnabled === true && access?.studentEnabled === true))
}

export function canRequestAiWriting(access, envelope, busy) {
  return Boolean(!busy && access?.canEvaluate === true &&
    ['not_started', 'failed'].includes(envelope?.status))
}

export function aiWritingCriterionRows(taskReport, taskNumber) {
  if (!taskReport || typeof taskReport !== 'object' ||
      !taskReport.criteria || typeof taskReport.criteria !== 'object') return []
  return CRITERIA.map(([key, label]) => ({
    key,
    label: key === 'taskAchievementOrResponse'
      ? (taskNumber === 1 ? 'Task Achievement' : 'Task Response') : label,
    band: typeof taskReport.criteria[key]?.band === 'number' ? taskReport.criteria[key].band : null,
    explanation: String(taskReport.criteria[key]?.explanation || ''),
    evidence: String(taskReport.criteria[key]?.evidence || '')
  }))
}

export function formatAiBand(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9
    ? value.toFixed(1) : '-'
}

export function readableAiWritingError(error) {
  const code = String(error?.code || '').replace(/^functions\//, '')
  if (code === 'not-found' || code === 'unimplemented') {
    return 'The AI report service is not available yet. No assessment was started.'
  }
  if (code === 'unauthenticated') return 'Please sign in again to use AI Writing.'
  if (code === 'permission-denied') return 'AI Writing is not enabled for this account or assignment.'
  if (code === 'failed-precondition') return String(error?.message || 'AI Writing is not ready yet.')
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return 'The AI assessment service is temporarily unavailable. Check the report before retrying.'
  }
  return 'AI Writing could not be reached. Please try refreshing the report status.'
}
