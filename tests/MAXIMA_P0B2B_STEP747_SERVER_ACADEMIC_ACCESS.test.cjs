'use strict'
// Offline Cloud Callable permission regression: no network, no emulator, no AI.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { canonicalStudentAccessAllowed, requireCurrentTeacherAcademicStudent } =
  require('../functions/lib/p0bCurrentAcademicAccess')

const SCHOOL = 'maxima', TEACHER = 'step747_current', OLD = 'step747_old'
const STUDENT = 'step747_student', ADMIN = 'step747_admin'
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code } }
function fakeDb() {
  const docs = new Map()
  const set = (p, v) => docs.set(p, structuredClone(v))
  const del = p => docs.delete(p)
  const index = t => `schools/${SCHOOL}/teacherAcademicIndex/${t}`
  set(`schools/${SCHOOL}`, { status: 'active' })
  for (const id of [TEACHER, OLD]) set(`users/${id}`, {
    role: 'teacher', schoolId: SCHOOL, status: 'approved', deleted: false
  })
  set(`users/${ADMIN}`, { role: 'admin', status: 'approved' })
  set(`users/${STUDENT}`, {
    role: 'student', schoolId: SCHOOL, accountType: 'institution',
    status: 'approved', teacherIds: [OLD, TEACHER]
  })
  set(index(TEACHER), {
    schemaVersion: 1, source: 'managed_active_classes', teacherId: TEACHER,
    schoolId: SCHOOL, activeStudentIds: [STUDENT]
  })
  set(index(OLD), {
    schemaVersion: 1, source: 'managed_active_classes', teacherId: OLD,
    schoolId: SCHOOL, activeStudentIds: []
  })
  function snap(p) { return {
    exists: docs.has(p), ref: { path: p }, data: () => structuredClone(docs.get(p))
  } }
  const db = {
    doc: p => ({ path: p }),
    getAll: async (...rs) => rs.map(r => snap(r.path)),
    runTransaction: async cb => {
      const staged = []
      const tx = {
        get: async r => snap(r.path),
        getAll: async (...rs) => rs.map(r => snap(r.path)),
        set: (r, value) => staged.push([r.path, structuredClone(value)])
      }
      const result = await cb(tx)
      for (const [p, value] of staged) set(p, value)
      return result
    }
  }
  const manager = uid => ({ uid, profile: structuredClone(docs.get(`users/${uid}`)) })
  const check = (uid, tx) => requireCurrentTeacherAcademicStudent({
    db, HttpsError, manager: manager(uid), studentId: STUDENT, schoolId: SCHOOL, tx
  })
  return { db, docs, set, del, index, manager, check }
}
const denied = async p => assert.rejects(p, e => e?.code === 'permission-denied')

test('current teacher allowed; historical teacherIds and source ownership do not grant ex-teacher access', async () => {
  const f = fakeDb()
  assert.equal(await f.check(TEACHER), true)
  await denied(f.check(OLD))
  // Even if historical profile links still contain OLD, no access.
  assert.ok(f.docs.get(`users/${STUDENT}`).teacherIds.includes(OLD))
})

test('index missing, no student membership, malformed or forged index fails closed', async () => {
  for (const edit of [
    d => d.del(d.index(TEACHER)),
    d => d.set(d.index(TEACHER), { activeStudentIds: [STUDENT] }),
    d => { const p = d.index(TEACHER), obj = d.docs.get(p); obj.activeStudentIds = [] },
    d => { const p = d.index(TEACHER), obj = d.docs.get(p); obj.source = 'legacy_teacherIds' },
    d => { const p = d.index(TEACHER), obj = d.docs.get(p); obj.teacherId = OLD },
    d => { const p = d.index(TEACHER), obj = d.docs.get(p); obj.schoolId = 'other' },
    d => { const p = d.index(TEACHER), obj = d.docs.get(p); obj.schemaVersion = 0 },
    d => { const p = d.index(TEACHER), obj = d.docs.get(p); obj.activeStudentIds = 'everyone' }
  ]) {
    const f = fakeDb()
    edit(f)
    await denied(f.check(TEACHER))
  }
})

test('inactive, archived, deleted, deleting or mismatched user / school always denied', async () => {
  const trials = [
    f => { f.docs.get(`users/${TEACHER}`).status = 'pending' },
    f => { f.docs.get(`users/${TEACHER}`).deleted = true },
    f => { f.docs.get(`users/${TEACHER}`).schoolId = 'other' },
    f => { f.docs.get(`users/${STUDENT}`).status = 'pending' },
    f => { f.docs.get(`users/${STUDENT}`).archived = true },
    f => { f.docs.get(`users/${STUDENT}`).deleted = true },
    f => { f.docs.get(`users/${STUDENT}`).permanentDeleteInProgress = true },
    f => { f.docs.get(`users/${STUDENT}`).schoolId = 'other' },
    f => { f.docs.get(`users/${STUDENT}`).accountType = 'individual' },
    f => { f.docs.get(`schools/${SCHOOL}`).status = 'inactive' }
  ]
  for (const change of trials) { const f = fakeDb(); change(f); await denied(f.check(TEACHER)) }
})

test('active admin remains authorized without teacher index; transaction rechecks admin status', async () => {
  const f = fakeDb()
  assert.equal(await f.check(ADMIN), true)
  const result = await f.db.runTransaction(async tx => f.check(ADMIN, tx))
  assert.equal(result, true)
  f.docs.get(`users/${ADMIN}`).role = 'teacher'
  await denied(f.db.runTransaction(async tx => f.check(ADMIN, tx)))
})

test('stale preflight cannot commit a write after membership revocation', async () => {
  const f = fakeDb()
  assert.equal(await f.check(TEACHER), true)
  f.docs.get(f.index(TEACHER)).activeStudentIds = []
  const initial = structuredClone([...f.docs])
  await denied(f.db.runTransaction(async tx => {
    await f.check(TEACHER, tx)
    tx.set(f.db.doc('reviewEffects/test'), {tampered: true})
  }))
  assert.deepEqual([...f.docs], initial)
  assert.equal(f.docs.has('reviewEffects/test'), false)
})

test('invalid inputs and spoofed manager roles are denied', async () => {
  const f = fakeDb()
  const badManager = { uid: TEACHER, profile: { role: 'admin' } }
  // RequireAssignmentManager checks current status; transaction rechecks the role.
  await denied(requireCurrentTeacherAcademicStudent({
    db: f.db, HttpsError, manager: badManager, studentId: STUDENT,
    schoolId: SCHOOL, tx: { get: async r => ({exists:true,data:()=>f.docs.get(r.path)}) }
  }))
  await denied(requireCurrentTeacherAcademicStudent({
    db: f.db, HttpsError, manager: f.manager(TEACHER), studentId: '../x', schoolId: SCHOOL
  }))
})

test('safe canonical predicate accepts only the exact current teacher/student/school/index tuple', () => {
  const f = fakeDb()
  const inputs = {
    teacherUid: TEACHER, studentId: STUDENT, schoolId: SCHOOL,
    teacher: f.docs.get(`users/${TEACHER}`), student: f.docs.get(`users/${STUDENT}`),
    school: f.docs.get(`schools/${SCHOOL}`), index: f.docs.get(f.index(TEACHER))
  }
  assert.equal(canonicalStudentAccessAllowed(inputs), true)
  assert.equal(canonicalStudentAccessAllowed({...inputs,teacherUid:OLD}), false)
  assert.equal(canonicalStudentAccessAllowed({...inputs,studentId:'fake'}), false)
})

test('Cloud Callable gates include student history/state, moderation and reopen; all irreversible deletions are admin-only', () => {
  const source = fs.readFileSync(path.join(__dirname,'../functions/index.js'),'utf8')
  const span = name => {
    const start = source.indexOf(`exports.${name} = onCall(`)
    assert.ok(start >= 0, `${name} exists`)
    const next = source.indexOf('\nexports.',start+1)
    return source.slice(start,next>start?next:source.length)
  }
  for (const name of ['getManagedSubmissionAttemptState','getManagedSubmissionAttemptHistory',
    'setManagedSubmissionStatsExclusion','setSubmissionAttemptControl']) {
    assert.match(span(name),/await requireCurrentTeacherAcademicStudent\(/, name)
    // A source's old owner is not authorized to alter the current learner's results;
    // conversely, the new current teacher need not be the old source owner.
    assert.doesNotMatch(span(name).slice(0,2000),/managerCanManageSource\(manager, source\)/, name)
  }
  assert.match(span('setManagedSubmissionStatsExclusion'),/studentId, schoolId, tx/)
  assert.match(span('setSubmissionAttemptControl'),/studentId, schoolId, tx: transaction/)
  assert.match(source,/async function managedResultDeletionContext\(request\) \{[\s\S]{0,250}const manager = await requireAdmin\(request\)/)
  assert.match(source,/async function legacyContentPurgeContext\(request\) \{[\s\S]{0,300}const manager = await requireAdmin\(request\)/)
  assert.match(span('permanentlyDeleteManagedSubmissionResult'),/manager\.data\(\)\?\.role !== 'admin'/)
  assert.match(source,/if \(manager\.data\(\)\?\.role !== 'admin' \|\| !source\?\.exists/)
})
