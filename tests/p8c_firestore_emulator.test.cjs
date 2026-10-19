'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { createP8CAssignmentService } = require('../functions/lib/p8cAssignmentService')
const { createP8CArchiveService } = require('../functions/lib/p8cArchiveService')
const host = process.env.FIRESTORE_EMULATOR_HOST || ''
const projectId = process.env.GCLOUD_PROJECT || ''
const emulatorOnly = /^(127\.0\.0\.1|localhost):\d{2,5}$/.test(host) && /^demo-[a-z0-9-]+$/.test(projectId)
class TestError extends Error { constructor(code,message){super(message);this.code=code} }

// No firebase-admin is imported until the host and project ID are BOTH
// proven to be local/demo. Running without a loopback emulator just skips.
test('P8C-E1 real Firestore transactions: concurrent assignments, sponsor prune, archive, cross-school guard',
  {skip: !emulatorOnly && 'Requires loopback Firestore emulator and demo project'}, async () => {
    const requireFunctions=createRequire(join(__dirname,'..','functions','package.json'))
    const {initializeApp,deleteApp}=requireFunctions('firebase-admin/app')
    const {getFirestore,FieldValue}=requireFunctions('firebase-admin/firestore')
    const name=`p8c_${randomUUID()}`
    const app=initializeApp({projectId},name)
    try {
      const db=getFirestore(app)
      const suffix=randomUUID().replaceAll('-','').slice(0,12)
      const school=`p8c-${suffix}`
      const teacher=`Teacher${suffix}`
      const student1=`StudentA${suffix}`
      const student2=`StudentB${suffix}`
      const contentId=`Writing${suffix}`
      const contentType='writing',sourceCollection='writingHomeworks'
      const source={schoolId:school,teacherId:teacher,createdBy:teacher,teacherIds:[teacher],archived:false}
      const uidAccess=uid=>`studentAccess/${uid}_${contentType}_${contentId}`
      await db.doc(`schools/${school}`).set({status:'active'})
      await db.doc(`users/${teacher}`).set({role:'teacher',status:'approved',schoolId:school,accountType:'institution'})
      for (const uid of [student1,student2]) await db.doc(`users/${uid}`).set({role:'student',status:'approved',schoolId:school,accountType:'institution'})
      await db.doc(`${sourceCollection}/${contentId}`).set({...source,title:'P8C test writing'})
      const service=createP8CAssignmentService({db,FieldValue,HttpsError:TestError,
        requireAssignmentManager:async req=>({uid:req.auth.uid,profile:{role:'teacher',status:'approved',schoolId:school}}),
        managerCanManageSource:(manager,s)=>s.teacherId===manager.uid,
        schoolIdOf:doc=>doc?.schoolId||'maxima',
        accountTypeOf:doc=>doc?.accountType||'institution',
        studentAccessPayload:(type,collection,id,s,uid)=>({uid,schoolId:s.schoolId,contentType:type,contentId:id,sourceCollection:collection,accessType:'assignment',status:'active',updatedAt:FieldValue.serverTimestamp()}),
        studentAccessId:(uid,type,id)=>`${uid}_${type}_${id}`
      })
      const request=changes=>({auth:{uid:teacher},data:{contentType,contentId,changes}})
      const add=uid=>({studentId:uid,assigned:true,expectedAssigned:false})
      const rem=uid=>({studentId:uid,assigned:false,expectedAssigned:true})
      await Promise.all([service.write(request([add(student1)])),service.write(request([add(student2)]))])
      for(const uid of [student1,student2]) assert.equal((await db.doc(uidAccess(uid)).get()).data().accessType,'assignment')
      const policyId=`aiWritingSponsoredPolicies/writing_${contentId}`
      await db.doc(policyId).set({schemaVersion:2,schoolId:school,contentType,contentId,sourceCollection,
        studentIds:[student1,student2].sort(),enabled:true,
        grants:{[student1]:{grantedBy:teacher,grantedAtMs:10000},[student2]:{grantedBy:teacher,grantedAtMs:10000}}})
      const result=await service.write(request([rem(student1)]))
      assert.equal(result.sponsoredGrantsPruned,true)
      assert.equal((await db.doc(uidAccess(student1)).get()).data().accessType,'unassigned_archive')
      assert.equal((await db.doc(uidAccess(student1)).get()).data().status,'inactive')
      assert.deepEqual((await db.doc(policyId).get()).data().studentIds,[student2])
      await assert.rejects(service.write(request([rem(student1)])),{code:'failed-precondition'})
      assert.equal((await db.doc(uidAccess(student2)).get()).data().status,'active')
      const submission={uid:student1,studentId:student1,schoolId:school,writingId:contentId,
        submittedAt:'2026-10-20T01:00:00Z',task2Answer:'PRIVATE STUDENT TEXT',result:{band:7}}
      await db.doc(`writingSubmissions/${student1}_${contentId}`).set(submission)
      const archive=createP8CArchiveService({db,HttpsError:TestError,
        requireStudent:async req=>({uid:req.auth.uid,schoolId:school,profile:(await db.doc('users/'+req.auth.uid).get()).data()}),
        schoolIdOf:doc=>doc?.schoolId||'maxima',
        getStudentOwnedResultSnapshots:async (collection,who)=>{
          const snap=await db.collection(collection).where('uid','==',who.uid).get()
          return snap.docs.map(d=>({id:d.id,data:d.data()}))
        },
        studentResultSafeBase:(id,data)=>({submittedAt:data.submittedAt,reviewed:data.reviewed,
          review:null,result:data.result||null,status:data.status}),
        studentResultMatchesOwner:(data,uid,s)=>(data.uid===uid||data.studentId===uid)&&
          (!data.uid||data.uid===uid)&&(!data.studentId||data.studentId===uid)&&data.schoolId===s,
        studentAttemptHistoryMatches:()=>false,
        studentScoreContentId:()=>''
      })
      const archiveResult=await archive.list({auth:{uid:student1},data:{contentType:'writing'}})
      assert.equal(archiveResult.items.length,1)
      assert.equal(JSON.stringify(archiveResult).includes('PRIVATE STUDENT TEXT'),false)
      await db.doc(uidAccess(student1)).update({adminHidden:true})
      const hidden=await archive.list({auth:{uid:student1},data:{contentType:'writing'}})
      assert.equal(hidden.items.length,0)
    } finally { await deleteApp(app) }
  })
