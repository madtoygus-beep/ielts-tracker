'use strict'
// P4-D: REAL Firestore transaction integration but ALWAYS local demo emulator.
// Zero production access and ZERO paid API calls (stub-only provider).
// Safe to run repeatedly: each test uses a unique synthetic document suffix.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { randomBytes, createHash } = require('node:crypto')
const { createAiWritingEvaluationService } = require('../functions/lib/aiWritingEvaluation')
const { createAiWritingSponsoredEvaluationService } = require('../functions/lib/aiWritingSponsoredEvaluation')
const { validReport, essay, NOW, SUBMITTED_AT, GRANTED_AT } = require('./helpers/p4d_fixture.cjs')

const host = process.env.FIRESTORE_EMULATOR_HOST || ''
const SAFE = /^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{2,5}$/.test(host) &&
  process.env.GCLOUD_PROJECT !== 'maxima-tracker' &&
  process.env.GOOGLE_CLOUD_PROJECT !== 'maxima-tracker' &&
  process.env.FIREBASE_CONFIG !== 'maxima-tracker'
const emulatorTest = (name, callback) => test(name,
  {skip:SAFE?false:'Requires loopback Firestore Emulator; production explicitly forbidden'}, callback)
const PROJECT = 'demo-maxima-p4d'
const sha = v => createHash('sha256').update(v).digest('hex')
class HttpsError extends Error { constructor(code, message) { super(message); this.code=code } }

async function setup({context='homework',credits=2,choice='ai',billing='student_credit',pilot=true,providerImpl=null}={}) {
  if (!SAFE) throw new Error('P4D emulator tests must never connect to production')
  // Load the Admin SDK only after the local loopback safety gate.
  const mod = createRequire(resolve(__dirname,'../functions/package.json'))
  const { initializeApp, deleteApp } = mod('firebase-admin/app')
  const { getFirestore, FieldValue } = mod('firebase-admin/firestore')
  const suffix = randomBytes(6).toString('hex')
  const uid = `p4dStudent${suffix}`
  const contentId = `p4d${context==='mock'?'Mock':'Writing'}${suffix}`
  const writingId = context==='mock' ? `p4dWriting${suffix}` : contentId
  const admin = `p4dAdmin${suffix}`
  const app = initializeApp({projectId:PROJECT}, `p4d-${suffix}`)
  const db = getFirestore(app)
  const mock = context === 'mock'
  const contentType = mock ? 'mock' : 'writing'
  const sourceCollection = mock ? 'mockTests' : 'writingHomeworks'
  const submissionCollection = mock ? 'mockSubmissions' : 'writingSubmissions'
  const submissionPath = `${submissionCollection}/${uid}_${contentId}`
  const jobId = sha(['ai-writing-v1',uid,context,contentId,1].join('\0'))
  const monthRef = db.doc('aiWritingMonthlyUsage/maxima_202610')
  const accessRef = db.doc(`aiWritingStudentAccess/${uid}`)
  const jobRef = db.doc(`aiWritingEvaluations/${jobId}`)
  const policyRef = db.doc(`aiWritingSponsoredPolicies/${contentType}_${contentId}`)
  const submitRef = db.doc(submissionPath)
  const source = mock
    ? {schoolId:'maxima',writingId,enabledSections:{writing:true}}
    : {schoolId:'maxima',contentType:'task2_only',task2:{prompt:'Discuss education policy.'}}
  const linked = {schoolId:'maxima',contentType:'task2_only',task2:{prompt:'Discuss education policy.'}}
  const submission = {uid,studentId:uid,schoolId:'maxima',attemptNumber:1,
    submittedAt:SUBMITTED_AT,
    ...(mock ? {mockTestId:contentId,writingId,writingMode:'task2_only',
      status:'submitted',enabledSections:{writing:true},writingAnswers:{task1:'',task2:essay(300)}}
    : {writingId,writingMode:'task2_only',task1Answer:'',task2Answer:essay(300),
      aiReviewChoice:choice,aiBillingMode:billing})}
  // Separate project; the only collections touched are synthetic test IDs
  // except schools/maxima and settings/maxima within this demo project.
  const batch=db.batch()
  batch.set(db.doc('schools/maxima'),{status:'active'})
  batch.set(db.doc('aiWritingSchoolSettings/maxima'),{schoolId:'maxima',pilotEnabled:pilot})
  // Reset monthly totals only in the dedicated demo project so repeated
  // test runs remain isolated (and assert counts from zero).
  batch.set(monthRef,{schemaVersion:1,schoolId:'maxima',month:'202610',
    requestCount:0,pendingCount:0,completedCount:0,sponsoredRequestCount:0})
  batch.set(db.doc(`users/${uid}`),{uid,role:'student',status:'approved',accountType:'institution',schoolId:'maxima'})
  batch.set(db.doc(`users/${admin}`),{role:'admin',status:'approved',accountType:'institution',schoolId:'maxima'})
  batch.set(db.doc(`${sourceCollection}/${contentId}`),source)
  if (mock) batch.set(db.doc(`writingHomeworks/${writingId}`),linked)
  batch.set(submitRef,submission)
  batch.set(db.doc(`studentAccess/${uid}_${contentType}_${contentId}`),{
    uid,schoolId:'maxima',contentType,contentId,sourceCollection,
    accessType:'assignment',status:'active'})
  batch.set(accessRef,{uid,studentId:uid,schoolId:'maxima',accountType:'institution',
    enabled:true,creditsRemaining:credits,creditsUsedTotal:0})
  batch.set(policyRef,{schemaVersion:2,schoolId:'maxima',context,contentType,
    contentId,sourceCollection,billing:'institution',enabled:true,studentIds:[uid],
    grants:{[uid]:{grantedBy:admin,grantedAtMs:GRANTED_AT}}})
  await batch.commit()
  let calls=0
  const provider=async()=>{
    calls++
    return providerImpl ? providerImpl() : {report:validReport(context),model:'local-synthetic-only'}
  }
  const personal=createAiWritingEvaluationService({
    db,FieldValue,HttpsError,
    requireStudent:async()=>({uid,schoolId:'maxima'}),
    requireStudentAttemptSource:async()=>true,
    submissionContentConfigFor:()=>({sourceCollection}),
    findCurrentSubmissionRecord:async()=>({ref:submitRef,data:(await submitRef.get()).data()}),
    getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf:d=>d?.schoolId,getMockEnabledSections:d=>d?.enabledSections||{},
    getMockWritingMode:()=> 'task2_only',provider,
    getApiKey:()=> 'sk-synthetic-and-never-sent',providerEnabled:()=>true,now:()=>NOW
  })
  const sponsored=createAiWritingSponsoredEvaluationService({
    db,FieldValue,schoolIdOf:d=>d?.schoolId,
    getMockEnabledSections:d=>d?.enabledSections||{},
    getMockWritingMode:()=> 'task2_only',provider,
    getApiKey:()=> 'sk-synthetic-and-never-sent',providerEnabled:()=>true,
    findCurrentSubmissionRecord:async()=>({ref:submitRef,data:(await submitRef.get()).data()}),
    submissionContentConfigFor:()=>({}),now:()=>NOW
  })
  const event=()=>({data:{before:{exists:false},after:{exists:true,ref:submitRef,data:()=>submission}}})
  const cleanup=async()=>{await db.terminate();await deleteApp(app)}
  return {db,uid,contentId,context,app,accessRef,jobRef,monthRef,policyRef,
    submissionRef:submitRef,personal,sponsored,event,
    request:{data:{context,contentId}},calls:()=>calls,cleanup}
}

emulatorTest('P4D-E1 emulator: two concurrent personal-credit callables use one credit and one monthly request',async()=>{
  let releaseProvider,enteredProvider
  const entered=new Promise(resolve=>{enteredProvider=resolve})
  const w=await setup({providerImpl:async()=>{enteredProvider();return new Promise(resolve=>{releaseProvider=resolve})}})
  try {
    const first=w.personal.evaluate(w.request)
    await entered
    assert.equal((await w.personal.evaluate(w.request)).status,'processing')
    assert.equal((await w.accessRef.get()).data().creditsRemaining,1)
    releaseProvider({report:validReport(),model:'local-synthetic-only'})
    assert.equal((await first).status,'completed')
    assert.equal((await w.personal.evaluate(w.request)).reused,true)
    const access=(await w.accessRef.get()).data()
    const month=(await w.monthRef.get()).data()
    assert.equal(w.calls(),1)
    assert.deepEqual([access.creditsRemaining,access.creditsUsedTotal],[1,1])
    assert.deepEqual([month.requestCount,month.pendingCount,month.completedCount],[1,0,1])
  } finally { await w.cleanup() }
})

emulatorTest('P4D-E2 emulator: provider error refunds credit; a later retry spends once',async()=>{
  let first=true
  const w=await setup({credits:1,providerImpl:async()=>{
    if (first) {first=false;throw new Error('local provider failure')}
    return {report:validReport(),model:'local-synthetic-only'}
  }})
  try {
    await assert.rejects(w.personal.evaluate(w.request),e=>e?.code==='unavailable')
    assert.equal((await w.accessRef.get()).data().creditsRemaining,1)
    assert.equal((await w.jobRef.get()).data().status,'failed')
    assert.equal((await w.personal.getReport(w.request)).canRetry,true)
    assert.equal((await w.personal.evaluate(w.request)).status,'completed')
    const access=(await w.accessRef.get()).data()
    const month=(await w.monthRef.get()).data()
    assert.equal(w.calls(),2)
    assert.deepEqual([access.creditsRemaining,access.creditsUsedTotal],[0,1])
    assert.deepEqual([month.requestCount,month.pendingCount,month.completedCount],[2,0,1])
  } finally { await w.cleanup() }
})

emulatorTest('P4D-E3 emulator: student cannot charge Mock credit but valid funded Mock completes free',async()=>{
  const w=await setup({context:'mock',credits:4})
  try {
    await assert.rejects(w.personal.evaluate(w.request),e=>e?.code==='permission-denied')
    assert.equal(w.calls(),0)
    assert.equal((await w.sponsored.submit('mock',w.event())).status,'completed')
    assert.equal((await w.sponsored.submit('mock',w.event())).status,'completed')
    const access=(await w.accessRef.get()).data()
    const month=(await w.monthRef.get()).data()
    assert.equal(w.calls(),1)
    assert.deepEqual([access.creditsRemaining,access.creditsUsedTotal],[4,0])
    assert.equal((await w.jobRef.get()).data().billingMode,'sponsored_auto')
    assert.deepEqual([month.requestCount,month.pendingCount,month.completedCount],[1,0,1])
  } finally { await w.cleanup() }
})

emulatorTest('P4D-E4 emulator: revoking a sponsored grant mid-flight cannot settle or touch credits',async()=>{
  let enteredProvider,releaseProvider
  const entered=new Promise(resolve=>{enteredProvider=resolve})
  const w=await setup({context:'mock',credits:5,providerImpl:async()=>{
    enteredProvider();return new Promise(resolve=>{releaseProvider=resolve})
  }})
  try {
    const first=w.sponsored.submit('mock',w.event())
    await entered
    await w.policyRef.update({enabled:false,studentIds:[],grants:{}})
    releaseProvider({report:validReport('mock'),model:'local-synthetic-only'})
    assert.equal((await first).status,'failed')
    assert.equal((await w.jobRef.get()).data().status,'failed')
    const access=(await w.accessRef.get()).data()
    const month=(await w.monthRef.get()).data()
    assert.equal(w.calls(),1)
    assert.deepEqual([access.creditsRemaining,access.creditsUsedTotal],[5,0])
    assert.deepEqual([month.requestCount,month.pendingCount,month.completedCount],[1,0,0])
  } finally { await w.cleanup() }
})
