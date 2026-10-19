'use strict'

// P8-C: Student-by-student, optimistic assignment mutations. Never replace a
// whole assignment roster from a potentially stale browser snapshot.
const { grantMapIsConsistent, grantsForPolicy } = require('./aiWritingSponsoredGrants')
const { teacherOwnsSource } = require('./aiWritingTeacherRelationship')
const ALLOWED_TYPES = Object.freeze({
  reading: 'readings', listening: 'listenings', writing: 'writingHomeworks',
  vocabulary: 'vocabularyTests', mock: 'mockTests'
})
const SAFE_ID = /^[A-Za-z0-9_-]{1,150}$/
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function parseChanges(data, HttpsError) {
  const fail = (message) => { throw new HttpsError('invalid-argument', message) }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(k => !['contentType','contentId','changes'].includes(k))) {
    fail('Use a scoped assignment change request. Refresh an older assignment editor.')
  }
  const contentType = data.contentType
  const contentId = data.contentId
  if (!own(ALLOWED_TYPES, contentType) ||
      typeof contentId !== 'string' || !SAFE_ID.test(contentId)) {
    fail('A valid assignment type and content ID are required.')
  }
  if (!Array.isArray(data.changes) || data.changes.length > 250) {
    fail('Assignment changes must be an array of at most 250 students.')
  }
  const seen = new Set()
  const changes = data.changes.map(change => {
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
        Object.keys(change).some(k => !['studentId','assigned','expectedAssigned'].includes(k)) ||
        typeof change.studentId !== 'string' || !SAFE_ID.test(change.studentId) ||
        ['__proto__', 'constructor', 'prototype'].includes(change.studentId) ||
        typeof change.assigned !== 'boolean' || typeof change.expectedAssigned !== 'boolean') {
      fail('Each assignment change needs a valid student ID and expected state.')
    }
    if (change.assigned === change.expectedAssigned) {
      fail('Only real add/remove changes may be submitted.')
    }
    if (seen.has(change.studentId)) fail('A student cannot be changed twice in one request.')
    seen.add(change.studentId)
    return { ...change }
  })
  return { contentType, contentId, sourceCollection: ALLOWED_TYPES[contentType], changes }
}

function createP8CAssignmentService({
  db, FieldValue, HttpsError, requireAssignmentManager, managerCanManageSource,
  schoolIdOf, accountTypeOf, studentAccessPayload, studentAccessId
}) {
  const fail = (code, msg) => { throw new HttpsError(code, msg) }
  const dataOf = snap => snap?.exists ? snap.data() || {} : null

  async function write(request) {
    const manager = await requireAssignmentManager(request)
    const input = parseChanges(request?.data, HttpsError)
    const sourceRef = db.doc(`${input.sourceCollection}/${input.contentId}`)
    const managerRef = db.doc(`users/${manager.uid}`)
    const policyRef = ['writing','mock'].includes(input.contentType)
      ? db.doc(`aiWritingSponsoredPolicies/${input.contentType}_${input.contentId}`) : null
    const studentRefs = input.changes.map(change => db.doc(`users/${change.studentId}`))
    const accessRefs = input.changes.map(change =>
      db.doc(`studentAccess/${studentAccessId(change.studentId, input.contentType, input.contentId)}`))

    return db.runTransaction(async tx => {
      // All reads finish before the first write. Firestore retries a conflicting
      // transaction, so independent student changes cannot overwrite each other.
      const sourceSnap = await tx.get(sourceRef)
      const source = dataOf(sourceSnap)
      if (!source || source.deleted === true) fail('not-found', 'Assignment source is not available.')
      const schoolId = schoolIdOf(source)
      const schoolRef = db.doc(`schools/${schoolId}`)
      const reads = await Promise.all([
        tx.get(managerRef), tx.get(schoolRef),
        ...(policyRef ? [tx.get(policyRef)] : []),
        ...studentRefs.map(ref => tx.get(ref)),
        ...accessRefs.map(ref => tx.get(ref))
      ])
      const freshManagerProfile = dataOf(reads[0])
      if (!freshManagerProfile || !['admin','teacher'].includes(freshManagerProfile.role) ||
          freshManagerProfile.status !== 'approved' || freshManagerProfile.deleted === true ||
          (freshManagerProfile.role === 'teacher' &&
            (schoolIdOf(freshManagerProfile) !== schoolId ||
             accountTypeOf(freshManagerProfile) !== 'institution')) ||
          // Current teacherId wins; legacy array-only sources remain supported.
          !(freshManagerProfile.role === 'teacher'
            ? teacherOwnsSource(source, manager.uid)
            : managerCanManageSource({ uid: manager.uid, profile: freshManagerProfile }, source))) {
        fail('permission-denied', 'You can no longer manage this assignment.')
      }
      if (dataOf(reads[1])?.status !== 'active') {
        fail('failed-precondition', 'The institution is not active.')
      }
      let offset = 2
      const oldPolicy = policyRef ? dataOf(reads[offset++]) : null
      const studentSnaps = reads.slice(offset, offset + studentRefs.length)
      const accessSnaps = reads.slice(offset + studentRefs.length)
      const planned = []
      const removedIds = new Set()
      for (let i = 0; i < input.changes.length; i++) {
        const change = input.changes[i]
        const existing = dataOf(accessSnaps[i])
        if (existing && (existing.uid !== change.studentId ||
            existing.contentType !== input.contentType ||
            existing.contentId !== input.contentId ||
            existing.sourceCollection !== input.sourceCollection ||
            schoolIdOf(existing) !== schoolId ||
            !['assignment', 'unassigned_archive'].includes(existing.accessType))) {
          fail('failed-precondition', 'Conflicting assignment record. Contact an administrator.')
        }
        const currentlyAssigned = existing?.accessType === 'assignment'
        if (currentlyAssigned !== change.expectedAssigned) {
          fail('failed-precondition', 'Another editor changed an assignment. Refresh before saving again.')
        }
        if (change.assigned) {
          const profile = dataOf(studentSnaps[i])
          if (source.archived === true || !profile || profile.role !== 'student' ||
              profile.status !== 'approved' || profile.deleted === true ||
              profile.archived === true || profile.permanentDeleteInProgress === true ||
              accountTypeOf(profile) !== 'institution' || schoolIdOf(profile) !== schoolId) {
            fail('failed-precondition', 'An added student is not active in the source institution.')
          }
          const payload = studentAccessPayload(input.contentType, input.sourceCollection,
            input.contentId, source, change.studentId)
          // Never clear an independent Admin hide lock by reassignment.
          if (existing?.adminHidden === true) {
            payload.adminHidden = true
            payload.status = 'inactive'
          }
          if (!existing) payload.assignedAt = FieldValue.serverTimestamp()
          else if (existing.accessType === 'unassigned_archive') {
            payload.reassignedAt = FieldValue.serverTimestamp()
            payload.reassignedBy = manager.uid
          }
          planned.push({ type: 'assign', ref: accessRefs[i], payload })
        } else {
          // A tombstone is retained even without submissions; the archive
          // reader returns it ONLY when a verified, completed result exists.
          // No submission/history document is ever modified or deleted.
          planned.push({ type: 'unassign', ref: accessRefs[i], payload: {
            accessType: 'unassigned_archive', status: 'inactive',
            unassignedAt: FieldValue.serverTimestamp(), unassignedBy: manager.uid,
            updatedAt: FieldValue.serverTimestamp()
          } })
          removedIds.add(change.studentId)
        }
      }

      let nextPolicy = null
      if (oldPolicy && removedIds.size > 0) {
        if (oldPolicy.contentType !== input.contentType ||
            oldPolicy.contentId !== input.contentId ||
            oldPolicy.sourceCollection !== input.sourceCollection ||
            schoolIdOf(oldPolicy) !== schoolId ||
            !grantMapIsConsistent(oldPolicy)) {
          fail('failed-precondition', 'AI funding policy needs administrator repair before unassignment.')
        }
        if (oldPolicy.studentIds.some(uid => removedIds.has(uid))) {
          const previous = grantsForPolicy(oldPolicy)
          // Do not silently erase unrelated grants during a legacy conversion.
          if (oldPolicy.enabled !== true ||
              Object.keys(previous).length !== oldPolicy.studentIds.length) {
            fail('failed-precondition', 'Legacy AI grants need review before removing a student.')
          }
          const grants = { ...previous }
          for (const uid of removedIds) delete grants[uid]
          nextPolicy = {
            schemaVersion: 2, grants,
            studentIds: Object.keys(grants).sort(),
            enabled: Object.keys(grants).length > 0,
            updatedAt: FieldValue.serverTimestamp(), updatedBy: manager.uid
          }
        }
      }
      // Atomic: a sponsor grant cannot outlive an unassignment, and a failed
      // optimistic check leaves ALL other students untouched.
      for (const operation of planned) {
        tx.set(operation.ref, operation.payload, { merge: true })
      }
      if (nextPolicy) tx.update(policyRef, nextPolicy)
      return {
        ok: true, contentType: input.contentType, contentId: input.contentId,
        created: planned.filter(p => p.type === 'assign').length,
        removed: removedIds.size, sponsoredGrantsPruned: Boolean(nextPolicy),
        unchanged: planned.length === 0
      }
    })
  }

  return { write }
}

module.exports = { parseChanges, createP8CAssignmentService }
