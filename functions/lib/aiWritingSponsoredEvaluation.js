'use strict'

// P5B-3C: Teacher-selected institution-sponsored AI evaluation triggered only by
// a genuinely submitted/current Writing or Mock attempt. Never use student credits.
// No raw submitted essays/images, API secret, or provider response bodies are logged.
const { createHash, randomBytes } = require('crypto')
const { prepareAiWritingEvaluation } = require('./aiWritingGrading')
const { MAX_MONTHLY_SCHOOL_EVALUATIONS, LEASE_MS } = require('./aiWritingEvaluation')
const { MAX_STUDENTS_PER_POLICY } = require('./aiWritingSponsoredPolicy')

const PILOT_SCHOOL_ID = 'maxima'
const ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/
const STUDENT_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/
const SOURCE_CONFIG = Object.freeze({
  homework: Object.freeze({ contentType: 'writing', sourceCollection: 'writingHomeworks', submissionCollection: 'writingSubmissions', sourceField: 'writingId' }),
  mock: Object.freeze({ contentType: 'mock', sourceCollection: 'mockTests', submissionCollection: 'mockSubmissions', sourceField: 'mockTestId' })
})
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const dataOf = snap => snap?.exists ? (snap.data() || {}) : null
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const active = value => value && value.deleted !== true && value.archived !== true &&
  value.permanentDeleteInProgress !== true

function isNewSubmittedAttempt(context, before, after) {
  if (!SOURCE_CONFIG[context] || !after || typeof after !== 'object') return false
  if (typeof after.submittedAt !== 'string' || !Number.isFinite(Date.parse(after.submittedAt)) ||
      !Number.isSafeInteger(after.attemptNumber) || after.attemptNumber < 1 || after.attemptNumber > 1000 ||
      (context === 'mock' && after.status !== 'submitted')) return false
  if (!before) return true
  // A teacher changing grades/review or metadata MUST NOT start a paid call.
  // Secure resubmission increments the attempt and supplies a new submittedAt.
  return Number.isSafeInteger(before.attemptNumber) &&
    after.attemptNumber === before.attemptNumber + 1 &&
    after.submittedAt !== before.submittedAt
}

function submissionSignature(context, value) {
  return sha(JSON.stringify({
    studentId: value.studentId, uid: value.uid,
    contentId: value[SOURCE_CONFIG[context].sourceField],
    attemptNumber: value.attemptNumber, submittedAt: value.submittedAt,
    writingMode: value.writingMode,
    ...(context === 'mock'
      ? { writingId: value.writingId,
          writingEnabled: value.enabledSections?.writing,
          task1Answer: value.writingAnswers?.task1,
          task2Answer: value.writingAnswers?.task2 }
      : { task1Answer: value.task1Answer, task2Answer: value.task2Answer })
  }))
}

function policyUpdatedAfterSubmission(policy, submission) {
  const updated = policy?.updatedAt
  const updatedMs = typeof updated?.toMillis === 'function' ? updated.toMillis()
    : (updated instanceof Date ? updated.getTime() :
      (typeof updated === 'string' ? Date.parse(updated) : NaN))
  const submittedMs = Date.parse(submission.submittedAt)
  // Legacy records without a verifiable timestamp must not authorize automatic spending.
  return !Number.isFinite(updatedMs) || !Number.isFinite(submittedMs) || updatedMs > submittedMs
}

function createAiWritingSponsoredEvaluationService({
  db, FieldValue, provider, getApiKey, providerEnabled,
  schoolIdOf, getMockEnabledSections, getMockWritingMode,
  findCurrentSubmissionRecord, submissionContentConfigFor,
  now = () => Date.now()
}) {
  if (![db, FieldValue, provider, getApiKey, providerEnabled, schoolIdOf,
    getMockEnabledSections, getMockWritingMode, findCurrentSubmissionRecord,
    submissionContentConfigFor].every(Boolean)) {
    throw new Error('Sponsored evaluation dependencies are missing.')
  }

  function refsFor(context, submissionRef, after) {
    const config = SOURCE_CONFIG[context]
    if (!config || !submissionRef?.id ||
        !submissionRef.path?.startsWith(`${config.submissionCollection}/`) ||
        !STUDENT_ID_PATTERN.test(after.uid) || after.uid !== after.studentId ||
        !ID_PATTERN.test(after[config.sourceField]) ||
        schoolIdOf(after) !== PILOT_SCHOOL_ID) return null
    const contentId = after[config.sourceField]
    const uid = after.uid
    const jobId = sha(['ai-writing-v1', uid, context, contentId, after.attemptNumber].join('\0'))
    return {
      context, config, uid, contentId, jobId, attemptNumber: after.attemptNumber,
      submissionRef,
      userRef: db.doc(`users/${uid}`), schoolRef: db.doc(`schools/${PILOT_SCHOOL_ID}`),
      settingsRef: db.doc(`aiWritingSchoolSettings/${PILOT_SCHOOL_ID}`),
      policyRef: db.doc(`aiWritingSponsoredPolicies/${config.contentType}_${contentId}`),
      sourceRef: db.doc(`${config.sourceCollection}/${contentId}`),
      assignmentRef: db.doc(`studentAccess/${uid}_${config.contentType}_${contentId}`),
      controlRef: db.doc(`submissionAttemptControls/${sha(`${uid}\u001f${config.contentType}\u001f${contentId}`)}`),
      jobRef: db.doc(`aiWritingEvaluations/${jobId}`),
      eventSignature: submissionSignature(context, after), eventSubmittedAt: after.submittedAt
    }
  }

  function checkedState(context, snaps, refs) {
    const [submission, user, school, settings, policy, source, assignment, control, linked] = snaps.map(dataOf)
    if (!submission || !active(submission) || submission.uid !== refs.uid ||
        submission.studentId !== refs.uid || submission.attemptNumber !== refs.attemptNumber ||
        submissionSignature(context, submission) !== refs.eventSignature ||
        schoolIdOf(submission) !== PILOT_SCHOOL_ID ||
        !active(user) || user.role !== 'student' || user.status !== 'approved' ||
        !['', 'institution'].includes(typeof user.accountType === 'string'
          ? user.accountType.trim().toLowerCase() : '') ||
        schoolIdOf(user) !== PILOT_SCHOOL_ID ||
        school?.status !== 'active' ||
        settings?.schoolId !== PILOT_SCHOOL_ID || settings.pilotEnabled !== true ||
        policy?.schoolId !== PILOT_SCHOOL_ID || policy.enabled !== true ||
        policy.billing !== 'institution' || policy.context !== context ||
        policy.contentId !== refs.contentId || policy.contentType !== refs.config.contentType ||
        policy.sourceCollection !== refs.config.sourceCollection ||
        !Array.isArray(policy.studentIds) || policy.studentIds.length === 0 ||
        policy.studentIds.length > MAX_STUDENTS_PER_POLICY ||
        policy.studentIds.some(id => typeof id !== 'string' || !STUDENT_ID_PATTERN.test(id)) ||
        new Set(policy.studentIds).size !== policy.studentIds.length ||
        !policy.studentIds.includes(refs.uid) ||
        policyUpdatedAfterSubmission(policy, submission) ||
        !active(source) || schoolIdOf(source) !== PILOT_SCHOOL_ID ||
        !assignment || assignment.uid !== refs.uid || assignment.schoolId !== PILOT_SCHOOL_ID ||
        assignment.contentId !== refs.contentId ||
        assignment.contentType !== refs.config.contentType ||
        assignment.sourceCollection !== refs.config.sourceCollection ||
        assignment.accessType !== 'assignment' || assignment.status !== 'active' ||
        assignment.adminHidden === true || control?.status === 'open' ||
        submission[refs.config.sourceField] !== refs.contentId) return null
    try {
      if (context === 'homework') {
        return { prepared: prepareAiWritingEvaluation({ context, source, submission }) }
      }
      if (getMockEnabledSections(source)?.writing !== true ||
          !ID_PATTERN.test(source.writingId || '') ||
          !linked || !active(linked) || schoolIdOf(linked) !== PILOT_SCHOOL_ID ||
          submission.writingId !== source.writingId ||
          submission.enabledSections?.writing !== true) return null
      const mode = getMockWritingMode(source, linked)
      if (!['full_writing', 'task1_only', 'task2_only'].includes(mode) ||
          submission.writingMode !== mode) return null
      return { prepared: prepareAiWritingEvaluation({
        context, source: { ...linked, contentType: mode }, submission
      }) }
    } catch (_) {
      // Missing Task 1 image, incomplete text or invalid source: fail closed.
      return null
    }
  }

  async function getAuthorizedState(reader, refs) {
    const baseRefs = [refs.submissionRef, refs.userRef, refs.schoolRef,
      refs.settingsRef, refs.policyRef, refs.sourceRef, refs.assignmentRef, refs.controlRef]
    const baseSnaps = await Promise.all(baseRefs.map(ref => reader.get(ref)))
    const source = dataOf(baseSnaps[5])
    const linkedRef = refs.context === 'mock' && ID_PATTERN.test(source?.writingId || '')
      ? db.doc(`writingHomeworks/${source.writingId}`) : null
    const linkedSnap = linkedRef ? await reader.get(linkedRef) : null
    const checked = checkedState(refs.context, [...baseSnaps, linkedSnap], refs)
    if (!checked) return null
    return { ...checked, fingerprint: sha(JSON.stringify(checked.prepared)), linkedRef }
  }

  async function submit(context, event) {
    const before = event?.data?.before?.exists ? event.data.before.data() : null
    const afterSnap = event?.data?.after
    const after = dataOf(afterSnap)
    if (!isNewSubmittedAttempt(context, before, after)) return { status: 'ignored' }
    // IMPORTANT: The trigger must be separately, explicitly enabled by an operator.
    if (providerEnabled() !== true) return { status: 'disabled' }
    const key = getApiKey()
    if (typeof key !== 'string' || !key.startsWith('sk-') || key.length < 20) {
      return { status: 'disabled' }
    }
    const refs = refsFor(context, afterSnap.ref, after)
    if (!refs) return { status: 'ignored' }
    const config = submissionContentConfigFor(refs.config.contentType)
    const current = await findCurrentSubmissionRecord(config, refs.uid, refs.contentId)
    if (!current?.ref || current.ref.path !== refs.submissionRef.path ||
        current.data?.attemptNumber !== refs.attemptNumber) return { status: 'stale' }

    const first = await getAuthorizedState({ get: ref => ref.get() }, refs)
    if (!first) return { status: 'ineligible' }

    const time = now()
    const month = new Date(time).toISOString().slice(0, 7).replace('-', '')
    const monthlyRef = db.doc(`aiWritingMonthlyUsage/${PILOT_SCHOOL_ID}_${month}`)
    const leaseId = randomBytes(16).toString('hex')
    const reservation = await db.runTransaction(async tx => {
      const [jobSnap, monthSnap] = await Promise.all([
        tx.get(refs.jobRef), tx.get(monthlyRef)
      ])
      const existing = dataOf(jobSnap)
      if (existing) {
        // Do not steal a student-funded lease or repeat a billed provider request.
        if (existing.jobId !== refs.jobId || existing.studentId !== refs.uid ||
            existing.contentId !== refs.contentId || existing.context !== context ||
            existing.attemptNumber !== refs.attemptNumber) return { kind: 'conflict' }
        return { kind: existing.status === 'completed' ? 'completed' : 'already_started' }
      }
      const fresh = await getAuthorizedState(tx, refs)
      if (!fresh || fresh.fingerprint !== first.fingerprint) return { kind: 'ineligible' }
      const monthly = dataOf(monthSnap)
      const count = monthly ? integer(monthly.requestCount) : 0
      const pending = monthly ? integer(monthly.pendingCount) : 0
      const completed = monthly ? integer(monthly.completedCount) : 0
      const sponsoredCount = monthly?.sponsoredRequestCount === undefined ? 0
        : integer(monthly.sponsoredRequestCount)
      if (count === null || pending === null || completed === null ||
          sponsoredCount === null ||
          (monthly && (monthly.schoolId !== PILOT_SCHOOL_ID || monthly.month !== month))) {
        return { kind: 'invalid_budget' }
      }
      if (count >= MAX_MONTHLY_SCHOOL_EVALUATIONS) return { kind: 'budget_exhausted' }
      // At-most-one model reservation per attempt across both billing paths.
      // Never update aiWritingStudentAccess or aiWritingCreditOperations.
      tx.set(monthlyRef, {
        schemaVersion: 1, schoolId: PILOT_SCHOOL_ID, month,
        requestCount: count + 1, sponsoredRequestCount: sponsoredCount + 1,
        pendingCount: pending + 1, completedCount: completed,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })
      tx.create(refs.jobRef, {
        schemaVersion: 1, jobId: refs.jobId, studentId: refs.uid, uid: refs.uid,
        schoolId: PILOT_SCHOOL_ID, context, contentId: refs.contentId,
        contentType: refs.config.contentType, attemptNumber: refs.attemptNumber,
        fingerprint: fresh.fingerprint, submissionId: refs.submissionRef.id,
        billing: 'institution', billingMode: 'sponsored_auto',
        sponsoredPolicyId: refs.policyRef.id, status: 'processing',
        leaseId, leaseUntilMs: time + LEASE_MS, month,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      })
      return { kind: 'reserved', fingerprint: fresh.fingerprint }
    })
    if (reservation.kind !== 'reserved') return { status: reservation.kind }

    async function failJob(reason) {
      return db.runTransaction(async tx => {
        const [jobSnap, monthSnap] = await Promise.all([
          tx.get(refs.jobRef), tx.get(monthlyRef)
        ])
        const job = dataOf(jobSnap)
        if (!job || job.status !== 'processing' || job.leaseId !== leaseId ||
            job.billingMode !== 'sponsored_auto') return false
        const monthly = dataOf(monthSnap)
        const pending = integer(monthly?.pendingCount)
        if (pending === null || pending < 1) throw new Error('Sponsored AI budget reconciliation requires administrator review.')
        tx.update(refs.jobRef, {
          status: 'failed', leaseUntilMs: 0,
          lastFailureCode: reason, updatedAt: FieldValue.serverTimestamp()
        })
        tx.update(monthlyRef, {
          pendingCount: pending - 1, updatedAt: FieldValue.serverTimestamp()
        })
        return true
      })
    }

    try {
      const response = await provider(first.prepared, key)
      const report = response?.report
      const hasTask = task => task && typeof task === 'object' &&
        Number.isFinite(task.estimatedBand) && task.estimatedBand >= 0 && task.estimatedBand <= 9 &&
        task.criteria && typeof task.criteria === 'object' &&
        ['taskAchievementOrResponse', 'coherenceAndCohesion', 'lexicalResource',
          'grammaticalRangeAndAccuracy'].every(key =>
          Number.isFinite(task.criteria[key]?.band) &&
          typeof task.criteria[key]?.explanation === 'string')
      if (!report || report.isAiEstimate !== true || report.context !== context ||
          report.teacherFinalScore !== null ||
          !Number.isFinite(report.estimatedBand) || report.estimatedBand < 0 ||
          report.estimatedBand > 9 ||
          !['full_writing','task1_only','task2_only'].includes(report.writingMode) ||
          (first.prepared.task1 && !hasTask(report.task1)) ||
          (first.prepared.task2 && !hasTask(report.task2)) ||
          (context === 'mock' && report.isProvisionalMockEstimate !== true) ||
          typeof response.model !== 'string' || !response.model.trim()) {
        throw new Error('Provider report validation failed.')
      }
      const settled = await db.runTransaction(async tx => {
        const [jobSnap, monthSnap] = await Promise.all([
          tx.get(refs.jobRef), tx.get(monthlyRef)
        ])
        const job = dataOf(jobSnap)
        if (!job || job.status !== 'processing' || job.leaseId !== leaseId ||
            job.billingMode !== 'sponsored_auto' || job.fingerprint !== reservation.fingerprint ||
            job.leaseUntilMs <= now()) return false
        const fresh = await getAuthorizedState(tx, refs)
        if (!fresh || fresh.fingerprint !== reservation.fingerprint) return false
        const monthly = dataOf(monthSnap)
        const pending = integer(monthly?.pendingCount)
        const completed = integer(monthly?.completedCount)
        if (pending === null || pending < 1 || completed === null) return false
        tx.update(refs.jobRef, {
          status: 'completed', report: response.report,
          providerModel: response.model,
          providerResponseId: response.providerResponseId || '',
          leaseUntilMs: 0, completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        })
        tx.update(monthlyRef, {
          pendingCount: pending - 1, completedCount: completed + 1,
          updatedAt: FieldValue.serverTimestamp()
        })
        return true
      })
      if (settled) return { status: 'completed' }
      await failJob('state_changed')
      return { status: 'failed' }
    } catch (_) {
      // Never expose the provider error body or the submitted essay to logs.
      await failJob('provider_or_settlement_failure')
      return { status: 'failed' }
    }
  }

  return { submit }
}

module.exports = {
  createAiWritingSponsoredEvaluationService,
  isNewSubmittedAttempt,
  submissionSignature,
  policyUpdatedAfterSubmission,
  MAX_MONTHLY_SCHOOL_EVALUATIONS
}
