'use strict'

// P5D / AI Mock Overall: reflect a COMPLETED, validated Mock AI report in
// the current Mock result and current Mock score. No model calls, billing,
// credit changes, historical-attempt writes, or teacher-grade changes.
const { createHash } = require('crypto')
const { prepareAiWritingEvaluation, validAiWritingReport } = require('./aiWritingGrading')

const PILOT_SCHOOL_ID = 'maxima'
const VALID_ID = /^[A-Za-z0-9_-]{1,150}$/
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex')
const dataOf = snap => snap?.exists ? (snap.data() || {}) : null
const attemptOf = value => Number.isSafeInteger(value?.attemptNumber) && value.attemptNumber >= 1
  ? value.attemptNumber : 1

function numericBand(value) {
  if (value === '' || value === undefined || value === null || typeof value === 'boolean') return null
  const band = Number(value)
  return Number.isFinite(band) && band >= 1 && band <= 9 ? band : null
}

function teacherWritingBand(submission) {
  const result = submission?.result || {}
  for (const value of [
    submission?.writingReview?.overall,
    result.writing?.band,
    result.writingBand,
    submission?.review?.writingOverall
  ]) {
    const band = numericBand(value)
    if (band !== null) return band
  }
  return null
}

function effectiveMockOverall(submission, aiEstimatedBand = null) {
  const result = submission?.result || {}
  const sections = submission?.enabledSections || result.enabledSections || {}
  const included = section => sections[section] !== false && result[section]?.enabled !== false
  const teacherBand = included('writing') ? teacherWritingBand(submission) : null
  const aiBand = included('writing') ? numericBand(aiEstimatedBand) : null
  const effectiveWritingBand = teacherBand ?? aiBand
  const writingSource = teacherBand !== null ? 'teacher' : aiBand !== null ? 'ai' : 'none'
  const listeningBand = included('listening') ? numericBand(result.listening?.band) : null
  const readingBand = included('reading') ? numericBand(result.reading?.band) : null
  const bands = [listeningBand, readingBand, effectiveWritingBand].filter(band => band !== null)
  const overall = bands.length
    ? Math.round((bands.reduce((sum, band) => sum + band, 0) / bands.length) * 2) / 2
    : null
  return { teacherBand, aiBand, effectiveWritingBand, writingSource, overall }
}

function createAiMockOverallSyncService({
  db, findCurrentSubmissionRecord, submissionContentConfigFor,
  matchingCurrentMockScoreForStats, getMockEnabledSections, getMockWritingMode,
  schoolIdOf
}) {
  if (![db, findCurrentSubmissionRecord, submissionContentConfigFor,
    matchingCurrentMockScoreForStats, getMockEnabledSections,
    getMockWritingMode, schoolIdOf].every(Boolean)) {
    throw new Error('Mock Overall sync dependencies are missing.')
  }

  async function onAiReport(event) {
    const before = dataOf(event?.data?.before)
    const after = dataOf(event?.data?.after)
    if (!after || after.status !== 'completed' || before?.status === 'completed' ||
        after.context !== 'mock' || after.schoolId !== PILOT_SCHOOL_ID ||
        !VALID_ID.test(after.studentId || '') || !VALID_ID.test(after.contentId || '') ||
        after.uid !== after.studentId || after.contentType !== 'mock' ||
        !Number.isSafeInteger(after.attemptNumber) || after.attemptNumber < 1 ||
        after.attemptNumber > 1000 || !after.submissionId) {
      return { status: 'ignored' }
    }
    const uid = after.studentId
    const contentId = after.contentId
    const expectedJobId = sha(['ai-writing-v1', uid, 'mock', contentId, after.attemptNumber].join('\0'))
    if (event?.params?.id !== expectedJobId || after.jobId !== expectedJobId) {
      return { status: 'invalid_job' }
    }

    // Do not touch any prior attempt or hidden historical score. The existing
    // current-head selector handles canonical and older submission IDs.
    const current = await findCurrentSubmissionRecord(
      submissionContentConfigFor('mock'), uid, contentId
    )
    if (!current?.ref || current.ref.id !== after.submissionId ||
        attemptOf(current.data) !== after.attemptNumber) {
      return { status: 'stale_attempt' }
    }

    let scoreRecord
    try {
      scoreRecord = await matchingCurrentMockScoreForStats(
        uid, contentId, PILOT_SCHOOL_ID, current
      )
    } catch (_) {
      // An ambiguous legacy score needs explicit reconciliation, not a blind
      // migration. Never update a possibly historical score.
      return { status: 'ambiguous_score' }
    }
    const submissionRef = current.ref
    const jobRef = db.doc(`aiWritingEvaluations/${expectedJobId}`)
    const sourceRef = db.doc(`mockTests/${contentId}`)
    const scoreRef = scoreRecord?.ref || db.doc(`scores/${uid}_${contentId}`)
    const controlRef = db.doc(`submissionAttemptControls/${sha(`${uid}\u001fmock\u001f${contentId}`)}`)
    const userRef = db.doc(`users/${uid}`)
    const schoolRef = db.doc(`schools/${PILOT_SCHOOL_ID}`)

    return db.runTransaction(async tx => {
      const [submissionSnap, jobSnap, sourceSnap, scoreSnap, controlSnap, userSnap, schoolSnap] = await Promise.all([
        tx.get(submissionRef), tx.get(jobRef), tx.get(sourceRef), tx.get(scoreRef),
        tx.get(controlRef), tx.get(userRef), tx.get(schoolRef)
      ])
      const submission = dataOf(submissionSnap)
      const job = dataOf(jobSnap)
      const source = dataOf(sourceSnap)
      const score = dataOf(scoreSnap)
      const user = dataOf(userSnap)
      const school = dataOf(schoolSnap)
      if (!submission || !job || !source ||
          !user || user.role !== 'student' || user.status !== 'approved' ||
          user.deleted === true || user.archived === true ||
          schoolIdOf(user) !== PILOT_SCHOOL_ID || school?.status !== 'active' ||
          controlSnap.data()?.status === 'open' ||
          submission.archived === true || submission.deleted === true ||
          submission.permanentDeleteInProgress === true ||
          submission.status !== 'submitted' || submission.uid !== uid ||
          submission.studentId !== uid || submission.mockTestId !== contentId ||
          schoolIdOf(submission) !== PILOT_SCHOOL_ID ||
          attemptOf(submission) !== after.attemptNumber ||
          source.archived === true || source.deleted === true ||
          schoolIdOf(source) !== PILOT_SCHOOL_ID ||
          submission.enabledSections?.writing !== true ||
          getMockEnabledSections(source)?.writing !== true ||
          job.status !== 'completed' || job.jobId !== expectedJobId ||
          job.submissionId !== submissionRef.id || job.uid !== uid ||
          job.studentId !== uid || job.schoolId !== PILOT_SCHOOL_ID ||
          job.contentType !== 'mock' || job.context !== 'mock' ||
          job.contentId !== contentId || job.attemptNumber !== after.attemptNumber) {
        return { status: 'stale_or_ineligible' }
      }
      if (score && (((score.uid && score.uid !== uid) ||
          (score.studentId && score.studentId !== uid) ||
          (score.mockTestId && score.mockTestId !== contentId) ||
          (score.mockId && score.mockId !== contentId) ||
          (!score.uid && !score.studentId) ||
          (!score.mockTestId && !score.mockId)) ||
          schoolIdOf(score) !== PILOT_SCHOOL_ID ||
          (Number(score.attemptNumber || 1) !== after.attemptNumber) ||
          (typeof score.createdAt === 'string' && score.createdAt &&
           typeof submission.submittedAt === 'string' && submission.submittedAt &&
           score.createdAt !== submission.submittedAt))) {
        return { status: 'stale_score' }
      }
      if (!VALID_ID.test(source.writingId || '') || submission.writingId !== source.writingId) {
        return { status: 'invalid_writing_source' }
      }
      const linkedSnap = await tx.get(db.doc(`writingHomeworks/${source.writingId}`))
      const linked = dataOf(linkedSnap)
      if (!linked || linked.deleted === true || linked.archived === true ||
          schoolIdOf(linked) !== PILOT_SCHOOL_ID) return { status: 'invalid_writing_source' }
      const writingMode = getMockWritingMode(source, linked)
      if (!['full_writing', 'task1_only', 'task2_only'].includes(writingMode) ||
          submission.writingMode !== writingMode) return { status: 'invalid_writing_mode' }

      let prepared
      try {
        prepared = prepareAiWritingEvaluation({
          context: 'mock', source: { ...linked, contentType: writingMode }, submission
        })
      } catch (_) {
        return { status: 'invalid_submission' }
      }
      if (job.fingerprint !== sha(JSON.stringify(prepared)) ||
          !validAiWritingReport(job.report, prepared)) return { status: 'invalid_report' }

      const bands = effectiveMockOverall(submission, job.report.estimatedBand)
      const oldResult = submission.result || {}
      const oldWriting = oldResult.writing || {}
      const nextWriting = {
        ...oldWriting,
        aiEstimatedBand: bands.aiBand,
        aiFeedbackOnly: job.report.feedbackOnly === true,
        effectiveBand: bands.effectiveWritingBand,
        effectiveBandSource: bands.writingSource
      }
      const nextResult = {
        ...oldResult,
        writing: nextWriting,
        overall: bands.overall,
        overallEstimate: bands.overall,
        finalOverall: bands.teacherBand !== null ? bands.overall : null,
        reviewedOverall: bands.teacherBand !== null ? bands.overall : null
      }
      const scoreBand = value => value === null ? '' : value.toFixed(1)
      const nextScore = {
        uid, studentId: uid, schoolId: PILOT_SCHOOL_ID,
        mockTestId: contentId, source: 'mock_test',
        attemptNumber: after.attemptNumber,
        writing: scoreBand(bands.effectiveWritingBand),
        overall: scoreBand(bands.overall),
        writingSource: bands.writingSource,
        aiEstimatedWritingBand: bands.aiBand
      }
      const hasChanged = oldWriting.aiEstimatedBand !== nextWriting.aiEstimatedBand ||
        oldWriting.aiFeedbackOnly !== nextWriting.aiFeedbackOnly ||
        oldWriting.effectiveBand !== nextWriting.effectiveBand ||
        oldWriting.effectiveBandSource !== nextWriting.effectiveBandSource ||
        oldResult.overall !== nextResult.overall ||
        oldResult.overallEstimate !== nextResult.overallEstimate ||
        oldResult.finalOverall !== nextResult.finalOverall ||
        oldResult.reviewedOverall !== nextResult.reviewedOverall
      const scoreChanged = !score || score.writing !== nextScore.writing ||
        score.overall !== nextScore.overall || score.writingSource !== nextScore.writingSource ||
        score.aiEstimatedWritingBand !== nextScore.aiEstimatedWritingBand
      if (hasChanged) tx.update(submissionRef, { result: nextResult })
      if (scoreChanged) {
        if (score) tx.set(scoreRef, nextScore, { merge: true })
        else tx.create(scoreRef, {
          ...nextScore,
          studentEmail: submission.studentEmail || '',
          teacherId: submission.teacherId || '',
          teacherIds: Array.isArray(submission.teacherIds) ? submission.teacherIds : [],
          date: (submission.submittedAt || '').slice(0, 10),
          createdAt: submission.submittedAt || '',
          gradedByServer: true, gradingSchemaVersion: 1,
          ...(submission.excludedFromStats === true ? { excludedFromStats: true } : {})
        })
      }
      return { status: hasChanged || scoreChanged ? 'synced' : 'unchanged',
        writingSource: bands.writingSource }
    })
  }

  return { onAiReport }
}

module.exports = {
  numericBand, teacherWritingBand, effectiveMockOverall,
  createAiMockOverallSyncService
}
