'use strict'

const { randomUUID, createHash } = require('node:crypto')

// Empty is the legacy session. A teacher reset creates a new, server-owned
// generation without deleting results, recordings or the old device draft.
function attemptGeneration(value) {
  return typeof value === 'string' ? value : ''
}

function mockSpeakingAttemptId(uid, mockId, attemptNumber, generation = '') {
  const legacy = `${uid}\0${mockId}\0${attemptNumber}`
  return createHash('sha256').update(generation ? `${legacy}\0${generation}` : legacy).digest('hex')
}

function vocabularyDraftId(uid, contentId, generation = '') {
  return `${uid}_${contentId}${generation ? `_restart_${generation}` : ''}`
}

function createAttemptRestartService({ db, FieldValue, HttpsError, schoolIdOf,
  requireCurrentTeacherAcademicStudent, attemptControlId, attemptHistoryId,
  attemptHistoryPayload, schemaVersion = 1 }) {
  const fail = (code, message) => { throw new HttpsError(code, message) }

  async function assertCurrent({ transaction, uid, config, contentId, generation, schoolId }) {
    const ref = db.doc(`studentAccess/${uid}_${config.contentType}_${contentId}`)
    const snap = await (transaction ? transaction.get(ref) : ref.get())
    const access = snap.exists ? snap.data() : null
    if (!access || access.uid !== uid || access.contentId !== contentId ||
      access.contentType !== config.contentType || access.sourceCollection !== config.sourceCollection ||
      schoolIdOf(access) !== schoolId || access.accessType !== 'assignment' ||
      access.status !== 'active' || access.adminHidden === true) {
      fail('permission-denied', 'This assignment is no longer available.')
    }
    if (attemptGeneration(access.attemptGeneration) !== attemptGeneration(generation)) {
      fail('failed-precondition', 'Your teacher restarted this attempt. Reload to start with a new timer and blank answers.')
    }
    return access
  }

  async function startFresh({ manager, config, contentId, studentId, source,
    accessRef, current, mockScore, expectedGeneration }) {
    if (typeof expectedGeneration !== 'string' || expectedGeneration.length > 80) {
      fail('invalid-argument', 'Refresh the attempt options before restarting.')
    }
    const generation = randomUUID()
    const controlId = attemptControlId(studentId, config.contentType, contentId)
    const controlRef = db.doc(`submissionAttemptControls/${controlId}`)
    const currentRef = current?.ref || db.doc(`${config.submissionCollection}/${studentId}_${contentId}`)
    const restartRef = db.doc(`submissionAttemptRestarts/${controlId}_${generation}`)
    const schoolId = schoolIdOf(source)

    return db.runTransaction(async tx => {
      const [accessSnap, sourceSnap, currentSnap, controlSnap, managerSnap, studentSnap, schoolSnap] = await Promise.all([
        tx.get(accessRef), tx.get(db.doc(`${config.sourceCollection}/${contentId}`)),
        tx.get(currentRef), tx.get(controlRef), tx.get(db.doc(`users/${manager.uid}`)),
        tx.get(db.doc(`users/${studentId}`)), tx.get(db.doc(`schools/${schoolId}`))
      ])
      const access = accessSnap.data() || {}
      const latestSource = sourceSnap.data() || {}
      const profile = managerSnap.data() || {}
      if (!managerSnap.exists || !['admin', 'teacher'].includes(profile.role) ||
        profile.status !== 'approved' || profile.archived || profile.deleted || profile.permanentDeleteInProgress) {
        fail('permission-denied', 'Teacher access changed. Sign in again.')
      }
      if (!sourceSnap.exists || schoolIdOf(latestSource) !== schoolId || latestSource.archived || latestSource.deleted) {
        fail('failed-precondition', 'This content is no longer available.')
      }
      const learner = studentSnap.data() || {}
      if (learner.role !== 'student' || learner.status !== 'approved' || schoolIdOf(learner) !== schoolId ||
        learner.archived || learner.deleted || learner.permanentDeleteInProgress || schoolSnap.data()?.status !== 'active') {
        fail('permission-denied', 'The student or institution is no longer available.')
      }
      await assertCurrent({ transaction: tx, uid: studentId, config, contentId,
        generation: expectedGeneration, schoolId })
      await requireCurrentTeacherAcademicStudent({ db, HttpsError,
        manager: { uid: manager.uid, profile }, studentId, schoolId, tx })

      // A reset dialog may have been open while the learner finished. Never
      // silently turn that newly submitted work into another attempt.
      const previous = currentSnap.exists ? currentSnap.data() : null
      const base = previous ? Number(previous.attemptNumber) || 1 : 0
      if (Boolean(previous) !== Boolean(current) ||
        (previous && (currentSnap.id !== current.id || base !== (Number(current.data.attemptNumber) || 1)))) {
        fail('aborted', 'The student submitted while these options were open. Refresh and try again.')
      }
      if (previous && ((previous.uid || previous.studentId) !== studentId ||
        (previous.uid && previous.uid !== studentId) || (previous.studentId && previous.studentId !== studentId) ||
        !(config.parentFields || [config.parentField]).some(field => previous[field] === contentId) ||
        schoolIdOf(previous) !== schoolId)) {
        fail('failed-precondition', 'The current result does not match this assignment.')
      }
      const oldControl = controlSnap.data() || {}
      const historyRef = previous ? db.doc(`submissionAttemptHistory/${attemptHistoryId(controlId, base)}`) : null
      const [historySnap, scoreSnap, draftSnap] = await Promise.all([
        historyRef ? tx.get(historyRef) : null,
        mockScore?.ref ? tx.get(mockScore.ref) : null,
        config.contentType === 'vocabulary' ? tx.get(db.doc(`vocabularyDrafts/${vocabularyDraftId(studentId, contentId, expectedGeneration)}`)) : null
      ])
      const nextAttemptNumber = previous ? base + 1 : 1
      const audit = {
        uid: studentId, studentId, schoolId, contentType: config.contentType, contentId,
        sourceCollection: config.sourceCollection, submissionCollection: config.submissionCollection,
        previousGeneration: attemptGeneration(access.attemptGeneration), attemptGeneration: generation,
        restartedBy: manager.uid, restartedByRole: profile.role, restartedAt: FieldValue.serverTimestamp(),
        currentSubmissionId: currentSnap.exists ? currentSnap.id : '',
        nextAttemptNumber, previousControl: controlSnap.exists ? oldControl : null
      }
      if (draftSnap?.exists) audit.vocabularyDraftSnapshot = draftSnap.data()
      if (config.contentType === 'mock') audit.previousSpeakingAttemptId = mockSpeakingAttemptId(
        studentId, contentId, oldControl.status === 'open' ? base + 1 : Math.max(1, base),
        attemptGeneration(access.attemptGeneration))

      if (previous) {
        if (!historySnap.exists) tx.create(historyRef, attemptHistoryPayload({
          config, student: { uid: studentId }, contentId, source: latestSource,
          managerUid: manager.uid, managerRole: profile.role,
          currentSnap, currentData: previous, attemptNumber: base, scoreSnap
        }))
        tx.set(controlRef, {
          schemaVersion, uid: studentId, studentId, schoolId,
          contentType: config.contentType, contentId, sourceCollection: config.sourceCollection,
          submissionCollection: config.submissionCollection, status: 'open', mode: 'start_fresh',
          baseAttemptNumber: base, nextAttemptNumber, baseSubmissionId: currentSnap.id,
          baseSubmittedAt: previous.submittedAt || '', openedBy: manager.uid,
          openedByRole: profile.role, openedAt: FieldValue.serverTimestamp(),
          updatedBy: manager.uid, updatedAt: FieldValue.serverTimestamp()
        })
      }
      tx.create(restartRef, audit)
      tx.set(accessRef, { attemptGeneration: generation, attemptRestartedAt: FieldValue.serverTimestamp(),
        attemptRestartedBy: manager.uid }, { merge: true })
      return { ok: true, mode: 'start_fresh', nextAttemptNumber, attemptGeneration: generation,
        restartedInProgress: !previous || oldControl.status === 'open' }
    })
  }
  return { assertCurrent, startFresh }
}

module.exports = { attemptGeneration, mockSpeakingAttemptId, vocabularyDraftId, createAttemptRestartService }
