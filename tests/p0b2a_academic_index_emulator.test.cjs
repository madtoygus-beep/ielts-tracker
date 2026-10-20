'use strict'
// P0-B2A: local Firestore Emulator test. No production Firebase, OpenAI or external SDK calls.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const requireFunctions = createRequire(join(__dirname, '../functions/package.json'))
const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore, FieldValue } = requireFunctions('firebase-admin/firestore')
const { mutateManagedClassWithIndex } = require('../functions/lib/p0bAcademicMembershipIndex')

const HOST=process.env.FIRESTORE_EMULATOR_HOST || ''
const PROJECT=process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
assert.match(HOST,/^(127\.0\.0\.1|localhost):8081$/,'STOP: local Firestore Emulator on port 8081 required')
assert.equal(PROJECT,'demo-maxima-p0b','STOP: demo-maxima-p0b only; production forbidden')

const app=initializeApp({projectId:PROJECT},'maxima-p0b2a-local-index')
const db=getFirestore(app)
const token=process.pid.toString(36)
const teacherId=`p0b2a_teacher_${token}`
const schoolId='maxima'
const c1=db.doc(`classes/p0b2a_A_${token}`)
const c2=db.doc(`classes/p0b2a_B_${token}`)
const index=db.doc(`schools/${schoolId}/teacherAcademicIndex/${teacherId}`)
const users=['u1','u2','u3'].map(x=>db.doc(`users/p0b2a_${x}_${token}`))
const ids=users.map(r=>r.id)
const payload = (selected,name) => ({
  schoolId,teacherId,name,studentIds:selected,teacherIds:[teacherId],
  archived:false,status:'active',createdBy:teacherId
})
async function change(ref,operation,details=null) {
 return mutateManagedClassWithIndex({
   db,FieldValue,classRef:ref,teacherId,schoolId,operation,payload:details,
   studentRefs:operation==='save'? (details.studentIds||[]).map(x=>db.doc(`users/${x}`)):[],
   updatedBy:'p0b2a_local_test',actorRole:'admin',now:'2026-10-20T00:00:00Z'
 })
}
async function indexStudents() {
 const snap=await index.get()
 assert.equal(snap.exists,true)
 return snap.data().activeStudentIds
}

test('concurrent class mutations build one complete and idempotent active membership index', async()=>{
 await Promise.all([
   change(c1,'save',payload([ids[0],ids[1]],'Class A')),
   change(c2,'save',payload([ids[1],ids[2]],'Class B'))
 ])
 assert.deepEqual(await indexStudents(),ids)
 await change(c1,'save',payload([ids[0]],'Class A'))
 assert.deepEqual(await indexStudents(),ids)
 await change(c2,'archive',{archived:true,updatedAt:'2026-10-20T01:00:00Z'})
 assert.deepEqual(await indexStudents(),[ids[0]])
 await change(c2,'archive',{archived:false,updatedAt:'2026-10-20T02:00:00Z'})
 assert.deepEqual(await indexStudents(),ids)
 await change(c2,'delete')
 assert.deepEqual(await indexStudents(),[ids[0]])
 assert.equal((await c2.get()).exists,false)
 // Historical profile teacherIds remain additive but never grant membership.
 assert.ok((await users[1].get()).data().teacherIds.includes(teacherId))
 assert.ok(!(await indexStudents()).includes(ids[1]))
})

test.after(async()=>{
 await Promise.all([c1,c2,index,...users].map(r=>r.delete().catch(()=>{})))
 await deleteApp(app)
})
