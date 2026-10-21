'use strict'

// P0-B2B / Step747 - fail-closed *server-side* teacher/student membership.
// Admin SDK bypasses client Firestore Rules. This is an independent permission
// check for student-specific Cloud Callables, not an assignment-owner check.
// Test with local Firestore Emulator; NEVER use user.teacherIds for access.

const schoolOf = profile => profile?.schoolId || 'maxima' // matches existing legacy Rules fallback
const validId = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && value.trim() === value && !value.includes('/')
const active = profile => profile && profile.status === 'approved' &&
  profile.deleted !== true && profile.archived !== true &&
  profile.permanentDeleteInProgress !== true

function canonicalStudentAccessAllowed({ teacherUid, studentId, schoolId,
  teacher, student, school, index }) {
  return validId(teacherUid) && validId(studentId) && validId(schoolId) &&
    active(teacher) && teacher.role === 'teacher' && schoolOf(teacher) === schoolId &&
    active(student) && student.role === 'student' && schoolOf(student) === schoolId &&
    (student.accountType === undefined || student.accountType === null ||
      (typeof student.accountType === 'string' && student.accountType.trim().toLowerCase() === 'institution')) &&
    school && school.status === 'active' &&
    index && index.schemaVersion === 1 && index.source === 'managed_active_classes' &&
    index.teacherId === teacherUid && index.schoolId === schoolId &&
    Array.isArray(index.activeStudentIds) && index.activeStudentIds.includes(studentId)
}

async function requireCurrentTeacherAcademicStudent({ db, HttpsError, manager,
  studentId, schoolId, tx = null }) {
  const deny = () => { throw new HttpsError('permission-denied',
    'Current active class membership is required for this learner.') }
  if (!manager || !validId(manager.uid) || !validId(studentId) || !validId(schoolId)) deny()
  const role = manager.profile?.role
  if (role === 'admin') {
    // Caller already used requireAssignmentManager / requireAdmin. Transaction
    // writes must additionally recheck this role/status at commit time.
    if (tx) {
      const snap = await tx.get(db.doc(`users/${manager.uid}`))
      const profile = snap.exists ? snap.data() || {} : {}
      if (!active(profile) || profile.role !== 'admin') deny()
    }
    return true
  }
  if (role !== 'teacher' || schoolOf(manager.profile) !== schoolId) deny()

  const refs = [
    db.doc(`users/${manager.uid}`),
    db.doc(`users/${studentId}`),
    db.doc(`schools/${schoolId}`),
    db.doc(`schools/${schoolId}/teacherAcademicIndex/${manager.uid}`)
  ]
  // Firestore transaction reads are repeatable and conflict on concurrent
  // index revocation, so a stale preflight cannot authorize a later write.
  const snaps = tx ? await tx.getAll(...refs) : await db.getAll(...refs)
  const values = snaps.map(s => s.exists ? (s.data() || {}) : null)
  if (!canonicalStudentAccessAllowed({
    teacherUid: manager.uid, studentId, schoolId,
    teacher: values[0], student: values[1], school: values[2], index: values[3]
  })) deny()
  return true
}

module.exports = { canonicalStudentAccessAllowed, requireCurrentTeacherAcademicStudent }
