'use strict'
// P6-A1 focused offline checks. No Firebase connection or model requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const lib = path.join(process.cwd(), 'functions', 'lib')
const { createAiWritingAccessService } = require(path.join(lib, 'aiWritingAccess.js'))
const { createAiWritingSponsoredPolicyService } = require(path.join(lib, 'aiWritingSponsoredPolicy.js'))
const { createAiWritingEvaluationService } = require(path.join(lib, 'aiWritingEvaluation.js'))
const { createAiWritingManagedReportService } = require(path.join(lib, 'aiWritingManagedReport.js'))
class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const timeField = { serverTimestamp: () => 'server-time' }
const copy = o => structuredClone(o)
function fakeDb(initial) {
  const records = new Map(Object.entries(copy(initial)))
  const stat = { writes: 0, reads: 0 }
  const snap = (p) => ({ exists: records.has(p), id: p.split('/').at(-1),
    data: () => records.has(p) ? copy(records.get(p)) : undefined })
  const ref = p => ({ path: p, id: p.split('/').at(-1),
    get: async () => { stat.reads++; return snap(p) } })
  const db = {
    doc: ref,
    collection: name => ({where: (field, op, value) => {
      if (name !== 'classes' || field !== 'teacherId' || op !== '==') throw Error('Unexpected query')
      return { _query: true, get: async () => ({ docs: [...records.entries()]
        .filter(([p, data]) => p.startsWith('classes/') && data.teacherId === value)
        .map(([p]) => snap(p)) }) }
    }}),
    getAll: async (...refs) => refs.map(r => snap(r.path)),
    runTransaction: async fn => {
      const writes = []
      const tx = {
        get: async r => { stat.reads++; return r._query ? r.get() : snap(r.path) },
        set: (r, data, opts) => writes.push(['set', r.path, copy(data), opts]),
        update: (r, data) => writes.push(['update', r.path, copy(data)]),
        create: (r, data) => writes.push(['create', r.path, copy(data)])
      }
      const result = await fn(tx)
      for (const [op, p, value, opts] of writes) {
        if (op === 'create') assert.equal(records.has(p), false)
        if (op === 'update') assert.equal(records.has(p), true)
        records.set(p, opts?.merge || op === 'update'
          ? { ...(records.get(p) || {}), ...value } : value)
        stat.writes++
      }
      return result
    }
  }
  return { db, records, stat }
}
const schoolIdOf = d => d?.schoolId || 'maxima'
const accountTypeOf = d => d?.accountType || 'institution'
const liveStudent = {role: 'student', status: 'approved', accountType: 'institution',
  schoolId: 'maxima', teacherId: 'teacherNew', teacherIds: ['teacherOld','teacherNew'], createdBy: 'teacherOld'}
const liveTeacher = {role: 'teacher', status: 'approved', accountType: 'institution', schoolId: 'maxima'}
const liveAdmin = {role: 'admin', status: 'approved', accountType: 'institution', schoolId: 'maxima'}
const activeAssignment = {uid: 'student01', schoolId: 'maxima', contentType: 'writing',
  contentId: 'essay01', sourceCollection: 'writingHomeworks', accessType: 'assignment', status: 'active'}
function policySetup(studentOverrides={}, { policy=true }={}) {
  const records = {
    'schools/maxima': {status: 'active'},
    'users/student01': {...liveStudent, ...studentOverrides},
    'users/teacherOld': liveTeacher, 'users/teacherNew': liveTeacher, 'users/admin0001': liveAdmin,
    'writingHomeworks/essay01': {schoolId: 'maxima', teacherIds: ['teacherOld','teacherNew'], archived: false},
    'classes/teacherNewClass': {schoolId:'maxima', teacherId:'teacherNew', name:'Class 10', studentIds:['student01'], archived:false},
    'studentAccess/student01_writing_essay01': activeAssignment,
    ...(policy ? {'aiWritingSponsoredPolicies/writing_essay01': {
      schoolId: 'maxima', contentType: 'writing', contentId: 'essay01',
      sourceCollection: 'writingHomeworks', context: 'homework', studentIds: ['student01'],
      enabled: true, billing: 'institution', updatedBy: 'teacherNew'
    }} : {})
  }
  const store = fakeDb(records)
  function service(uid) {
    const manager = {uid, profile: store.records.get(`users/${uid}`)}
    const service = createAiWritingSponsoredPolicyService({
      db: store.db, FieldValue: timeField, HttpsError: AuthError,
      requireAssignmentManager: async () => manager,
      managerCanManageSource: (actor, source) => actor.profile.role === 'admin' ||
        source.teacherIds.includes(actor.uid),
      schoolIdOf, accountTypeOf,
      teacherIdsOf: source => source.teacherIds || [],
      getMockEnabledSections: source => source.enabledSections || {}
    })
    return service
  }
  const getReq = {data: {contentType: 'writing', contentId: 'essay01'}}
  const setReq = {data: {...getReq.data, enabled: true, studentIds: ['student01']}}
  return {...store, service, getReq, setReq}
}

test('old teacher is denied when current scalar teacherId points to another teacher, even with stale teacherIds', async () => {
  const s = policySetup()
  assert.equal((await s.service('teacherOld').getPolicy(s.getReq)).enabled, false)
  await assert.rejects(s.service('teacherOld').setPolicy(s.setReq), e => e.code === 'permission-denied')
  assert.equal(s.stat.writes, 0)
})

test('current teacher can view and configure sponsored policy', async () => {
  const s = policySetup()
  const state = await s.service('teacherNew').getPolicy(s.getReq)
  assert.equal(state.enabled, true)
  assert.deepEqual(state.studentIds, ['student01'])
  const updated = await s.service('teacherNew').setPolicy(s.setReq)
  assert.equal(updated.ok, true)
  assert.equal(s.stat.writes, 1)
  assert.equal(s.records.get('aiWritingSponsoredPolicies/writing_essay01').updatedBy, 'teacherNew')
})

test('historical createdBy alone is not a teacher authorization', async () => {
  const s = policySetup({teacherId: '', teacherIds: [], createdBy: 'teacherOld'})
  assert.deepEqual((await s.service('teacherOld').getPolicy(s.getReq)).studentIds, [])
  await assert.rejects(s.service('teacherOld').setPolicy(s.setReq), e => e.code === 'permission-denied')
})

test('legacy array-only teacher link still works with independently proven active class membership', async () => {
  const s = policySetup({teacherId: '', teacherIds: ['teacherOld'], createdBy: 'admin0001'})
  // Compatibility works only with a current class, NOT from an old additive array alone.
  s.records.set('classes/teacherOldClass', {schoolId:'maxima',teacherId:'teacherOld', name:'Active IELTS', studentIds:['student01'], archived:false})
  assert.equal((await s.service('teacherOld').getPolicy(s.getReq)).enabled, true)
})

test('admin remains authorized for active institutional student even without teacher assignment', async () => {
  const s = policySetup({teacherId: '', teacherIds: [], createdBy: ''})
  assert.equal((await s.service('admin0001').getPolicy(s.getReq)).enabled, true)
  assert.equal((await s.service('admin0001').setPolicy(s.setReq)).ok, true)
})

test('prototype member names cannot masquerade as writing or mock type', async () => {
  const s = policySetup()
  for (const contentType of ['constructor','__proto__','toString']) {
    await assert.rejects(s.service('teacherNew').getPolicy({data: {contentType, contentId:'essay01'}}),
      e => e.code === 'invalid-argument')
    await assert.rejects(s.service('teacherNew').setPolicy({data: {contentType, contentId:'essay01', enabled: true, studentIds:['student01']}}),
      e => e.code === 'invalid-argument')
  }
  assert.equal(s.stat.writes, 0)
})

test('sponsored policy rejects archived/deleting student and denies B2C', async () => {
  for (const variant of [{archived: true}, {permanentDeleteInProgress: true}, {accountType: 'individual'}]) {
    const s = policySetup(variant)
    assert.equal((await s.service('teacherNew').getPolicy(s.getReq)).enabled, false)
    await assert.rejects(s.service('teacherNew').setPolicy(s.setReq),
      e => e.code === 'permission-denied')
    assert.equal(s.stat.writes, 0)
  }
})

function accessSetup(userOverrides={}) {
  const records = {
    'schools/maxima': {status:'active'}, 'users/student01': {...liveStudent, ...userOverrides},
    'users/admin0001': liveAdmin,
    'aiWritingSchoolSettings/maxima': {schoolId:'maxima', pilotEnabled:true},
    'aiWritingStudentAccess/student01': {uid:'student01',studentId:'student01',schoolId:'maxima',
      accountType:'institution',enabled:true,creditsRemaining:3}
  }
  const store = fakeDb(records)
  const service = createAiWritingAccessService({
    db: store.db, FieldValue:timeField, HttpsError:AuthError,
    requireAdmin: async () => ({uid:'admin0001',profile:store.records.get('users/admin0001')}),
    requireStudent: async () => ({uid:'student01',schoolId:'maxima',profile:store.records.get('users/student01')}),
    accountTypeOf, schoolIdOf,
    requireActiveSchoolForProfile: async p => ({schoolId:p.schoolId,school:store.records.get('schools/maxima')})
  })
  return {...store, service}
}
test('individual or archived student cannot get pilot permission or additional credits', async () => {
  for (const variation of [{archived:true},{permanentDeleteInProgress:true},{accountType:'individual'}]) {
    const s=accessSetup(variation)
    await assert.rejects(s.service.getMyAiWritingAccess({}), e => e.code === 'permission-denied')
    await assert.rejects(s.service.setAiWritingStudentAccess({data: {
      studentId:'student01', requestId:'request001', enabled:true, creditDelta:1
    }}), e => e.code === 'failed-precondition')
    assert.equal(s.stat.writes,0)
  }
})

test('institution student retains normal access and idempotent admin grant operation', async () => {
  const s=accessSetup()
  assert.equal((await s.service.getMyAiWritingAccess({})).canEvaluate, true)
  const req = {data: {studentId:'student01',requestId:'request001',creditDelta:1,enabled:true}}
  const state = await s.service.setAiWritingStudentAccess(req)
  assert.equal(state.creditsRemaining,4)
  assert.equal(s.records.get('aiWritingStudentAccess/student01').creditsRemaining,4)
  const second = await s.service.setAiWritingStudentAccess(req)
  assert.equal(second.alreadyApplied,true)
  assert.equal(s.records.get('aiWritingStudentAccess/student01').creditsRemaining,4)
})

function evaluationSetup(profile) {
  let sourceWasRead = false
  const store=fakeDb({})
  const service = createAiWritingEvaluationService({
    db:store.db, FieldValue:timeField, HttpsError:AuthError,
    requireStudent:async () => ({uid:'student01',schoolId:'maxima',profile}),
    requireStudentAttemptSource:async () => {sourceWasRead=true; throw new Error('source-should-not-be-read')},
    submissionContentConfigFor:()=>({contentType:'writing',sourceCollection:'writingHomeworks'}),
    findCurrentSubmissionRecord:async()=>null,
    getOpenSubmissionAttemptControl:async()=>false,
    schoolIdOf, getMockEnabledSections:()=>({writing:true}), getMockWritingMode:()=> 'task2_only',
    provider:async()=> { throw new Error('provider-should-not-be-called') },
    getApiKey:()=> 'sk-local-demo-test-not-secret', providerEnabled:()=>true
  })
  return {service, sourceWasRead:() => sourceWasRead}
}
test('archived and deleting user cannot start AI evaluation or read a report', async () => {
  for (const variation of [{archived:true},{permanentDeleteInProgress:true},{accountType:'individual'}]) {
    const s=evaluationSetup({...liveStudent,...variation})
    const request={data:{context:'homework',contentId:'essay01'}}
    await assert.rejects(s.service.evaluate(request),e=>e.code==='permission-denied')
    await assert.rejects(s.service.getReport(request),e=>e.code==='permission-denied')
    assert.equal(s.sourceWasRead(),false)
  }
})

test('managed report refuses archived/deleting student even with valid teacher and active assignment', async () => {
  for (const variation of [{archived:true},{permanentDeleteInProgress:true}]) {
    let submissionRead=false
    const records={'writingHomeworks/essay01':{schoolId:'maxima',teacherIds:['teacherNew']}}
    const store=fakeDb(records)
    const service=createAiWritingManagedReportService({
      db:store.db,HttpsError:AuthError,
      requireAssignmentManager:async()=>({uid:'teacherNew',profile:liveTeacher}),
      managerCanManageSource:()=>true,
      requireManagedStudentAssignment:async()=>({profile:{...liveStudent,...variation}}),
      submissionContentConfigFor:()=>({sourceCollection:'writingHomeworks',contentType:'writing'}),
      findCurrentSubmissionRecord:async()=>{submissionRead=true; return null},
      getOpenSubmissionAttemptControl:async()=>false,
      schoolIdOf, getMockEnabledSections:()=>({writing:true}), getMockWritingMode:()=> 'task2_only'
    })
    await assert.rejects(service.getReport({data:{context:'homework',contentId:'essay01',studentId:'student01',attemptNumber:1}}),
      e=>e.code==='permission-denied')
    assert.equal(submissionRead,false)
  }
})

test('Firestore direct writes to AI credits and reports remain denied by unchanged rules', () => {
  const rules = fs.readFileSync('firestore.rules','utf8')
  for (const collection of ['aiWritingStudentAccess','aiWritingCreditOperations','aiWritingEvaluations','aiWritingSponsoredPolicies']) {
    const body=rules.split(`match /${collection}/{`)[1]
    assert.ok(body,`missing ${collection} rule`)
    assert.match(body.split('}')[1]||'',/allow read, write: if false;/)
  }
})
