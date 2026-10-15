'use strict'

// P5A-2B: Institution-only, default-OFF server-owned AI Writing evaluation.
// This module must never accept prompt text, images, or student answers from a callable request.
// Only source and submitted attempts read from Firestore are model input.
const { createHash, randomBytes } = require('crypto')
const { prepareAiWritingEvaluation } = require('./aiWritingGrading')

const PILOT_SCHOOL_ID = 'maxima'
const MAX_MONTHLY_SCHOOL_EVALUATIONS = 60
const MAX_CREDIT_BALANCE = 1000
const LEASE_MS = 180000 // Greater than the transport's 90-second timeout.
const MAX_CONTENT_ID_LENGTH = 150

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const validInteger = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback
const dataOf = snap => snap?.exists ? (snap.data() || {}) : null
const isActiveStudent = user => user?.role === 'student' && user.status === 'approved' &&
  user.deleted !== true && user.accountType !== 'individual' && user.schoolId !== '__individual__'

function createAiWritingEvaluationService({
  db, FieldValue, HttpsError, requireStudent, requireStudentAttemptSource,
  submissionContentConfigFor, findCurrentSubmissionRecord, getOpenSubmissionAttemptControl,
  schoolIdOf, getMockEnabledSections, getMockWritingMode,
  provider, getApiKey, providerEnabled = () => false, now = () => Date.now()
}) {
  if (![db, FieldValue, HttpsError, requireStudent, requireStudentAttemptSource,
    submissionContentConfigFor, findCurrentSubmissionRecord, getOpenSubmissionAttemptControl,
    schoolIdOf, getMockEnabledSections, getMockWritingMode, provider, getApiKey].every(Boolean)) {
    throw new Error('AI evaluation service dependencies are missing.')
  }
  const fail = (code, message) => { throw new HttpsError(code, message) }
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value)
  const ownership = (item, student) => Boolean(item && item.uid === student.uid &&
    item.studentId === student.uid && schoolIdOf(item) === student.schoolId)

  function parseInput(request) {
    const input = request?.data
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['context', 'contentId'].includes(key))) {
      fail('invalid-argument', 'Only context and contentId may be supplied.')
    }
    const context = input.context
    const contentId = input.contentId
    if (!['homework', 'mock'].includes(context) || !validId(contentId) ||
      contentId.length > MAX_CONTENT_ID_LENGTH) {
      fail('invalid-argument', 'Choose a valid submitted Writing or Mock assignment.')
    }
    return { context, contentId, contentType: context === 'homework' ? 'writing' : 'mock' }
  }

  function makePrepared(context, source, linkedWriting, submission) {
    if (context === 'homework') {
      return prepareAiWritingEvaluation({ context, source, submission })
    }
    const sections = getMockEnabledSections(source)
    if (sections?.writing !== true || !linkedWriting || !source.writingId) {
      fail('failed-precondition', 'This mock does not include a Writing section.')
    }
    const mode = getMockWritingMode(source, linkedWriting)
    if (!['full_writing', 'task1_only', 'task2_only'].includes(mode) ||
        submission.writingId !== source.writingId ||
        submission.enabledSections?.writing !== true ||
        submission.writingMode !== mode) {
      fail('failed-precondition', 'The linked Mock Writing resource has changed.')
    }
    return prepareAiWritingEvaluation({
      context, source: { ...linkedWriting, contentType: mode }, submission
    })
  }

  function validateFresh({ student, context, contentId, source, submission, linkedWriting, assignment }) {
    if (!ownership(submission, student) ||
        (context === 'homework' ? submission.writingId : submission.mockTestId) !== contentId) {
      fail('permission-denied', 'The submitted attempt is not owned by this student.')
    }
    if (!source || source.archived === true || source.deleted === true ||
        schoolIdOf(source) !== student.schoolId ||
        (context === 'mock' && (!linkedWriting || linkedWriting.archived === true ||
          linkedWriting.deleted === true || schoolIdOf(linkedWriting) !== student.schoolId))) {
      fail('failed-precondition', 'The assignment or its linked Writing resource is unavailable.')
    }
    const contentType = context === 'mock' ? 'mock' : 'writing'
    if (!assignment || assignment.uid !== student.uid || assignment.schoolId !== student.schoolId ||
        assignment.contentType !== contentType || assignment.contentId !== contentId ||
        assignment.sourceCollection !== (context === 'mock' ? 'mockTests' : 'writingHomeworks') ||
        assignment.accessType !== 'assignment' || assignment.status !== 'active' ||
        assignment.adminHidden === true) {
      fail('permission-denied', 'The assignment is no longer accessible.')
    }
    const attemptNumber = validInteger(submission.attemptNumber, 1)
    if (attemptNumber < 1 || attemptNumber > 1000) {
      fail('failed-precondition', 'Invalid submission attempt number.')
    }
    const prepared = makePrepared(context, source, linkedWriting, submission)
    const fingerprint = sha(JSON.stringify(prepared))
    return { prepared, fingerprint, attemptNumber }
  }

  async function readEvidence(student, { context, contentType, contentId }) {
    if (student.schoolId !== PILOT_SCHOOL_ID || student.profile?.accountType === 'individual') {
      fail('permission-denied', 'The AI Writing pilot is restricted to Maxima institution accounts.')
    }
    const config = submissionContentConfigFor(contentType)
    await requireStudentAttemptSource(student, config, contentId)
    const current = await findCurrentSubmissionRecord(config, student.uid, contentId)
    if (!current?.ref) fail('failed-precondition', 'Submit this assignment before requesting AI evaluation.')
    if (await getOpenSubmissionAttemptControl(config, student.uid, contentId, current)) {
      fail('failed-precondition', 'Finish the reopened attempt before requesting its AI report.')
    }
    const sourceRef = db.doc(`${config.sourceCollection}/${contentId}`)
    const submissionRef = current.ref
    const assignmentRef = db.doc(`studentAccess/${student.uid}_${contentType}_${contentId}`)
    const [sourceSnap, submissionSnap, assignmentSnap] = await Promise.all([
      sourceRef.get(), submissionRef.get(), assignmentRef.get()
    ])
    const source = dataOf(sourceSnap)
    const writingId = context === 'mock' && typeof source?.writingId === 'string' &&
      validId(source.writingId) ? source.writingId : ''
    const linkedRef = writingId ? db.doc(`writingHomeworks/${writingId}`) : null
    const linkedSnap = linkedRef ? await linkedRef.get() : null
    const currentSubmission = dataOf(submissionSnap)
    const { prepared, fingerprint, attemptNumber } = validateFresh({
      student, context, contentId, source, submission: currentSubmission,
      linkedWriting: dataOf(linkedSnap), assignment: dataOf(assignmentSnap)
    })
    const jobId = sha(['ai-writing-v1', student.uid, context, contentId, attemptNumber].join('\0'))
    return {
      student, context, contentId, contentType, attemptNumber, fingerprint, prepared,
      submittedAt: currentSubmission?.submittedAt,
      jobId, jobRef: db.doc(`aiWritingEvaluations/${jobId}`),
      sourceRef, submissionRef, assignmentRef, linkedRef,
      userRef: db.doc(`users/${student.uid}`), schoolRef: db.doc(`schools/${student.schoolId}`),
      settingsRef: db.doc(`aiWritingSchoolSettings/${student.schoolId}`),
      accessRef: db.doc(`aiWritingStudentAccess/${student.uid}`),
      controlRef: db.doc(`submissionAttemptControls/${sha(`${student.uid}\u001f${contentType}\u001f${contentId}`)}`)
    }
  }

  // Every critical input is read again IN the transaction to eliminate time-of-check races.
  async function freshInTx(tx, evidence, { checkPilot = false } = {}) {
    const refs = [evidence.userRef, evidence.schoolRef, evidence.settingsRef,
      evidence.accessRef, evidence.assignmentRef, evidence.sourceRef,
      evidence.submissionRef, evidence.controlRef]
    if (evidence.linkedRef) refs.push(evidence.linkedRef)
    const snaps = await Promise.all(refs.map(ref => tx.get(ref)))
    const [userSnap, schoolSnap, settingsSnap, accessSnap, assignmentSnap,
      sourceSnap, submissionSnap, controlSnap, linkedSnap] = snaps
    const user = dataOf(userSnap)
    const school = dataOf(schoolSnap)
    const settings = dataOf(settingsSnap)
    const access = dataOf(accessSnap)
    const control = dataOf(controlSnap)
    if (!isActiveStudent(user) || schoolIdOf(user) !== evidence.student.schoolId ||
        school?.status !== 'active') {
      fail('permission-denied', 'Student or institution is no longer active.')
    }
    if (control?.status === 'open') {
      fail('failed-precondition', 'A Writing retake is currently open.')
    }
    const fresh = validateFresh({
      student: evidence.student, context: evidence.context, contentId: evidence.contentId,
      source: dataOf(sourceSnap), submission: dataOf(submissionSnap),
      assignment: dataOf(assignmentSnap), linkedWriting: dataOf(linkedSnap)
    })
    if (fresh.fingerprint !== evidence.fingerprint || fresh.attemptNumber !== evidence.attemptNumber) {
      fail('failed-precondition', 'This submitted attempt changed; reload the assignment.')
    }
    if (checkPilot) {
      const validAccess = access?.studentId === evidence.student.uid &&
        access?.uid === evidence.student.uid && access?.schoolId === evidence.student.schoolId &&
        access?.accountType === 'institution' && access?.enabled === true
      if (!validAccess || settings?.schoolId !== evidence.student.schoolId ||
          settings?.pilotEnabled !== true) {
        fail('permission-denied', 'AI Writing access is not enabled for this student.')
      }
    }
    return { access, settings }
  }

  function requireMatchingJob(data, evidence) {
    if (!data || data.jobId !== evidence.jobId || data.studentId !== evidence.student.uid ||
        data.schoolId !== evidence.student.schoolId || data.context !== evidence.context ||
        data.contentId !== evidence.contentId || data.attemptNumber !== evidence.attemptNumber ||
        data.fingerprint !== evidence.fingerprint) {
      fail('failed-precondition', 'Existing AI report ownership or content does not match.')
    }
  }

  async function reserve(evidence) {
    const time = now()
    const month = new Date(time).toISOString().slice(0, 7).replace('-', '')
    const monthlyRef = db.doc(`aiWritingMonthlyUsage/${evidence.student.schoolId}_${month}`)
    const leaseId = randomBytes(16).toString('hex')
    const ledgerId = sha(`ai-credit-reservation\0${evidence.jobId}\0${leaseId}`)
    const ledgerRef = db.doc(`aiWritingCreditOperations/${ledgerId}`)
    return db.runTransaction(async tx => {
      const [jobSnap, monthSnap] = await Promise.all([tx.get(evidence.jobRef), tx.get(monthlyRef)])
      const job = dataOf(jobSnap)
      if (job) {
        requireMatchingJob(job, evidence)
        if (job.status === 'completed') {
          return { kind: 'completed', report: job.report }
        }
        if (job.status === 'processing' && validInteger(job.leaseUntilMs) > time) {
          return { kind: 'processing', retryAfterSeconds: Math.max(1,
            Math.ceil((job.leaseUntilMs - time) / 1000)) }
        }
        // Institution-funded jobs are never taken over by a student credit flow.
        if (job.billingMode === 'sponsored_auto') {
          fail('failed-precondition', 'This assignment has an institution-funded AI evaluation. Contact your teacher if it failed.')
        }
      }
      const { access } = await freshInTx(tx, evidence, { checkPilot: true })
      const ledgerSnap = await tx.get(ledgerRef)
      if (ledgerSnap.exists) fail('aborted', 'Duplicate AI reservation token.')
      const monthData = dataOf(monthSnap) || {}
      // Bound real provider REQUESTS, including paid calls that later fail/refund.
      // A completed-count-only limit would permit unlimited failing API charges.
      const requestCount = validInteger(monthData.requestCount)
      const reuseExistingHold = job?.status === 'processing' &&
        validInteger(job.leaseUntilMs) <= time && job.activeLedgerId
      if (requestCount >= MAX_MONTHLY_SCHOOL_EVALUATIONS) {
        fail('resource-exhausted', 'This school has reached its monthly AI request limit.')
      }
      const balance = access?.creditsRemaining
      if (!reuseExistingHold && (!Number.isSafeInteger(balance) || balance <= 0 ||
          balance > MAX_CREDIT_BALANCE)) {
        fail('resource-exhausted', 'No AI Writing credits remain.')
      }
      const activeLedgerRef = reuseExistingHold
        ? db.doc(`aiWritingCreditOperations/${job.activeLedgerId}`) : ledgerRef
      if (reuseExistingHold) {
        const originalLedger = await tx.get(activeLedgerRef)
        if (!originalLedger.exists || originalLedger.data()?.status !== 'reserved' ||
            originalLedger.data()?.jobId !== evidence.jobId) {
          fail('failed-precondition', 'Expired AI reservation needs administrator recovery.')
        }
      }
      // No transaction writes until ALL document reads above have finished.
      if (!reuseExistingHold) {
        tx.update(evidence.accessRef, {
          creditsRemaining: balance - 1, updatedAt: FieldValue.serverTimestamp()
        })
        tx.create(ledgerRef, {
          action: 'ai_evaluation_reservation', schemaVersion: 1,
          jobId: evidence.jobId, studentId: evidence.student.uid,
          schoolId: evidence.student.schoolId, contentType: evidence.contentType,
          context: evidence.context, contentId: evidence.contentId,
          attemptNumber: evidence.attemptNumber, creditDelta: -1,
          status: 'reserved', createdAt: FieldValue.serverTimestamp()
        })
      }
      // Increment for every new model request, even if an expired lease
      // reuses an existing held student credit. Never refund this cost ceiling.
      tx.set(monthlyRef, {
        schemaVersion: 1, schoolId: evidence.student.schoolId, month,
        requestCount: requestCount + 1,
        ...(!reuseExistingHold ? {
          completedCount: validInteger(monthData.completedCount),
          pendingCount: validInteger(monthData.pendingCount) + 1
        } : {}),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })
      tx.set(evidence.jobRef, {
        schemaVersion: 1, jobId: evidence.jobId,
        studentId: evidence.student.uid, uid: evidence.student.uid,
        schoolId: evidence.student.schoolId, context: evidence.context,
        contentId: evidence.contentId, contentType: evidence.contentType,
        attemptNumber: evidence.attemptNumber, fingerprint: evidence.fingerprint,
        submissionId: evidence.submissionRef.id, status: 'processing',
        leaseId, leaseUntilMs: time + LEASE_MS, month,
        activeLedgerId: reuseExistingHold ? job.activeLedgerId : ledgerId,
        createdAt: job?.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })
      return { kind: 'reserved', leaseId,
        ledgerId: reuseExistingHold ? job.activeLedgerId : ledgerId, month, monthlyRef }
    })
  }

  async function settle(evidence, reservation, providerResult) {
    if (!providerResult?.report || providerResult.report.isAiEstimate !== true ||
        providerResult.report.context !== evidence.context ||
        typeof providerResult.model !== 'string') {
      throw new Error('AI provider report did not pass grading validation.')
    }
    return db.runTransaction(async tx => {
      const [jobSnap, ledgerSnap, monthSnap] = await Promise.all([
        tx.get(evidence.jobRef), tx.get(db.doc(`aiWritingCreditOperations/${reservation.ledgerId}`)),
        tx.get(reservation.monthlyRef)
      ])
      const job = dataOf(jobSnap)
      requireMatchingJob(job, evidence)
      if (job.status !== 'processing' || job.leaseId !== reservation.leaseId ||
          job.activeLedgerId !== reservation.ledgerId) {
        fail('aborted', 'AI evaluation already changed; this result was not saved.')
      }
      if (job.leaseUntilMs <= now()) fail('deadline-exceeded', 'AI evaluation expired.')
      const { access } = await freshInTx(tx, evidence, { checkPilot: true })
      const ledger = dataOf(ledgerSnap)
      const monthData = dataOf(monthSnap)
      if (!ledger || ledger.status !== 'reserved' || !monthData ||
          validInteger(monthData.pendingCount) < 1 ||
          !Number.isSafeInteger(access.creditsUsedTotal) || access.creditsUsedTotal < 0) {
        fail('failed-precondition', 'AI credit settlement audit is inconsistent.')
      }
      // Persist ONLY structured report and metadata; never essay, image, or prompt.
      tx.update(evidence.jobRef, {
        status: 'completed', report: providerResult.report,
        providerModel: providerResult.model,
        providerResponseId: providerResult.providerResponseId || '',
        leaseUntilMs: 0, completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })
      tx.update(evidence.accessRef, {
        creditsUsedTotal: access.creditsUsedTotal + 1,
        updatedAt: FieldValue.serverTimestamp()
      })
      tx.update(db.doc(`aiWritingCreditOperations/${reservation.ledgerId}`), {
        status: 'settled', settledAt: FieldValue.serverTimestamp()
      })
      tx.update(reservation.monthlyRef, {
        pendingCount: validInteger(monthData.pendingCount) - 1,
        completedCount: validInteger(monthData.completedCount) + 1,
        updatedAt: FieldValue.serverTimestamp()
      })
      return { status: 'completed', context: evidence.context, contentId: evidence.contentId,
        attemptNumber: evidence.attemptNumber, report: providerResult.report, reused: false }
    })
  }

  async function refund(evidence, leaseId, ledgerId, monthlyRef, reason = 'provider_failure') {
    return db.runTransaction(async tx => {
      const [jobSnap, ledgerSnap, accessSnap, monthSnap] = await Promise.all([
        tx.get(evidence.jobRef), tx.get(db.doc(`aiWritingCreditOperations/${ledgerId}`)),
        tx.get(evidence.accessRef), tx.get(monthlyRef)
      ])
      const job = dataOf(jobSnap)
      if (!job || job.status !== 'processing' || job.leaseId !== leaseId ||
          job.activeLedgerId !== ledgerId) return false
      requireMatchingJob(job, evidence)
      const ledger = dataOf(ledgerSnap)
      if (!ledger || ledger.status !== 'reserved') {
        fail('failed-precondition', 'AI refund ledger is inconsistent.')
      }
      const access = dataOf(accessSnap)
      if (access && access.uid === evidence.student.uid && access.studentId === evidence.student.uid &&
          access.schoolId === evidence.student.schoolId && access.accountType === 'institution') {
        const balance = access.creditsRemaining
        if (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_CREDIT_BALANCE) {
          fail('failed-precondition', 'AI credit balance is invalid; contact an administrator.')
        }
        tx.update(evidence.accessRef, {
          // A concurrent admin top-up may fill the 1000-credit pilot cap.
          creditsRemaining: Math.min(MAX_CREDIT_BALANCE, balance + 1),
          updatedAt: FieldValue.serverTimestamp()
        })
      }
      const monthData = dataOf(monthSnap)
      if (!monthData || validInteger(monthData.pendingCount) < 1) {
        fail('failed-precondition', 'AI monthly usage audit is inconsistent.')
      }
      tx.update(monthlyRef, {
        pendingCount: validInteger(monthData.pendingCount) - 1,
        updatedAt: FieldValue.serverTimestamp()
      })
      tx.update(db.doc(`aiWritingCreditOperations/${ledgerId}`), {
        status: 'refunded', refundedAt: FieldValue.serverTimestamp(), reason
      })
      tx.update(evidence.jobRef, {
        status: 'failed', leaseUntilMs: 0, activeLedgerId: '',
        lastFailureCode: reason, updatedAt: FieldValue.serverTimestamp()
      })
      return true
    })
  }

  async function evaluate(request) {
    const input = parseInput(request)
    const student = await requireStudent(request)
    // Deploy remains fail-closed until the operator explicitly enables the provider.
    if (providerEnabled() !== true) {
      fail('failed-precondition', 'AI Writing is not connected yet. No credits were used.')
    }
    const secret = getApiKey()
    if (typeof secret !== 'string' || !secret.startsWith('sk-')) {
      fail('failed-precondition', 'AI Writing provider secret is not configured.')
    }
    const evidence = await readEvidence(student, input)
    const reservation = await reserve(evidence)
    if (reservation.kind === 'completed') {
      return { status: 'completed', context: evidence.context, contentId: evidence.contentId,
        attemptNumber: evidence.attemptNumber, report: reservation.report, reused: true }
    }
    if (reservation.kind === 'processing') return { status: 'processing', ...reservation }
    try {
      const result = await provider(evidence.prepared, secret)
      return await settle(evidence, reservation, result)
    } catch (_) {
      // Never return/log raw provider errors; they can contain private essay text.
      try {
        const refunded = await refund(evidence, reservation.leaseId, reservation.ledgerId,
          reservation.monthlyRef)
        if (!refunded) {
          fail('aborted', 'A newer AI evaluation request owns this attempt; check its status.')
        }
      } catch (error) {
        if (error?.code === 'aborted') throw error
        fail('internal', 'AI evaluation failed and credit reconciliation needs administrator review.')
      }
      fail('unavailable', 'AI evaluation could not finish. Your AI credit was returned; try again later.')
    }
  }

  // Read-only indication that the teacher selected THIS submitted attempt for
  // institution-funded automatic assessment. No credit access is required and
  // this read never starts a model call. A revoked/late policy stays hidden.
  async function pendingInstitutionSponsoredReport(evidence) {
    const submittedMs = typeof evidence.submittedAt === 'string'
      ? Date.parse(evidence.submittedAt) : NaN
    if (!Number.isFinite(submittedMs)) return false
    const contentType = evidence.context === 'mock' ? 'mock' : 'writing'
    const collection = evidence.context === 'mock' ? 'mockTests' : 'writingHomeworks'
    const policyRef = db.doc(`aiWritingSponsoredPolicies/${contentType}_${evidence.contentId}`)
    const [policySnap, settingsSnap] = await Promise.all([
      policyRef.get(), evidence.settingsRef.get()
    ])
    const policy = dataOf(policySnap)
    const settings = dataOf(settingsSnap)
    if (settings?.schoolId !== PILOT_SCHOOL_ID || settings.pilotEnabled !== true ||
        policy?.schoolId !== PILOT_SCHOOL_ID || policy.enabled !== true ||
        policy.billing !== 'institution' || policy.context !== evidence.context ||
        policy.contentId !== evidence.contentId || policy.contentType !== contentType ||
        policy.sourceCollection !== collection ||
        !Array.isArray(policy.studentIds) || policy.studentIds.length < 1 ||
        policy.studentIds.length > 60 || new Set(policy.studentIds).size !== policy.studentIds.length ||
        policy.studentIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(id)) ||
        !policy.studentIds.includes(evidence.student.uid)) return false
    const updated = policy.updatedAt
    const updatedMs = typeof updated?.toMillis === 'function' ? updated.toMillis()
      : updated instanceof Date ? updated.getTime()
        : typeof updated === 'string' ? Date.parse(updated) : NaN
    return Number.isFinite(updatedMs) && updatedMs <= submittedMs
  }

  async function getReport(request) {
    const input = parseInput(request)
    const student = await requireStudent(request)
    const evidence = await readEvidence(student, input)
    const snap = await evidence.jobRef.get()
    if (!snap.exists) return { status: 'not_started', context: input.context,
      contentId: input.contentId, institutionFunded: await pendingInstitutionSponsoredReport(evidence) }
    const job = snap.data() || {}
    requireMatchingJob(job, evidence)
    if (job.status === 'processing') {
      // Sponsored jobs do not have a student-credit ledger. Never run the
      // personal-credit refund/retry path for an institution-funded attempt.
      if (job.billingMode === 'sponsored_auto' && validInteger(job.leaseUntilMs) <= now()) {
        return { status: 'failed', canRetry: false, institutionFunded: true }
      }
      if (validInteger(job.leaseUntilMs) <= now() && job.activeLedgerId && job.month) {
        const ref = db.doc(`aiWritingMonthlyUsage/${student.schoolId}_${job.month}`)
        const refunded = await refund(evidence, job.leaseId, job.activeLedgerId, ref, 'expired_reservation')
        return refunded
          ? { status: 'failed', canRetry: true, creditReconciled: true }
          : { status: 'processing', retryAfterSeconds: 5 }
      }
      return { status: 'processing', retryAfterSeconds: Math.max(1,
        Math.ceil((job.leaseUntilMs - now()) / 1000)),
        institutionFunded: job.billingMode === 'sponsored_auto' }
    }
    if (job.status === 'completed') return {
      status: 'completed', context: input.context, contentId: input.contentId,
      attemptNumber: evidence.attemptNumber, report: job.report, reused: true,
      institutionFunded: job.billingMode === 'sponsored_auto'
    }
    return { status: 'failed', canRetry: job.billingMode !== 'sponsored_auto',
      institutionFunded: job.billingMode === 'sponsored_auto' }
  }

  return { evaluate, getReport }
}

module.exports = { createAiWritingEvaluationService, MAX_MONTHLY_SCHOOL_EVALUATIONS, LEASE_MS }
