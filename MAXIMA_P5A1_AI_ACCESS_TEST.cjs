'use strict'

// P5A-1 offline access and credit tests; no network or Firebase emulator needed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createAiWritingAccessService } = require('./functions/lib/aiWritingAccess')

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

class MemoryFirestore {
  constructor() { this.rows = new Map() }
  doc(path) {
    if (!/^[^/]+\/[^/]+$/.test(path)) throw new Error(`Invalid mock ref: ${path}`)
    const db = this
    return { path, async get() { return db.snapshot(path) } }
  }
  snapshot(path) {
    const current = this.rows.get(path)
    return { exists: Boolean(current), data: () => current ? structuredClone(current) : undefined }
  }
  seed(path, value) { this.rows.set(path, structuredClone(value)) }
  async runTransaction(callback) {
    const staged = []
    const db = this
    const tx = {
      async get(ref) { return db.snapshot(ref.path) },
      set(ref, value, options = {}) {
        staged.push({ op: 'set', path: ref.path, value: structuredClone(value), merge: Boolean(options.merge) })
      },
      create(ref, value) {
        staged.push({ op: 'create', path: ref.path, value: structuredClone(value) })
      }
    }
    const result = await callback(tx)
    for (const write of staged) {
      if (write.op === 'create' && db.rows.has(write.path)) {
        throw new HttpsError('already-exists', 'Mock document exists')
      }
      const previous = write.merge && db.rows.get(write.path) ? db.rows.get(write.path) : {}
      db.rows.set(write.path, { ...structuredClone(previous), ...write.value })
    }
    return result
  }
}

const db = new MemoryFirestore()
const schoolIdOf = profile => profile?.schoolId || 'maxima'
const accountTypeOf = profile => {
  if (profile?.accountType === 'individual' || profile?.schoolId === '__individual__') return 'individual'
  if (profile?.accountType === 'platform' || profile?.schoolId === '__platform__') return 'platform'
  return 'institution'
}
function approved(profile, role) {
  return profile?.role === role && profile.status === 'approved' && profile.deleted !== true
}
function authRequest(uid, data = {}) { return { auth: uid ? { uid } : null, data } }
async function profileOf(request, role) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Login required')
  const snap = await db.doc(`users/${request.auth.uid}`).get()
  if (!snap.exists || !approved(snap.data(), role)) {
    throw new HttpsError('permission-denied', `Not an active ${role}`)
  }
  return { uid: request.auth.uid, profile: snap.data(), schoolId: schoolIdOf(snap.data()) }
}
async function requireActiveSchoolForProfile(profile) {
  const snap = await db.doc(`schools/${schoolIdOf(profile)}`).get()
  if (!snap.exists || snap.data().status !== 'active') {
    throw new HttpsError('failed-precondition', 'Inactive institution')
  }
}
const service = createAiWritingAccessService({
  db, HttpsError, schoolIdOf, accountTypeOf, requireActiveSchoolForProfile,
  FieldValue: { serverTimestamp: () => 'SERVER_TIME' },
  async requireAdmin(req) { return profileOf(req, 'admin') },
  async requireStudent(req) {
    const user = await profileOf(req, 'student')
    if (accountTypeOf(user.profile) !== 'institution') {
      throw new HttpsError('permission-denied', 'Self-study not supported')
    }
    await requireActiveSchoolForProfile(user.profile)
    return user
  }
})

db.seed('schools/maxima', { status: 'active' })
db.seed('schools/other-school', { status: 'active' })
db.seed('users/ADMIN_MAX', { role: 'admin', status: 'approved', accountType: 'institution', schoolId: 'maxima' })
db.seed('users/ADMIN_OTHER', { role: 'admin', status: 'approved', accountType: 'institution', schoolId: 'other-school' })
db.seed('users/TEACHER_MAX', { role: 'teacher', status: 'approved', accountType: 'institution', schoolId: 'maxima' })
db.seed('users/STUDENT_001', { role: 'student', status: 'approved', accountType: 'institution', schoolId: 'maxima' })
db.seed('users/STUDENT_002', { role: 'student', status: 'approved', accountType: 'institution', schoolId: 'maxima' })
db.seed('users/STUDENT_FOREIGN', { role: 'student', status: 'approved', accountType: 'institution', schoolId: 'other-school' })
db.seed('users/INDIV_00001', { role: 'student', status: 'approved', accountType: 'individual', schoolId: '__individual__' })
db.seed('users/PENDING_001', { role: 'student', status: 'pending', accountType: 'institution', schoolId: 'maxima' })
db.seed('users/DELETED_001', { role: 'student', status: 'approved', deleted: true, accountType: 'institution', schoolId: 'maxima' })

const checks = []
function test(label, fn) { checks.push({ label, fn }) }
async function denies(action, code) {
  await assert.rejects(action, err => err instanceof HttpsError && err.code === code)
}
function change(requestId, overrides = {}) {
  return authRequest('ADMIN_MAX', { studentId: 'STUDENT_001', requestId, ...overrides })
}

test('Default-off: student has no access without pilot or grant', async () => {
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.canEvaluate, false)
  assert.equal(s.creditsRemaining, 0)
  assert.equal(s.pilotEnabled, false)
})
test('Unauthenticated student access denied', async () => {
  await denies(() => service.getMyAiWritingAccess(authRequest(null)), 'unauthenticated')
})
test('Self-study student rejected', async () => {
  await denies(() => service.getMyAiWritingAccess(authRequest('INDIV_00001')), 'permission-denied')
})
test('Teacher cannot impersonate student', async () => {
  await denies(() => service.getMyAiWritingAccess(authRequest('TEACHER_MAX')), 'permission-denied')
})
test('Non-admin cannot enable school pilot', async () => {
  await denies(() => service.setAiWritingSchoolPilot(authRequest('TEACHER_MAX', { enabled: true })), 'permission-denied')
})
test('Pilot toggle rejects non-boolean', async () => {
  await denies(() => service.setAiWritingSchoolPilot(authRequest('ADMIN_MAX', { enabled: 1 })), 'invalid-argument')
})
test('Admin enables only own school pilot', async () => {
  const res = await service.setAiWritingSchoolPilot(authRequest('ADMIN_MAX', { enabled: true }))
  assert.equal(res.pilotEnabled, true)
  assert.equal(db.snapshot('aiWritingSchoolSettings/other-school').exists, false)
})
test('Other-school administrator cannot enable the Maxima-only pilot', async () => {
  await denies(() => service.setAiWritingSchoolPilot(authRequest('ADMIN_OTHER', { enabled: true })), 'permission-denied')
})
test('School pilot alone never grants student access', async () => {
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.canEvaluate, false)
  assert.equal(s.pilotEnabled, true)
})
test('Administrator cannot grant cross-school student', async () => {
  await denies(() => service.setAiWritingStudentAccess(authRequest('ADMIN_OTHER', {
    studentId: 'STUDENT_001', requestId: 'crossschool01', enabled: true, creditDelta: 5
  })), 'permission-denied')
})
test('Individual account cannot receive institution AI credits', async () => {
  await denies(() => service.setAiWritingStudentAccess(authRequest('ADMIN_MAX', {
    studentId: 'INDIV_00001', requestId: 'individual0001', enabled: true, creditDelta: 5
  })), 'permission-denied')
})
test('Pending student cannot receive grants', async () => {
  await denies(() => service.setAiWritingStudentAccess(authRequest('ADMIN_MAX', {
    studentId: 'PENDING_001', requestId: 'pendinggrant01', enabled: true, creditDelta: 5
  })), 'failed-precondition')
})
test('Archived or deleted student cannot receive grants', async () => {
  await denies(() => service.setAiWritingStudentAccess(authRequest('ADMIN_MAX', {
    studentId: 'DELETED_001', requestId: 'deletedgrant1', enabled: true, creditDelta: 5
  })), 'failed-precondition')
})
test('Student ID and requestId validated', async () => {
  await denies(() => service.setAiWritingStudentAccess(change('xx', { enabled: true })), 'invalid-argument')
})
test('Fractional credits are rejected', async () => {
  await denies(() => service.setAiWritingStudentAccess(change('fractional001', { creditDelta: 1.5 })), 'invalid-argument')
})
test('Grant of 5 credits and student enable are atomic', async () => {
  const result = await service.setAiWritingStudentAccess(change('grantPilot0001', { enabled: true, creditDelta: 5 }))
  assert.equal(result.creditsRemaining, 5)
  assert.equal(result.studentEnabled, true)
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.canEvaluate, true)
  assert.equal(s.creditsAddedTotal, 5)
})
test('Admin can read own school student permission', async () => {
  const s = await service.getAdminAiWritingStudentAccess(authRequest('ADMIN_MAX', { studentId: 'STUDENT_001' }))
  assert.equal(s.canEvaluate, true)
})
test('Admin cannot read other-school AI permissions', async () => {
  await denies(() => service.getAdminAiWritingStudentAccess(authRequest('ADMIN_OTHER', { studentId: 'STUDENT_001' })), 'permission-denied')
})
test('Repeated requestId does not grant credits twice', async () => {
  const r = await service.setAiWritingStudentAccess(change('grantPilot0001', { enabled: true, creditDelta: 5 }))
  assert.equal(r.alreadyApplied, true)
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.creditsRemaining, 5)
})
test('Repeated requestId with different payload is rejected', async () => {
  await denies(() => service.setAiWritingStudentAccess(change('grantPilot0001', { enabled: false, creditDelta: 5 })), 'already-exists')
})
test('All others stay disabled without individual approval', async () => {
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_002'))
  assert.equal(s.canEvaluate, false)
  assert.equal(s.creditsRemaining, 0)
})
test('Disabling school immediately removes effective AI access', async () => {
  await service.setAiWritingSchoolPilot(authRequest('ADMIN_MAX', { enabled: false }))
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.canEvaluate, false)
  assert.equal(s.creditsRemaining, 5)
})
test('Central server access predicate also denies while pilot disabled', async () => {
  const student = await profileOf(authRequest('STUDENT_001'), 'student')
  await denies(() => service.assertCanEvaluateAiWriting(student), 'permission-denied')
})
test('Reenabling school restores eligible student access without new credits', async () => {
  await service.setAiWritingSchoolPilot(authRequest('ADMIN_MAX', { enabled: true }))
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.canEvaluate, true)
})
test('Disabling one student preserves credits but blocks AI', async () => {
  const r = await service.setAiWritingStudentAccess(change('disablePilot01', { enabled: false }))
  assert.equal(r.creditsRemaining, 5)
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.canEvaluate, false)
})
test('Admin can re-enable student without topup', async () => {
  await service.setAiWritingStudentAccess(change('reenablePilot1', { enabled: true }))
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.canEvaluate, true)
})
test('Admin can reduce unused credit balance transactionally', async () => {
  const r = await service.setAiWritingStudentAccess(change('reducePilot01', { creditDelta: -3 }))
  assert.equal(r.creditsRemaining, 2)
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_001'))
  assert.equal(s.creditsRemovedTotal, 3)
})
test('Credit balance cannot be negative', async () => {
  await denies(() => service.setAiWritingStudentAccess(change('underflowPilot1', { creditDelta: -5 })), 'failed-precondition')
})
test('Per-operation credit change cap applies', async () => {
  await denies(() => service.setAiWritingStudentAccess(change('tooManyCredit', { creditDelta: 101 })), 'invalid-argument')
})
test('Student access cannot be activated without any credits', async () => {
  await service.setAiWritingStudentAccess(authRequest('ADMIN_MAX', {
    studentId: 'STUDENT_002', requestId: 'enableZero0001', enabled: true
  }))
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_002'))
  assert.equal(s.studentEnabled, true)
  assert.equal(s.canEvaluate, false)
})
test('Access record ownership tampering fails closed', async () => {
  db.seed('aiWritingStudentAccess/STUDENT_002', {
    studentId: 'STUDENT_FOREIGN', schoolId: 'other-school', accountType: 'institution',
    enabled: true, creditsRemaining: 99
  })
  const s = await service.getMyAiWritingAccess(authRequest('STUDENT_002'))
  assert.equal(s.canEvaluate, false)
  await denies(() => service.setAiWritingStudentAccess(authRequest('ADMIN_MAX', {
    studentId: 'STUDENT_002', requestId: 'wrongOwnership1', creditDelta: 5
  })), 'failed-precondition')
})
test('Inactive school cannot grant additional access', async () => {
  db.seed('schools/maxima', { status: 'inactive' })
  await denies(() => service.setAiWritingStudentAccess(change('inactiveSchool1', { creditDelta: 1 })), 'failed-precondition')
})
test('Archived account denied AI status independently of remaining credits', async () => {
  db.seed('users/STUDENT_001', { role:'student', status:'deleted', deleted:true, accountType:'institution', schoolId:'maxima' })
  await denies(() => service.getMyAiWritingAccess(authRequest('STUDENT_001')), 'permission-denied')
})
test('Rules deny browser access to all AI-related data collections', async () => {
  const rules = fs.readFileSync(path.join(__dirname, 'firestore.rules'), 'utf8')
  for (const name of ['aiWritingSchoolSettings','aiWritingStudentAccess','aiWritingCreditOperations']) {
    const escape = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(rules, new RegExp(`match /${escape}/\\{[^}]+\\} \\{\\s*allow read, write: if false;`))
  }
})
test('Full account deletion includes AI access and credit operations', async () => {
  const index = fs.readFileSync(path.join(__dirname, 'functions/index.js'), 'utf8')
  assert.match(index, /\{ name: 'aiWritingStudentAccess', fields: \['uid', 'studentId'\] \}/)
  assert.match(index, /\{ name: 'aiWritingCreditOperations', fields: \['studentId'\] \}/)
  assert.match(index, /'aiWritingSchoolSettings',\s*'aiWritingStudentAccess',\s*'aiWritingCreditOperations'/)
})
test('P5A-1 performs no AI model requests or credit consumption', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'functions/lib/aiWritingAccess.js'), 'utf8')
  assert.doesNotMatch(source, /https:\/\/api\.openai\.com|generateContent\(|responses\.create\(/)
  assert.doesNotMatch(source, /creditsUsedTotal:\s*safeCount\(stored\.creditsUsedTotal\)\s*\+/)
})

;(async () => {
  let passed = 0
  for (const check of checks) {
    try {
      await check.fn()
      passed++
      process.stdout.write(`PASS ${check.label}\n`)
    } catch (error) {
      console.error(`FAIL ${check.label}:`, error)
      process.exitCode = 1
      break
    }
  }
  console.log(`\nP5A-1 offline access/credits: ${passed}/${checks.length} PASS`)
})()
