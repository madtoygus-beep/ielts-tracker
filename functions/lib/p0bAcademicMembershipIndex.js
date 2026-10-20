'use strict'

// P0-B2A: server-owned membership index for browser academic records.
// The index is advisory until P0-B2B rules and UI are deliberately published.
// This module NEVER calls the AI provider and NEVER uses historical user.teacherIds.

const MAX_ACTIVE_STUDENTS = 4000

function activeClassStudents(classData, teacherId, schoolId) {
  if (!classData || typeof classData !== 'object' ||
      classData.teacherId !== teacherId || classData.schoolId !== schoolId ||
      classData.archived === true || classData.deleted === true ||
      classData.permanentDeleteInProgress === true ||
      classData.system === true || classData.isSystem === true ||
      String(classData.name || '').trim().toLowerCase() === 'all' ||
      (typeof classData.status === 'string' && classData.status !== 'active') ||
      !Array.isArray(classData.studentIds)) return []

  return classData.studentIds.filter(uid =>
    typeof uid === 'string' && uid.trim() === uid && uid.length > 0 &&
    uid.length <= 128 && !uid.includes('/'))
}

function collectStudentIds(classDocs, teacherId, schoolId) {
  const students = new Set()
  for (const item of classDocs) {
    for (const uid of activeClassStudents(item, teacherId, schoolId)) students.add(uid)
    if (students.size > MAX_ACTIVE_STUDENTS) {
      throw new Error('Active class membership index exceeds safe document size limit')
    }
  }
  return [...students].sort()
}

/**
 * Atomically write the class mutation AND its canonical teacher membership index.
 * A transaction read of the index serializes concurrent edits to different classes
 * owned by the same teacher, avoiding a stale last-writer-wins student list.
 * The index uses ONLY non-archived, non-system, current classes, not profile links.
 *
 * The existing class write eligibility and students validation remains at the caller.
 * P0-B2B admission hardening: teachers may rearrange/remove existing authorized
 * learners, but may NEVER expand the canonical academic index. An admin must
 * explicitly admit a new teacher/student pair through the managed class writer.
 * Teacher checks and index membership are read in the same transaction to avoid
 * a concurrent revocation followed by stale teacher re-admission.
 * This function does not bootstrap historical teachers; a separately approved,
 * audited backfill is required before making index-based Firestore Rules live.
 */
async function mutateManagedClassWithIndex({
  db, FieldValue, classRef, teacherId, schoolId, operation, payload = null,
  studentRefs = [], updatedBy = '', actorRole, now = new Date().toISOString()
}) {
  if (!db?.runTransaction || !FieldValue || !classRef?.id ||
      typeof teacherId !== 'string' || !teacherId || teacherId.includes('/') ||
      typeof schoolId !== 'string' || !schoolId || schoolId.includes('/') ||
      !['save', 'archive', 'delete'].includes(operation) ||
      !['teacher', 'admin'].includes(actorRole) ||
      (actorRole === 'teacher' && updatedBy !== teacherId)) {
    throw new Error('Invalid P0-B2A class index update request')
  }
  if (operation !== 'delete' && (!payload || typeof payload !== 'object')) {
    throw new Error('Missing class mutation data')
  }
  const indexRef = db.doc(`schools/${schoolId}/teacherAcademicIndex/${teacherId}`)
  const classesQuery = db.collection('classes').where('teacherId', '==', teacherId)

  return db.runTransaction(async tx => {
    // Read BEFORE any writes; every class edit for this teacher touches this
    // index, so concurrent snapshots conflict and Firestore retries the loser.
    const indexSnap = await tx.get(indexRef)
    const classSnap = await tx.get(classRef)
    const classesSnap = await tx.get(classesQuery)

    if (indexSnap.exists && indexSnap.data()?.schoolId !== schoolId) {
      throw new Error('Teacher index school mismatch')
    }
    const existing = classSnap.exists ? classSnap.data() || {} : null
    if (existing && existing.schoolId !== schoolId) {
      throw new Error('Class school changed during update')
    }
    if (existing?.teacherId && existing.teacherId !== teacherId) {
      throw new Error('Class teacher changed during update')
    }
    if (operation !== 'save' && !existing) {
      throw new Error('Class disappeared during update')
    }
    if (operation === 'save' && payload.teacherId !== teacherId) {
      throw new Error('Invalid class teacher')
    }

    const effective = operation === 'delete' ? null : { ...(existing || {}), ...payload }
    const otherClasses = classesSnap.docs
      .filter(doc => doc.id !== classRef.id && doc.exists)
      .map(doc => doc.data() || {})
    if (effective) otherClasses.push(effective)
    const activeStudentIds = collectStudentIds(otherClasses, teacherId, schoolId)

    // Previous index membership is the only teacher-held admission capability.
    // Historical users.teacherIds, createdBy, source teacherId and class roster
    // alone must never grant a new student's historical academic records.
    if (actorRole === 'teacher') {
      const priorIds = indexSnap.exists ? indexSnap.data()?.activeStudentIds : []
      if (!Array.isArray(priorIds) || priorIds.some(uid =>
        typeof uid !== 'string' || !uid || uid.includes('/'))) {
        throw new Error('Invalid academic membership index; admin repair required')
      }
      const approved = new Set(priorIds)
      if (activeStudentIds.some(uid => !approved.has(uid))) {
        throw new Error('New academic class members require admin authorization')
      }
    }

    if (operation === 'delete') tx.delete(classRef)
    else tx.set(classRef, payload, { merge: Boolean(existing) })
    for (const studentRef of studentRefs) {
      tx.set(studentRef, {
        teacherIds: FieldValue.arrayUnion(teacherId),
        updatedAt: now,
        updatedBy
      }, { merge: true })
    }
    tx.set(indexRef, {
      schemaVersion: 1,
      teacherId,
      schoolId,
      source: 'managed_active_classes',
      activeStudentIds,
      updatedAt: now,
      updatedBy
    }, { merge: false })
    return { activeStudentCount: activeStudentIds.length }
  })
}

module.exports = { activeClassStudents, collectStudentIds, mutateManagedClassWithIndex }
