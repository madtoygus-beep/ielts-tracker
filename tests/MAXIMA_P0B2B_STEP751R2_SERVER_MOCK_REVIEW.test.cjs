'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {createMockWritingReviewService,validateReview,computeOverall}=require('../functions/lib/p0bMockWritingReviewService')

const TEACHER='test_current', OLD='test_previous', STUDENT='test_learner', ADMIN='test_admin'
const SID=`${STUDENT}_mockA`, SPATH=`mockSubmissions/${SID}`, SCORE=`scores/${SID}`
const STAMP='2026-10-21T00:25:00.000Z'
const clone=x=>structuredClone(x)
function rubric(){return {
  task1:{taskAchievement:'7.0',coherenceCohesion:'7',lexicalResource:'7',grammarRangeAccuracy:'7.5'},
  task2:{taskResponse:'7.5',coherenceCohesion:'7',lexicalResource:'7.0',grammarRangeAccuracy:'7.5'}
}}
function review(){return {
  task1Enabled:true,task2Enabled:true,task1Band:'7.0',task2Band:'7.5',rubric:rubric(),
  task1Feedback:'Good task 1',task2Feedback:'Good task 2',overall:'7.5',generalFeedback:'Clear'
}}
function seed(){return {
  [SPATH]:{
    uid:STUDENT,studentId:STUDENT,schoolId:'maxima',teacherId:OLD,teacherIds:[OLD],
    mockTestId:'mockA',status:'submitted',attemptNumber:1,submittedAt:STAMP,
    gradedByServer:true,enabledSections:{writing:true,listening:true,reading:true},
    result:{
      reading:{band:6.5,correct:25,enabled:true}, listening:{band:7,correct:30,enabled:true},
      writing:{enabled:true,aiEstimatedBand:6.5,aiEvaluationId:'AI-SERVER-001',
        aiCreditsUsed:2,aiStatus:'completed',aiFeedback:{summary:'AI report'},status:'ai_evaluated'},
      finalOverall:6.5,overall:6.5,overallEstimate:6.5,reviewedOverall:null
    }
  },
  [SCORE]:{uid:STUDENT,studentId:STUDENT,schoolId:'maxima',mockTestId:'mockA',
    source:'mock_test',attemptNumber:1,createdAt:STAMP, gradedByServer:true,
    teacherId:OLD,teacherIds:[OLD],reading:6.5,listening:7,writing:'',
    overall:6.5,aiEstimatedWritingBand:6.5,excludedFromStats:false}
}}
const managerStatus={teacher:{role:'teacher',status:'approved',schoolId:'maxima',deleted:false},
  admin:{role:'admin',status:'approved',schoolId:'maxima',deleted:false}}
class FakeError extends Error{constructor(code,message){super(message);this.code=code}}
class Store{
  constructor(data){this.data=new Map(Object.entries(clone(data)))}
  doc(path){return {path,id:path.split('/').at(-1)}}
  async get(ref){return this.snapshot(ref)}
  snapshot(ref){const data=this.data.get(ref.path);return {exists:data!==undefined,id:ref.id,ref,
    data:()=>data===undefined ? undefined : clone(data)}}
  async runTransaction(handler){
    const store=this
    const staged=new Map()
    const tx={
      async get(ref){return store.snapshot(ref)},
      update(ref,delta){
        const old=staged.get(ref.path) || store.data.get(ref.path)
        if(!old)throw new Error('NOT_FOUND '+ref.path)
        staged.set(ref.path,{...clone(old),...clone(delta)})
      },
      create(ref,delta){
        if(staged.has(ref.path)||store.data.has(ref.path))throw new Error('ALREADY_EXISTS '+ref.path)
        staged.set(ref.path,clone(delta))
      }
    }
    const response=await handler(tx)
    for(const [path,data] of staged)store.data.set(path,data)
    return response
  }
}
function kit({withoutScore=false,uid=TEACHER,legacy=false,mutateBeforeTxn=null}={}){
  const data=seed()
  if(withoutScore)delete data[SCORE]
  if(legacy){data['scores/legacy_1']=data[SCORE];delete data[SCORE]}
  const db=new Store(data)
  const profiles={
    [TEACHER]:clone(managerStatus.teacher),
    [OLD]:clone(managerStatus.teacher),
    [ADMIN]:clone(managerStatus.admin),
    [STUDENT]:{role:'student',status:'approved',schoolId:'maxima'}
  }
  const access={[TEACHER]:[STUDENT],[OLD]:[]}
  let oneTimeMutation=mutateBeforeTxn
  const underlyingRunTransaction=db.runTransaction.bind(db)
  db.runTransaction=async handler=>{
    if(oneTimeMutation){oneTimeMutation({db,profiles,access});oneTimeMutation=null}
    return underlyingRunTransaction(handler)
  }
  const membership=async({manager,studentId,schoolId})=>{
    if(manager.profile.role==='admin')return true
    if(manager.profile.role!=='teacher'||manager.profile.status!=='approved'||
      manager.profile.deleted===true || manager.profile.archived===true||
      profiles[manager.uid].status!=='approved'||profiles[manager.uid].deleted===true||
      profiles[manager.uid].archived===true || schoolId!=='maxima'||
      !access[manager.uid]?.includes(studentId)||
      profiles[studentId]?.status!=='approved')throw new FakeError('permission-denied','Current student access missing')
    return true
  }
  const service=createMockWritingReviewService({db,HttpsError:FakeError,
    requireAssignmentManager:async(req)=>{
      const p=profiles[req.auth?.uid]
      if(!p||!['teacher','admin'].includes(p.role)||p.status!=='approved')throw new FakeError('permission-denied','No active manager')
      return {uid:req.auth.uid,profile:p}
    },
    requireCurrentTeacherAcademicStudent:membership,
    findCurrentSubmissionRecord:async(c,studentId,mockTestId)=>{
      if(c!=='mock'||studentId!==STUDENT||mockTestId!=='mockA')return null
      const ref=db.doc(SPATH),snap=await db.get(ref)
      return snap.exists?{ref,id:ref.id,data:snap.data()}:null
    },
    submissionContentConfigFor:type=>type,
    matchingCurrentMockScoreForStats:async(studentId,mockTestId,schoolId,current)=>{
      const ref=db.doc(SCORE), snap=await db.get(ref)
      if(snap.exists)return snap
      const legacyRef=db.doc('scores/legacy_1'), legacySnap=await db.get(legacyRef)
      return legacySnap.exists?legacySnap:null
    },
    schoolIdOf:d=>d.schoolId||'maxima'
  })
  const request=(overrides={})=>({auth:uid===null?null:{uid},data:{
    studentId:STUDENT,mockTestId:'mockA',submissionId:SID,attemptNumber:1,
    submittedAt:STAMP,review:review(),...overrides
  }})
  return {db,service,request,profiles,access}
}
async function denied(work,code){await assert.rejects(work,err=>err.code===code)}

test('review schema strict and inherited/AI fields rejected',()=>{
  assert.equal(validateReview(review()),true)
  for(const fn of [
    p=>p.aiEstimatedBand=9,
    p=>p.rubric.task1.aiEstimatedBand=9,
    p=>p.rubric.task1.taskAchievement='99',
    p=>p.rubric.task2.taskResponse={band:7},
    p=>p.overall='9.5',
    p=>p.task1Feedback='x'.repeat(12001),
    p=>{p.task1Enabled=false;p.task2Enabled=false}
  ]){const r=review();fn(r);assert.equal(validateReview(r),false)}
})

test('Task-1-only and Task-2-only forms accept empty disabled rubric',()=>{
  for(const task of ['task1','task2']){
    const r=review();r[task+'Enabled']=false;r[task+'Band']='';r.rubric[task]={}
    assert.equal(validateReview(r),true,'Disabled '+task+' should match Dashboard')
    r.rubric[task].aiEstimatedBand=9
    assert.equal(validateReview(r),false,'Injected AI in disabled rubric is denied')
  }
})

test('current teacher review writes only human fields and derived overall atomically',async()=>{
  const k=kit(),s0=clone(k.db.data.get(SPATH)),score0=clone(k.db.data.get(SCORE))
  const result=await k.service(k.request())
  assert.equal(result.ok,true)
  const s=k.db.data.get(SPATH),sc=k.db.data.get(SCORE)
  assert.deepEqual(s.result.reading,s0.result.reading)
  assert.deepEqual(s.result.listening,s0.result.listening)
  assert.equal(s.result.writing.aiEvaluationId,'AI-SERVER-001')
  assert.equal(s.result.writing.aiEstimatedBand,6.5)
  assert.deepEqual(s.result.writing.aiFeedback,{summary:'AI report'})
  assert.equal(s.result.writing.aiCreditsUsed,2)
  assert.equal(s.result.writing.band,'7.5')
  assert.equal(s.result.writing.effectiveBand,7.5)
  assert.equal(s.result.writing.effectiveBandSource,'teacher')
  assert.equal(s.result.overall,7)
  assert.equal(s.writingReview.overall,'7.5')
  assert.equal(s.reviewedBy,TEACHER)
  assert.equal(sc.reading,score0.reading)
  assert.equal(sc.listening,score0.listening)
  assert.equal(sc.gradedByServer,score0.gradedByServer)
  assert.equal(sc.aiEstimatedWritingBand,score0.aiEstimatedWritingBand)
  assert.equal(sc.teacherId,OLD)
  assert.equal(sc.writing,'7.5')
  assert.equal(sc.overall,7)
  assert.equal(sc.updatedBy,TEACHER)
})

test('teacher review can be revised and AI data remains untouched',async()=>{
  const k=kit();await k.service(k.request())
  const r=review();r.overall='8.0';r.generalFeedback='Edited by teacher'
  await k.service(k.request({review:r}))
  assert.equal(k.db.data.get(SPATH).result.writing.band,'8.0')
  assert.equal(k.db.data.get(SPATH).result.writing.aiEvaluationId,'AI-SERVER-001')
  assert.equal(k.db.data.get(SCORE).writing,'8.0')
})

test('current transferred teacher allowed, old teacher rejected',async()=>{
  const k=kit();await k.service(k.request())
  const old=kit({uid:OLD})
  await denied(old.service(old.request()),'permission-denied')
})

test('revocation between preflight and transaction aborts all writes',async()=>{
  const k=kit({mutateBeforeTxn:({access})=>{access[TEACHER]=[]}})
  const before=clone(Object.fromEntries(k.db.data))
  await denied(k.service(k.request()),'permission-denied')
  assert.deepEqual(Object.fromEntries(k.db.data),before)
})

test('student and unauthenticated caller denied',async()=>{
  for(const uid of [STUDENT,null]){
    const k=kit({uid});await denied(k.service(k.request()),'permission-denied')
  }
})

test('invalid payload, client AI fields, invalid grade rejected',async()=>{
  for(const p of [
    {other:true},
    {review:{...review(),aiEvaluationId:'fake'}},
    {review:{...review(),overall:'9.5'}},
    {review:{...review(),rubric:{...rubric(),ai:'attacker'}}},
    {review:{...review(),task1Feedback:5}},
    {attemptNumber:2},
    {submittedAt:'2001-01-01T00:00:00.000Z'},
    {submissionId:'another_submission'}
  ]){
    const k=kit();await assert.rejects(k.service(k.request(p)))
    assert.deepEqual(k.db.data.get(SPATH),seed()[SPATH])
  }
})

test('Mock without writing, changed attempt, changed school and deleted result denied',async()=>{
  for(const mutation of [
    s=>s.enabledSections.writing=false,
    s=>s.status='deleted',
    s=>s.attemptNumber=2,
    s=>s.schoolId='other',
    s=>delete s.result.writing
  ]){
    const k=kit();mutation(k.db.data.get(SPATH));await assert.rejects(k.service(k.request()))
  }
})

test('missing canonical score first created from server evidence',async()=>{
  const k=kit({withoutScore:true});await k.service(k.request())
  const s=k.db.data.get(SCORE)
  assert.equal(s.createdAt,STAMP)
  assert.equal(s.source,'mock_test')
  assert.equal(s.aiEstimatedWritingBand,6.5)
  assert.equal(s.reading,6.5)
  assert.equal(s.teacherId,OLD)
  assert.equal(s.writing,'7.5')
})

test('unique legacy score updated in place without duplicate canonical score',async()=>{
  const k=kit({legacy:true});await k.service(k.request())
  assert.equal(k.db.data.has(SCORE),false)
  assert.equal(k.db.data.get('scores/legacy_1').writing,'7.5')
  assert.equal(k.db.data.get('scores/legacy_1').teacherId,OLD)
})

test('stale score attempt or provenance refused without partial writing',async()=>{
  for(const mutation of [
    s=>s.attemptNumber=3,
    s=>s.createdAt='2020-01-01T00:00:00.000Z',
    s=>s.studentId='someone_else',
    s=>s.schoolId='other',
    s=>s.mockTestId='different'
  ]){
    const k=kit();mutation(k.db.data.get(SCORE))
    const prior=clone(k.db.data.get(SPATH))
    await denied(k.service(k.request()),'aborted')
    assert.deepEqual(k.db.data.get(SPATH),prior)
  }
})

test('staff admin allowed for support review without academic index',async()=>{
  const k=kit({uid:ADMIN})
  const result=await k.service(k.request())
  assert.equal(result.ok,true)
  assert.equal(k.db.data.get(SPATH).reviewedBy,ADMIN)
})

test('client server computes overall excluding disabled objective sections',()=>{
  const s=seed()[SPATH];s.enabledSections.listening=false
  assert.equal(computeOverall(s,s.result,7.5),7)
  s.enabledSections.reading=false
  assert.equal(computeOverall(s,s.result,7.5),7.5)
})
