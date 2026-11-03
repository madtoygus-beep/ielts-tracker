'use strict'

// AUD-FIX2: Server-owned normal Writing teacher reviews. The browser never
// writes provenance/timestamps directly. Teacher membership is re-read in the
// same Firestore transaction as the immutable attempt identity.
const { validateReview } = require('./p0bMockWritingReviewService')

const safeId = x => typeof x === 'string' && x.length > 0 && x.length <= 180 &&
  x.trim() === x && !x.includes('/') && !/[\x00-\x1f]/.test(x)
const own = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype &&
  Object.keys(x).length === keys.length && keys.every(key => Object.hasOwn(x, key))
const attemptOf = value => Number.isSafeInteger(value?.attemptNumber) &&
  value.attemptNumber > 0 ? value.attemptNumber : 1

function createWritingReviewSecureService({ db, HttpsError, requireAssignmentManager,
  requireCurrentTeacherAcademicStudent, schoolIdOf, now = () => new Date().toISOString() }) {
  const fail = (code, reason) => { throw new HttpsError(code, reason) }
  return async function saveWritingReviewSecure(request) {
    const manager = await requireAssignmentManager(request)
    if (manager.profile?.role !== 'teacher') {
      fail('permission-denied', 'A current teacher is required to review Writing.')
    }
    const data = request.data || {}
    if (!own(data, ['studentId', 'writingId', 'submissionId', 'attemptNumber',
      'submittedAt', 'review']) ||
      !safeId(data.studentId) || !safeId(data.writingId) || !safeId(data.submissionId) ||
      !Number.isSafeInteger(data.attemptNumber) || data.attemptNumber < 1 ||
      typeof data.submittedAt !== 'string' || data.submittedAt.length < 15 ||
      data.submittedAt.length > 70 || !validateReview(data.review)) {
      fail('invalid-argument', 'Invalid Writing review fields or attempt identity.')
    }
    const ref = db.doc(`writingSubmissions/${data.submissionId}`)
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (!snap.exists) fail('not-found', 'Writing submission no longer exists.')
      const current = snap.data() || {}
      const uid = current.uid || current.studentId
      const schoolId = schoolIdOf(current)
      if (uid !== data.studentId ||
        (current.uid && current.uid !== data.studentId) ||
        (current.studentId && current.studentId !== data.studentId) ||
        current.writingId !== data.writingId ||
        current.submittedAt !== data.submittedAt ||
        attemptOf(current) !== data.attemptNumber ||
        (current.status && current.status !== 'submitted') ||
        current.archived === true || current.deleted === true ||
        !safeId(schoolId)) {
        fail('failed-precondition', 'Writing attempt changed; refresh the review.')
      }
      await requireCurrentTeacherAcademicStudent({
        db, HttpsError, manager, studentId: data.studentId, schoolId, tx
      })
      const reviewedAt = now()
      tx.update(ref, {
        reviewed: true,
        reviewedAt,
        reviewedBy: manager.uid,
        review: data.review
      })
      return { ok: true, submissionId: data.submissionId, reviewedAt }
    })
  }
}

module.exports = { createWritingReviewSecureService }
