'use strict'
// Firestore Emulator ONLY, never real Firestore or Cloud Functions. Checks
// canonical server helper with Admin SDK and real transaction read semantics.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const requireFunctions = createRequire(join(__dirname,'../functions/package.json'))
const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore } = requireFunctions('firebase-admin/firestore')
const { requireCurrentTeacherAcademicStudent } = require('../functions/lib/p0bCurrentAcademicAccess')

const HOST = process.env.FIRESTORE_EMULATOR_HOST || ''
const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
assert.match(HOST, /^(127\.0\.0\.1|localhost):8081$/, 'STOP: emulator must run locally on port 8081')
assert.equal(PROJECT, 'demo-maxima-p0b', 'STOP: forbidden real Firebase project')
const app = initializeApp({projectId:PROJECT},`p0b747-${process.pid}`)
const db = getFirestore(app)
class HttpsError extends Error { constructor(code,msg){super(msg);this.code=code} }
let counter=0
const denied = p => assert.rejects(p,e=>e?.code==='permission-denied')

async function fixture() {
  const suffix = `${process.pid}_${++counter}`
  const schoolId = `step747school${suffix}`
  const oldId = `step747old${suffix}`, currentId = `step747current${suffix}`
  const studentId = `step747student${suffix}`, adminId = `step747admin${suffix}`
  const ref = p => db.doc(p)
  const idx = t => `schools/${schoolId}/teacherAcademicIndex/${t}`
  const docs = [
    [`schools/${schoolId}`,{status:'active'}],
    [`users/${oldId}`,{role:'teacher',schoolId,status:'approved'}],
    [`users/${currentId}`,{role:'teacher',schoolId,status:'approved'}],
    [`users/${studentId}`,{role:'student',schoolId,status:'approved',
      accountType:'institution',teacherIds:[oldId,currentId]}],
    [`users/${adminId}`,{role:'admin',schoolId,status:'approved'}],
    [idx(oldId),{schemaVersion:1,source:'managed_active_classes',
      teacherId:oldId,schoolId,activeStudentIds:[]}],
    [idx(currentId),{schemaVersion:1,source:'managed_active_classes',
      teacherId:currentId,schoolId,activeStudentIds:[studentId]}],
    [`writingHomeworks/step747source${suffix}`,{schoolId,
      teacherId:oldId,teacherIds:[oldId],createdBy:oldId}]
  ]
  const batch=db.batch()
  for(const [p,v] of docs)batch.set(ref(p),v)
  await batch.commit()
  const manager = id=>({uid:id,profile:{role:id===adminId?'admin':'teacher',
    schoolId,status:'approved'}})
  const check=(id,tx)=>requireCurrentTeacherAcademicStudent({
    db,HttpsError,manager:manager(id),studentId,schoolId,tx
  })
  return {suffix,schoolId,oldId,currentId,adminId,studentId,ref,idx,check}
}

test('source-owner ex-teacher denied while newly assigned teacher can read transferred learner',async()=>{
  const f=await fixture()
  await denied(f.check(f.oldId))
  await assert.doesNotReject(f.check(f.currentId))
  await assert.doesNotReject(f.check(f.adminId))
})

test('a transaction checks current canonical membership before committing any moderation write',async()=>{
  const f=await fixture()
  const writeRef=f.ref(`step747markers/positive${f.suffix}`)
  await db.runTransaction(async tx=>{
    await f.check(f.currentId,tx)
    tx.set(writeRef,{allowed:true})
  })
  assert.equal((await writeRef.get()).data()?.allowed,true)
  await f.ref(f.idx(f.currentId)).update({activeStudentIds:[]})
  const deniedRef=f.ref(`step747markers/denied${f.suffix}`)
  await denied(db.runTransaction(async tx=>{
    await f.check(f.currentId,tx)
    tx.set(deniedRef,{shouldNeverCommit:true})
  }))
  assert.equal((await deniedRef.get()).exists,false)
})

test('teacher profile, school and student state revocation all fail closed',async()=>{
  const f=await fixture()
  await f.ref(`users/${f.studentId}`).update({archived:true})
  await denied(f.check(f.currentId))
  await f.ref(`users/${f.studentId}`).update({archived:false})
  await f.ref(`schools/${f.schoolId}`).update({status:'inactive'})
  await denied(f.check(f.currentId))
  await f.ref(`schools/${f.schoolId}`).update({status:'active'})
  await f.ref(`users/${f.currentId}`).update({deleted:true})
  await denied(f.check(f.currentId))
})

test('administrator transaction requires active admin identity; false admin role denied',async()=>{
  const f=await fixture()
  await assert.doesNotReject(db.runTransaction(async tx=>f.check(f.adminId,tx)))
  await f.ref(`users/${f.adminId}`).update({role:'teacher'})
  await denied(db.runTransaction(async tx=>f.check(f.adminId,tx)))
})

test.after(async()=>{ await deleteApp(app) })
