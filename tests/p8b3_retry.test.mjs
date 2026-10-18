// P8-B3: Only personal-credit originally chosen Writing may manually retry.
// Synthetic Firestore documents + dummy provider; no network, live data or paid calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  isPersonalCreditAiSelection, safeAiWritingAccess, safeAiWritingEnvelope,
  canRequestAiWriting
} from '../src/services/aiWritingStudentPolicy.js'
const require = createRequire(import.meta.url)
const { createAiWritingEvaluationService } = require('../functions/lib/aiWritingEvaluation.js')
const { prepareAiWritingEvaluation } = require('../functions/lib/aiWritingGrading.js')
const dir = path.dirname(fileURLToPath(import.meta.url))
const UID = 'studentAAA', W = 'writingAAA', M = 'mockAAA', SCHOOL = 'maxima'
const NOW = Date.parse('2026-10-18T21:00:00Z')
const essay = n => Array.from({length:n},(_,i)=>`word${i}`).join(' ')
const sha = value => createHash('sha256').update(value).digest('hex')
class AuthError extends Error {constructor(code,message){super(message);this.code=code}}

function world({choice='ai',billing='student_credit',words=300,context='homework',jobStatus=null,jobBilling=null,leaseExpired=false,accessCredits=0,providerImpl=null} = {}) {
  const mock = context==='mock'
  const contentId = mock ? M : W
  const contentType = mock ? 'mock' : 'writing'
  const sourceCollection = mock ? 'mockTests' : 'writingHomeworks'
  const submissionCollection = mock ? 'mockSubmissions' : 'writingSubmissions'
  const source = mock
    ? {schoolId:SCHOOL,writingId:W,enabledSections:{writing:true}}
    : {schoolId:SCHOOL,contentType:'task2_only',task2:{prompt:'Discuss this problem.'}}
  const writingSource = {schoolId:SCHOOL,contentType:'task2_only',task2:{prompt:'Discuss this problem.'}}
  const submission = {uid:UID,studentId:UID,schoolId:SCHOOL,attemptNumber:1,
    submittedAt:'2026-10-18T17:00:00Z',aiReviewChoice:choice,aiBillingMode:billing,
    ...(mock
      ? {mockTestId:M,writingId:W,writingMode:'task2_only',enabledSections:{writing:true},writingAnswers:{task1:'',task2:essay(words)}}
      : {writingId:W,writingMode:'task2_only',task1Answer:'',task2Answer:essay(words)})}
  const prepared = prepareAiWritingEvaluation({source:mock?writingSource:source,submission,context})
  const fingerprint = sha(JSON.stringify(prepared))
  const jobId = sha(['ai-writing-v1',UID,context,contentId,1].join('\0'))
  const docs = new Map(Object.entries({
    [`${sourceCollection}/${contentId}`]:source,
    [`${submissionCollection}/${UID}_${contentId}`]:submission,
    [`studentAccess/${UID}_${contentType}_${contentId}`]:{
      uid:UID,schoolId:SCHOOL,contentType,contentId,sourceCollection,
      accessType:'assignment',status:'active'},
    [`users/${UID}`]:{uid:UID,role:'student',schoolId:SCHOOL,status:'approved',accountType:'institution'},
    [`schools/${SCHOOL}`]:{status:'active'},
    [`aiWritingSchoolSettings/${SCHOOL}`]:{schoolId:SCHOOL,pilotEnabled:true},
    [`aiWritingStudentAccess/${UID}`]:{uid:UID,studentId:UID,schoolId:SCHOOL,
      accountType:'institution',enabled:true,creditsRemaining:accessCredits,creditsUsedTotal:0}
  }))
  if(mock)docs.set(`writingHomeworks/${W}`,writingSource)
  const job = {schemaVersion:1,jobId,studentId:UID,schoolId:SCHOOL,context,contentId,
    attemptNumber:1,fingerprint,status:jobStatus,leaseId:'leaseAAA',activeLedgerId:'ledgerAAA',
    month:'202610',leaseUntilMs:NOW+(leaseExpired?-1000:120000),
    ...(jobBilling ? {billingMode:jobBilling} : {})}
  if(jobStatus) docs.set(`aiWritingEvaluations/${jobId}`,job)
  if(jobStatus==='processing'){
    docs.set('aiWritingCreditOperations/ledgerAAA',{jobId,status:'reserved'})
    docs.set('aiWritingMonthlyUsage/maxima_202610',{requestCount:1,pendingCount:1,completedCount:0})
  }
  const writes = []
  const snapshot = p => ({exists:docs.has(p),id:p.split('/').at(-1),data:()=>docs.get(p)})
  const doc = p => ({path:p,id:p.split('/').at(-1),get:async()=>snapshot(p)})
  const db = {doc,docs,writes,runTransaction:async fn => {
    const staged=[]
    const tx={get:async r=>snapshot(r.path),update:(r,v)=>staged.push([r.path,v]),
      set:(r,v)=>staged.push([r.path,v]),create:(r,v)=>staged.push([r.path,v])}
    const result=await fn(tx)
    for(const [p,v] of staged){docs.set(p,{...docs.get(p),...v});writes.push(p)}
    return result
  }}
  let calls=0
  const svc = createAiWritingEvaluationService({db,FieldValue:{serverTimestamp:()=>NOW},HttpsError:AuthError,
    requireStudent:async()=>({uid:UID,schoolId:SCHOOL}),
    requireStudentAttemptSource:async()=>true,
    submissionContentConfigFor:()=>({sourceCollection}),
    findCurrentSubmissionRecord:async()=>({ref:doc(`${submissionCollection}/${UID}_${contentId}`)}),
    getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf:d=>d?.schoolId,
    getMockEnabledSections:d=>d?.enabledSections || {},getMockWritingMode:()=> 'task2_only',
    provider:async(prepared,secret)=>{calls++;if(providerImpl)return providerImpl(prepared,secret);throw new Error('Fake provider must not be called.')},
    getApiKey:()=> 'sk-local-fake',providerEnabled:()=>true,now:()=>NOW})
  return {db,docs,writes,svc,input:{data:{context,contentId}},jobId,
    providerCalls:()=>calls}
}

function validStubReport() {
  const criterion={band:6,explanation:'Clear reasoning and adequate examples.',evidence:''}
  const task2={wordCount:300,feedbackOnly:false,estimatedBand:6,
    criteria:{taskAchievementOrResponse:criterion,coherenceAndCohesion:criterion,
      lexicalResource:criterion,grammaticalRangeAndAccuracy:criterion}}
  return {isAiEstimate:true,teacherFinalScore:null,context:'homework',
    writingMode:'task2_only',isProvisionalMockEstimate:false,
    task1:null,task2,estimatedBand:6,feedbackOnly:false}
}

test('B3 frontend: only exact personal-credit homework selection is eligible for manual retry',()=>{
  assert.equal(isPersonalCreditAiSelection('homework','ai','student_credit'),true)
  for(const args of [
    ['homework','teacher','student_credit'],['homework','ai','institution'],
    ['homework','ai',null],['mock','ai','student_credit'],
    ['mock','teacher','institution']
  ])assert.equal(isPersonalCreditAiSelection(...args),false,JSON.stringify(args))
})

test('B3 frontend: server canRetry + active personal credits + valid status are all required',()=>{
  const access=safeAiWritingAccess({schoolId:'maxima',accountType:'institution',pilotEnabled:true,
    studentEnabled:true,creditsRemaining:2,canEvaluate:true})
  assert.equal(canRequestAiWriting(access,{status:'failed',canRetry:true},false),true)
  assert.equal(canRequestAiWriting(access,{status:'not_started',canRetry:true},false),true)
  for (const invalid of [
    {status:'failed',canRetry:false},{status:'failed'},
    {status:'failed',canRetry:true,institutionFunded:true},
    {status:'processing',canRetry:true},{status:'completed',canRetry:true},
    {status:'too_short',canRetry:true},{status:'unavailable',canRetry:true}
  ])assert.equal(canRequestAiWriting(access,invalid,false),false,JSON.stringify(invalid))
  assert.equal(canRequestAiWriting(access,{status:'failed',canRetry:true},true),false)
  assert.equal(canRequestAiWriting({...access,canEvaluate:false},{status:'failed',canRetry:true},false),false)
})

test('B3 frontend: untrusted institution-funded retry flag is forcibly cleared',()=>{
  const envelope=safeAiWritingEnvelope({status:'failed',canRetry:true,institutionFunded:true},1)
  assert.equal(envelope.institutionFunded,true)
  assert.equal(envelope.canRetry,false)
  assert.equal(safeAiWritingEnvelope({status:'failed',canRetry:true},1).canRetry,true)
  assert.equal(safeAiWritingEnvelope({status:'failed',canRetry:'true'},1).canRetry,false)
})

test('B3 backend: missed first personal-credit evaluation is retryable but read-only',async()=>{
  const w=world(),r=await w.svc.getReport(w.input)
  assert.equal(r.status,'not_started');assert.equal(r.canRetry,true)
  assert.equal(w.writes.length,0);assert.equal(w.providerCalls(),0)
})

test('B3 backend: teacher-submitted Writing is never retryable and cannot spend a credit',async()=>{
  const w=world({choice:'teacher',billing:'none'})
  assert.equal((await w.svc.getReport(w.input)).canRetry,false)
  await assert.rejects(w.svc.evaluate(w.input),e=>e.code==='permission-denied')
  assert.equal(w.writes.length,0);assert.equal(w.providerCalls(),0)
})

test('B3 backend: institution-funded Writing does not unlock personal-credit retry',async()=>{
  const w=world({choice:'ai',billing:'institution'})
  assert.equal((await w.svc.getReport(w.input)).canRetry,false)
  await assert.rejects(w.svc.evaluate(w.input),e=>e.code==='permission-denied')
  assert.equal(w.writes.length,0);assert.equal(w.providerCalls(),0)
})

test('B3 backend: personal-credit failure returns canRetry; legacy job without billingMode is supported',async()=>{
  const w=world({jobStatus:'failed'})
  const report=await w.svc.getReport(w.input)
  assert.equal(report.status,'failed');assert.equal(report.canRetry,true)
  assert.equal(report.institutionFunded,false);assert.equal(w.writes.length,0)
})

test('B3 backend: sponsored failed job cannot advertise personal-credit retry even with mislabeled submission',async()=>{
  const w=world({jobStatus:'failed',jobBilling:'sponsored_auto'})
  const report=await w.svc.getReport(w.input)
  assert.equal(report.canRetry,false);assert.equal(report.institutionFunded,true)
  assert.equal(w.writes.length,0)
})

test('B3 backend: a teacher-request job cannot become a student-credit retry',async()=>{
  const w=world({jobStatus:'failed',jobBilling:'teacher_request'})
  const report=await w.svc.getReport(w.input)
  assert.equal(report.canRetry,false)
  assert.equal(w.writes.length,0)
})

test('B3 backend: unknown job state fails closed instead of inviting a paid retry',async()=>{
  const w=world({jobStatus:'cancelled',jobBilling:'student_credit'})
  const status=await w.svc.getReport(w.input)
  assert.equal(status.status,'failed')
  assert.equal(status.canRetry,false)
  assert.equal(w.writes.length,0)
})

test('B3 backend: personal-credit submitted answer below minimum cannot trigger a retry',async()=>{
  const w=world({words:20})
  assert.equal((await w.svc.getReport(w.input)).status,'too_short')
  assert.equal((await w.svc.getReport(w.input)).canRetry,undefined)
  assert.equal(w.providerCalls(),0)
})

test('B3 backend: Mock has no personal-credit retry, regardless of billing metadata',async()=>{
  const w=world({context:'mock',choice:'ai',billing:'student_credit',jobStatus:'failed'})
  assert.equal((await w.svc.getReport(w.input)).canRetry,false)
  assert.equal(w.providerCalls(),0)
})

test('B3 backend: expired personal-credit reservation refunded once, then retry enabled',async()=>{
  const w=world({jobStatus:'processing',leaseExpired:true})
  const first=await w.svc.getReport(w.input)
  assert.equal(first.status,'failed');assert.equal(first.canRetry,true)
  assert.equal(first.creditReconciled,true)
  assert.equal(w.docs.get(`aiWritingStudentAccess/${UID}`).creditsRemaining,1)
  assert.equal(w.docs.get('aiWritingCreditOperations/ledgerAAA').status,'refunded')
  assert.equal(w.docs.get('aiWritingMonthlyUsage/maxima_202610').pendingCount,0)
  const writes=w.writes.length
  assert.equal((await w.svc.getReport(w.input)).canRetry,true)
  assert.equal(w.writes.length,writes,'a report refresh must never refund twice')
  assert.equal(w.providerCalls(),0)
})

test('B3 backend: active reservation stays processing, no early retry and no credit refund',async()=>{
  const w=world({jobStatus:'processing',leaseExpired:false})
  const status=await w.svc.getReport(w.input)
  assert.equal(status.status,'processing');assert.equal(status.canRetry,undefined)
  assert.equal(w.writes.length,0)
})

test('B3 backend: concurrent personal retries reserve one credit; completed report is reused for free',async()=>{
  let enteredProvider, releaseProvider
  const providerEntered = new Promise(resolve=>{enteredProvider=resolve})
  const w=world({accessCredits:2,providerImpl:()=>{
    enteredProvider()
    return new Promise(resolve=>{releaseProvider=resolve})
  }})
  const firstPending=w.svc.evaluate(w.input)
  await providerEntered
  const second=await w.svc.evaluate(w.input)
  assert.equal(second.status,'processing')
  assert.equal(w.providerCalls(),1)
  assert.equal(w.docs.get(`aiWritingStudentAccess/${UID}`).creditsRemaining,1)
  assert.equal(w.docs.get(`aiWritingEvaluations/${w.jobId}`).billingMode,'student_credit')
  releaseProvider({report:validStubReport(),model:'local-test-provider'})
  const first=await firstPending
  assert.equal(first.status,'completed')
  const month=w.docs.get('aiWritingMonthlyUsage/maxima_202610')
  assert.equal(month.requestCount,1)
  assert.equal(month.pendingCount,0)
  assert.equal(month.completedCount,1)
  assert.equal(w.docs.get(`aiWritingStudentAccess/${UID}`).creditsUsedTotal,1)
  assert.equal((await w.svc.getReport(w.input)).canRetry,undefined)
  const third=await w.svc.evaluate(w.input)
  assert.equal(third.status,'completed')
  assert.equal(third.reused,true)
  assert.equal(w.providerCalls(),1)
  assert.equal(w.docs.get(`aiWritingStudentAccess/${UID}`).creditsRemaining,1)
})

test('B3 backend: provider failure refunds once, later successful retry spends one credit',async()=>{
  let failFirst=true
  const w=world({accessCredits:1,providerImpl:async()=>{
    if(failFirst){failFirst=false;throw new Error('Simulated model failure')}
    return {report:validStubReport(),model:'local-test-provider'}
  }})
  await assert.rejects(w.svc.evaluate(w.input),e=>e.code==='unavailable')
  assert.equal(w.docs.get(`aiWritingStudentAccess/${UID}`).creditsRemaining,1)
  assert.equal(w.docs.get('aiWritingMonthlyUsage/maxima_202610').pendingCount,0)
  assert.equal((await w.svc.getReport(w.input)).canRetry,true)
  const completed=await w.svc.evaluate(w.input)
  assert.equal(completed.status,'completed')
  assert.equal(w.providerCalls(),2)
  const access=w.docs.get(`aiWritingStudentAccess/${UID}`)
  assert.equal(access.creditsRemaining,0)
  assert.equal(access.creditsUsedTotal,1)
  const month=w.docs.get('aiWritingMonthlyUsage/maxima_202610')
  assert.equal(month.requestCount,2)
  assert.equal(month.pendingCount,0)
  assert.equal(month.completedCount,1)
  const ledgerDocs=[...w.docs.entries()].filter(([key])=>key.startsWith('aiWritingCreditOperations/'))
  assert.deepEqual(ledgerDocs.map(([,ledger])=>ledger.status).sort(),['refunded','settled'])
})

test('B3 UI contract: both student entrypoints pass server-recorded billingMode; no manual override',()=>{
  const doWriting=fs.readFileSync(path.join(dir,'../src/pages/DoWriting.jsx'),'utf8')
  const dashboard=fs.readFileSync(path.join(dir,'../src/pages/StudentDashboard.jsx'),'utf8')
  const panel=fs.readFileSync(path.join(dir,'../src/components/AiWritingStudentPanel.jsx'),'utf8')
  assert.match(doWriting,/submittedBillingMode=\{completedSubmission\.aiBillingMode/)
  assert.match(dashboard,/submittedBillingMode=\{selectedReview\.submission\.aiBillingMode/)
  assert.match(panel,/personalCreditSelected && envelope\.canRetry === true && access\?\.canEvaluate === true/)
  assert.match(panel,/!personalCreditSelected \|\|/)
  assert.ok(panel.indexOf('getMyAiWritingReportCall(getPayload())') <
    panel.indexOf('getMyAiWritingAccessCall({})'),
  'credit balance must be fetched after the report can reconcile an expired reservation')
  assert.doesNotMatch(panel,/allowManualRequest/)
  assert.doesNotMatch(doWriting,/allowManualRequest/)
  assert.doesNotMatch(dashboard,/allowManualRequest/)
})
