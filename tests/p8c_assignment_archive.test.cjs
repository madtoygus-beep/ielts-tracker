'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseChanges, createP8CAssignmentService } = require('../functions/lib/p8cAssignmentService')
const { createP8CArchiveService } = require('../functions/lib/p8cArchiveService')

class TestError extends Error { constructor(code, message) { super(message); this.code = code } }
const clone = obj => structuredClone(obj)
class FakeSnap {
  constructor(id, data) { this.id=id; this.exists=data!==undefined; this.value=data===undefined?undefined:clone(data) }
  data() { return clone(this.value) }
}
class FakeDB {
  constructor(docs={}) { this.docs=new Map(Object.entries(clone(docs))); this.version=new Map() }
  doc(path) { return { path, id: path.split('/').at(-1) } }
  get(path) { return new FakeSnap(path.split('/').at(-1),this.docs.get(path)) }
  collection(name) {
    return { where: (field, op, value) => {
      assert.equal(op,'==')
      const filters=[[field,value]]
      const query={ where(k,o,v){assert.equal(o,'=='); filters.push([k,v]); return query},
        get: async () => ({docs:[...this.docs.entries()].filter(([path,doc])=>
          path.startsWith(`${name}/`) && path.split('/').length===2 &&
          filters.every(([key,expected])=>doc[key]===expected)).map(([path,doc])=>
            new FakeSnap(path.split('/').at(-1),doc))}) }
      return query
    } }
  }
  async getAll(...refs) { return refs.map(ref=>this.get(ref.path)) }
  async runTransaction(callback) {
    for (let tries=0;tries<6;tries++) {
      const reads=new Map(), actions=[]
      const tx={
        get: async ref => { const path=ref.path; reads.set(path,this.version.get(path)||0); return this.get(path) },
        set:(ref,data,{merge}={})=>actions.push({kind:'set',path:ref.path,data,merge}),
        update:(ref,data)=>actions.push({kind:'update',path:ref.path,data})
      }
      const result=await callback(tx)
      if ([...reads].some(([path,ver])=>(this.version.get(path)||0)!==ver)) continue
      for (const action of actions) {
        const prev=this.docs.get(action.path) || {}
        this.docs.set(action.path,clone(action.merge||action.kind==='update' ? {...prev,...action.data}:action.data))
        this.version.set(action.path,(this.version.get(action.path)||0)+1)
      }
      return result
    }
    throw new TestError('aborted','Transaction conflicted')
  }
}
const SOURCE='writingHomeworks/Homework01'
const MANAGER='Teacher0001'
const ADMIN='Admin00001'
const STUDENT1='Student0001'
const STUDENT2='Student0002'
const SCHOOL='maxima'
const accessPath=(uid,type='writing',id='Homework01')=>`studentAccess/${uid}_${type}_${id}`
const sourceDoc={schoolId:SCHOOL,createdBy:MANAGER,teacherId:MANAGER,teacherIds:[MANAGER],archived:false}
const access=uid=>({uid,schoolId:SCHOOL,contentType:'writing',contentId:'Homework01',sourceCollection:'writingHomeworks',accessType:'assignment',status:'active'})
const student=uid=>({role:'student',status:'approved',accountType:'institution',schoolId:SCHOOL,uid})
const fixture=(overrides={})=>new FakeDB({
  [SOURCE]:sourceDoc,
  [`users/${MANAGER}`]:{role:'teacher',status:'approved',schoolId:SCHOOL,accountType:'institution'},
  [`users/${ADMIN}`]:{role:'admin',status:'approved',schoolId:SCHOOL},
  [`users/${STUDENT1}`]:student(STUDENT1),
  [`users/${STUDENT2}`]:student(STUDENT2),
  [`schools/${SCHOOL}`]:{status:'active'},
  ...overrides
})
const managerReq=(changes,owner=MANAGER)=>({auth:{uid:owner},data:{contentType:'writing',contentId:'Homework01',changes}})
const grant=(uid,manager=MANAGER)=>({grantedBy:manager,grantedAtMs:10000})
const policy=(uids)=>({
  schemaVersion:2,schoolId:SCHOOL,sourceCollection:'writingHomeworks',contentId:'Homework01',contentType:'writing',
  studentIds:uids,enabled:uids.length>0,grants:Object.fromEntries(uids.map(uid=>[uid,grant(uid)]))
})
function svc(db) {
  return createP8CAssignmentService({db,
    FieldValue:{serverTimestamp:()=> '2026-10-20T00:00:00Z'},HttpsError:TestError,
    requireAssignmentManager:async req=>({uid:req.auth.uid,profile:db.get(`users/${req.auth.uid}`).data()}),
    managerCanManageSource:(manager,source)=>manager.profile.role==='admin'||source.teacherId===manager.uid,
    schoolIdOf:doc=>doc?.schoolId||SCHOOL,
    accountTypeOf:doc=>doc?.accountType || 'institution',
    studentAccessPayload:(type,col,id,source,uid)=>({uid,schoolId:source.schoolId,contentType:type,contentId:id,
      sourceCollection:col,accessType:'assignment',status:source.archived?'inactive':'active',updatedAt:'timestamp'}),
    studentAccessId:(uid,type,id)=>`${uid}_${type}_${id}`
  })
}
const add=uid=>({studentId:uid,assigned:true,expectedAssigned:false})
const remove=uid=>({studentId:uid,assigned:false,expectedAssigned:true})

test('P8C-01 rejects stale legacy full-list writers without touching any access',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:access(STUDENT1)})
  await assert.rejects(svc(db).write({auth:{uid:MANAGER},data:{contentType:'writing',contentId:'Homework01',studentIds:[]}}),{code:'invalid-argument'})
  assert.equal(db.get(accessPath(STUDENT1)).data().accessType,'assignment')
})
test('P8C-02 two disjoint adds cannot drop one another',async()=>{
  const db=fixture(); const s=svc(db)
  await Promise.all([s.write(managerReq([add(STUDENT1)])),s.write(managerReq([add(STUDENT2)]))])
  assert.equal(db.get(accessPath(STUDENT1)).data().accessType,'assignment')
  assert.equal(db.get(accessPath(STUDENT2)).data().accessType,'assignment')
})
test('P8C-03 stale remove rejects and leaves another student intact',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:access(STUDENT1),[accessPath(STUDENT2)]:access(STUDENT2)})
  await svc(db).write(managerReq([remove(STUDENT1)]))
  await assert.rejects(svc(db).write(managerReq([remove(STUDENT1)])),{code:'failed-precondition'})
  assert.equal(db.get(accessPath(STUDENT2)).data().accessType,'assignment')
})
test('P8C-04 unassignment retains inactive archive tombstone and admin hide',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:{...access(STUDENT1),adminHidden:true}})
  await svc(db).write(managerReq([remove(STUDENT1)]))
  const saved=db.get(accessPath(STUDENT1)).data()
  assert.equal(saved.accessType,'unassigned_archive'); assert.equal(saved.status,'inactive')
  assert.equal(saved.adminHidden,true); assert.equal(saved.unassignedBy,MANAGER)
})
test('P8C-05 reassignment preserves independent admin hide',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:{...access(STUDENT1),adminHidden:true,accessType:'unassigned_archive',status:'inactive'}})
  await svc(db).write(managerReq([add(STUDENT1)]))
  const saved=db.get(accessPath(STUDENT1)).data()
  assert.equal(saved.accessType,'assignment'); assert.equal(saved.status,'inactive'); assert.equal(saved.adminHidden,true)
})
test('P8C-06 sponsor grant is pruned atomically for removed student alone',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:access(STUDENT1),[accessPath(STUDENT2)]:access(STUDENT2),
    'aiWritingSponsoredPolicies/writing_Homework01':policy([STUDENT1,STUDENT2])})
  const out=await svc(db).write(managerReq([remove(STUDENT1)]))
  const p=db.get('aiWritingSponsoredPolicies/writing_Homework01').data()
  assert.equal(out.sponsoredGrantsPruned,true); assert.deepEqual(p.studentIds,[STUDENT2]); assert.equal(p.grants[STUDENT1],undefined)
  assert.deepEqual(p.grants[STUDENT2],grant(STUDENT2))
})
test('P8C-07 single last sponsored grant revocation disables funding',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:access(STUDENT1),
    'aiWritingSponsoredPolicies/writing_Homework01':policy([STUDENT1])})
  await svc(db).write(managerReq([remove(STUDENT1)]))
  const p=db.get('aiWritingSponsoredPolicies/writing_Homework01').data()
  assert.equal(p.enabled,false); assert.deepEqual(p.studentIds,[])
})
test('P8C-08 invalid policy fails closed without removing assignment',async()=>{
  const bad=policy([STUDENT1]); bad.grants={}
  const db=fixture({[accessPath(STUDENT1)]:access(STUDENT1),
    'aiWritingSponsoredPolicies/writing_Homework01':bad})
  await assert.rejects(svc(db).write(managerReq([remove(STUDENT1)])),{code:'failed-precondition'})
  assert.equal(db.get(accessPath(STUDENT1)).data().accessType,'assignment')
})
test('P8C-09 different-school and B2C student cannot be added',async()=>{
  for (const wrong of [{...student(STUDENT1),schoolId:'elsewhere'},
    {...student(STUDENT1),accountType:'individual'}]) {
    const db=fixture({[`users/${STUDENT1}`]:wrong})
    await assert.rejects(svc(db).write(managerReq([add(STUDENT1)])),{code:'failed-precondition'})
    assert.equal(db.get(accessPath(STUDENT1)).exists,false)
  }
})
test('P8C-10 inactive teacher or mismatched manager cannot alter assignment',async()=>{
  const db=fixture({[`users/${MANAGER}`]:{role:'teacher',status:'archived',schoolId:SCHOOL}})
  await assert.rejects(svc(db).write(managerReq([add(STUDENT1)])),{code:'permission-denied'})
})
test('P8C-11 admin can manage authorized source but student must be in school',async()=>{
  const db=fixture()
  await svc(db).write(managerReq([add(STUDENT1)],ADMIN))
  assert.equal(db.get(accessPath(STUDENT1)).data().accessType,'assignment')
})
test('P8C-12 malformed/duplicate/ambiguous changes are rejected',()=>{
  for (const changes of [[add(STUDENT1),add(STUDENT1)],
    [{studentId:'__proto__',assigned:true,expectedAssigned:false}],
    [{studentId:STUDENT1,assigned:true,expectedAssigned:true}],
    [{studentId:STUDENT1,assigned:'yes',expectedAssigned:false}]]) {
    assert.throws(()=>parseChanges({contentType:'writing',contentId:'Homework01',changes},TestError),{code:'invalid-argument'})
  }
})
test('P8C-13 no-op changes are safe and authorized',async()=>{
  const db=fixture()
  const out=await svc(db).write(managerReq([]))
  assert.equal(out.unchanged,true)
})
test('P8C-14 adding to archived content fails closed',async()=>{
  const db=fixture({[SOURCE]:{...sourceDoc,archived:true}})
  await assert.rejects(svc(db).write(managerReq([add(STUDENT1)])),{code:'failed-precondition'})
})
test('P8C-15 mixed changes commit atomically',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:access(STUDENT1)})
  await svc(db).write(managerReq([remove(STUDENT1),add(STUDENT2)]))
  assert.equal(db.get(accessPath(STUDENT1)).data().accessType,'unassigned_archive')
  assert.equal(db.get(accessPath(STUDENT2)).data().accessType,'assignment')
})

function archiveSvc(db,results={},history=[],aiReader=null) {
  const originalCollection=db.collection.bind(db)
  if(history.length) {
    history.forEach((item,i)=>db.docs.set(`submissionAttemptHistory/history_${i}`,item))
  }
  return createP8CArchiveService({
    db,HttpsError:TestError,
    requireStudent:async req=>({uid:req.auth.uid,schoolId:SCHOOL}),
    schoolIdOf:obj=>obj?.schoolId||SCHOOL,
    getStudentOwnedResultSnapshots:async collection=>(results[collection]||[]).map((data,i)=>({id:`submission_${i}`,data})),
    studentResultSafeBase:(id,data)=>({submittedAt:data.submittedAt, result:data.result||null,
      reviewed:data.reviewed||false,review:data.review||null, status:data.status, task2Answer:undefined}),
    studentResultMatchesOwner:(record,uid,school)=>
      (record.uid===uid||record.studentId===uid) && (!record.uid||record.uid===uid) &&
      (!record.studentId||record.studentId===uid) && (record.schoolId||SCHOOL)===school,
    studentAttemptHistoryMatches:(config,h,uid,school)=>
      h.uid===uid&&h.studentId===uid&&(h.schoolId||SCHOOL)===school&&
      h.contentType===config.contentType&&h.sourceCollection===config.sourceCollection&&
      h.submissionCollection===config.submissionCollection,
    studentScoreContentId:d=>d.source==='mock_test'?d.mockTestId:'',
    readSavedWritingAi:aiReader
  })
}
const archivedAccess={...access(STUDENT1),accessType:'unassigned_archive',status:'inactive'}
const submitted={uid:STUDENT1,studentId:STUDENT1,schoolId:SCHOOL,writingId:'Homework01',
  submittedAt:'2026-10-20T00:00:00Z',task2Answer:'SECRET ANSWER',result:{band:7}}
const archiveReq={auth:{uid:STUDENT1},data:{contentType:'writing'}}
test('P8C-16 archived submitted result is available as answer-free summary',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:archivedAccess})
  const response=await archiveSvc(db,{writingSubmissions:[submitted]}).list(archiveReq)
  assert.equal(response.items.length,1)
  assert.equal(response.items[0].result.band,7)
  assert.equal(JSON.stringify(response).includes('SECRET ANSWER'),false)
})
test('P8C-17 no archived access never exposes any submission',async()=>{
  const db=fixture()
  const result=await archiveSvc(db,{writingSubmissions:[submitted]}).list(archiveReq)
  assert.deepEqual(result.items,[])
})
test('P8C-18 another student cannot access the archive',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:archivedAccess})
  const result=await archiveSvc(db,{writingSubmissions:[submitted]}).list({auth:{uid:STUDENT2},data:{contentType:'writing'}})
  assert.deepEqual(result.items,[])
})
test('P8C-19 admin-hidden archive is not shown',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:{...archivedAccess,adminHidden:true}})
  const result=await archiveSvc(db,{writingSubmissions:[submitted]}).list(archiveReq)
  assert.deepEqual(result.items,[])
})
test('P8C-20 school-archived source remains hidden',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:archivedAccess,[SOURCE]:{...sourceDoc,archived:true}})
  const result=await archiveSvc(db,{writingSubmissions:[submitted]}).list(archiveReq)
  assert.deepEqual(result.items,[])
})
test('P8C-21 no submitted timestamp or result cannot create phantom history',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:archivedAccess})
  const result=await archiveSvc(db,{writingSubmissions:[{...submitted,submittedAt:null,result:null,status:'draft'}]}).list(archiveReq)
  assert.deepEqual(result.items,[])
})
test('P8C-22 cross-school source remains hidden',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:archivedAccess,[SOURCE]:{...sourceDoc,schoolId:'other'}})
  const result=await archiveSvc(db,{writingSubmissions:[submitted]}).list(archiveReq)
  assert.deepEqual(result.items,[])
})
test('P8C-23 invalid archive category is rejected',async()=>{
  const db=fixture()
  await assert.rejects(archiveSvc(db).list({auth:{uid:STUDENT1},data:{contentType:'scores'}}),{code:'invalid-argument'})
})
test('P8C-24 immutable attempt summary requires matching source and student',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:archivedAccess})
  const goodHistory={uid:STUDENT1,studentId:STUDENT1,schoolId:SCHOOL,contentId:'Homework01',
    contentType:'writing',sourceCollection:'writingHomeworks',submissionCollection:'writingSubmissions',
    attemptNumber:2,submissionSnapshot:{...submitted,submittedAt:'2026-10-19T00:00:00Z'}}
  const badHistory={...goodHistory,attemptNumber:3,submissionSnapshot:{...submitted,studentId:STUDENT2}}
  const result=await archiveSvc(db,{},[goodHistory,badHistory]).list(archiveReq)
  assert.equal(result.items.length,1)
  assert.equal(result.items[0].attemptNumber,2)
})

test('P8C-25 saved verified AI headline is read-only and contains no report text',async()=>{
  const db=fixture({[accessPath(STUDENT1)]:archivedAccess})
  let reads=0
  const readSaved=async ({student,contentId,submissionId})=>{
    reads++; assert.equal(student.uid,STUDENT1)
    assert.equal(contentId,'Homework01');assert.equal(submissionId,'submission_0')
    return {status:'completed',estimatedBand:7.5,feedbackOnly:false,report:{private:'HIDDEN'}}
  }
  const out=await archiveSvc(db,{writingSubmissions:[submitted]},[],readSaved).list(archiveReq)
  assert.equal(reads,1)
  assert.equal(out.items[0].aiEstimatedBand,7.5)
  assert.equal(JSON.stringify(out).includes('HIDDEN'),false)
})
