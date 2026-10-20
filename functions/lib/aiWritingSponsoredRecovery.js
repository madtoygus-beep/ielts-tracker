'use strict'

// P0-A: idempotent repair for expired institution-funded AI Writing jobs.
// NO provider calls, NO student-credit writes and NO decrement to provider
// requestCount or sponsoredRequestCount (a request may already have been billed).
const PILOT_SCHOOL_ID = 'maxima'
const HASH = /^[a-f0-9]{64}$/
const MONTH = /^20\d{2}(0[1-9]|1[0-2])$/
const dataOf = snap => snap?.exists ? (snap.data() || {}) : null
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null

function createAiWritingSponsoredRecoveryService({ db, FieldValue, now = () => Date.now() }) {
  if (!db || !FieldValue || typeof now !== 'function') {
    throw new Error('Sponsored recovery dependencies are missing.')
  }

  async function reconcileJob({ jobId, expectedStudentId = null } = {}) {
    if (typeof jobId !== 'string' || !HASH.test(jobId) ||
        (expectedStudentId !== null &&
          (typeof expectedStudentId !== 'string' || !expectedStudentId))) {
      return { status: 'ineligible' }
    }
    const jobRef = db.doc(`aiWritingEvaluations/${jobId}`)
    return db.runTransaction(async tx => {
      const job = dataOf(await tx.get(jobRef))
      if (!job) return { status: 'not_found' }
      // This recovery must never touch student-funded or teacher-request jobs.
      if (job.jobId !== jobId || job.schoolId !== PILOT_SCHOOL_ID ||
          job.billing !== 'institution' || job.billingMode !== 'sponsored_auto' ||
          !['homework', 'mock'].includes(job.context) ||
          typeof job.studentId !== 'string' || !job.studentId ||
          (expectedStudentId !== null && job.studentId !== expectedStudentId)) {
        return { status: 'ineligible' }
      }
      if (job.status === 'completed') return { status: 'completed' }
      if (job.status === 'failed') return { status: 'failed' }
      if (job.status !== 'processing') return { status: 'needs_review' }
      if (!Number.isSafeInteger(job.leaseUntilMs) || job.leaseUntilMs <= 0 ||
          typeof job.leaseId !== 'string' || !job.leaseId ||
          typeof job.month !== 'string' || !MONTH.test(job.month)) {
        return { status: 'needs_review' }
      }
      if (job.leaseUntilMs > now()) return { status: 'active' }

      // Read the ORIGINAL reservation month; month rollover must not move
      // the pending count to the current month.
      const monthRef = db.doc(`aiWritingMonthlyUsage/${PILOT_SCHOOL_ID}_${job.month}`)
      const monthly = dataOf(await tx.get(monthRef))
      if (!monthly || monthly.schoolId !== PILOT_SCHOOL_ID ||
          monthly.month !== job.month ||
          counter(monthly.requestCount) === null ||
          counter(monthly.completedCount) === null ||
          counter(monthly.pendingCount) === null ||
          monthly.pendingCount < 1 ||
          (monthly.sponsoredRequestCount !== undefined &&
            counter(monthly.sponsoredRequestCount) === null)) {
        return { status: 'needs_review' }
      }
      tx.update(jobRef, {
        status: 'failed', leaseUntilMs: 0,
        lastFailureCode: 'sponsored_lease_expired',
        repairedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })
      tx.update(monthRef, {
        pendingCount: monthly.pendingCount - 1,
        updatedAt: FieldValue.serverTimestamp()
      })
      return { status: 'reconciled' }
    })
  }
  return { reconcileJob }
}

module.exports = { createAiWritingSponsoredRecoveryService }
