'use strict'
// P8-B3: Real Firestore credit transaction E2E with synthetic records and a
// local, stubbed provider. NEVER connect to production or make paid AI calls.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { createAiWritingEvaluationService } = require('../functions/lib/aiWritingEvaluation')
const safeHost = /^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{2,5}$/.test(process.env.FIRESTORE_EMULATOR_HOST || '') &&
  process.env.GCLOUD_PROJECT !== 'maxima-tracker' &&
  process.env.GOOGLE_CLOUD_PROJECT !== 'maxima-tracker'
// Each emulator run gets a fresh synthetic namespace: never reuse a completed AI job.
const PROJECT = 'demo-maxima-p8b3-' + require('node:crypto').randomBytes(6).toString('hex')
const NOW = Date.parse('2026-10-18T21:00:00Z')
const USER = 'p8b3EmulatorStudent', WRITING = 'p8b3EmulatorWriting'
const essay = Array.from({length:300},(_,i)=>`word${i}`).join(' ')
const criterion = {band:6,explanation:'Local test.',evidence:''}
const report = {
  isAiEstimate:true,teacherFinalScore:null,context:'homework',writingMode:'task2_only',
  isProvisionalMockEstimate:false,task1:null,
  task2:{wordCount:300,feedbackOnly:false,estimatedBand:6,
    criteria:{taskAchievementOrResponse:criterion,coherenceAndCohesion:criterion,
      lexicalResource:criterion,grammaticalRangeAndAccuracy:criterion}},
  estimatedBand:6,feedbackOnly:false
}
class HttpsError extends Error {constructor(code,message){super(message);this.code=code}}

function createService(db, FieldValue, provider) {
  return createAiWritingEvaluationService({
    db, FieldValue, HttpsError,
    requireStudent: async()=>({uid:USER,schoolId:'maxima'}),
    requireStudentAttemptSource:async()=>true,
    submissionContentConfigFor:()=>({sourceCollection:'writingHomeworks'}),
    findCurrentSubmissionRecord:async()=>({ref:db.doc(`writingSubmissions/${USER}_${WRITING}`)}),
    getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf:d=>d?.schoolId,
    getMockEnabledSections:()=>({}),getMockWritingMode:()=> 'task2_only',
    provider,getApiKey:()=> 'sk-local-stub-not-real',providerEnabled:()=>true,now:()=>NOW
  })
}

test('B3 emulator: one held credit during concurrent request; exactly one settle and free reuse',
  {skip:!safeHost && 'Requires a LOCAL loopback Firestore emulator (production forbidden)'},
  async()=>{
    const mod=createRequire(resolve(__dirname,'../functions/package.json'))
    const {initializeApp,deleteApp}=mod('firebase-admin/app')
    const {getFirestore,FieldValue}=mod('firebase-admin/firestore')
    const app=initializeApp({projectId:PROJECT},'p8b3-credit-emulator')
    const db=getFirestore(app)
    try{
      const batch=db.batch()
      batch.set(db.doc('schools/maxima'),{status:'active'})
      batch.set(db.doc(`users/${USER}`),{uid:USER,role:'student',status:'approved',
        schoolId:'maxima',accountType:'institution'})
      batch.set(db.doc('aiWritingSchoolSettings/maxima'),{schoolId:'maxima',pilotEnabled:true})
      batch.set(db.doc(`aiWritingStudentAccess/${USER}`),{uid:USER,studentId:USER,
        schoolId:'maxima',accountType:'institution',enabled:true,creditsRemaining:1,
        creditsUsedTotal:0})
      batch.set(db.doc(`studentAccess/${USER}_writing_${WRITING}`),{
        uid:USER,schoolId:'maxima',contentType:'writing',contentId:WRITING,
        sourceCollection:'writingHomeworks',accessType:'assignment',status:'active'})
      batch.set(db.doc(`writingHomeworks/${WRITING}`),{schoolId:'maxima',
        contentType:'task2_only',task2:{prompt:'Discuss a current issue.'}})
      batch.set(db.doc(`writingSubmissions/${USER}_${WRITING}`),{
        uid:USER,studentId:USER,schoolId:'maxima',writingId:WRITING,attemptNumber:1,
        submittedAt:'2026-10-18T17:00:00Z',aiReviewChoice:'ai',aiBillingMode:'student_credit',
        writingMode:'task2_only',task1Answer:'',task2Answer:essay})
      await batch.commit()
      let entered,release,count=0
      const providerEntered=new Promise(resolve=>{entered=resolve})
      const service=createService(db,FieldValue,async()=>{
        count++;entered()
        return await new Promise(resolve=>{release=resolve})
      })
      const request={data:{context:'homework',contentId:WRITING}}
      assert.equal((await service.getReport(request)).canRetry,true)
      const firstPending=service.evaluate(request)
      await providerEntered
      const second=await service.evaluate(request)
      assert.equal(second.status,'processing')
      assert.equal(count,1)
      assert.equal((await db.doc(`aiWritingStudentAccess/${USER}`).get()).data().creditsRemaining,0)
      release({report,model:'local-synthetic-model'})
      assert.equal((await firstPending).status,'completed')
      assert.equal((await service.evaluate(request)).reused,true)
      assert.equal(count,1)
      const access=(await db.doc(`aiWritingStudentAccess/${USER}`).get()).data()
      const month=(await db.doc('aiWritingMonthlyUsage/maxima_202610').get()).data()
      assert.equal(access.creditsRemaining,0)
      assert.equal(access.creditsUsedTotal,1)
      assert.equal(month.requestCount,1)
      assert.equal(month.pendingCount,0)
      assert.equal(month.completedCount,1)
      assert.equal((await service.getReport(request)).status,'completed')
    }finally{
      await db.terminate()
      await deleteApp(app)
    }
  })
