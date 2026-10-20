'use strict'
// P0-A regression tests: pure in-memory tests, no network, credentials, Firebase or paid AI.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createAiWritingSponsoredRecoveryService } = require('../functions/lib/aiWritingSponsoredRecovery')
const { createAiWritingManagedReportService } = require('../functions/lib/aiWritingManagedReport')

const JOB_ID = 'a'.repeat(64)
const MONTH = '202610'
const MONTH_PATH = `aiWritingMonthlyUsage/maxima_${MONTH}`
const JOB_PATH = `aiWritingEvaluations/${JOB_ID}`
const NOW = Date.parse('2026-11-02T00:00:00Z')
const clone = value => structuredClone(value)
const FieldValue = {serverTimestamp: () => 'server-time'}
const validJob = () => ({
  jobId: JOB_ID, studentId: 'student001', schoolId: 'maxima',
  billing: 'institution', billingMode: 'sponsored_auto',
  status: 'processing', context: 'homework',
  month: MONTH, leaseId: 'test-lease', leaseUntilMs: NOW - 3600000
})
const validMonth = () => ({
  schoolId: 'maxima', month: MONTH, requestCount: 12,
  pendingCount: 1, completedCount: 8, sponsoredRequestCount: 5
})
class MemoryDb {
  constructor(records) { this.docs = new Map(Object.entries(clone(records))); this.writes=[]; this.tail=Promise.resolve() }
  doc(p) { return {path:p, id:p.split('/').at(-1), get: () => Promise.resolve(this.snap(p))} }
  snap(p) {const value=this.docs.get(p);return {exists:this.docs.has(p),id:p.split('/').at(-1),data:()=>clone(value)} }
  async runTransaction(fn) {
    const prev=this.tail; let unlock; this.tail=new Promise(resolve=>unlock=resolve); await prev
    const updates=[];let wrote=false
    try {
      const value=await fn({
        get:async ref=>{assert.equal(wrote,false,'Firestore reads must precede writes');return this.snap(ref.path)},
        update:(ref,data)=>{wrote=true;updates.push([ref.path,clone(data)])}
      })
      for(const [p,data] of updates){assert.ok(this.docs.has(p));this.docs.set(p,{...this.docs.get(p),...data});this.writes.push([p,data])}
      return value
    } finally {unlock()}
  }
}
const setup = (jobChanges={}, monthChanges={}) => {
  const db=new MemoryDb({[JOB_PATH]:{...validJob(),...jobChanges},[MONTH_PATH]:{...validMonth(),...monthChanges}})
  const service=createAiWritingSponsoredRecoveryService({db,FieldValue,now:()=>NOW})
  return {db,service,job:()=>db.docs.get(JOB_PATH),month:()=>db.docs.get(MONTH_PATH)}
}
const invoke = (service, extras={}) => service.reconcileJob({jobId:JOB_ID, expectedStudentId:'student001',...extras})

test('expired funded reservation repairs ONLY original-month pending; request cost stays billed',async()=>{
  const {db,service,job,month}=setup()
  assert.deepEqual(await invoke(service),{status:'reconciled'})
  assert.equal(job().status,'failed')
  assert.equal(job().lastFailureCode,'sponsored_lease_expired')
  assert.equal(job().leaseUntilMs,0)
  assert.equal(month().pendingCount,0)
  assert.equal(month().requestCount,12)
  assert.equal(month().sponsoredRequestCount,5)
  assert.equal(month().completedCount,8)
  assert.equal(db.docs.has('aiWritingMonthlyUsage/maxima_202611'),false)
  assert.deepEqual(db.writes.map(([p])=>p).sort(),[JOB_PATH,MONTH_PATH].sort())
})

test('reconcile twice and parallel calls cannot double-decrement a pending reservation',async()=>{
  const {service,db,month}=setup()
  const status=await Promise.all(Array.from({length:12},()=>invoke(service)))
  assert.equal(status.filter(x=>x.status==='reconciled').length,1)
  assert.ok(status.every(x=>['reconciled','failed'].includes(x.status)))
  assert.equal(month().pendingCount,0)
  assert.equal(db.writes.length,2)
})

test('active sponsored lease is never interrupted',async()=>{
  const {service,db,job}=setup({leaseUntilMs:NOW+30000})
  assert.equal((await invoke(service)).status,'active')
  assert.equal(job().status,'processing');assert.equal(db.writes.length,0)
})

test('provider completed just before repair wins, report remains untouched',async()=>{
  const {service,db,job}=setup({status:'completed', leaseUntilMs:0, report:{band:7}})
  assert.equal((await invoke(service)).status,'completed')
  assert.deepEqual(job().report,{band:7});assert.equal(db.writes.length,0)
})

test('student-funded, foreign school and wrong owner are never repaired',async()=>{
  for(const variant of [{billingMode:'student_credit',billing:'student'}, {schoolId:'other'}, {jobId:'b'.repeat(64)}]){
    const {service,db}=setup(variant)
    assert.equal((await invoke(service)).status,'ineligible');assert.equal(db.writes.length,0)
  }
  const {service,db}=setup()
  assert.equal((await invoke(service,{expectedStudentId:'attacker'})).status,'ineligible')
  assert.equal(db.writes.length,0)
})

test('invalid month counters and incorrect school/month stop without writing',async()=>{
  for(const variant of [{pendingCount:0},{pendingCount:'1'},{requestCount:'12'},
    {completedCount:null},{schoolId:'other'},{month:'202609'}]) {
    const {service,db}=setup({},variant)
    assert.equal((await invoke(service)).status,'needs_review');assert.equal(db.writes.length,0)
  }
})

test('invalid lease/month and missing month records are fail-closed',async()=>{
  for (const variant of [{month:'202613'},{leaseId:''},{leaseUntilMs:'expired'}]) {
    const {service,db}=setup(variant)
    assert.equal((await invoke(service)).status,'needs_review');assert.equal(db.writes.length,0)
  }
  const {service,db}=setup()
  db.docs.delete(MONTH_PATH)
  assert.equal((await invoke(service)).status,'needs_review');assert.equal(db.writes.length,0)
})

test('invalid hash cannot become an arbitrary Firestore document path',async()=>{
  const {service,db}=setup()
  for(const id of ['../../../users/admin', '','A'.repeat(64)]){
    assert.equal((await service.reconcileJob({jobId:id})).status,'ineligible')
  }
  assert.equal(db.writes.length,0)
})

class FakeHttpsError extends Error {constructor(code,msg){super(msg);this.code=code}}
function reportFixture(source,uid='teacherOld') {
  const db=new MemoryDb({'writingHomeworks/hw01':source})
  const manager={uid,profile:{role:'teacher',schoolId:'maxima',status:'approved'}}
  const service=createAiWritingManagedReportService({
    db,HttpsError:FakeHttpsError,requireAssignmentManager:async()=>manager,
    managerCanManageSource:()=>true,  // Older main helper incorrectly trusts stale teacherIds.
    requireManagedStudentAssignment:async()=>({profile:{role:'student'}}),
    submissionContentConfigFor:()=>({contentType:'writing',sourceCollection:'writingHomeworks'}),
    findCurrentSubmissionRecord:async()=>null,getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf: v=>v?.schoolId||'maxima',getMockEnabledSections:()=>({}),
    getMockWritingMode:()=>null
  })
  return {service,request:{auth:{uid},data:{context:'homework',contentId:'hw01',studentId:'student001',attemptNumber:1}}}
}

test('stale teacherIds loses managed AI report permission when primary teacher changed',async()=>{
  const f=reportFixture({schoolId:'maxima',teacherId:'teacherNew',teacherIds:['teacherOld','teacherNew']})
  await assert.rejects(f.service.getReport(f.request),{code:'permission-denied'})
})

test('current teacher may still open legitimately assigned report',async()=>{
  const f=reportFixture({schoolId:'maxima',teacherId:'teacherNew',teacherIds:['teacherOld','teacherNew']},'teacherNew')
  assert.equal((await f.service.getReport(f.request)).status,'not_started')
})

test('legacy source without primary teacher retains controlled teacherIds compatibility',async()=>{
  const f=reportFixture({schoolId:'maxima',teacherIds:['teacherOld']})
  assert.equal((await f.service.getReport(f.request)).status,'not_started')
})

test('archived staff and permanent deletion checks exist in authoritative manager helper',()=>{
  const index=fs.readFileSync(path.join(__dirname,'../functions/index.js'),'utf8')
  assert.match(index,/profile\.archived === true \|\| profile\.permanentDeleteInProgress === true/)
  assert.match(index,/await requireAdmin\(request\)[\s\S]*?data\.jobIds/)
})

// Test the actual student report path with an expired sponsored job.
test('student report read reconciles expired sponsored quota without calling provider',async()=>{
  const crypto=require('node:crypto')
  const {createAiWritingEvaluationService}=require('../functions/lib/aiWritingEvaluation')
  const {prepareAiWritingEvaluation}=require('../functions/lib/aiWritingGrading')
  const uid='student001', contentId='writing001'
  const source={schoolId:'maxima',contentType:'task2_only',task2:{prompt:'Discuss technology in education.'}}
  const sub={uid,studentId:uid,schoolId:'maxima',writingId:contentId,attemptNumber:1,
    task2Answer:('Students should use digital resources carefully. ').repeat(30),
    aiReviewChoice:'ai',aiBillingMode:'institution',submittedAt:'2026-10-14T10:00:00.000Z'}
  const prepared=prepareAiWritingEvaluation({context:'homework',source,submission:sub})
  const sha=s=>crypto.createHash('sha256').update(s).digest('hex')
  const jobId=sha(['ai-writing-v1',uid,'homework',contentId,1].join('\0'))
  const subId=`${uid}_${contentId}`
  const job={...validJob(),jobId,studentId:uid,contentId,context:'homework',attemptNumber:1,
    fingerprint:sha(JSON.stringify(prepared)),submissionId:subId}
  const db=new MemoryDb({
    [`writingHomeworks/${contentId}`]:source,
    [`writingSubmissions/${subId}`]:sub,
    [`studentAccess/${uid}_writing_${contentId}`]:{uid,schoolId:'maxima',contentType:'writing',contentId,
      sourceCollection:'writingHomeworks',accessType:'assignment',status:'active'},
    [`aiWritingEvaluations/${jobId}`]:job,
    [MONTH_PATH]:validMonth()
  })
  const recovery=createAiWritingSponsoredRecoveryService({db,FieldValue,now:()=>NOW})
  let providerCalls=0
  const service=createAiWritingEvaluationService({
    db,FieldValue,HttpsError:FakeHttpsError,
    requireStudent:async()=>({uid,schoolId:'maxima',profile:{role:'student',status:'approved',accountType:'institution'}}),
    requireStudentAttemptSource:async()=>{},
    submissionContentConfigFor:()=>({contentType:'writing',sourceCollection:'writingHomeworks',submissionCollection:'writingSubmissions'}),
    findCurrentSubmissionRecord:async()=>({ref:db.doc(`writingSubmissions/${subId}`),data:sub}),
    getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf:data=>data?.schoolId||'maxima',
    getMockEnabledSections:()=>({}),getMockWritingMode:()=>null,
    provider:async()=>{providerCalls++;throw Error('PROVIDER MUST NOT BE CALLED')},
    getApiKey:()=>'',providerEnabled:()=>false,
    reconcileExpiredSponsoredJob:recovery.reconcileJob,now:()=>NOW
  })
  const result=await service.getReport({data:{context:'homework',contentId}})
  assert.equal(result.status,'failed')
  assert.equal(result.institutionFunded,true)
  assert.equal(result.canRetry,false)
  assert.equal(db.docs.get(`aiWritingEvaluations/${jobId}`).status,'failed')
  assert.equal(db.docs.get(MONTH_PATH).pendingCount,0)
  assert.equal(db.docs.get(MONTH_PATH).requestCount,12)
  assert.equal(providerCalls,0)
  // Reopening the report must not decrement the quota a second time.
  const second=await service.getReport({data:{context:'homework',contentId}})
  assert.equal(second.status,'failed')
  assert.equal(db.docs.get(MONTH_PATH).pendingCount,0)
})
