'use strict'

// P6-A2: explicit current class membership; legacy user.teacherIds is additive
// and NEVER authorizes institution-funded AI on its own.
const SCHOOL_ID = 'maxima'

function teacherClassQuery(db, uid) {
  return db.collection('classes').where('teacherId', '==', uid)
}

function currentTeacherStudents(snapshot, uid) {
  const result = new Set()
  if (!snapshot || !Array.isArray(snapshot.docs)) return result
  for (const doc of snapshot.docs) {
    if (doc?.exists === false || typeof doc?.data !== 'function') continue
    const data = doc.data() || {}
    if (data.teacherId !== uid || data.schoolId !== SCHOOL_ID ||
        data.archived === true || data.deleted === true ||
        data.permanentDeleteInProgress === true ||
        (typeof data.status === 'string' && data.status !== 'active') ||
        data.system === true || data.isSystem === true ||
        (typeof data.name === 'string' && data.name.trim().toLowerCase() === 'all') ||
        !Array.isArray(data.studentIds)) continue
    for (const studentId of data.studentIds) {
      if (typeof studentId === 'string') result.add(studentId)
    }
  }
  return result
}

function teacherOwnsSource(source, uid) {
  if (!source || typeof uid !== 'string' || !uid) return false
  const primary = typeof source.teacherId === 'string' ? source.teacherId.trim() : ''
  if (primary) return primary === uid
  return Array.isArray(source.teacherIds) && source.teacherIds.includes(uid)
}

module.exports = { teacherClassQuery, currentTeacherStudents, teacherOwnsSource }
