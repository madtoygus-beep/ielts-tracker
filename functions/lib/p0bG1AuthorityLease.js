'use strict'

// G1 LOCAL CANDIDATE, NOT A PRODUCTION FREEZE.
// Used only by NEWLY DEPLOYED callables. Old Cloud Run revisions do not run
// this code. Infra fencing and proof that old requests have drained are still
// mandatory before the FIRST classWriteGate / index backfill operation.
const { randomUUID } = require('node:crypto')
const { RELEASE, GATE_ID } = require('./p0bManagedClassSecureWriter')

const OPERATION_SET = new Set([
  'createManagedUser', 'approveManagedUser', 'rejectManagedUser',
  'restoreManagedUser', 'deleteManagedUser', 'updateManagedUser',
  'saveManagedSchool', 'syncManagedClassStudentLinks',
  'permanentlyDeleteManagedUser', 'deleteManagedSchool'
])

// These endpoints can mutate a class or legacy teacher relationship without
// atomically maintaining teacherAcademicIndex. Fail closed for institutional
// accounts until a separately reviewed, index-safe implementation exists.
const QUARANTINED_OPERATIONS = new Set([
  'syncManagedClassStudentLinks',
  'permanentlyDeleteManagedUser',
  'deleteManagedSchool'
])

function validId(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 128 && value === value.trim() && !value.includes('/')
}

async function withG1AuthorityLease({ db, FieldValue, HttpsError, schoolId,
  actorUid, operation }, work) {
  if (typeof work !== 'function' || !db?.runTransaction ||
      !FieldValue?.serverTimestamp || typeof HttpsError !== 'function' ||
      !OPERATION_SET.has(operation) || !validId(schoolId) || !validId(actorUid)) {
    throw new Error('Invalid G1 authority lease contract')
  }
  // Destructive helpers scan classes globally, including for individual UIDs.
  // Quarantine these operations for ALL school IDs until they preserve the
  // canonical index. No B2C exception is safe for permanent deletion yet.
  if (QUARANTINED_OPERATIONS.has(operation)) {
    throw new HttpsError('failed-precondition',
      'This operation is paused pending an index-safe implementation.')
  }
  // Institutional teacherAcademicIndex does not authorize individual B2C or
  // platform manager restores/edits. Preserve these non-destructive flows.
  if (schoolId === '__individual__' || schoolId === '__platform__') {
    return work()
  }

  const gateRef = db.doc(`schools/${schoolId}/classWriteGate/${GATE_ID}`)
  const actorRef = db.doc(`users/${actorUid}`)
  const leaseId = randomUUID()
  const leaseRef = db.doc(`schools/${schoolId}/classAuthorityOperations/${leaseId}`)

  // Transaction read of the gate serializes admission against a transaction
  // that closes the gate. An admitted operation creates a persistent lease
  // BEFORE any side effect. Closing the gate is not itself a full freeze:
  // a separate operator must prove the active lease set is EMPTY, then verify
  // relevant class/user/index snapshots and fence all old runtimes.
  await db.runTransaction(async tx => {
    const gateSnap = await tx.get(gateRef)
    const gate = gateSnap.exists ? gateSnap.data() || {} : {}
    if (gate.schemaVersion !== 1 || gate.release !== RELEASE || gate.phase !== 'open') {
      throw new HttpsError('failed-precondition',
        'Institution management is temporarily paused for a security cutover.')
    }
    // A role/status change between requireAdmin() and admission must not
    // authorize a previously privileged request through the new revision.
    const actorSnap = await tx.get(actorRef)
    const actor = actorSnap.exists ? actorSnap.data() || {} : null
    if (!actor || actor.role !== 'admin' || actor.status !== 'approved' ||
        actor.deleted === true || actor.archived === true ||
        actor.permanentDeleteInProgress === true) {
      throw new HttpsError('permission-denied',
        'Your institution management permission has changed.')
    }
    tx.create(leaseRef, {
      schemaVersion: 1,
      schoolId,
      operation,
      actorUid,
      release: RELEASE,
      admittedAt: FieldValue.serverTimestamp()
    })
  })
  try {
    return await work()
  } finally {
    // Never automatically expire or garbage-collect a lease: crashing or
    // partial cleanup must fail the operator's drain verification closed.
    // A failed cleanup leaves the lease visible for manual investigation.
    await leaseRef.delete()
  }
}

module.exports = {
  withG1AuthorityLease,
  OPERATION_SET,
  QUARANTINED_OPERATIONS
}
