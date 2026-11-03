'use strict'
const HASH = /^[a-f0-9]{64}$/
function createAiWritingRecoveryAdmin({ db, requireAdmin, HttpsError, recovery, now = () => Date.now() }) {
  async function admin(request) {
    const actor = await requireAdmin(request)
    if ((actor.profile?.schoolId || 'maxima') !== 'maxima') throw new HttpsError('permission-denied', 'This institution cannot manage these Writing jobs.')
    return actor
  }
  async function list(request) {
    await admin(request)
    if (request.data != null && (typeof request.data !== 'object' || Array.isArray(request.data) || Object.keys(request.data).length)) throw new HttpsError('invalid-argument', 'No search parameters are accepted.')
    const snapshot = await db.collection('aiWritingEvaluations').where('status', '==', 'processing').limit(201).get()
    const items = snapshot.docs.slice(0, 200).map(doc => ({ ...doc.data(), id: doc.id }))
      .filter(job => HASH.test(job.id) && job.jobId === job.id && job.schoolId === 'maxima' && job.billing === 'institution' && job.billingMode === 'sponsored_auto' && ['homework', 'mock'].includes(job.context) && typeof job.studentId === 'string' && Number.isSafeInteger(job.leaseUntilMs) && job.leaseUntilMs > 0 && job.leaseUntilMs <= now())
      .sort((a,b) => a.leaseUntilMs - b.leaseUntilMs)
    return { items: items.slice(0,20).map(job => ({ jobId: job.id, studentId: job.studentId, context: job.context, attemptNumber: Number.isSafeInteger(job.attemptNumber) ? job.attemptNumber : 1, expiredAtMs: job.leaseUntilMs })), moreAvailable: snapshot.docs.length > 200 || items.length > 20 }
  }
  async function reconcile(request) {
    const actor = await admin(request)
    const data = request.data
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Array.isArray(data.jobIds) || data.jobIds.length < 1 || data.jobIds.length > 20 || data.jobIds.some(id => typeof id !== 'string' || !HASH.test(id)) || new Set(data.jobIds).size !== data.jobIds.length) throw new HttpsError('invalid-argument', 'Select 1–20 distinct Writing jobs.')
    const results = []
    for (const jobId of data.jobIds) results.push({ jobId, status: (await recovery.reconcileJob({ jobId, actorId: actor.uid })).status })
    return { results }
  }
  return { list, reconcile }
}
module.exports = { createAiWritingRecoveryAdmin }
