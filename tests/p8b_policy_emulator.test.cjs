'use strict'
// P8-B1 Firestore transaction verification. Runs ONLY against a LOCAL demo
// emulator. With no FIRESTORE_EMULATOR_HOST the test is intentionally skipped.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { createAiWritingSponsoredPolicyService } = require('../functions/lib/aiWritingSponsoredPolicy')
const demo = 'demo-maxima-p8b'
const host = process.env.FIRESTORE_EMULATOR_HOST || ''
const safe = /^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{2,5}$/.test(host) &&
  process.env.GCLOUD_PROJECT !== 'maxima-tracker' && process.env.GOOGLE_CLOUD_PROJECT !== 'maxima-tracker'

test('B1 emulator: update() replaces grants map atomically and no-op preserves updateTime',
  {skip: !safe && 'Requires a loopback Firestore emulator (never production)'}, async () => {
    const mod = createRequire(resolve(__dirname, '../functions/package.json'))
    const { initializeApp, deleteApp } = mod('firebase-admin/app')
    const { getFirestore, FieldValue } = mod('firebase-admin/firestore')
    const app = initializeApp({projectId:demo},'p8b-emulator-test')
    const db = getFirestore(app)
    const A = 'p8bStudentA', B = 'p8bStudentB', C = 'p8bStudentC'
    const T = 'p8bTeacherA', ADMIN = 'p8bAdminAA', W = 'p8bWritingA'
    const initialMs = Date.parse('2026-10-17T09:00:00Z')
    const path=`aiWritingSponsoredPolicies/writing_${W}`
    const rights={
      [A]:{grantedBy:ADMIN,grantedAtMs:initialMs},
      [B]:{grantedBy:ADMIN,grantedAtMs:initialMs}
    }
    const staff = role => ({role, schoolId:'maxima',accountType:'institution',status:'approved'})
    const schoolIdOf = d=>d?.schoolId || 'maxima'
    const batch=db.batch()
    batch.set(db.doc('schools/maxima'),{status:'active'})
    batch.set(db.doc(`writingHomeworks/${W}`),{schoolId:'maxima',teacherId:T,
      teacherIds:[T],contentType:'task2_only'})
    batch.set(db.doc(`users/${T}`),staff('teacher'))
    batch.set(db.doc(`users/${ADMIN}`),staff('admin'))
    batch.set(db.doc('classes/p8bActiveClass'),{teacherId:T,schoolId:'maxima',name:'P8-B',
      status:'active',studentIds:[A,C]})
    for(const id of [A,B,C]) {
      batch.set(db.doc(`users/${id}`),staff('student'))
      batch.set(db.doc(`studentAccess/${id}_writing_${W}`),{uid:id,schoolId:'maxima',
        contentType:'writing',contentId:W,sourceCollection:'writingHomeworks',
        accessType:'assignment',status:'active'})
    }
    batch.set(db.doc(path),{
      schemaVersion:2,schoolId:'maxima',enabled:true,billing:'institution',
      contentType:'writing',contentId:W,sourceCollection:'writingHomeworks',context:'homework',
      studentIds:[A,B],grants:rights,updatedBy:ADMIN,updatedAt:FieldValue.serverTimestamp()
    })
    await batch.commit()
    class HttpsError extends Error {constructor(code,message){super(message);this.code=code}}
    const create=uid=>createAiWritingSponsoredPolicyService({
      db,FieldValue,HttpsError,
      requireAssignmentManager:async()=>({uid,profile:staff(uid===T?'teacher':'admin')}),
      managerCanManageSource:(manager,source)=>manager.profile.role==='admin' || source.teacherId===uid,
      schoolIdOf,accountTypeOf:d=>d?.accountType || 'institution',
      teacherIdsOf:d=>d?.teacherIds||[],getMockEnabledSections:()=>({})
    })
    const request=ids=>({data:{contentType:'writing',contentId:W,enabled:ids.length>0,studentIds:ids}})
    try {
      assert.deepEqual((await create(T).getPolicy({data:{contentType:'writing',contentId:W}})).studentIds,[A])
      await create(T).setPolicy(request([A,C]))
      const firstSnap=await db.doc(path).get(), doc=firstSnap.data()
      assert.deepEqual(doc.studentIds,[A,B,C])
      assert.equal(doc.grants[B].grantedBy,ADMIN)
      assert.equal(doc.grants[C].grantedBy,T)
      assert.equal(Object.keys(doc.grants).length,3)
      await create(T).setPolicy(request([C]))
      const secondSnap=await db.doc(path).get()
      assert.deepEqual(secondSnap.data().studentIds,[B,C])
      assert.deepEqual(Object.keys(secondSnap.data().grants).sort(),[B,C].sort())
      const version=secondSnap.updateTime.toMillis()
      const out=await create(T).setPolicy(request([C]))
      assert.equal(out.unchanged,true)
      const thirdSnap=await db.doc(path).get()
      assert.equal(thirdSnap.updateTime.toMillis(),version)
    } finally {
      await db.terminate()
      await deleteApp(app)
    }
  })
