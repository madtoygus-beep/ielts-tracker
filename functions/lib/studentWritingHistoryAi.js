'use strict'

// P8-B5: Saved, read-only student Writing AI results for an EXACT attempt.
// Authorization (student, active assignment and source, retake review locks)
// happens in the existing history/review callables BEFORE this helper runs.
// This module has no model provider, credits, writes, secrets, or retry path.
const { createHash } = require('crypto')

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const validAttempt = value => Number.isSafeInteger(value) && value >= 1 && value <= 1000
const validId = value => typeof value === 'string' && value.trim().length > 0 &&
  !value.includes('/') && Buffer.byteLength(value, 'utf8') <= 1500

function createStudentWritingHistoryAiService({ db, prepareAiWritingEvaluation, validAiWritingReport }) {
  if (!db || !prepareAiWritingEvaluation || !validAiWritingReport) {
    throw new Error('Writing history AI service dependencies are missing.')
  }

  async function readSavedReport({ student, source, contentId, attemptNumber, submission, submissionId,
    includeReport = false }) {
    // Mirror the institution-only saved-report boundary. Turning the school
    // pilot OFF must not remove a student's already purchased/saved result.
    if (student?.schoolId !== 'maxima' ||
        student.profile?.accountType === 'individual' ||
        student.profile?.archived === true ||
        student.profile?.permanentDeleteInProgress === true ||
        !validId(contentId) || !validId(submissionId) || !validAttempt(attemptNumber) ||
        !source || source.archived === true || source.deleted === true ||
        !submission || typeof submission !== 'object' ||
        (submission.uid && submission.uid !== student.uid) ||
        (submission.studentId && submission.studentId !== student.uid) ||
        (submission.schoolId && submission.schoolId !== student.schoolId) ||
        submission.writingId !== contentId ||
        Number(submission.attemptNumber || 1) !== attemptNumber) return null

    const jobId = sha(['ai-writing-v1', student.uid, 'homework', contentId, attemptNumber].join('\0'))
    const snap = await db.doc(`aiWritingEvaluations/${jobId}`).get()
    if (!snap.exists) return null
    const job = snap.data() || {}
    if (job.status !== 'completed' || job.jobId !== jobId ||
        job.studentId !== student.uid || job.schoolId !== student.schoolId ||
        job.context !== 'homework' || job.contentId !== contentId ||
        (job.contentType && job.contentType !== 'writing') ||
        job.attemptNumber !== attemptNumber || job.submissionId !== submissionId) return null

    // If the submission/source has been edited since grading, do not attach
    // a possibly unrelated score. In particular, never display a new attempt's
    // grade on an older snapshot with the same content ID.
    let prepared
    try {
      prepared = prepareAiWritingEvaluation({ context: 'homework', source, submission })
      const fingerprint = sha(JSON.stringify(prepared))
      if (job.fingerprint !== fingerprint || !validAiWritingReport(job.report, prepared)) return null
    } catch {
      return null
    }

    const band = job.report.estimatedBand
    if (!(typeof band === 'number' && Number.isFinite(band) && band >= 0 && band <= 9) &&
        !(band === null && job.report.feedbackOnly === true)) return null

    return {
      contentId, attemptNumber, status: 'completed',
      estimatedBand: band, feedbackOnly: job.report.feedbackOnly === true,
      institutionFunded: job.billingMode === 'sponsored_auto',
      ...(includeReport ? { report: job.report } : {})
    }
  }

  return { readSavedReport }
}

module.exports = { createStudentWritingHistoryAiService }
