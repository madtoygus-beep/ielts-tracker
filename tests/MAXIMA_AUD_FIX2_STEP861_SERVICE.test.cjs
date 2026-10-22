'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {createWritingReviewSecureService}=require('../functions/lib/p0bWritingReviewSecureService')

const TEACHER='audfix2-teacher', STUDENT='audfix2-student'
const submittedAt='2026-10-22T08:00:00.000Z'
const review={task1Enabled:true,task2Enabled:true,task1Band:'6.5',task2Band:'7.0',
  rubric:{task1:{taskAchievement:'6.5',coherenceCohesion:'6.5',lexicalResource:'6.5',grammarRangeAccuracy:'6.5'},
    task2:{taskResponse:'7.0',coherenceCohesion:'7.0',lexicalResource:'7.0',grammarRangeAccuracy:'7.0'}},
  task1Feedback:'Good',task2Feedback:'Good',overall:'7.0',generalFeedback:'Good'}
const payload=()=>({studentId:STUDENT,writingId:'writing-a',submissionId:'attempt-1',attemptNumber:1,submittedAt,review})
class HttpsError extends Error { constructor(code,message){ super(message); this.code=code }}
function fixture({userRole='teacher',authorised=true,attrs={},actorArchived=false}={}){
  let record={uid:STUDENT,studentId:STUDENT,schoolId:'maxima',writingId:'writing-a',
    status:'submitted',submittedAt,attemptNumber:1,answers:{task1:'original'},
    aiReviewChoice:'teacher',aiBillingMode:'none',aiEstimatedBand:null,...attrs}
  const log={writes:[],membershipCalls:0}
  const transaction={get:async()=>({exists:true,data:()=>structuredClone(record)}),
    update:(ref,change)=>{log.writes.push({ref,change}); record={...record,...change}}}
  const db={doc:path=>({path}),runTransaction:async callback=>callback(transaction)}
  const manager={uid:TEACHER,profile:{role:userRole,archived:actorArchived}}
  const requireAssignmentManager=async()=>{
    if(actorArchived) throw new HttpsError('permission-denied','Archived teacher')
    return manager
  }
  const requireCurrentTeacherAcademicStudent=async({tx,manager:actual,studentId,schoolId})=>{
    log.membershipCalls++
    assert.equal(tx,transaction)
    assert.equal(actual.uid,TEACHER)
    assert.equal(studentId,STUDENT)
    assert.equal(schoolId,'maxima')
    if(!authorised) throw new HttpsError('permission-denied','Current class revoked')
  }
  const service=createWritingReviewSecureService({db,HttpsError,requireAssignmentManager,
    requireCurrentTeacherAcademicStudent,schoolIdOf:v=>v.schoolId||'maxima',now:()=> '2026-10-22T10:00:00.000Z'})
  return {service,log,record:()=>record}
}

test('01: teacher review is server-attributed and attempt + AI payload unchanged',async()=>{
  const x=fixture()
  const r=await x.service({data:payload()})
  assert.equal(r.ok,true)
  assert.equal(x.log.writes.length,1)
  assert.equal(x.log.membershipCalls,1)
  assert.equal(x.log.writes[0].ref.path,'writingSubmissions/attempt-1')
  assert.deepEqual(Object.keys(x.log.writes[0].change).sort(),['review','reviewed','reviewedAt','reviewedBy'])
  assert.equal(x.record().reviewedBy,TEACHER)
  assert.equal(x.record().reviewedAt,'2026-10-22T10:00:00.000Z')
  assert.equal(x.record().aiBillingMode,'none')
  assert.equal(x.record().answers.task1,'original')
})
test('02: malicious extra field or malformed review is rejected before writes',async()=>{
  const x=fixture()
  for(const bad of [{...payload(),reviewedBy:'someone-else'},
    {...payload(),review:{...review,extra:'yes'}},
    {...payload(),review:{...review,overall:12}},
    {...payload(),studentId:'../bad'}]){
    await assert.rejects(x.service({data:bad}),{code:'invalid-argument'})
  }
  assert.equal(x.log.writes.length,0)
})
test('03: teacher whose class membership was revoked cannot write',async()=>{
  const x=fixture({authorised:false})
  await assert.rejects(x.service({data:payload()}),{code:'permission-denied'})
  assert.equal(x.log.writes.length,0)
})
test('04: stale attempt number, submittedAt and student identity denied',async()=>{
  const x=fixture()
  for(const changed of [{attemptNumber:2},{submittedAt:'2026-10-01T00:00:00Z'},
      {studentId:'another'}]){
    await assert.rejects(x.service({data:{...payload(),...changed}}),{code:'failed-precondition'})
  }
  assert.equal(x.log.writes.length,0)
})
test('05: historical legacy attempt missing studentId still works',async()=>{
  const x=fixture({attrs:{studentId:undefined,attemptNumber:undefined}})
  const r=await x.service({data:payload()})
  assert.equal(r.ok,true)
  assert.equal(x.log.writes.length,1)
})
test('06: cross-school, archived or invalid submission are denied',async()=>{
  for(const attrs of [{schoolId:'other'}, {archived:true},
    {status:'draft'}, {deleted:true}, {writingId:'different'},
    {uid:'other',studentId:STUDENT}]){
    const x=fixture({attrs})
    await assert.rejects(x.service({data:payload()}))
    assert.equal(x.log.writes.length,0)
  }
})
test('07: admin role and archived teacher are denied',async()=>{
  for(const opt of [{userRole:'admin'},{actorArchived:true}]){
    const x=fixture(opt)
    await assert.rejects(x.service({data:payload()}),{code:'permission-denied'})
    assert.equal(x.log.writes.length,0)
  }
})
test('08: repeated teacher edit changes only four review fields, never bills AI',async()=>{
  const x=fixture()
  await x.service({data:payload()})
  await x.service({data:{...payload(),review:{...review,generalFeedback:'Revised'}}})
  assert.equal(x.log.writes.length,2)
  assert.equal(x.record().review.generalFeedback,'Revised')
  assert.equal(x.record().aiBillingMode,'none')
  assert.equal(x.record().attemptNumber,1)
})
