// Presentation-only helpers: never write Firestore, change submissions or bypass AI report access checks.

function writtenAnswer(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function mockWritingDisplayStatus(submission) {
  if (
    submission?.result?.enabledSections?.writing === false ||
    submission?.enabledSections?.writing === false ||
    submission?.result?.writing?.enabled === false
  ) return 'not_included'

  const storedStatus = submission?.result?.writing?.status ||
    submission?.writingReview?.status ||
    submission?.review?.writingStatus ||
    'pending_review'

  // Preserve any existing teacher review, including historical records whose
  // original answer text is no longer present on the current submission.
  if (storedStatus === 'reviewed' || storedStatus === 'not_included') return storedStatus

  // A previously stored teacher band must not disappear merely because old
  // response text was migrated, archived or is absent from this snapshot.
  const teacherBand = submission?.result?.writing?.band ??
    submission?.result?.writingBand ??
    submission?.writingReview?.overall ??
    submission?.review?.writingOverall
  if (teacherBand !== null && teacherBand !== undefined && teacherBand !== '' &&
      Number.isFinite(Number(teacherBand)) && Number(teacherBand) >= 1 && Number(teacherBand) <= 9) {
    return storedStatus
  }

  const task1 = submission?.writingAnswers?.task1 || submission?.writing?.task1 ||
    submission?.task1Answer || ''
  const task2 = submission?.writingAnswers?.task2 || submission?.writing?.task2 ||
    submission?.task2Answer || ''
  if (writtenAnswer(task1) || writtenAnswer(task2)) return storedStatus

  // A legacy record may have counts but missing answer text. Do not falsely
  // claim the student submitted nothing; the answer cannot be verified.
  const t1Count = Number(submission?.result?.writing?.task1WordCount ||
    submission?.writing?.task1WordCount || submission?.task1WordCount || 0)
  const t2Count = Number(submission?.result?.writing?.task2WordCount ||
    submission?.writing?.task2WordCount || submission?.task2WordCount || 0)
  if (t1Count > 0 || t2Count > 0) return 'answer_unavailable'

  return 'not_submitted'
}

export function isCurrentSavedAttemptMismatch(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return (code === 'functions/failed-precondition' || code === 'failed-precondition') &&
    message.includes('The selected submission is not the current saved attempt.')
}
