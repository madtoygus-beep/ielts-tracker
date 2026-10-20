'use strict'
// P0-B2B Step 701: real Firestore Emulator transaction checks.
// This test DOES NOT call Cloud Functions; runtime identity forwarding is checked offline.
const test = require('node:test')
const assert = require('node:assert/strict')
const {createRequire} = require('node:module')
const {join} = require('node:path')
const functionsRequire = createRequire(join(__dirname,'../functions/package.json'))
const {initializeApp,deleteApp} = functionsRequire('firebase-admin/app')
const {getFirestore,FieldValue} = functionsRequire('firebase-admin/firestore')
const {mutateManagedClassWithIndex} = require('../functions/lib/p0bAcademicMembershipIndex')

const host=process.env.FIRESTORE_EMULATOR_HOST || ''
const project=process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
assert.match(host,/^(127\.0\.0\.1|localhost):8081$/,'STOP: use local Emulator port 8081')
assert.equal(project,'demo-maxima-p0b','STOP: production project forbidden')
const app=initializeApp({projectId:project},'p0b2b-step701-admission-'+process.pid)
const db=getFirestore(app)
const teacherId=`step701_teacher_${process.pid}`
const schoolId='maxima'
const a=db.doc(`classes/step701_A_${process.pid}`)
const b=db.doc(`classes/step701_B_${process.pid}`)
const index=db.doc(`schools/${schoolId}/teacherAcademicIndex/${teacherId}`)
const u1=`step701_authorized_${process.pid}`,u2=`step701_unapproved_${process.pid}`
const us=[db.doc(`users/${u1}`),db.doc(`users/${u2}`)]
const roster=(ids,name='Class A')=>({teacherId,schoolId,studentIds:ids,teacherIds:[teacherId],name,archived:false,status:'active',createdBy:teacherId})
const change=(ref,operation,payload,actorRole,updatedBy)=>mutateManagedClassWithIndex({
  db,FieldValue,classRef:ref,teacherId,schoolId,operation,payload,actorRole,updatedBy,
  studentRefs:operation==='save' ? (payload.studentIds||[]).map(uid=>db.doc(`users/${uid}`)) : [],
  now:'2026-10-21T00:00:00Z'
})
const ids=async()=>{const snap=await index.get();return snap.exists?snap.data().activeStudentIds:[]}
const exists=async r=>(await r.get()).exists

test('admin admission, teacher reorganization, fail-closed expansion, immediate revoke and no re-grant',async()=>{
  await change(a,'save',roster([u1]),'admin','school_admin')
  assert.deepEqual(await ids(),[u1])
  await change(b,'save',roster([u1],'Class B'),'teacher',teacherId)
  assert.deepEqual(await ids(),[u1])
  await assert.rejects(change(b,'save',roster([u1,u2],'Class B'),'teacher',teacherId),/admin authorization/)
  assert.equal((await b.get()).data().studentIds.includes(u2),false)
  assert.deepEqual(await ids(),[u1])
  assert.equal(await exists(us[1]),false)

  await change(a,'save',roster([]),'teacher',teacherId)
  await change(b,'save',roster([],'Class B'),'teacher',teacherId)
  assert.deepEqual(await ids(),[])
  await assert.rejects(change(a,'save',roster([u1]),'teacher',teacherId),/admin authorization/)
  assert.deepEqual(await ids(),[])
  await change(a,'save',roster([u1]),'admin','school_admin')
  assert.deepEqual(await ids(),[u1])
  // The teacher's next class archive cannot increase membership.
  await change(a,'archive',{archived:true},'teacher',teacherId)
  assert.deepEqual(await ids(),[])
  await assert.rejects(change(a,'archive',{archived:false},'teacher',teacherId),/admin authorization/)
  assert.deepEqual(await ids(),[])
  await change(a,'archive',{archived:false},'admin','school_admin')
  assert.deepEqual(await ids(),[u1])
})

test.after(async()=>{
  await Promise.all([a,b,index,...us].map(ref=>ref.delete().catch(()=>{})))
  await deleteApp(app)
})
