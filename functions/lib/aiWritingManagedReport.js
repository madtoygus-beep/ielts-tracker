'use strict'

// P5D: Staff-only, read-only AI Writing report access.
// No model provider, secret, credit ledger, billing transaction, or Firestore writes.
// All identities, source content, submissions and permissions come from Firestore.
const { createHash } = require('crypto')
const {
  prepareAiWritingEvaluation,
  eligibleTasks,
  validAiWritingReport
} = require('./aiWritingGrading')

const PILOT_SCHOOL_ID = 'maxima'
const VALID_ID = /^[A-Za-z0-9_-]{1,150}$/
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const dataOf = snap => snap?.exists ? (snap.data() || {}) : null

function createAiWritingManagedReportService({
  db, HttpsError, requireAssignmentManager, managerCanManageSource,
  requireManagedStudentAssignment, submissionContentConfigFor,
  findCurrentSubmissionRecord, getOpenSubmissionAttemptControl,
  schoolIdOf, getMockEnabledSections, getMockWritingMode
}) {
  if (![db, HttpsError, requireAssignmentManager, managerCanManageSource,
    requireManagedStudentAssignment, submissionContentConfigFor,
    findCurrentSubmissionRecord, getOpenSubmissionAttemptControl,
    schoolIdOf, getMockEnabledSections, getMockWritingMode].every(Boolean)) {
    throw new Error('Managed AI report service dependencies are missing.')
  }
  const fail = (code, message) => { throw new HttpsError(code, message) }
  const isValidId = value => typeof value === 'string' && VALID_ID.test(value)
  const isActiveSource = source => Boolean(source && source.deleted !== true && source.archived !== true)

  function parseInput(request) {
    const data = request?.data
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(key => !['context', 'contentId', 'studentId', 'attemptNumber'].includes(key))) {
      fail('invalid-argument', 'Provide context, contentId, studentId and attemptNumber only.')
    }
    if (!['homework', 'mock'].includes(data.context) ||
        !isValidId(data.contentId) || !isValidId(data.studentId) ||
        !Number.isSafeInteger(data.attemptNumber) ||
        data.attemptNumber < 1 || data.attemptNumber > 1000) {
      fail('invalid-argument', 'Invalid Writing report request.')
    }
    return {
      context: data.context, contentId: data.contentId,
      studentId: data.studentId, attemptNumber: data.attemptNumber,
      contentType: data.context === 'mock' ? 'mock' : 'writing'
    }
  }

  async function getReport(request) {
    const input = parseInput(request)
    const manager = await requireAssignmentManager(request)
    const config = submissionContentConfigFor(input.contentType)
    const sourceSnap = await db.doc(`${config.sourceCollection}/${input.contentId}`).get()
    const source = dataOf(sourceSnap)

    // An admin's general content permissions do not grant access outside
    // the institution-only AI pilot. Teachers must also own this source.
    if (!isActiveSource(source) || schoolIdOf(source) !== PILOT_SCHOOL_ID ||
        !managerCanManageSource(manager, source)) {
      fail('permission-denied', 'AI report access is not available for this assignment.')
    }
    // Also verifies the student's current approved institutional profile and
    // an active, non-hidden, school-matching studentAccess assignment.
    const studentAssignment = await requireManagedStudentAssignment(manager, config, source,
      input.studentId, input.contentId)
    // Archived/deleting student profiles must not expose saved AI reports,
    // even when an old active studentAccess record still exists.
    if (studentAssignment?.profile?.archived === true ||
        studentAssignment?.profile?.permanentDeleteInProgress === true) {
      fail('permission-denied', 'AI report access is unavailable for this student.')
    }

    const current = await findCurrentSubmissionRecord(config, input.studentId, input.contentId)
    if (!current?.ref) {
      return { status: 'not_started', context: input.context, attemptNumber: input.attemptNumber }
    }
    if (await getOpenSubmissionAttemptControl(config, input.studentId, input.contentId, current)) {
      fail('failed-precondition', 'The student is currently completing a reopened attempt.')
    }
    const submission = dataOf(await current.ref.get())
    const expectedField = input.context === 'mock' ? 'mockTestId' : 'writingId'
    if (!submission || submission.uid !== input.studentId ||
        submission.studentId !== input.studentId ||
        schoolIdOf(submission) !== PILOT_SCHOOL_ID ||
        submission[expectedField] !== input.contentId ||
        submission.attemptNumber !== input.attemptNumber ||
        (input.context === 'mock' && submission.status !== 'submitted')) {
      fail('failed-precondition', 'The selected submission is not the current saved attempt.')
    }

    let prepared
    try {
      if (input.context === 'homework') {
        prepared = prepareAiWritingEvaluation({ context: 'homework', source, submission })
      } else {
        if (getMockEnabledSections(source)?.writing !== true ||
            !isValidId(source.writingId) ||
            submission.writingId !== source.writingId ||
            submission.enabledSections?.writing !== true) {
          fail('failed-precondition', 'The Mock Writing link is not valid.')
        }
        const linked = dataOf(await db.doc(`writingHomeworks/${source.writingId}`).get())
        if (!isActiveSource(linked) || schoolIdOf(linked) !== PILOT_SCHOOL_ID) {
          fail('failed-precondition', 'The linked Writing resource is unavailable.')
        }
        const mode = getMockWritingMode(source, linked)
        if (!['full_writing', 'task1_only', 'task2_only'].includes(mode) ||
            submission.writingMode !== mode) {
          fail('failed-precondition', 'The Mock Writing mode has changed.')
        }
        prepared = prepareAiWritingEvaluation({
          context: 'mock', source: { ...linked, contentType: mode }, submission
        })
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error
      fail('failed-precondition', 'The Writing source or submitted answers cannot be verified.')
    }

    if (!eligibleTasks(prepared).length) {
      return { status: 'too_short', context: input.context, attemptNumber: input.attemptNumber }
    }
    const fingerprint = sha(JSON.stringify(prepared))
    const jobId = sha(['ai-writing-v1', input.studentId, input.context,
      input.contentId, input.attemptNumber].join('\0'))
    const job = dataOf(await db.doc(`aiWritingEvaluations/${jobId}`).get())
    if (!job) {
      return { status: 'not_started', context: input.context, attemptNumber: input.attemptNumber }
    }

    // Fail closed on a mixed-up, stale, tampered or cross-student report.
    if (job.jobId !== jobId || job.studentId !== input.studentId ||
        job.schoolId !== PILOT_SCHOOL_ID || job.context !== input.context ||
        job.contentId !== input.contentId || job.attemptNumber !== input.attemptNumber ||
        job.fingerprint !== fingerprint || job.submissionId !== current.ref.id ||
        (job.contentType && job.contentType !== input.contentType)) {
      fail('failed-precondition', 'This AI report does not match the saved submission.')
    }
    if (job.status !== 'completed') {
      return {
        status: job.status === 'processing' ? 'processing' : 'failed',
        context: input.context, attemptNumber: input.attemptNumber
      }
    }
    if (!validAiWritingReport(job.report, prepared)) {
      fail('failed-precondition', 'The saved AI report failed validation.')
    }
    return {
      status: 'completed', context: input.context,
      contentId: input.contentId, attemptNumber: input.attemptNumber,
      report: job.report, institutionFunded: job.billingMode === 'sponsored_auto'
    }
  }

  return { getReport }
}

module.exports = { createAiWritingManagedReportService }
