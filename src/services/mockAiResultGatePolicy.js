// Mock result disclosure: AI completion and the Mock score sync are separate
// server events. Never display an objective-only Overall as a final IELTS Mock
// result while a funded Writing assessment is expected.
export const MOCK_AI_POLL_MS = 4000
export const MOCK_AI_WAIT_LIMIT_MS = 90000

export function mockBand(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 && number <= 9 ? number : null
}

export function savedMockWritingScoreReady(result, submission = null) {
  if (!result || typeof result !== 'object') return false
  if ((mockBand(result.finalOverall) ?? mockBand(result.overall) ??
    mockBand(result.overallEstimate)) === null) return false
  const writing = result.writing || {}
  const effective = mockBand(writing.effectiveBand)
  if (writing.effectiveBandSource === 'ai') {
    if (effective === null || effective !== mockBand(writing.aiEstimatedBand)) return false

    // Match the saved server-side Mock Overall calculation before release.
    const sections = submission?.enabledSections || result.enabledSections || {}
    const included = section =>
      sections[section] !== false && result[section]?.enabled !== false

    if (!included('writing')) return false

    const bands = [
      included('listening') ? mockBand(result.listening?.band) : null,
      included('reading') ? mockBand(result.reading?.band) : null,
      effective
    ].filter(band => band !== null)

    const expectedOverall = Math.round(
      (bands.reduce((sum, band) => sum + band, 0) / bands.length) * 2
    ) / 2

    const savedOveralls = [
      result.finalOverall,
      result.overall,
      result.overallEstimate
    ].filter(value => value !== null && value !== undefined && value !== '')

    return savedOveralls.length > 0 &&
      savedOveralls.every(value => mockBand(value) === expectedOverall)
  }
  if (writing.effectiveBandSource === 'teacher') {
    return effective !== null
  }
  const teacherBand = mockBand(writing.band)
  const legacyTeacherBand = mockBand(submission?.writingReview?.overall)
  return writing.status === 'reviewed' &&
    (teacherBand !== null || legacyTeacherBand !== null)
}

export function mockAiGateDecision(envelope, result = null) {
  if (!envelope || typeof envelope !== 'object') return 'retry'
  switch (envelope.status) {
    case 'processing':
      return 'wait'
    case 'not_started':
      return envelope.institutionFunded === true ? 'wait' : 'not_funded'
    case 'completed': {
      if (envelope.report?.feedbackOnly === true && envelope.report?.estimatedBand == null) {
        return 'feedback_only'
      }
      const expected = mockBand(envelope.report?.estimatedBand)
      if (expected === null) return 'blocked'
      const actual = mockBand(result?.writing?.aiEstimatedBand)
      return actual === expected && savedMockWritingScoreReady(result) ? 'ready' : 'syncing'
    }
    case 'too_short':
      return 'too_short'
    case 'failed':
      return 'failed'
    case 'stale_attempt':
      return 'blocked'
    default:
      return 'retry'
  }
}

// Student dashboard: never present an objective-only estimate as a
// completed Full Mock Overall while an included Writing score is pending.
export function dashboardMockOverall(submission) {
  const result = submission?.result
  if (!result || typeof result !== 'object') return null

  const writing = result.writing || {}
  const sections = submission?.enabledSections || result.enabledSections || {}

  const writingIncluded = typeof sections.writing === 'boolean'
    ? sections.writing
    : typeof writing.enabled === 'boolean'
      ? writing.enabled
      : (
        writing.status === 'pending_review' ||
        writing.status === 'reviewed' ||
        writing.effectiveBandSource === 'ai' ||
        writing.effectiveBandSource === 'teacher' ||
        mockBand(writing.aiEstimatedBand) !== null ||
        mockBand(writing.band) !== null ||
        Boolean(submission?.writingAnswers &&
          Object.keys(submission.writingAnswers).length)
      )

  if (writingIncluded && !savedMockWritingScoreReady(result, submission)) {
    return null
  }

  // With AI Writing, only use the Overall fields checked by STEP57.
  // A legacy reviewedOverall must not override a verified AI result.
  if (writingIncluded && writing.effectiveBandSource === 'ai') {
    return mockBand(result.finalOverall) ??
      mockBand(result.overall) ??
      mockBand(result.overallEstimate)
  }

  return mockBand(result.reviewedOverall) ??
    mockBand(result.finalOverall) ??
    mockBand(result.overall) ??
    mockBand(result.overallEstimate)
}
