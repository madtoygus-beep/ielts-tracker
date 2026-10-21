'use strict'

// P0-B2B Step751R2: trusted, atomic Mock Writing teacher review.
// The browser supplies ONLY a human review and attempt identity. AI and
// objective scores are always read from the server-owned submission snapshot.

const isMap = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const ownKeys = (value, required, optional = []) => {
  if (!isMap(value)) return false
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key))
}

const safeId = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && value.trim() === value && !value.includes('/') &&
  !/[\u0000-\u001f]/.test(value)

const validBand = value => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 9 &&
      Number.isInteger(value * 2)
  }
  return typeof value === 'string' &&
    /^(?:[0-8](?:\.[05])?|9(?:\.0)?)$/.test(value)
}
const optionalBand = value => value === '' || value === null || validBand(value)

const TASK1_FIELDS = Object.freeze([
  'taskAchievement', 'coherenceCohesion', 'lexicalResource', 'grammarRangeAccuracy'
])
const TASK2_FIELDS = Object.freeze([
  'taskResponse', 'coherenceCohesion', 'lexicalResource', 'grammarRangeAccuracy'
])
const REVIEW_FIELDS = Object.freeze([
  'task1Enabled', 'task2Enabled', 'task1Band', 'task2Band', 'rubric',
  'task1Feedback', 'task2Feedback', 'overall', 'generalFeedback'
])

function validateReview(value) {
  if (!ownKeys(value, REVIEW_FIELDS)) return false
  if (typeof value.task1Enabled !== 'boolean' ||
      typeof value.task2Enabled !== 'boolean' ||
      (!value.task1Enabled && !value.task2Enabled)) return false
  if (!optionalBand(value.task1Band) || !optionalBand(value.task2Band) ||
      !validBand(value.overall)) return false
  for (const field of ['task1Feedback', 'task2Feedback', 'generalFeedback']) {
    if (typeof value[field] !== 'string' || value[field].length > 12000) return false
  }
  if (!ownKeys(value.rubric, ['task1', 'task2'])) return false
  for (const [task, fields, enabled, band] of [
    ['task1', TASK1_FIELDS, value.task1Enabled, value.task1Band],
    ['task2', TASK2_FIELDS, value.task2Enabled, value.task2Band]
  ]) {
    if (enabled) {
      if (!ownKeys(value.rubric[task], fields)) return false
      if (!fields.every(field => optionalBand(value.rubric[task][field]))) return false
    } else if (!ownKeys(value.rubric[task], []) || band !== '') {
      // TeacherDashboard intentionally sends an empty rubric for a
      // section disabled in a Task-1-only or Task-2-only Mock.
      return false
    }
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 75000
}

function computeOverall(submission, result, teacherBand) {
  const sections = isMap(submission.enabledSections)
    ? submission.enabledSections : (isMap(result.enabledSections) ? result.enabledSections : {})
  const enabledBand = (name) => {
    if (sections[name] === false || result[name]?.enabled === false) return null
    const band = Number(result[name]?.band)
    return Number.isFinite(band) && band > 0 && band <= 9 ? band : null
  }
  const parts = [enabledBand('listening'), enabledBand('reading'), teacherBand]
    .filter(value => value !== null)
  return parts.length ? Math.round(parts.reduce((sum, value) => sum + value, 0) /
    parts.length * 2) / 2 : teacherBand
}

function createMockWritingReviewService({db, HttpsError, requireAssignmentManager,
  requireCurrentTeacherAcademicStudent, findCurrentSubmissionRecord,
  submissionContentConfigFor, matchingCurrentMockScoreForStats,
  schoolIdOf}) {
  const fault = (code, message) => { throw new HttpsError(code, message) }
  const attemptOf = value => Number.isSafeInteger(value?.attemptNumber) &&
    value.attemptNumber >= 1 ? value.attemptNumber : 1
  const scoreMatches = (score, submission, studentId, mockTestId, schoolId, legacy) => {
    if (!score || !['mock_test', undefined].includes(score.source) ||
        (score.uid !== studentId && score.studentId !== studentId) ||
        (score.uid && score.uid !== studentId) ||
        (score.studentId && score.studentId !== studentId) ||
        (score.mockTestId !== mockTestId && score.mockId !== mockTestId) ||
        schoolIdOf(score) !== schoolId ||
        attemptOf(score) !== attemptOf(submission)) return false
    const scoreAt = typeof score.createdAt === 'string' ? score.createdAt : ''
    const submittedAt = submission.submittedAt
    if (legacy && (!scoreAt || scoreAt !== submittedAt)) return false
    if (scoreAt && scoreAt !== submittedAt) return false
    return true
  }

  return async function saveMockWritingReviewSecure(request) {
    const manager = await requireAssignmentManager(request)
    const input = request.data || {}
    if (!ownKeys(input, ['studentId', 'mockTestId', 'submissionId',
      'attemptNumber', 'submittedAt', 'review'])) {
      fault('invalid-argument', 'Unexpected or missing Mock Writing review fields.')
    }
    const {studentId, mockTestId, submissionId, attemptNumber, submittedAt, review} = input
    if (![studentId, mockTestId, submissionId].every(safeId) ||
      !Number.isSafeInteger(attemptNumber) || attemptNumber < 1 ||
      typeof submittedAt !== 'string' || submittedAt.length < 15 ||
      submittedAt.length > 64 || !validateReview(review)) {
      fault('invalid-argument', 'Invalid Mock Writing review or attempt reference.')
    }

    const current = await findCurrentSubmissionRecord(
      submissionContentConfigFor('mock'), studentId, mockTestId)
    if (!current || current.id !== submissionId) {
      fault('failed-precondition', 'Selected Mock attempt is not the current submission.')
    }
    const pre = current.data || {}
    if (pre.uid !== studentId || (pre.studentId && pre.studentId !== studentId) ||
        pre.mockTestId !== mockTestId || pre.submittedAt !== submittedAt ||
        attemptOf(pre) !== attemptNumber || pre.status !== 'submitted') {
      fault('failed-precondition', 'Mock attempt changed; refresh the review.')
    }
    const schoolId = schoolIdOf(pre)
    if (!safeId(schoolId)) fault('failed-precondition', 'Invalid institution.')

    // Availability probe only; the authoritative membership check is in
    // transaction and re-read alongside the submission and score versions.
    await requireCurrentTeacherAcademicStudent({
      db, HttpsError, manager, studentId, schoolId
    })
    const selectedScore = await matchingCurrentMockScoreForStats(
      studentId, mockTestId, schoolId, current)
    const canonicalScoreRef = db.doc(`scores/${studentId}_${mockTestId}`)
    const selectedScoreRef = selectedScore?.ref || canonicalScoreRef
    const isLegacyScore = selectedScore?.ref && selectedScore.ref.path !== canonicalScoreRef.path
    const studentScoreId = selectedScoreRef.id

    return db.runTransaction(async tx => {
      // Firestore transaction reads MUST all occur before writes.
      const submissionSnap = await tx.get(current.ref)
      const scoreSnap = await tx.get(selectedScoreRef)
      // When an existing legacy score is selected, also check whether a
      // canonical score was created concurrently to prevent duplicate writes.
      const canonicalSnap = isLegacyScore ? await tx.get(canonicalScoreRef) : scoreSnap
      await requireCurrentTeacherAcademicStudent({
        db, HttpsError, manager, studentId, schoolId, tx
      })
      if (!submissionSnap.exists) {
        fault('aborted', 'Mock submission disappeared. Refresh and try again.')
      }
      const submission = submissionSnap.data() || {}
      if (submission.uid !== studentId ||
          (submission.studentId && submission.studentId !== studentId) ||
          submission.mockTestId !== mockTestId ||
          submission.submittedAt !== submittedAt ||
          attemptOf(submission) !== attemptNumber ||
          submission.status !== 'submitted' || schoolIdOf(submission) !== schoolId ||
          (isLegacyScore && canonicalSnap.exists)) {
        fault('aborted', 'The Mock attempt or linked score changed. Refresh and retry.')
      }
      const result = submission.result
      if (!isMap(result) || !isMap(result.writing) ||
          submission.enabledSections?.writing === false ||
          result.writing.enabled === false) {
        fault('failed-precondition', 'This Mock has no Writing section to review.')
      }
      const numericWriting = Number(review.overall)
      const finalOverall = computeOverall(submission, result, numericWriting)
      // Do not accept a browser-supplied result or AI field, and do not
      // re-create the result from stale UI snapshots.
      const nextResult = {
        ...result,
        writing: {
          ...result.writing,
          status: 'reviewed',
          band: review.overall,
          effectiveBand: numericWriting,
          effectiveBandSource: 'teacher',
          task1Band: review.task1Band,
          task2Band: review.task2Band,
          review
        },
        finalOverall, reviewedOverall: finalOverall,
        overallEstimate: finalOverall, overall: finalOverall
      }
      const now = new Date().toISOString()
      if (scoreSnap.exists) {
        if (!scoreMatches(scoreSnap.data() || {}, submission, studentId,
          mockTestId, schoolId, Boolean(isLegacyScore))) {
          fault('aborted', 'Existing Mock score does not match the current attempt.')
        }
      } else if (selectedScore) {
        fault('aborted', 'Previously located Mock score disappeared.')
      }

      const scoreGrade = {
        writing: review.overall, writingSource: 'teacher',
        overall: finalOverall, updatedAt: now, updatedBy: manager.uid
      }
      const noScore = !scoreSnap.exists
      let firstScore = null
      if (noScore) {
        // Only first canonical score may be created. AI evidence is copied
        // from trusted submission, never from the teacher's request.
        const sections = isMap(submission.enabledSections)
          ? submission.enabledSections : (isMap(result.enabledSections) ? result.enabledSections : {})
        firstScore = {
          uid: studentId, studentId,
          studentEmail: typeof submission.studentEmail === 'string' ? submission.studentEmail : '',
          schoolId,
          teacherId: typeof submission.teacherId === 'string' ? submission.teacherId : '',
          teacherIds: Array.isArray(submission.teacherIds) ? submission.teacherIds : [],
          date: submittedAt.slice(0, 10), source: 'mock_test', mockTestId,
          attemptNumber,
          listening: sections.listening === false || result.listening?.enabled === false
            ? '' : (result.listening?.band ?? ''),
          reading: sections.reading === false || result.reading?.enabled === false
            ? '' : (result.reading?.band ?? ''),
          speaking: '',
          aiEstimatedWritingBand: result.writing.aiEstimatedBand ?? null,
          createdAt: submittedAt,
          gradedByServer: submission.gradedByServer === true,
          gradingSchemaVersion: Number.isSafeInteger(submission.gradingSchemaVersion)
            ? submission.gradingSchemaVersion : 1,
          ...(submission.excludedFromStats === true ? {excludedFromStats:true} : {}),
          ...scoreGrade
        }
      }
      tx.update(current.ref, {
        reviewedAt: now,
        reviewedBy: manager.uid,
        writingReview: {status:'reviewed', ...review},
        result: nextResult
      })
      if (noScore) tx.create(canonicalScoreRef, firstScore)
      else tx.update(selectedScoreRef, scoreGrade)

      return {
        ok: true, submissionId, scoreId: studentScoreId,
        attemptNumber, reviewedAt: now, writingBand: review.overall,
        overall: finalOverall
      }
    })
  }
}

module.exports = {createMockWritingReviewService, validateReview, computeOverall}
