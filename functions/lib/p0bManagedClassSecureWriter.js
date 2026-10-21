'use strict'

// Step786: fail-closed, transaction-authorized managed class mutations.
// IMPORTANT: the existing, already-deployed 2026-10-11 functions DO NOT read
// this gate. A separate controlled cutover must quiesce those old revisions.
// Never treat a gate document or this module alone as a Production freeze.
const { collectStudentIds } = require('./p0bAcademicMembershipIndex')

const RELEASE = 'p0b2b-class-writer-v1'
const GATE_ID = 'p0b2b'

function validId(v) {
  return typeof v === 'string' && v !== '' && v.length <= 128 &&
    v.trim() === v && !v.includes('/')
}
function activeUser(profile) {
  return profile && profile.status === 'approved' &&
    profile.deleted !== true && profile.archived !== true &&
    profile.permanentDeleteInProgress !== true
}
function schoolOf(profile) {
  return profile?.schoolId || 'maxima'
}
function currentClassTeacher(data) {
  return typeof data?.teacherId === 'string' && data.teacherId !== ''
    ? data.teacherId
    : Array.isArray(data?.teacherIds) && validId(data.teacherIds[0])
      ? data.teacherIds[0] : ''
}
function isSystem(data) {
  return data?.system === true || data?.isSystem === true ||
    String(data?.name || '').trim().toLowerCase() === 'all'
}
function sameStoredValue(left, right) {
  if (left === right) return true
  if (left && typeof left.isEqual === 'function') return left.isEqual(right) === true
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  return false
}
function sameVersion(left, right) {
  if (!left || !right) return false
  // Firestore DocumentSnapshot.updateTime is a Timestamp with isEqual().
  return typeof left.isEqual === 'function' && left.isEqual(right) === true
}
function validInstitutionStudent(student, schoolId) {
  return activeUser(student) && student.role === 'student' &&
    schoolOf(student) === schoolId &&
    (student.accountType == null ||
      (typeof student.accountType === 'string' &&
        student.accountType.trim().toLowerCase() === 'institution'))
}
function fail(HttpsError, code, message) { throw new HttpsError(code, message) }

/**
 * Server-owned class writer. Each caller supplies a server-observed document
 * updateTime, NEVER a client-provided timestamp. The transaction itself
 * revalidates actor, school, class version, teacher, students and write gate.
 *
 * The gate is default-deny and SERIALIZES with writes in this new revision.
 * It cannot stop operations already accepted by the older Production revision;
 * a separate cutover barrier and draining proof are mandatory.
 */
async function mutateManagedClassSecure({
  db, FieldValue, HttpsError, classRef, teacherId, schoolId,
  operation, payload = null, expectedClassUpdateTime = null,
  actorUid, now = new Date().toISOString()
}) {
  if (!db?.runTransaction || !FieldValue?.arrayUnion || typeof HttpsError !== 'function' ||
      !classRef?.id || !validId(classRef.id) || !validId(actorUid) ||
      !validId(schoolId) || (teacherId !== '' && !validId(teacherId)) ||
      !['create', 'edit', 'archive', 'delete'].includes(operation) ||
      (operation !== 'delete' && (!payload || typeof payload !== 'object')) ||
      (operation === 'create' && expectedClassUpdateTime !== null) ||
      (operation !== 'create' && !expectedClassUpdateTime)) {
    fail(HttpsError, 'invalid-argument', 'Invalid class mutation contract.')
  }
  // Reject a caller trying to change school or teacher through the payload.
  if ((operation === 'create' || operation === 'edit') &&
      (payload.schoolId !== schoolId || payload.teacherId !== teacherId ||
        !Array.isArray(payload.studentIds) || payload.studentIds.length > 250 ||
        new Set(payload.studentIds).size !== payload.studentIds.length ||
        payload.studentIds.some(id => !validId(id)))) {
    fail(HttpsError, 'invalid-argument', 'Invalid teacher or student class data.')
  }
  const gateRef = db.doc(`schools/${schoolId}/classWriteGate/${GATE_ID}`)
  const schoolRef = db.doc(`schools/${schoolId}`)
  const actorRef = db.doc(`users/${actorUid}`)
  const indexRef = teacherId
    ? db.doc(`schools/${schoolId}/teacherAcademicIndex/${teacherId}`) : null
  const teacherRef = teacherId ? db.doc(`users/${teacherId}`) : null
  const classesQuery = teacherId
    ? db.collection('classes').where('teacherId', '==', teacherId) : null

  return db.runTransaction(async tx => {
    // All reads happen before writes. Because the gate is read in this
    // transaction, a concurrent freeze write conflicts and retries/denies.
    const gateSnap = await tx.get(gateRef)
    const gate = gateSnap.exists ? gateSnap.data() || {} : {}
    if (gate.schemaVersion !== 1 || gate.phase !== 'open' || gate.release !== RELEASE) {
      fail(HttpsError, 'failed-precondition', 'Class changes are temporarily paused.')
    }
    const actorSnap = await tx.get(actorRef)
    const actor = actorSnap.exists ? actorSnap.data() || {} : null
    if (!activeUser(actor) || !['admin', 'teacher'].includes(actor.role)) {
      fail(HttpsError, 'permission-denied', 'Your class management permission has changed.')
    }
    const schoolSnap = await tx.get(schoolRef)
    const school = schoolSnap.exists ? schoolSnap.data() || {} : null
    if (!school || (actor.role === 'teacher' && school.status !== 'active') ||
      (['create', 'edit'].includes(operation) && school.status !== 'active')) {
      fail(HttpsError, 'failed-precondition', 'This school is not active for class changes.')
    }
    if (actor.role === 'teacher' && schoolOf(actor) !== schoolId) {
      fail(HttpsError, 'permission-denied', 'Your school membership has changed.')
    }

    const classSnap = await tx.get(classRef)
    const current = classSnap.exists ? classSnap.data() || {} : null
    if (operation === 'create') {
      if (current) fail(HttpsError, 'already-exists', 'This class was created concurrently.')
      if (!teacherId) fail(HttpsError, 'failed-precondition', 'A teacher is required for new classes.')
    } else {
      if (!current) fail(HttpsError, 'not-found', 'This class was removed during editing.')
      if (!sameVersion(classSnap.updateTime, expectedClassUpdateTime)) {
        fail(HttpsError, 'aborted', 'This class was changed elsewhere. Refresh before saving.')
      }
      if (schoolOf(current) !== schoolId || currentClassTeacher(current) !== teacherId) {
        fail(HttpsError, 'permission-denied', 'Class ownership changed during editing.')
      }
      if (isSystem(current) && operation !== 'edit') {
        fail(HttpsError, 'failed-precondition', 'The ALL/system class cannot be archived or deleted.')
      }
    }
    if (actor.role === 'teacher' &&
        (actorUid !== teacherId || (current && isSystem(current)))) {
      fail(HttpsError, 'permission-denied', 'Only the active class teacher may edit this class.')
    }
    if (!teacherId && !(current && isSystem(current) && actor.role === 'admin')) {
      fail(HttpsError, 'permission-denied', 'System class changes require an active admin.')
    }
    if ((operation === 'create' || operation === 'edit') &&
        (isSystem(payload) !== Boolean(current && isSystem(current)))) {
      fail(HttpsError, 'failed-precondition', 'System class status cannot change through editing.')
    }

    // The caller's payload must not resurrect an archived class or rewrite
    // its server-owned creation metadata while a concurrent edit is in flight.
    if (operation === 'edit' &&
        (payload.archived !== (current.archived === true) ||
          payload.createdBy !== current.createdBy ||
          (!sameStoredValue(payload.createdAt, current.createdAt)))) {
      fail(HttpsError, 'aborted', 'Class metadata is stale; please refresh.')
    }

    const teacherSnap = teacherRef ? await tx.get(teacherRef) : null
    const teacher = teacherSnap?.exists ? teacherSnap.data() || {} : null
    if (teacherId && (operation === 'create' || operation === 'edit' ||
        (operation === 'archive' && payload.archived === false)) &&
        (!activeUser(teacher) || teacher.role !== 'teacher' || schoolOf(teacher) !== schoolId)) {
      fail(HttpsError, 'failed-precondition', 'The selected teacher is no longer active.')
    }

    const indexSnap = indexRef ? await tx.get(indexRef) : null
    if (indexSnap?.exists) {
      const index = indexSnap.data() || {}
      if (index.schoolId !== schoolId || index.teacherId !== teacherId ||
          index.schemaVersion !== 1 || index.source !== 'managed_active_classes' ||
          !Array.isArray(index.activeStudentIds)) {
        fail(HttpsError, 'failed-precondition', 'Teacher index requires admin repair.')
      }
    }
    const classGroup = classesQuery ? await tx.get(classesQuery) : null

    const effective = operation === 'delete' ? null :
      operation === 'create' ? { ...payload } : { ...current, ...payload }
    const selectedIds = operation === 'create' || operation === 'edit'
      ? payload.studentIds :
      operation === 'archive' && payload.archived === false
        ? effective?.studentIds || [] : []
    if (!Array.isArray(selectedIds) || selectedIds.length > 250 ||
        selectedIds.some(id => !validId(id))) {
      fail(HttpsError, 'failed-precondition', 'Class roster requires admin repair.')
    }
    if (selectedIds.length > 0) {
      const refs = selectedIds.map(uid => db.doc(`users/${uid}`))
      const snaps = await tx.getAll(...refs)
      for (const snap of snaps) {
        if (!snap.exists || !validInstitutionStudent(snap.data() || {}, schoolId)) {
          fail(HttpsError, 'failed-precondition', 'Selected students must be active in this school.')
        }
      }
    }

    let activeStudentIds = []
    if (teacherId) {
      const otherClasses = classGroup.docs
        .filter(doc => doc.exists && doc.id !== classRef.id)
        .map(doc => doc.data() || {})
      if (effective) otherClasses.push(effective)
      activeStudentIds = collectStudentIds(otherClasses, teacherId, schoolId)
      if (actor.role === 'teacher') {
        const prior = indexSnap?.exists ? indexSnap.data().activeStudentIds : []
        if (prior.some(id => !validId(id)) ||
            activeStudentIds.some(id => !prior.includes(id))) {
          fail(HttpsError, 'permission-denied', 'New class members require admin authorization.')
        }
      }
    }
    // === WRITE BOUNDARY: nothing above this line mutates Firestore. ===
    if (operation === 'delete') tx.delete(classRef)
    else tx.set(classRef, payload, { merge: operation !== 'create' })
    if (teacherId && (operation === 'create' || operation === 'edit')) {
      for (const uid of selectedIds) {
        tx.set(db.doc(`users/${uid}`), {
          teacherIds: FieldValue.arrayUnion(teacherId),
          updatedAt: now, updatedBy: actorUid
        }, { merge: true })
      }
    }
    if (indexRef) tx.set(indexRef, {
      schemaVersion: 1, teacherId, schoolId, source: 'managed_active_classes',
      activeStudentIds, updatedAt: now, updatedBy: actorUid
    }, { merge: false })
    return { activeStudentCount: activeStudentIds.length, class: effective }
  })
}

module.exports = { mutateManagedClassSecure, RELEASE, GATE_ID }
