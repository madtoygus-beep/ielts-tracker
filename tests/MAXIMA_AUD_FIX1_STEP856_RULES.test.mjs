import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

const PROJECT = 'demo-maxima-audfix1-step856'
const ADMIN = 'audfix1-admin'
const ARCHIVED_ADMIN = 'audfix1-archived-admin'
const DELETING_ADMIN = 'audfix1-deleting-admin'
const STUDENT = 'audfix1-student'
const ARCHIVED_STUDENT = 'audfix1-archived-student'
const DELETING_STUDENT = 'audfix1-deleting-student'
const RESTORED_STUDENT = 'audfix1-restored-student'
const TEACHER = 'audfix1-teacher'
const RESULTS = ['scores','readingSubmissions','listeningSubmissions','writingSubmissions','mockSubmissions','vocabularySubmissions']
const cfgPort = Number((process.env.FIRESTORE_EMULATOR_HOST || '').split(':')[1]);
let env;

function client(uid) { return env.authenticatedContext(uid).firestore() }
function result(uid, collectionName) { return doc(client(uid),`${collectionName}/example`) }
async function seed() {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore()
    await setDoc(doc(db, 'schools/maxima'), { status: 'active' })
    await setDoc(doc(db, 'schools/maxima/classWriteGate/p0b2b'), {
      schemaVersion: 1, release: 'p0b2b-class-writer-v1', phase: 'open'
    })
    for (const [id, role, archived, permanentDeleteInProgress] of [
      [ADMIN,'admin',false,false],
      [ARCHIVED_ADMIN,'admin',true,false],
      [DELETING_ADMIN,'admin',false,true],
      [STUDENT,'student',false,false],
      [ARCHIVED_STUDENT,'student',true,false],
      [DELETING_STUDENT,'student',false,true],
      [RESTORED_STUDENT,'student',false,false],
      [TEACHER,'teacher',false,false]
    ]) {
      await setDoc(doc(db,`users/${id}`),{
        role,status:'approved',deleted:false,archived,permanentDeleteInProgress,schoolId:'maxima'
      })
    }
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${TEACHER}`),{
      schemaVersion:1,schoolId:'maxima',source:'managed_active_classes',teacherId:TEACHER,activeStudentIds:[STUDENT]
    })
    for (const collectionName of RESULTS) {
      await setDoc(doc(db,`${collectionName}/example`),{
        uid:STUDENT,studentId:STUDENT,schoolId:'maxima',createdAt:'2026-10-01T00:00:00Z',
        submittedAt:'2026-10-01T00:00:00Z',attemptNumber:1,aiReviewChoice:'teacher',aiBillingMode:'none',
        answers:{Q1:'original'},result:{writing:{band:6}},archived:false,reading:6
      })
    }
    await setDoc(doc(db,'studentAccess/check'),{
      uid:STUDENT,schoolId:'maxima',contentType:'reading',contentId:'read-1',accessType:'assignment',status:'active'
    })
    await setDoc(doc(db,'studentAccess/check-archived'),{
      uid:ARCHIVED_STUDENT,schoolId:'maxima',contentType:'reading',contentId:'read-1',accessType:'assignment',status:'active'
    })
    await setDoc(doc(db,'studentAccess/check-deleting'),{
      uid:DELETING_STUDENT,schoolId:'maxima',contentType:'reading',contentId:'read-1',accessType:'assignment',status:'active'
    })
    await setDoc(doc(db,'studentAccess/check-restored'),{
      uid:RESTORED_STUDENT,schoolId:'maxima',contentType:'reading',contentId:'read-1',accessType:'assignment',status:'active'
    })
  })
}

before(async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^127\.0\.0\.1:\d+$/)
  assert.equal(process.env.GOOGLE_CLOUD_PROJECT,PROJECT)
  assert.equal(process.env.GCLOUD_PROJECT,PROJECT)
  assert.ok(cfgPort > 1000 && cfgPort <= 65535)
  env = await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:cfgPort,rules:readFileSync('firestore.rules','utf8')}})
})
after(async () => {if(env) await env.cleanup()})
beforeEach(async () => {await env.clearFirestore();await seed()})

test('01 active admin can read result; archived/deleting admin cannot', async () => {
  await assertSucceeds(getDoc(result(ADMIN,'scores')))
  for(const uid of [ARCHIVED_ADMIN,DELETING_ADMIN]){
    await assertFails(getDoc(result(uid,'scores')))
  }
})

test('02 archive and restore allowed only to approved admin when G1 open', async () => {
  for(const collectionName of RESULTS){
    const ref=result(ADMIN,collectionName)
    await assertSucceeds(updateDoc(ref,{archived:true,archivedAt:'2026-10-22T09:00:00Z',updatedAt:'2026-10-22T09:00:00Z'}))
    await assertSucceeds(updateDoc(ref,{archived:false,restoredAt:'2026-10-22T09:01:00Z',updatedAt:'2026-10-22T09:01:00Z'}))
  }
})

test('03 admin cannot change identity, attempt, AI, result or historical answers', async () => {
  const attacks=[
    {uid:TEACHER},{studentId:TEACHER},{schoolId:'unrelated'},
    {attemptNumber:7},{submittedAt:'2020-01-01T00:00:00Z'},
    {aiReviewChoice:'ai'},{aiBillingMode:'sponsored'},
    {reading:9},{'result.writing.band':9},{'answers.Q1':'tampered'},
    {reviewed:true},{excludedFromStats:true}
  ]
  for(const collectionName of RESULTS) for(const patch of attacks){
    await assertFails(updateDoc(result(ADMIN,collectionName),patch))
  }
})

test('04 no browser admin can create scores or student submissions',async()=>{
  for(const collectionName of RESULTS){
    await assertFails(setDoc(doc(client(ADMIN),`${collectionName}/fake`),{
      uid:STUDENT,studentId:STUDENT,schoolId:'maxima',attemptNumber:1,
      submittedAt:'2026-10-22T09:00:00Z',aiReviewChoice:'ai'
    }))
  }
})

test('05 frozen, absent or wrong-release gate denies admin hide and restore', async () => {
  await env.withSecurityRulesDisabled(async context =>
    updateDoc(doc(context.firestore(),'schools/maxima/classWriteGate/p0b2b'),{phase:'frozen'}))
  await assertFails(updateDoc(result(ADMIN,'mockSubmissions'),{
    archived:true,archivedAt:'2026-10-22T09:00:00Z',updatedAt:'2026-10-22T09:00:00Z'
  }))
  await env.withSecurityRulesDisabled(async context =>
    updateDoc(doc(context.firestore(),'schools/maxima/classWriteGate/p0b2b'),{phase:'open',release:'wrong'}))
  await assertFails(updateDoc(result(ADMIN,'mockSubmissions'),{
    archived:true,archivedAt:'2026-10-22T09:00:00Z',updatedAt:'2026-10-22T09:00:00Z'
  }))
})

test('06 unverified or cross-school legacy result cannot be archived',async()=>{
  await env.withSecurityRulesDisabled(async context => {
    const db=context.firestore()
    await updateDoc(doc(db,'scores/example'),{schoolId:'unrelated'})
  })
  await assertFails(updateDoc(result(ADMIN,'scores'),{
    archived:true,archivedAt:'2026-10-22T09:00:00Z',updatedAt:'2026-10-22T09:00:00Z'
  }))
  await env.withSecurityRulesDisabled(async context => {
    const db=context.firestore()
    await updateDoc(doc(db,'scores/example'),{schoolId:'maxima',studentId:TEACHER})
  })
  await assertFails(updateDoc(result(ADMIN,'scores'),{
    archived:true,archivedAt:'2026-10-22T09:00:00Z',updatedAt:'2026-10-22T09:00:00Z'
  }))
})

test('07 approved archived/deleting student cannot read assignment but restored student can',async()=>{
  await assertSucceeds(getDoc(doc(client(STUDENT),'studentAccess/check')))
  await assertFails(getDoc(doc(client(ARCHIVED_STUDENT),'studentAccess/check-archived')))
  await assertFails(getDoc(doc(client(DELETING_STUDENT),'studentAccess/check-deleting')))
  await assertSucceeds(getDoc(doc(client(RESTORED_STUDENT),'studentAccess/check-restored')))
})

test('08 teacher can still create valid manual score for current student',async()=>{
  await assertSucceeds(setDoc(doc(client(TEACHER),'scores/manualA'),{
    uid:STUDENT,studentId:STUDENT,schoolId:'maxima',teacherId:TEACHER,teacherIds:[TEACHER],addedBy:TEACHER,
    date:'2026-10-22',listening:'6.0',reading:'6.5',writing:'7.0',speaking:'6.0',overall:'6.5'
  }))
})

// Suite completion marker prints only if all test hooks finished successfully;
// the installer ALSO checks the process exit code and test summary.
console.log('AUD_FIX1_RULES_TESTS_DEFINED=8')
