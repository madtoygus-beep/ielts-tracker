'use strict'
// P8-B1/B2 regression: all Firestore state is in memory, provider is a stub.
// No network, student data, credits, paid AI, or production access.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAiWritingSponsoredPolicyService } = require('../functions/lib/aiWritingSponsoredPolicy')
const { createAiWritingSponsoredEvaluationService } = require('../functions/lib/aiWritingSponsoredEvaluation')
const { createAiWritingSubmissionChoiceService } = require('../functions/lib/aiWritingSubmissionChoice')
const { grantForStudent } = require('../functions/lib/aiWritingSponsoredGrants')
const { createHash } = require('crypto')
class AuthError extends Error { constructor(code, message) { super(message); this.code = code } }
const A = 'studentAAA', B = 'studentBBB', C = 'studentCCC',
  T = 'teacherAAA', ADMIN = 'admin00001', W = 'writingAAA', M = 'mocktestAAA'
const submittedAt = '2026-10-18T10:00:00.000Z'
const grantBefore = Date.parse('2026-10-18T09:00:00.000Z')
const when = { toMillis: () => grantBefore }
const FieldValue = { serverTimestamp: () => when }
const schoolIdOf = d => d?.schoolId || 'maxima'
const accountTypeOf = d => d?.accountType || 'institution'
const essay = n => Array.from({length:n}, (_, i) => `word${i}`).join(' ')
function validReport(context = 'homework') {
  const r = {band:6, explanation:'ok', evidence:''}
  return { isAiEstimate:true, teacherFinalScore:null,
    context, writingMode:'task2_only', isProvisionalMockEstimate:context==='mock',
    task1:null, task2:{wordCount:300, feedbackOnly:false, estimatedBand:6,
      criteria:{taskAchievementOrResponse:r, coherenceAndCohesion:r, lexicalResource:r, grammaticalRangeAndAccuracy:r}},
    estimatedBand:6, feedbackOnly:false }
}
function fakeDb(initial) {
  const docs = new Map(Object.entries(initial)), writes = []
  const snap = (p, data) => ({exists:data !== undefined, id:p.split('/').pop(), data:()=>data, ref:ref(p)})
  function ref(p) {return {path:p, id:p.split('/').pop(), get:async()=>snap(p, docs.get(p))}}
  const db = {docs, writes, doc:ref,
    collection:c=>({where:(field, op, value)=>({get:async()=>({docs:[...docs.entries()]
      .filter(([key, v])=>key.startsWith(c+'/') && key.split('/').length===2 && v[field]===value)
      .map(([key, v])=>snap(key,v))})})}),
    getAll:async (...refs)=>Promise.all(refs.map(x=>x.get())),
    runTransaction: async fn=>{
      const pending=[]
      const tx={get:r=>r.get(),
        create:(r,v)=>pending.push({type:'create',p:r.path,v}),
        update:(r,v)=>pending.push({type:'update',p:r.path,v}),
        set:(r,v,opts)=>pending.push({type:opts?.merge?'merge':'set',p:r.path,v})}
      const result=await fn(tx)
      for (const op of pending) {
        if (op.type==='create') assert(!docs.has(op.p), `Unexpected duplicate ${op.p}`)
        if (op.type==='update') assert(docs.has(op.p), `Unexpected missing ${op.p}`)
        docs.set(op.p,['update','merge'].includes(op.type)?{...docs.get(op.p),...op.v}:op.v)
        writes.push(op.p)
      }
      return result
    }
  }
  return db
}
const staff = role=>({role,status:'approved',accountType:'institution',schoolId:'maxima'})
const student = () => staff('student')
function policy(ids, grants = null) {
  const out = {schoolId:'maxima',enabled:ids.length>0,billing:'institution',
    context:'homework',contentId:W,contentType:'writing',sourceCollection:'writingHomeworks',
    studentIds:ids,updatedBy:ADMIN,updatedAt:when}
  if (grants) {out.schemaVersion=2;out.grants=grants}
  return out
}
function world({oldPolicy=null, mock=false}={}) {
  const grants = {[A]:{grantedBy:ADMIN,grantedAtMs:grantBefore},
    [B]:{grantedBy:ADMIN,grantedAtMs:grantBefore}}
  const records={
    [`users/${A}`]:student(),[`users/${B}`]:student(),[`users/${C}`]:student(),
    [`users/${T}`]:staff('teacher'),[`users/${ADMIN}`]:staff('admin'),
    'schools/maxima':{status:'active'},
    'aiWritingSchoolSettings/maxima':{schoolId:'maxima',pilotEnabled:true},
    [`writingHomeworks/${W}`]:{schoolId:'maxima',teacherId:T,teacherIds:[T],
      contentType:'task2_only',task2:{prompt:'Your thoughts?'}},
    'classes/active':{teacherId:T,schoolId:'maxima',status:'active',name:'Group A',studentIds:[A,C]},
    [`aiWritingSponsoredPolicies/writing_${W}`]:oldPolicy || policy([A,B],grants),
    [`writingSubmissions/${A}_${W}`]:{
      uid:A,studentId:A,schoolId:'maxima',writingId:W,attemptNumber:1,submittedAt,
      writingMode:'task2_only',task1Answer:'',task2Answer:essay(300),
      aiReviewChoice:'ai',aiBillingMode:'institution'
    }
  }
  for (const uid of [A,B,C]) records[`studentAccess/${uid}_writing_${W}`]={
    uid,schoolId:'maxima',contentType:'writing',contentId:W,
    sourceCollection:'writingHomeworks',accessType:'assignment',status:'active'
  }
  if (mock) {
    records[`mockTests/${M}`]={schoolId:'maxima',teacherId:T,teacherIds:[T],writingId:W,
      enabledSections:{writing:true}}
    records[`aiWritingSponsoredPolicies/mock_${M}`]={...policy([A],[A].reduce((v,x)=>(v[x]={grantedBy:ADMIN,grantedAtMs:grantBefore},v),{})),
      contentId:M,contentType:'mock',context:'mock',sourceCollection:'mockTests'}
    records[`mockSubmissions/${A}_${M}`]={uid:A,studentId:A,schoolId:'maxima',mockTestId:M,
      writingId:W,attemptNumber:1,submittedAt,status:'submitted',enabledSections:{writing:true},
      writingMode:'task2_only', writingAnswers:{task1:'',task2:essay(300)}}
    records[`studentAccess/${A}_mock_${M}`]={uid:A,schoolId:'maxima',contentId:M,
      contentType:'mock',sourceCollection:'mockTests',accessType:'assignment',status:'active'}
  }
  return fakeDb(records)
}
function managerService(db, uid) {
  return createAiWritingSponsoredPolicyService({
    db,FieldValue,HttpsError:AuthError,
    requireAssignmentManager:async()=>({uid,profile:db.docs.get(`users/${uid}`)}),
    managerCanManageSource:(actor,source)=>actor.profile.role==='admin' ||
      source.teacherId===actor.uid || source.teacherIds?.includes(actor.uid),
    schoolIdOf,accountTypeOf,teacherIdsOf:s=>s.teacherIds||[],
    getMockEnabledSections:s=>s.enabledSections || {}
  })
}
const getReq={data:{contentType:'writing',contentId:W}}
const setReq=(ids,enabled=true)=>({data:{...getReq.data,enabled,studentIds:ids}})
function choice(db, uid) {
  return createAiWritingSubmissionChoiceService({db,HttpsError:AuthError,
    requireStudent:async()=>({uid,schoolId:'maxima'}),schoolIdOf,accountTypeOf,
    providerEnabled:()=>true,sponsoredEnabled:()=>true}).getOptionsForStudent({uid,schoolId:'maxima'},W)
}
const sha=v=>createHash('sha256').update(v).digest('hex')
function trigger(db,provider) {
  return createAiWritingSponsoredEvaluationService({
    db,FieldValue,provider,getApiKey:()=> 'sk-test-only-not-a-real-key-000',providerEnabled:()=>true,
    schoolIdOf,getMockEnabledSections:source=>source?.enabledSections||{},
    getMockWritingMode:()=> 'task2_only',
    findCurrentSubmissionRecord:async(config, uid, contentId)=>{
      const context=contentId===M?'mock':'homework'
      const path=context==='mock'?`mockSubmissions/${uid}_${contentId}`:`writingSubmissions/${uid}_${contentId}`
      return {ref:db.doc(path),data:db.docs.get(path)}
    },submissionContentConfigFor:()=>({}),now:()=>Date.parse('2026-10-18T12:00:00Z')
  })
}
function event(db, context='homework') {
  const path=context==='mock'?`mockSubmissions/${A}_${M}`:`writingSubmissions/${A}_${W}`
  return {data:{before:{exists:false},after:{exists:true,ref:db.doc(path),data:()=>db.docs.get(path)}}}
}

test('B1: teacher sees only class grants; saving does not delete an admin grant outside class',async()=>{
  const db=world(), service=managerService(db,T)
  const found=await service.getPolicy(getReq)
  assert.deepEqual(found.studentIds,[A]);assert.equal(found.enabled,true)
  await service.setPolicy(setReq([A,C]))
  const stored=db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`)
  assert.deepEqual(stored.studentIds,[A,B,C])
  assert.deepEqual(stored.grants[B],{grantedBy:ADMIN,grantedAtMs:grantBefore})
  assert.deepEqual(stored.grants[A],{grantedBy:ADMIN,grantedAtMs:grantBefore})
  assert.equal(stored.grants[C].grantedBy,T)
  assert.equal(stored.grants[C].grantedAtMs>0,true)
  assert.equal((await choice(db,B)).institutionFunded,true)
})

test('B1: teacher switching local rights off preserves external admin grant',async()=>{
  const db=world(), service=managerService(db,T)
  await service.setPolicy(setReq([],false))
  const stored=db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`)
  assert.deepEqual(stored.studentIds,[B]);assert.equal(stored.enabled,true)
  assert.equal((await choice(db,A)).institutionFunded,false)
  assert.equal((await choice(db,B)).institutionFunded,true)
  const teacherView=await service.getPolicy(getReq)
  assert.equal(teacherView.enabled,false)
  assert.deepEqual(teacherView.studentIds,[])
})

test('B1: v2 no-op selection does not write or change timestamps; order does not matter',async()=>{
  const db=world(), admin=managerService(db,ADMIN)
  await admin.setPolicy(setReq([C,A,B]))
  const writes=db.writes.length
  const at=db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`).updatedAt
  const out=await admin.setPolicy(setReq([B,C,A]))
  assert.equal(out.unchanged,true);assert.equal(db.writes.length,writes)
  assert.equal(db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`).updatedAt,at)
})

test('B1: teacher cannot add non-class student even if regular homework is assigned',async()=>{
  const db=world(), teacher=managerService(db,T)
  await assert.rejects(teacher.setPolicy(setReq([B])),err=>err.code==='permission-denied')
  assert.equal(db.writes.length,0)
})

test('B1: a read-only legacy grant continues to work and converts to per-student grants on write',async()=>{
  const db=world({oldPolicy:policy([A,B])})
  assert.equal((await choice(db,B)).institutionFunded,true)
  await managerService(db,T).setPolicy(setReq([A,C]))
  const pol=db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`)
  assert.equal(pol.schemaVersion,2)
  assert.deepEqual(pol.grants[B],{grantedBy:ADMIN,grantedAtMs:grantBefore})
  assert.equal((await choice(db,B)).institutionFunded,true)
})

test('B2: unrelated policy edit during provider call cannot discard paid result',async()=>{
  const db=world();let calls=0
  const service=managerService(db,T)
  const out=await trigger(db,async()=>{
    calls++
    await service.setPolicy(setReq([A,C]))
    return {report:validReport(),model:'local-stub'}
  }).submit('homework',event(db))
  assert.equal(out.status,'completed')
  assert.equal(calls,1)
  const job= db.docs.get(`aiWritingEvaluations/${sha(['ai-writing-v1',A,'homework',W,1].join('\0'))}`)
  assert.equal(job.status,'completed')
  const month=db.docs.get('aiWritingMonthlyUsage/maxima_202610')
  assert.equal(month.pendingCount,0);assert.equal(month.completedCount,1)
  assert.equal(month.requestCount,1)
})

test('B2: direct revocation of the submitting student still blocks settlement',async()=>{
  const db=world()
  const out=await trigger(db,async()=>{
    await managerService(db,ADMIN).setPolicy(setReq([B]))
    return {report:validReport(),model:'local-stub'}
  }).submit('homework',event(db))
  assert.equal(out.status,'failed')
  const month=db.docs.get('aiWritingMonthlyUsage/maxima_202610')
  assert.equal(month.pendingCount,0);assert.equal(month.completedCount,0)
})

test('B2: Mock late grant (after submission) cannot trigger institution spend',async()=>{
  const db=world({mock:true})
  const doc=db.docs.get(`aiWritingSponsoredPolicies/mock_${M}`)
  doc.grants[A].grantedAtMs=Date.parse('2026-10-18T11:00:00Z')
  let calls=0
  const out=await trigger(db,async()=>{calls++}).submit('mock',event(db,'mock'))
  assert.equal(out.status,'ineligible');assert.equal(calls,0)
})

test('B2: a different student Mock grant edit does not change an earlier grant timestamp',async()=>{
  const db=world({mock:true})
  const old=db.docs.get(`aiWritingSponsoredPolicies/mock_${M}`)
  const before=grantForStudent(old,A).grantedAtMs
  await managerService(db,T).setPolicy({data:{contentType:'mock',contentId:M,
    enabled:true,studentIds:[A]}})
  const updated=db.docs.get(`aiWritingSponsoredPolicies/mock_${M}`)
  assert.equal(updated.grants[A].grantedAtMs,before)
  // Original author and grant timestamp have not changed.
  assert.equal(grantForStudent(updated,A).grantedBy,ADMIN)
})

test('B2: Send to Teacher still makes zero provider requests',async()=>{
  const db=world()
  const src=db.docs.get(`writingSubmissions/${A}_${W}`)
  db.docs.set(`writingSubmissions/${A}_${W}`,{...src,aiReviewChoice:'teacher',aiBillingMode:'none'})
  let calls=0
  const out=await trigger(db,async()=>{calls++}).submit('homework',event(db))
  assert.equal(out.status,'ignored');assert.equal(calls,0)
})

test('B1: v2 corrupted grant map is rejected and never expanded',async()=>{
  const db=world()
  db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`).grants[B].grantedBy='__proto__'
  await assert.rejects(managerService(db,T).setPolicy(setReq([A,C])),err=>err.code==='failed-precondition')
  assert.equal((await choice(db,A)).institutionFunded,false)
  assert.equal(db.writes.length,0)
})

test('B2: pre-existing Mock grant still completes after an unrelated manager update',async()=>{
  const db=world({mock:true});let calls=0
  const mockReq={data:{contentType:'mock',contentId:M,enabled:true,studentIds:[A,C]}}
  // Mock additional student assignment is required before it can be funded.
  db.docs.set(`studentAccess/${C}_mock_${M}`,{uid:C,schoolId:'maxima',contentId:M,
    contentType:'mock',sourceCollection:'mockTests',accessType:'assignment',status:'active'})
  const out=await trigger(db,async()=>{
    calls++
    await managerService(db,T).setPolicy(mockReq)
    return {report:validReport('mock'),model:'local-stub'}
  }).submit('mock',event(db,'mock'))
  assert.equal(out.status,'completed');assert.equal(calls,1)
  const policy=db.docs.get(`aiWritingSponsoredPolicies/mock_${M}`)
  assert.equal(policy.grants[A].grantedAtMs,grantBefore)
  assert.equal(policy.grants[C].grantedBy,T)
})

test('B2: deactivated original teacher issuer does not retain spending authority',async()=>{
  const db=world()
  const p=db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`)
  p.grants[A]={grantedBy:T,grantedAtMs:grantBefore}
  db.docs.get(`users/${T}`).status='disabled'
  let calls=0
  const out=await trigger(db,async()=>{calls++}).submit('homework',event(db))
  assert.equal(out.status,'ineligible');assert.equal(calls,0)
})

test('B2: reprocessed event cannot bill same attempt twice',async()=>{
  const db=world();let calls=0
  const run=trigger(db,async()=>{calls++;return {report:validReport(),model:'local-stub'}})
  assert.equal((await run.submit('homework',event(db))).status,'completed')
  const twice=await run.submit('homework',event(db))
  assert.equal(twice.status,'completed');assert.equal(calls,1)
  assert.equal(db.docs.get('aiWritingMonthlyUsage/maxima_202610').requestCount,1)
})

test('B1: 60 total grants is enforced across admin and teacher scopes',async()=>{
  const db=world(),p=db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`)
  const ids=[A,B]
  for (let i=0;i<58;i++) {
    const uid=`external${String(i).padStart(3,'0')}`
    ids.push(uid);db.docs.set(`users/${uid}`,student())
    db.docs.set(`studentAccess/${uid}_writing_${W}`,{uid,schoolId:'maxima',
      contentType:'writing',contentId:W,sourceCollection:'writingHomeworks',
      accessType:'assignment',status:'active'})
    p.grants[uid]={grantedBy:ADMIN,grantedAtMs:grantBefore}
  }
  p.studentIds=ids
  await assert.rejects(managerService(db,T).setPolicy(setReq([A,C])),
    e=>e.code==='resource-exhausted')
  assert.equal(db.writes.length,0)
  assert.equal(db.docs.get(`aiWritingSponsoredPolicies/writing_${W}`).studentIds.length,60)
})

test('B1: legacy Firestore timestamps retain fractional milliseconds',()=>{
  const { timestampMs, grantForStudent } = require('../functions/lib/aiWritingSponsoredGrants')
  const point=grantBefore + 0.375
  assert.equal(timestampMs({toMillis:()=>point}),point)
  const legacy=policy([A]);legacy.updatedAt={toMillis:()=>point}
  assert.equal(grantForStudent(legacy,A).grantedAtMs,point)
})
