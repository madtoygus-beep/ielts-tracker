'use strict'

// P5A-1: Institution-only, default-off AI Writing pilot permissions and credits.
// No model calls, no charges, and no student-facing scoring are implemented here.
// All reads and writes go through authenticated Cloud Functions (Admin SDK).
const { createHash } = require('crypto')

const SCHEMA_VERSION = 1
const PILOT_SCHOOL_ID = 'maxima' // P5A-1: the first 5-6 testers are Maxima institution students.
const MAX_CREDITS_BALANCE = 1000
const MAX_CREDIT_ADJUSTMENT = 100

function createAiWritingAccessService({
  db, FieldValue, HttpsError, requireAdmin, requireStudent, accountTypeOf,
  schoolIdOf, requireActiveSchoolForProfile
}) {
  if (!db || !FieldValue || !HttpsError || !requireAdmin || !requireStudent ||
      !accountTypeOf || !schoolIdOf || !requireActiveSchoolForProfile) {
    throw new Error('AI Writing service dependencies are missing.')
  }

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  const invalid = (code, text) => { throw new HttpsError(code, text) }
  const settingsRef = schoolId => db.doc(`aiWritingSchoolSettings/${schoolId}`)
  const accessRef = uid => db.doc(`aiWritingStudentAccess/${uid}`)

  function inputObject(request) {
    const data = request?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      invalid('invalid-argument', 'A valid request object is required.')
    }
    return data
  }

  function studentIdOf(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(value)) {
      invalid('invalid-argument', 'A valid student ID is required.')
    }
    return value
  }

  function requestIdOf(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
      invalid('invalid-argument', 'A unique 8-80 character requestId is required.')
    }
    return value
  }

  function approvedAdmin(profile) {
    return profile?.role === 'admin' && profile.status === 'approved' &&
      profile.deleted !== true && accountTypeOf(profile) === 'institution'
  }

  function approvedInstitutionStudent(profile) {
    return profile?.role === 'student' && profile.status === 'approved' &&
      profile.deleted !== true && accountTypeOf(profile) === 'institution'
  }

  function requireSameSchool(admin, profile) {
    if (!approvedAdmin(admin.profile)) {
      invalid('permission-denied', 'An approved institution administrator is required.')
    }
    if (schoolIdOf(admin.profile) !== PILOT_SCHOOL_ID ||
        schoolIdOf(profile) !== PILOT_SCHOOL_ID) {
      invalid('permission-denied', 'You cannot manage AI access in another school.')
    }
  }

  function creditBalance(data) {
    const balance = data?.creditsRemaining
    return Number.isSafeInteger(balance) && balance >= 0 && balance <= MAX_CREDITS_BALANCE ? balance : 0
  }

  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  function accessSummary({ studentId, schoolId, settings, access, profileActive }) {
    const validAccess = access?.studentId === studentId && access?.uid === studentId &&
      access?.schoolId === schoolId && access?.accountType === 'institution'
    const settingsEnabled = schoolId === PILOT_SCHOOL_ID &&
      settings?.schoolId === schoolId && settings?.pilotEnabled === true
    const studentEnabled = validAccess && access.enabled === true
    const creditsRemaining = validAccess ? creditBalance(access) : 0

    return {
      studentId,
      schoolId,
      accountType: 'institution',
      pilotEnabled: settingsEnabled,
      studentEnabled: Boolean(studentEnabled),
      creditsRemaining,
      creditsAddedTotal: validAccess ? safeCount(access.creditsAddedTotal) : 0,
      creditsRemovedTotal: validAccess ? safeCount(access.creditsRemovedTotal) : 0,
      creditsUsedTotal: validAccess ? safeCount(access.creditsUsedTotal) : 0,
      canEvaluate: Boolean(profileActive && settingsEnabled && studentEnabled && creditsRemaining > 0)
    }
  }

  async function getMyAiWritingAccess(request) {
    const student = await requireStudent(request)
    if (!approvedInstitutionStudent(student.profile)) {
      invalid('permission-denied', 'AI Writing pilot is restricted to institution students.')
    }
    const [settings, access] = await Promise.all([
      settingsRef(student.schoolId).get(),
      accessRef(student.uid).get()
    ])
    return accessSummary({
      studentId: student.uid,
      schoolId: student.schoolId,
      profileActive: true,
      settings: settings.exists ? settings.data() : null,
      access: access.exists ? access.data() : null
    })
  }

  async function getAdminAiWritingStudentAccess(request) {
    const admin = await requireAdmin(request)
    const studentId = studentIdOf(inputObject(request).studentId)
    const snap = await db.doc(`users/${studentId}`).get()
    if (!snap.exists) invalid('not-found', 'Student profile was not found.')
    const profile = snap.data() || {}
    requireSameSchool(admin, profile)
    if (profile.role !== 'student' || accountTypeOf(profile) !== 'institution') {
      invalid('permission-denied', 'Only institution students can use this pilot.')
    }
    const schoolId = schoolIdOf(profile)
    const [settings, access] = await Promise.all([
      settingsRef(schoolId).get(), accessRef(studentId).get()
    ])
    return accessSummary({
      studentId, schoolId,
      profileActive: approvedInstitutionStudent(profile),
      settings: settings.exists ? settings.data() : null,
      access: access.exists ? access.data() : null
    })
  }

  async function setAiWritingSchoolPilot(request) {
    const admin = await requireAdmin(request)
    const data = inputObject(request)
    if (!approvedAdmin(admin.profile)) {
      invalid('permission-denied', 'Institution Admin access is required.')
    }
    if (typeof data.enabled !== 'boolean') {
      invalid('invalid-argument', 'enabled must be true or false.')
    }

    const schoolId = schoolIdOf(admin.profile)
    if (schoolId !== PILOT_SCHOOL_ID) {
      invalid('permission-denied', 'The first AI Writing pilot is available only for Maxima.')
    }
    const ref = settingsRef(schoolId)
    await db.runTransaction(async tx => {
      const [adminSnap, schoolSnap, previous] = await Promise.all([
        tx.get(db.doc(`users/${admin.uid}`)),
        tx.get(db.doc(`schools/${schoolId}`)),
        tx.get(ref)
      ])
      if (!adminSnap.exists || !approvedAdmin(adminSnap.data()) ||
          schoolIdOf(adminSnap.data()) !== schoolId) {
        invalid('permission-denied', 'Administrator authorization changed.')
      }
      if (!schoolSnap.exists || schoolSnap.data()?.status !== 'active') {
        invalid('failed-precondition', 'Your institution must be active.')
      }
      tx.set(ref, {
        schemaVersion: SCHEMA_VERSION,
        schoolId,
        pilotEnabled: data.enabled,
        updatedBy: admin.uid,
        updatedAt: FieldValue.serverTimestamp(),
        ...(!previous.exists ? { createdAt: FieldValue.serverTimestamp() } : {})
      }, { merge: true })
    })
    return { ok: true, schoolId, pilotEnabled: data.enabled }
  }

  async function setAiWritingStudentAccess(request) {
    const admin = await requireAdmin(request)
    const data = inputObject(request)
    const studentId = studentIdOf(data.studentId)
    const requestId = requestIdOf(data.requestId)
    const hasEnabled = own(data, 'enabled')
    if (hasEnabled && typeof data.enabled !== 'boolean') {
      invalid('invalid-argument', 'enabled must be a boolean.')
    }
    const creditDelta = own(data, 'creditDelta') ? data.creditDelta : 0
    if (!Number.isSafeInteger(creditDelta) || Math.abs(creditDelta) > MAX_CREDIT_ADJUSTMENT) {
      invalid('invalid-argument', 'creditDelta must be an integer between -100 and 100.')
    }
    if (!hasEnabled && creditDelta === 0) {
      invalid('invalid-argument', 'An enabled change or credit adjustment is required.')
    }

    const studentRef = db.doc(`users/${studentId}`)
    const adminRef = db.doc(`users/${admin.uid}`)
    const initial = await studentRef.get()
    if (!initial.exists) invalid('not-found', 'Student profile was not found.')
    const initialProfile = initial.data() || {}
    requireSameSchool(admin, initialProfile)
    if (!approvedInstitutionStudent(initialProfile)) {
      invalid('failed-precondition', 'Only active institution students can receive AI access.')
    }
    const schoolId = schoolIdOf(initialProfile)
    await requireActiveSchoolForProfile(initialProfile)

    const payloadSignature = createHash('sha256').update(JSON.stringify({
      adminUid: admin.uid, studentId, schoolId,
      enabled: hasEnabled ? data.enabled : null, creditDelta
    })).digest('hex')
    const ledgerId = createHash('sha256')
      .update(`${studentId}\u001f${requestId}`, 'utf8').digest('hex')
    const ledgerRef = db.doc(`aiWritingCreditOperations/${ledgerId}`)
    const targetRef = accessRef(studentId)

    return db.runTransaction(async tx => {
      // Read all transaction documents before performing any writes.
      const [freshAdmin, freshStudent, schoolSnap, operationSnap, accessSnap] =
        await Promise.all([
          tx.get(adminRef), tx.get(studentRef), tx.get(db.doc(`schools/${schoolId}`)),
          tx.get(ledgerRef), tx.get(targetRef)
        ])

      if (!freshAdmin.exists || !approvedAdmin(freshAdmin.data()) ||
          schoolIdOf(freshAdmin.data()) !== schoolId) {
        invalid('permission-denied', 'Administrator authorization changed.')
      }
      if (!freshStudent.exists || !approvedInstitutionStudent(freshStudent.data()) ||
          schoolIdOf(freshStudent.data()) !== schoolId) {
        invalid('permission-denied', 'Student authorization changed.')
      }
      if (!schoolSnap.exists || schoolSnap.data()?.status !== 'active') {
        invalid('failed-precondition', 'The selected school is not active.')
      }
      if (operationSnap.exists) {
        const previousOperation = operationSnap.data() || {}
        if (previousOperation.payloadSignature !== payloadSignature ||
            previousOperation.requestId !== requestId) {
          invalid('already-exists', 'requestId was previously used for a different change.')
        }
        return {
          ok: true, alreadyApplied: true,
          ...accessSummary({
            studentId, schoolId,
            profileActive: true,
            settings: { schoolId, pilotEnabled: false },
            access: accessSnap.exists ? accessSnap.data() : null
          })
        }
      }

      const stored = accessSnap.exists ? (accessSnap.data() || {}) : {}
      if (accessSnap.exists && (stored.studentId !== studentId || stored.uid !== studentId ||
          stored.schoolId !== schoolId || stored.accountType !== 'institution')) {
        invalid('failed-precondition', 'Existing AI access record has invalid ownership.')
      }
      if (accessSnap.exists && (!Number.isSafeInteger(stored.creditsRemaining) ||
          stored.creditsRemaining < 0 || stored.creditsRemaining > MAX_CREDITS_BALANCE)) {
        invalid('failed-precondition', 'AI credit record is invalid; contact an administrator.')
      }
      const oldBalance = creditBalance(stored)
      const newBalance = oldBalance + creditDelta
      if (newBalance < 0 || newBalance > MAX_CREDITS_BALANCE) {
        invalid('failed-precondition', 'AI credits would be negative or exceed pilot balance limit.')
      }

      const newEnabled = hasEnabled ? data.enabled : (stored.enabled === true)
      tx.set(targetRef, {
        schemaVersion: SCHEMA_VERSION,
        studentId,
        uid: studentId,
        schoolId,
        accountType: 'institution',
        enabled: newEnabled,
        creditsRemaining: newBalance,
        creditsAddedTotal: safeCount(stored.creditsAddedTotal) + Math.max(0, creditDelta),
        creditsRemovedTotal: safeCount(stored.creditsRemovedTotal) + Math.max(0, -creditDelta),
        creditsUsedTotal: safeCount(stored.creditsUsedTotal),
        updatedBy: admin.uid,
        updatedAt: FieldValue.serverTimestamp(),
        ...(!accessSnap.exists ? { createdAt: FieldValue.serverTimestamp() } : {})
      }, { merge: true })
      tx.create(ledgerRef, {
        schemaVersion: SCHEMA_VERSION,
        requestId,
        payloadSignature,
        studentId,
        schoolId,
        action: 'admin_access_adjustment',
        actorUid: admin.uid,
        creditDelta,
        previousBalance: oldBalance,
        newBalance,
        previousEnabled: stored.enabled === true,
        newEnabled,
        createdAt: FieldValue.serverTimestamp()
      })
      return {
        ok: true, alreadyApplied: false,
        studentId, schoolId, studentEnabled: newEnabled,
        creditsRemaining: newBalance
      }
    })
  }

  // P5A-2 must call this same server-side check before reserving a credit.
  // It must also atomically reserve/settle the credit for each unique attempt.
  async function assertCanEvaluateAiWriting(student) {
    if (!approvedInstitutionStudent(student.profile)) {
      invalid('permission-denied', 'Individual and inactive accounts cannot use AI Writing.')
    }
    const [settings, access] = await Promise.all([
      settingsRef(student.schoolId).get(), accessRef(student.uid).get()
    ])
    const state = accessSummary({
      studentId: student.uid, schoolId: student.schoolId, profileActive: true,
      settings: settings.exists ? settings.data() : null,
      access: access.exists ? access.data() : null
    })
    if (!state.canEvaluate) {
      invalid('permission-denied', 'AI Writing is not enabled or credits are exhausted.')
    }
    return state
  }

  return {
    getMyAiWritingAccess,
    getAdminAiWritingStudentAccess,
    setAiWritingSchoolPilot,
    setAiWritingStudentAccess,
    assertCanEvaluateAiWriting
  }
}

module.exports = { createAiWritingAccessService }
