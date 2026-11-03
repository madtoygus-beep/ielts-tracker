'use strict'
// STEP848: FIRESTORE-EMULATOR-ONLY rehearsal. This file deliberately contains
// no Production migration entrypoint and MUST NOT be used as one.
const { classifyLegacyIdentity, COLLECTIONS } = require('./p0bG4LegacyAcademicPreview.cjs')

const DEMO_PROJECT = 'demo-maxima-p0b2b-step848'
const SCHOOL_ID = 'maxima'
const CLASS_RELEASE = 'p0b2b-class-writer-v1'
const ALLOWED_PATCH_FIELDS = new Set(['uid', 'studentId', 'schoolId'])
const validId = x => typeof x === 'string' && x.length >= 1 && x.length <= 128 &&
  x === x.trim() && !x.includes('/')

function assertIsolatedEmulator(projectId) {
  const envHost = process.env.FIRESTORE_EMULATOR_HOST || ''
  if (projectId !== DEMO_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT !== DEMO_PROJECT ||
      process.env.GCLOUD_PROJECT !== DEMO_PROJECT ||
      !/^127\.0\.0\.1:\d{2,5}$/.test(envHost) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GOOGLE_CLOUD_QUOTA_PROJECT ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('G4_EMULATOR_ONLY_BLOCKED')
  }
}

function versionEquals(a, b) {
  return Boolean(a && b && typeof a.isEqual === 'function' && a.isEqual(b))
}

function patchIsSafe(record, patch, profileUid, profileSchoolId) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).length === 0 ||
      Object.keys(patch).some(x => !ALLOWED_PATCH_FIELDS.has(x)) ||
      !validId(profileUid) || profileSchoolId !== SCHOOL_ID) return false
  for (const [field, value] of Object.entries(patch)) {
    if (Object.hasOwn(record, field) && record[field] !== '' &&
        record[field] !== null && record[field] !== undefined) return false
    if (value !== (field === 'schoolId' ? SCHOOL_ID : profileUid)) return false
  }
  return true
}

async function rehearseOne({ db, projectId, collection, docId, expectedUpdateTime }) {
  assertIsolatedEmulator(projectId)
  if (!db?.runTransaction || !COLLECTIONS.has(collection) ||
      !validId(docId) || !expectedUpdateTime?.isEqual) {
    throw new Error('G4_INVALID_MIGRATION_CONTRACT')
  }
  const gateRef = db.doc('schools/maxima/classWriteGate/p0b2b')
  const leaseQuery = db.collection('schools/maxima/classAuthorityOperations').limit(1)
  const recordRef = db.collection(collection).doc(docId)

  return db.runTransaction(async tx => {
    // Read all authority/fence evidence within the transaction. This rehearsal
    // does NOT prove that old Production Cloud Run revisions are fenced.
    const gateSnap = await tx.get(gateRef)
    const gate = gateSnap.exists ? gateSnap.data() || {} : null
    if (!gate || gate.phase !== 'frozen' || gate.schemaVersion !== 1 ||
        gate.release !== CLASS_RELEASE || gate.g4EmulatorRehearsal !== true) {
      throw new Error('G4_GATE_NOT_FROZEN_OR_MISMATCHED')
    }
    const leases = await tx.get(leaseQuery)
    if (!leases.empty) throw new Error('G4_AUTHORITY_LEASE_NOT_DRAINED')

    const recordSnap = await tx.get(recordRef)
    if (!recordSnap.exists) return { kind: 'manual_review', reason: 'missing_record' }
    if (!versionEquals(expectedUpdateTime, recordSnap.updateTime)) {
      throw new Error('G4_STALE_RECORD_VERSION')
    }
    const record = recordSnap.data() || {}
    const uid = typeof record.uid === 'string' && record.uid
      ? record.uid : record.studentId
    if (!validId(uid)) return { kind: 'manual_review', reason: 'unverified_identity' }
    const profileSnap = await tx.get(db.doc(`users/${uid}`))
    const profile = profileSnap.exists ? profileSnap.data() : null
    const result = classifyLegacyIdentity({
      collection, docId, record, profile, profileUid: uid
    })
    if (result.kind !== 'candidate_preview_only') {
      return { kind: result.kind, reason: result.reason }
    }
    if (!patchIsSafe(record, result.updates, uid, profile?.schoolId)) {
      throw new Error('G4_DISALLOWED_PATCH')
    }
    // Firestore precondition PLUS transactional revalidation. Only the three
    // missing identity fields may change. No grades, answers or timestamps.
    tx.update(recordRef, result.updates, { lastUpdateTime: expectedUpdateTime })
    return { kind: 'updated', fields: Object.keys(result.updates).sort() }
  }, { maxAttempts: 3 })
}

module.exports = {
  DEMO_PROJECT, SCHOOL_ID, CLASS_RELEASE, assertIsolatedEmulator,
  patchIsSafe, rehearseOne
}
