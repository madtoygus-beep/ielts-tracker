'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeAiWritingReport } = require('./functions/lib/aiWritingGrading')
const {
  createAiWritingSponsoredEvaluationService, isNewSubmittedAttempt,
  submissionSignature, policyUpdatedAfterSubmission, MAX_MONTHLY_SCHOOL_EVALUATIONS
} = require('./functions/lib/aiWritingSponsoredEvaluation')
const { createHash } = require('node:crypto')
const sha = s => createHash('sha256').update(s,'utf8').digest('hex')

const NOW = Date.parse('2026-10-15T03:00:00Z')
const SUBMITTED = '2026-10-15T02:00:00.000Z'
const POLICY_UPDATED = '2026-10-15T01:00:00.000Z'
const writingId = 'writing100'
const mockId = 'mock100'
const student = 'student0001'
const other = 'student0002'
const teacher = 'teacher0001'
const monthPath = 'aiWritingMonthlyUsage/maxima_202610'
const source = (context, id) => context === 'mock' ? `mockTests/${id}` : `writingHomeworks/${id}`
const policyPath = (context, id) => `aiWritingSponsoredPolicies/${context==='mock'?'mock':'writing'}_${id}`
const assignmentPath = (context, uid, id) => `studentAccess/${uid}_${context==='mock'?'mock':'writing'}_${id}`
const submissionPath = (context, uid, id) => `${context==='mock'?'mockSubmissions':'writingSubmissions'}/${uid}_${id}`
const jobPath = (context, uid, id, attempt = 1) =>
  `aiWritingEvaluations/${sha(['ai-writing-v1',uid,context,id,attempt].join('\0'))}`
const controlPath = (context, uid, id) =>
  `submissionAttemptControls/${sha(`${uid}\u001f${context==='mock'?'mock':'writing'}\u001f${id}`)}`

const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
class FakeDb {
  constructor() { this.docs = new Map(); this.writes = []; this._tail = Promise.resolve() }
  doc(p) { return { path:p, id:p.split('/').at(-1), get:()=>this.snapshot(p) } }
  snapshot(p) {
    const exists = this.docs.has(p)
    const data = clone(this.docs.get(p))
    return { exists, id:p.split('/').at(-1), ref:this.doc(p), data:()=>clone(data) }
  }
  put(p, data) { this.docs.set(p,clone(data)) }
  async runTransaction(callback) {
    const previous=this._tail
    let release
    this._tail=new Promise(resolve=>{release=resolve})
    await previous
    const staged=[]
    let wrote=false
    const tx={
      get: async ref=>{if(wrote)throw Error('Firestore: read after write');return this.snapshot(ref.path)},
      set:(ref, data, opts)=>{wrote=true;staged.push({kind:'set',p:ref.path,data:clone(data),opts})},
      create:(ref,data)=>{wrote=true;staged.push({kind:'create',p:ref.path,data:clone(data)})},
      update:(ref,data)=>{wrote=true;staged.push({kind:'update',p:ref.path,data:clone(data)})}
    }
    try {
      const result=await callback(tx)
      for(const op of staged){
        if(op.kind==='create' && this.docs.has(op.p))throw Error('Duplicate document create')
        if(op.kind==='update' && !this.docs.has(op.p))throw Error('Missing document update')
        const previousValue=op.kind!=='create' ? this.docs.get(op.p)||{} : {}
        this.docs.set(op.p, clone(op.kind==='set' && !op.opts?.merge ? op.data : {...previousValue,...op.data}))
        this.writes.push(op)
      }
      return result
    } finally { release() }
  }
}

function makeReport(prepared) {
  const makeTask=()=>({
    criteria: {
      taskAchievementOrResponse:{band:6.5,explanation:'Appropriate response.',evidence:''},
      coherenceAndCohesion:{band:6.5,explanation:'Logically structured.',evidence:''},
      lexicalResource:{band:6.5,explanation:'Appropriate vocabulary.',evidence:''},
      grammaticalRangeAndAccuracy:{band:6.5,explanation:'Mostly accurate grammar.',evidence:''}
    },
    overview:'Adequate answer with room for development.',strengths:[],priorities:[],corrections:[]
  })
  return normalizeAiWritingReport({
    task1:prepared.task1?makeTask():null, task2:prepared.task2?makeTask():null
  },prepared)
}

function fixture({context='homework', selected=[student], pilotEnabled=true,
  autoEnabled=true, secret='sk-test-12345678901234567890', provider, attempt=1}={}) {
  const db=new FakeDb()
  let calls=0
  const id=context==='mock'?mockId:writingId
  const subPath=submissionPath(context,student,id)
  const baseSubmission={
    uid:student,studentId:student,schoolId:'maxima',attemptNumber:attempt,
    submittedAt:SUBMITTED,writingMode:'task2_only', task1Enabled:false,task2Enabled:true
  }
  const submission=context==='mock'
    ? {...baseSubmission,mockTestId:id,writingId:writingId,status:'submitted',
      enabledSections:{writing:true},writingAnswers:{task1:'',task2:'Education improves quality of life. Schools should teach practical money skills, including budgeting, saving, responsible borrowing, and comparing loan costs to prepare students for adulthood.'},
      result:{overallEstimate:6.5}}
    : {...baseSubmission,writingId:id,task1Answer:'',task2Answer:'Education improves quality of life. Schools should teach practical money skills, including budgeting, saving, responsible borrowing, and comparing loan costs to prepare students for adulthood.'}
  db.put('users/'+student,{role:'student',status:'approved',schoolId:'maxima',accountType:'institution'})
  db.put('users/'+other,{role:'student',status:'approved',schoolId:'maxima',accountType:'institution'})
  db.put('schools/maxima',{status:'active'})
  db.put('aiWritingSchoolSettings/maxima',{schoolId:'maxima',pilotEnabled})
  db.put('writingHomeworks/'+writingId,{schoolId:'maxima',contentType:'task2_only',
    teacherId:teacher, task2:{title:'Task 2',prompt:'Discuss the importance of education.'}})
  db.put('mockTests/'+mockId,{schoolId:'maxima',writingId:writingId,
    teacherId:teacher,enabledSections:{writing:true,listening:false,reading:false}})
  db.put(policyPath(context,id),{schoolId:'maxima',enabled:true,
    contentId:id,contentType:context==='mock'?'mock':'writing',context,
    sourceCollection:context==='mock'?'mockTests':'writingHomeworks',
    studentIds:selected,billing:'institution',updatedAt:POLICY_UPDATED})
  db.put(assignmentPath(context,student,id),{uid:student,contentId:id,
    contentType:context==='mock'?'mock':'writing',schoolId:'maxima',
    sourceCollection:context==='mock'?'mockTests':'writingHomeworks',
    accessType:'assignment',status:'active',adminHidden:false})
  db.put(subPath,submission)
  const proxyProvider=async (prepared,key)=>{
    calls++
    if(provider)return provider(prepared,key,db)
    assert.equal(key,secret)
    return {report:makeReport(prepared),model:'gpt-5-mini',providerResponseId:'response-test'}
  }
  const service=createAiWritingSponsoredEvaluationService({
    db,FieldValue:{serverTimestamp:()=>NOW},
    provider:proxyProvider,getApiKey:()=>secret,providerEnabled:()=>autoEnabled,
    schoolIdOf: obj=>obj?.schoolId||'maxima',
    getMockEnabledSections: obj=>obj?.enabledSections || {writing:false},
    getMockWritingMode:(_mock,writing)=>writing?.contentType,
    findCurrentSubmissionRecord:async(_config,uid,contentId)=>{
      const ref=db.doc(submissionPath(context,uid,contentId))
      const snap=await ref.get()
      return snap.exists?{ref,data:snap.data()}:null
    },
    submissionContentConfigFor:type=>({contentType:type}) ,now:()=>NOW
  })
  const event=(before=null, after=submission)=>({
    data: {before: before?{exists:true,data:()=>clone(before)}:{exists:false},
      after: after? {exists:true,ref:db.doc(subPath),data:()=>clone(after)}:{exists:false}},
    params:{id:db.doc(subPath).id}
  })
  return {db,service,event,submission,id,subPath,
    evaluate: (before=null,after=submission)=>service.submit(context,event(before,after)),
    calls:()=>calls,ctx:context}
}

let passed=0, failed=0
async function test(name,fn){
  try {await fn();passed++;console.log('PASS',name)}
  catch(error){failed++;console.error('FAIL',name, error?.stack||error)}
}

;(async()=>{
await test('Disabled trigger never reads secret or calls provider',async()=>{
  const f=fixture({autoEnabled:false,secret:null})
  assert.equal((await f.evaluate()).status,'disabled');assert.equal(f.calls(),0);assert.equal(f.db.writes.length,0)
})
await test('Missing secret never requests provider',async()=>{
  const f=fixture({secret:''});assert.equal((await f.evaluate()).status,'disabled');assert.equal(f.calls(),0)
})
await test('New Writing submission is eligible',async()=>{
  const f=fixture();assert.equal((await f.evaluate()).status,'completed')
  assert.equal(f.calls(),1)
  const doc=f.db.docs.get(jobPath('homework',student,writingId))
  assert.equal(doc.status,'completed');assert.equal(doc.billing,'institution')
  assert.equal(doc.billingMode,'sponsored_auto')
  assert.equal(doc.report.isAiEstimate,true)
})
await test('Writing report retains four IELTS criteria',async()=>{
  const f=fixture();await f.evaluate()
  const report=f.db.docs.get(jobPath('homework',student,writingId)).report
  assert.equal(Object.keys(report.task2.criteria).length,4)
  assert.equal(report.estimatedBand,6.5)
})
await test('Successful sponsored attempt never touches any student credit documents',async()=>{
  const f=fixture(); f.db.put('aiWritingStudentAccess/'+student,{creditsRemaining:5,creditsUsedTotal:0})
  const prev=clone(f.db.docs.get('aiWritingStudentAccess/'+student))
  await f.evaluate()
  assert.deepEqual(f.db.docs.get('aiWritingStudentAccess/'+student),prev)
  assert.equal(f.db.writes.some(x=>x.p.startsWith('aiWritingStudentAccess/')||x.p.startsWith('aiWritingCreditOperations/')),false)
})
await test('Monthly cost ceiling includes sponsored provider requests',async()=>{
  const f=fixture();await f.evaluate()
  const doc=f.db.docs.get(monthPath)
  assert.equal(doc.requestCount,1);assert.equal(doc.sponsoredRequestCount,1)
  assert.equal(doc.completedCount,1);assert.equal(doc.pendingCount,0)
})
await test('Same attempt delivered twice starts just one provider request',async()=>{
  const f=fixture();await f.evaluate()
  assert.equal((await f.evaluate()).status,'completed')
  assert.equal(f.calls(),1)
  assert.equal(f.db.docs.get(monthPath).requestCount,1)
})
await test('Concurrent duplicate events reserve only one model call',async()=>{
  let release
  const wait=new Promise(r=>{release=r})
  const f=fixture({provider:async prepared=>{await wait;return {report:makeReport(prepared),model:'gpt-5-mini'}}})
  const first=f.evaluate();const second=f.evaluate()
  await new Promise(r=>setImmediate(r));release()
  const result=await Promise.all([first,second])
  assert.equal(result.filter(x=>x.status==='completed').length,1)
  assert.equal(f.calls(),1)
  assert.equal(f.db.docs.get(monthPath).requestCount,1)
})
await test('Teacher review edit does not trigger paid AI',async()=>{
  const f=fixture();const before=f.submission
  const after={...before,reviewed:true,review:{band:7.5}}
  assert.equal((await f.evaluate(before,after)).status,'ignored');assert.equal(f.calls(),0)
})
await test('Deletion event does not trigger AI',async()=>{
  const f=fixture();assert.equal((await f.service.submit('homework',f.event(f.submission,null))).status,'ignored')
})
await test('Attempt update requires next attempt AND new timestamp',async()=>{
  const f=fixture()
  assert.equal(isNewSubmittedAttempt('homework',{...f.submission,attemptNumber:1},{...f.submission,attemptNumber:2}),false)
  assert.equal(isNewSubmittedAttempt('homework',{...f.submission,attemptNumber:1},{...f.submission,attemptNumber:3,submittedAt:'2026-10-15T02:01:00Z'}),false)
  assert.equal(isNewSubmittedAttempt('homework',{...f.submission,attemptNumber:1},{...f.submission,attemptNumber:2,submittedAt:'2026-10-15T02:01:00Z'}),true)
})
await test('No selected student: no automatic call',async()=>{
  const f=fixture({selected:[other]});assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.calls(),0)
})
await test('Disabled teacher policy: no automatic call',async()=>{
  const f=fixture();f.db.docs.get(policyPath('homework',writingId)).enabled=false
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Policy created AFTER student submit does not trigger retroactive spend',async()=>{
  const f=fixture();f.db.docs.get(policyPath('homework',writingId)).updatedAt='2026-10-15T02:30:00Z'
  assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.calls(),0)
})
await test('Missing policy timestamp fails closed',async()=>{
  assert.equal(policyUpdatedAfterSubmission({},{submittedAt:SUBMITTED}),true)
  const f=fixture();delete f.db.docs.get(policyPath('homework',writingId)).updatedAt
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('School pilot disabled fails closed independent of selected assignment',async()=>{
  const f=fixture({pilotEnabled:false});assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Inactive school fails closed',async()=>{
  const f=fixture();f.db.docs.get('schools/maxima').status='inactive'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Individual account is excluded',async()=>{
  const f=fixture();f.db.docs.get('users/'+student).accountType='individual'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Platform-type student is excluded even within Maxima school',async()=>{
  const f=fixture();f.db.docs.get('users/'+student).accountType='platform'
  assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.calls(),0)
})
await test('Mixed-case individual account type is excluded',async()=>{
  const f=fixture();f.db.docs.get('users/'+student).accountType='Individual'
  assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.calls(),0)
})
await test('Pending student is excluded',async()=>{
  const f=fixture();f.db.docs.get('users/'+student).status='pending'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Archived student is excluded',async()=>{
  const f=fixture();f.db.docs.get('users/'+student).archived=true
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Foreign-school student is excluded',async()=>{
  const f=fixture();f.db.docs.get('users/'+student).schoolId='other-school'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Deleted teacher assignment is excluded',async()=>{
  const f=fixture();f.db.docs.get(assignmentPath('homework',student,writingId)).status='inactive'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Hidden student assignment is excluded',async()=>{
  const f=fixture();f.db.docs.get(assignmentPath('homework',student,writingId)).adminHidden=true
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Archived Writing source is excluded',async()=>{
  const f=fixture();f.db.docs.get(source('homework',writingId)).archived=true
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Open retake is excluded',async()=>{
  const f=fixture();f.db.put(controlPath('homework',student,writingId),{status:'open'})
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Writing without task answer cannot spend monthly request',async()=>{
  const f=fixture();f.submission.task2Answer='';f.db.put(f.subPath,f.submission)
  assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.db.docs.has(monthPath),false)
})
await test('Event does not match stored answers: no model request',async()=>{
  const f=fixture();f.submission.task2Answer='Edited by other actor'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Unsigned/invalid source document ID is excluded',async()=>{
  const f=fixture();const after={...f.submission,writingId:'../../secret'}
  assert.equal((await f.evaluate(null,after)).status,'ignored')
})
await test('Oversized Task 1 without image fails safely',async()=>{
  const f=fixture();f.db.docs.get(source('homework',writingId)).contentType='full_writing'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Mock Writing evaluation works for task2_only linked source',async()=>{
  const f=fixture({context:'mock'})
  assert.equal((await f.evaluate()).status,'completed');assert.equal(f.calls(),1)
  const job=f.db.docs.get(jobPath('mock',student,mockId))
  assert.equal(job.context,'mock');assert.equal(job.report.isProvisionalMockEstimate,true)
})
await test('Mock AI never touches teacher official score',async()=>{
  const f=fixture({context:'mock'})
  f.db.put(`scores/${student}_${mockId}`,{writing:7,overall:7.5})
  const score=clone(f.db.docs.get(`scores/${student}_${mockId}`))
  await f.evaluate()
  assert.deepEqual(f.db.docs.get(`scores/${student}_${mockId}`),score)
})
await test('Mock with no Writing section is denied',async()=>{
  const f=fixture({context:'mock'});f.db.docs.get(source('mock',mockId)).enabledSections.writing=false
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Mock mismatched linked source is denied',async()=>{
  const f=fixture({context:'mock'});f.db.docs.get(source('mock',mockId)).writingId='different'
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Mock with archived linked Writing is denied',async()=>{
  const f=fixture({context:'mock'});f.db.docs.get(source('homework',writingId)).archived=true
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('Mock unfinished status is denied',async()=>{
  const f=fixture({context:'mock'});f.submission.status='started'
  assert.equal((await f.evaluate()).status,'ignored')
})
await test('Monthly limit stops provider calls at 60 combined requests',async()=>{
  const f=fixture();f.db.put(monthPath,{schoolId:'maxima',month:'202610',requestCount:MAX_MONTHLY_SCHOOL_EVALUATIONS,pendingCount:0,completedCount:10})
  assert.equal((await f.evaluate()).status,'budget_exhausted');assert.equal(f.calls(),0)
  assert.equal(f.db.docs.get(monthPath).requestCount,60)
})
await test('Corrupted monthly usage fails closed',async()=>{
  const f=fixture();f.db.put(monthPath,{schoolId:'maxima',month:'202610',requestCount:'invalid',pendingCount:0,completedCount:0})
  assert.equal((await f.evaluate()).status,'invalid_budget');assert.equal(f.calls(),0)
})
await test('Previous credit-funded completed report is reused without sponsor billing',async()=>{
  const f=fixture();f.db.put(jobPath('homework',student,writingId),{
    jobId:jobPath('homework',student,writingId).split('/').at(-1),
    studentId:student,contentId:writingId,context:'homework',attemptNumber:1,
    status:'completed',report:{isAiEstimate:true}})
  assert.equal((await f.evaluate()).status,'completed');assert.equal(f.calls(),0)
  assert.equal(f.db.docs.has(monthPath),false)
})
await test('Pending student-funded job lease cannot be stolen',async()=>{
  const f=fixture();f.db.put(jobPath('homework',student,writingId),{
    jobId:jobPath('homework',student,writingId).split('/').at(-1),
    studentId:student,contentId:writingId,context:'homework',attemptNumber:1,
    status:'processing',activeLedgerId:'personal-credit-lease'})
  assert.equal((await f.evaluate()).status,'already_started');assert.equal(f.calls(),0)
})
await test('Failed job does not auto retry and incur another charge',async()=>{
  const f=fixture({provider:async()=>{throw Error('network provider secret payload')}})
  assert.equal((await f.evaluate()).status,'failed')
  assert.equal(f.db.docs.get(jobPath('homework',student,writingId)).status,'failed')
  assert.equal(f.db.docs.get(monthPath).pendingCount,0)
  assert.equal((await f.evaluate()).status,'already_started');assert.equal(f.calls(),1)
})
await test('Provider failure counts request but never consumes student credits',async()=>{
  const f=fixture({provider:async()=>{throw Error('private essay here')}})
  await f.evaluate()
  assert.equal(f.db.docs.get(monthPath).requestCount,1)
  assert.equal(f.db.docs.get(monthPath).sponsoredRequestCount,1)
  assert.equal(f.db.writes.some(x=>x.p.startsWith('aiWritingStudentAccess/')||x.p.startsWith('aiWritingCreditOperations/')),false)
})
await test('Policy revoked while provider in flight rejects report settlement',async()=>{
  const f=fixture({provider:async (prepared,key,db)=>{
    db.docs.get(policyPath('homework',writingId)).enabled=false
    return {report:makeReport(prepared),model:'gpt-5-mini'}
  }})
  assert.equal((await f.evaluate()).status,'failed')
  const job=f.db.docs.get(jobPath('homework',student,writingId))
  assert.equal(job.status,'failed');assert.equal(job.report,undefined)
  assert.equal(f.db.docs.get(monthPath).pendingCount,0)
})
await test('Student deactivated while provider in flight rejects result settlement',async()=>{
  const f=fixture({provider:async(prepared,key,db)=>{
    db.docs.get('users/'+student).deleted=true
    return {report:makeReport(prepared),model:'gpt-5-mini'}
  }})
  assert.equal((await f.evaluate()).status,'failed')
  assert.equal(f.db.docs.get(jobPath('homework',student,writingId)).report,undefined)
})
await test('Submitted essay replaced while provider in flight rejects result',async()=>{
  const f=fixture({provider:async(prepared,key,db)=>{
    db.docs.get(submissionPath('homework',student,writingId)).task2Answer='new answer'
    return {report:makeReport(prepared),model:'gpt-5-mini'}
  }})
  assert.equal((await f.evaluate()).status,'failed')
})
await test('Bad provider rubric cannot be saved',async()=>{
  const f=fixture({provider:async()=>({report:{context:'mock',isAiEstimate:true},model:'gpt-5-mini'})})
  assert.equal((await f.evaluate()).status,'failed')
})
await test('Changing student attribution in Firestore invalidates event',async()=>{
  const f=fixture();f.db.docs.get(f.subPath).studentId=other
  assert.equal((await f.evaluate()).status,'ineligible')
})
await test('different attempt number produces separate AI job',async()=>{
  const f=fixture({attempt:2});assert.equal((await f.evaluate()).status,'completed')
  assert.ok(f.db.docs.has(jobPath('homework',student,writingId,2)))
  assert.equal(f.db.docs.has(jobPath('homework',student,writingId,1)),false)
})
await test('Reservation writes not started for wrong current submission',async()=>{
  const f=fixture();f.db.docs.get(f.subPath).attemptNumber=2
  assert.equal((await f.evaluate()).status,'stale')
})
await test('Signature changes when submission answer changes',async()=>{
  const f=fixture();assert.notEqual(submissionSignature('homework',f.submission),
    submissionSignature('homework',{...f.submission,task2Answer:'New words'}))
})
await test('No new AI service writes scores or raw essays in report job',async()=>{
  const f=fixture();await f.evaluate()
  const job=f.db.docs.get(jobPath('homework',student,writingId))
  assert.equal(JSON.stringify(job).includes('Education improves quality of life.'),false)
  assert.equal(f.db.writes.some(x=>x.p.startsWith('scores/')),false)
})
await test('Backend trigger functions are secret-bound and default off',async()=>{
  const index=fs.readFileSync(path.join(__dirname,'functions/index.js'),'utf8')
  assert.match(index,/autoEvaluateSponsoredWriting = onDocumentWritten\(\{/)
  assert.match(index,/autoEvaluateSponsoredMockWriting = onDocumentWritten\(\{/)
  assert.match(index,/secrets: \[maximaOpenAiKey\]/)
  assert.match(index,/MAXIMA_AI_WRITING_SPONSORED_AUTO_ENABLED === 'true'/)
  assert.match(index,/MAXIMA_AI_WRITING_ENABLED === 'true'/)
  assert.doesNotMatch(index,/exports\.autoEvaluateSponsoredWriting\s*=\s*onCall\(/)
})
await test('Evaluation read/credit paths explicitly distinguish sponsored jobs',async()=>{
  const s=fs.readFileSync(path.join(__dirname,'functions/lib/aiWritingEvaluation.js'),'utf8')
  assert.match(s,/job\.billingMode === 'sponsored_auto'/)
  assert.match(s,/institutionFunded: job\.billingMode === 'sponsored_auto'/)
  assert.match(s,/if \(job\.billingMode === 'sponsored_auto'\)/)
})


await test('Corrupted sponsored policy duplicate IDs fails closed',async()=>{
  const f=fixture()
  f.db.docs.get(policyPath('homework',writingId)).studentIds=[student,student]
  assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.calls(),0)
})
await test('Corrupted sponsored policy with more than 60 IDs fails closed',async()=>{
  const f=fixture()
  f.db.docs.get(policyPath('homework',writingId)).studentIds=Array.from({length:61},(_,i)=>`student${String(i).padStart(4,'0')}`)
  assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.calls(),0)
})
await test('Corrupted sponsored policy with invalid UID fails closed',async()=>{
  const f=fixture()
  f.db.docs.get(policyPath('homework',writingId)).studentIds=[student,'../../foo']
  assert.equal((await f.evaluate()).status,'ineligible');assert.equal(f.calls(),0)
})
await test('Monthly quota with wrong school identity fails closed',async()=>{
  const f=fixture()
  f.db.put(monthPath,{schoolId:'other',month:'202610',requestCount:0,pendingCount:0,completedCount:0})
  assert.equal((await f.evaluate()).status,'invalid_budget');assert.equal(f.calls(),0)
})
await test('Monthly quota with wrong accounting month fails closed',async()=>{
  const f=fixture()
  f.db.put(monthPath,{schoolId:'maxima',month:'202601',requestCount:0,pendingCount:0,completedCount:0})
  assert.equal((await f.evaluate()).status,'invalid_budget');assert.equal(f.calls(),0)
})
await test('Fake AI report with no IELTS criteria is rejected',async()=>{
  const f=fixture({provider:async prepared=>({
    model:'gpt-5-mini', report:{isAiEstimate:true,context:prepared.context,
      teacherFinalScore:null,writingMode:'task2_only',estimatedBand:7,task2:{estimatedBand:7}}
  })})
  assert.equal((await f.evaluate()).status,'failed')
  assert.equal(f.db.docs.get(jobPath('homework',student,writingId)).report,undefined)
})
await test('Fake AI report cannot overwrite official teacher final score',async()=>{
  const f=fixture({provider:async prepared=>({
    model:'gpt-5-mini', report:{...makeReport(prepared),teacherFinalScore:9}
  })})
  assert.equal((await f.evaluate()).status,'failed')
})
await test('Report can be read with zero credits and no personal grant',async()=>{
  const f=fixture()
  assert.equal((await f.evaluate()).status,'completed')
  const {createAiWritingEvaluationService}=require('./functions/lib/aiWritingEvaluation')
  const reader=createAiWritingEvaluationService({
    db:f.db,FieldValue:{serverTimestamp:()=>NOW},
    HttpsError:class TestError extends Error{constructor(code,msg){super(msg);this.code=code}},
    requireStudent:async()=>({uid:student,schoolId:'maxima',profile:{role:'student',accountType:'institution'}}),
    requireStudentAttemptSource:async()=>f.db.docs.get(source('homework',writingId)),
    submissionContentConfigFor:()=>({contentType:'writing',sourceCollection:'writingHomeworks',submissionCollection:'writingSubmissions'}),
    findCurrentSubmissionRecord:async()=>({ref:f.db.doc(f.subPath),data:f.db.docs.get(f.subPath),id:f.subPath.split('/').at(-1)}),
    getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf:obj=>obj?.schoolId||'maxima',
    getMockEnabledSections:obj=>obj?.enabledSections||{writing:false},
    getMockWritingMode:()=> 'task2_only',
    provider:async()=>{throw Error('Should never call model while reading')},
    getApiKey:()=>'', providerEnabled:()=>false,now:()=>NOW
  })
  f.db.docs.get('aiWritingSchoolSettings/maxima').pilotEnabled=false
  const r=await reader.getReport({data:{context:'homework',contentId:writingId}})
  assert.equal(r.status,'completed');assert.equal(r.institutionFunded,true)
  assert.equal(r.report.estimatedBand,6.5)
})
await test('Failed institution-sponsored report cannot request student credit retry',async()=>{
  const f=fixture({provider:async()=>{throw Error('temporary model failure')}})
  await f.evaluate()
  const {createAiWritingEvaluationService}=require('./functions/lib/aiWritingEvaluation')
  const service=createAiWritingEvaluationService({
    db:f.db,FieldValue:{serverTimestamp:()=>NOW},
    HttpsError:class TestError extends Error{constructor(code,msg){super(msg);this.code=code}},
    requireStudent:async()=>({uid:student,schoolId:'maxima',profile:{role:'student',accountType:'institution'}}),
    requireStudentAttemptSource:async()=>{},
    submissionContentConfigFor:()=>({contentType:'writing',sourceCollection:'writingHomeworks',submissionCollection:'writingSubmissions'}),
    findCurrentSubmissionRecord:async()=>({ref:f.db.doc(f.subPath),data:f.db.docs.get(f.subPath),id:f.subPath.split('/').at(-1)}),
    getOpenSubmissionAttemptControl:async()=>null,
    schoolIdOf:obj=>obj?.schoolId||'maxima',getMockEnabledSections:()=>({writing:false}),
    getMockWritingMode:()=> 'task2_only',provider:async()=>{},getApiKey:()=> '',now:()=>NOW
  })
  const report=await service.getReport({data:{context:'homework',contentId:writingId}})
  assert.deepEqual(report,{status:'failed',canRetry:false,institutionFunded:true})
})

console.log(`\nP5B-3C sponsored submission evaluation: ${passed}/${passed+failed} PASS; ${failed} FAIL`)
if(failed)process.exitCode=1
})().catch(error=>{console.error('TEST HARNESS ERROR',error?.stack||error);process.exitCode=1})
