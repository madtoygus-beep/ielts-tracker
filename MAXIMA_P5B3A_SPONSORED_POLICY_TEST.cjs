'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createAiWritingSponsoredPolicyService } = require('./functions/lib/aiWritingSponsoredPolicy')

class TestHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

class FakeDb {
  constructor() { this.docs = new Map(); this.writes = [] }
  collection(name) {
    const db = this
    return { where(field, op, value) {
      if (name !== 'classes' || field !== 'teacherId' || op !== '==') {
        throw Error('Unexpected fixture query')
      }
      return { get: async () => ({ docs: [...db.docs.entries()]
        .filter(([p, data]) => p.startsWith('classes/') && data.teacherId === value)
        .map(([p]) => db.snapshot(p)) }) }
    } }
  }
  doc(path) {
    const db = this
    return {
      path,
      id: path.split('/').at(-1),
      get: async () => db.snapshot(path),
      set: async (data, options = {}) => db.put(path, data, options),
      delete: async () => db.docs.delete(path)
    }
  }
  snapshot(path) {
    const exists = this.docs.has(path)
    const data = exists ? structuredClone(this.docs.get(path)) : undefined
    return { exists, data: () => data }
  }
  put(path, data, options = {}) {
    const previous = options.merge ? this.docs.get(path) || {} : {}
    this.docs.set(path, structuredClone({ ...previous, ...data }))
    this.writes.push({ path, data: structuredClone(data) })
  }
  async getAll(...refs) { return Promise.all(refs.map(ref => ref.get())) }
  async runTransaction(fn) {
    const staged = []
    let startedWriting = false
    const tx = {
      get: async ref => {
        if (startedWriting) throw new Error('Firestore forbids read after transaction write')
        return ref.get()
      },
      set: (ref, data, opts) => { startedWriting = true; staged.push({ ref, data, opts }) }
    }
    const result = await fn(tx)
    for (const row of staged) this.put(row.ref.path, row.data, row.opts)
    return result
  }
}

const managerUid = 'teacher123'
const adminUid = 'admin123'
const s1 = 'student001'
const s2 = 'student002'
const s3 = 'student003'
const sourceId = 'wr100'
const mockId = 'mock100'
const writingSourcePath = `writingHomeworks/${sourceId}`
const mockSourcePath = `mockTests/${mockId}`
const accessPath = (uid, type, id) => `studentAccess/${uid}_${type}_${id}`
const policyPath = (type, id) => `aiWritingSponsoredPolicies/${type}_${id}`

function createFixture() {
  const db = new FakeDb()
  const teacher = { role:'teacher',status:'approved',deleted:false,schoolId:'maxima',accountType:'institution' }
  const admin = { role:'admin',status:'approved',deleted:false,schoolId:'maxima',accountType:'institution' }
  db.docs.set(`users/${managerUid}`, structuredClone(teacher))
  db.docs.set(`users/${adminUid}`, structuredClone(admin))
  db.docs.set('schools/maxima', { status:'active' })
  db.docs.set('classes/teacherGroup001', { schoolId:'maxima', name:'IELTS 12', teacherId:managerUid, studentIds:[s1,s2,s3], archived:false })
  db.docs.set(writingSourcePath, {
    title:'Unit 1 Writing',schoolId:'maxima',teacherId:managerUid,
    teacherIds:[managerUid],createdBy:managerUid,contentType:'task2_only'
  })
  db.docs.set(mockSourcePath, {
    title:'IELTS Mock 1',schoolId:'maxima',teacherId:managerUid,
    teacherIds:[managerUid],createdBy:managerUid,writingId:sourceId,
    enabledSections:{listening:true,reading:true,writing:true}
  })
  for (const uid of [s1,s2,s3]) {
    db.docs.set(`users/${uid}`, {
      uid,role:'student',status:'approved',deleted:false,
      schoolId:'maxima',accountType:'institution',teacherIds:[managerUid]
    })
    for (const [type,id,collection] of [
      ['writing',sourceId,'writingHomeworks'],['mock',mockId,'mockTests']
    ]) {
      db.docs.set(accessPath(uid,type,id), {
        uid,contentType:type,contentId:id,schoolId:'maxima',
        sourceCollection:collection,accessType:'assignment',status:'active',adminHidden:false
      })
    }
  }
  const service = createAiWritingSponsoredPolicyService({
    db,FieldValue:{serverTimestamp:()=>({isServerTimestamp:true})},
    HttpsError:TestHttpsError,
    requireAssignmentManager: async request => {
      if (!request.auth?.uid) throw new TestHttpsError('unauthenticated','Sign in')
      const profile = db.docs.get(`users/${request.auth.uid}`)
      if (!profile || !['teacher','admin'].includes(profile.role) || profile.status !== 'approved') {
        throw new TestHttpsError('permission-denied', 'Staff required')
      }
      return {uid:request.auth.uid,profile:structuredClone(profile)}
    },
    managerCanManageSource: (manager,source) => {
      if (manager.profile.role==='admin') return true
      return source.teacherId===manager.uid || source.createdBy===manager.uid ||
        (Array.isArray(source.teacherIds)&&source.teacherIds.includes(manager.uid))
    },
    schoolIdOf: object => object?.schoolId || 'maxima',
    accountTypeOf: object => object?.accountType || 'institution',
    teacherIdsOf: object => object?.teacherIds || [object?.teacherId].filter(Boolean),
    getMockEnabledSections: object => object.enabledSections || {writing:true}
  })
  const call = (data, uid=managerUid) => ({ auth:uid ? {uid}:undefined, data })
  const write = (data, uid=managerUid) => service.setPolicy(call(data,uid))
  const read = (data, uid=managerUid) => service.getPolicy(call(data,uid))
  return {db,service,call,read,write}
}

const policy = (more = {}) => ({contentType:'writing',contentId:sourceId,enabled:true,studentIds:[s1],...more})
const mockPolicy = more => ({contentType:'mock',contentId:mockId,enabled:true,studentIds:[s1],...more})
let total = 0, failed = 0
async function test(name, fn) {
  total++
  try { await fn(); console.log('PASS',name) }
  catch(error) { failed++; console.error('FAIL',name,error.stack || error) }
}
async function denied(promise, code) {
  await assert.rejects(promise, error => error.code === code)
}

;(async()=>{
  await test('Missing policy is disabled and reads without writes',async()=>{
    const f=createFixture(),result=await f.read({contentType:'writing',contentId:sourceId})
    assert.equal(result.enabled,false);assert.deepEqual(result.studentIds,[])
    assert.equal(result.autoEvaluationLive,false);assert.equal(f.db.writes.length,0)
  })
  await test('Teacher enables only selected Writing student',async()=>{
    const f=createFixture(),res=await f.write(policy());assert.equal(res.enabled,true)
    const stored=f.db.docs.get(policyPath('writing',sourceId));
    assert.deepEqual(stored.studentIds,[s1]);assert.equal(stored.billing,'institution')
    assert.equal(stored.context,'homework');assert.equal(res.autoEvaluationLive,false)
  })
  await test('Selected student can be read back only by owning staff',async()=>{
    const f=createFixture();await f.write(policy({studentIds:[s2,s1]}))
    const res=await f.read({contentType:'writing',contentId:sourceId})
    assert.equal(res.enabled,true);assert.deepEqual(res.studentIds,[s1,s2])
  })
  await test('Teacher can configure selected Mock Writing assignment',async()=>{
    const f=createFixture();await f.write(mockPolicy())
    const p=f.db.docs.get(policyPath('mock',mockId));
    assert.equal(p.context,'mock');assert.deepEqual(p.studentIds,[s1])
  })
  await test('No credit and provider interactions occur while storing policy',async()=>{
    const f=createFixture();await f.write(policy())
    assert.deepEqual(f.db.writes.map(x=>x.path),[policyPath('writing',sourceId)])
  })
  await test('Separate Mock and Writing policies never collide',async()=>{
    const f=createFixture();await f.write(policy());await f.write(mockPolicy({studentIds:[s2]}))
    assert.deepEqual(f.db.docs.get(policyPath('writing',sourceId)).studentIds,[s1])
    assert.deepEqual(f.db.docs.get(policyPath('mock',mockId)).studentIds,[s2])
  })
  await test('Idempotent policy write never creates duplicate documents',async()=>{
    const f=createFixture();await f.write(policy());await f.write(policy());
    assert.equal([...f.db.docs.keys()].filter(x=>x===policyPath('writing',sourceId)).length,1)
  })
  await test('Turning policy off with no students is possible',async()=>{
    const f=createFixture();await f.write(policy());await f.write(policy({enabled:false,studentIds:[]}));
    assert.equal((await f.read({contentType:'writing',contentId:sourceId})).enabled,false)
  })
  await test('Selected students may have their policy disabled but retained',async()=>{
    const f=createFixture();await f.write(policy({enabled:false}));
    assert.equal((await f.read({contentType:'writing',contentId:sourceId})).enabled,false)
  })
  await test('Anonymous request is denied',async()=>{
    const f=createFixture();await denied(f.write(policy(),null),'unauthenticated')
  })
  await test('Student cannot impersonate teacher',async()=>{
    const f=createFixture();await denied(f.write(policy(),s1),'permission-denied')
  })
  await test('Cross-school admin cannot configure Maxima',async()=>{
    const f=createFixture();f.db.docs.set(`users/${adminUid}`,{role:'admin',status:'approved',schoolId:'other',accountType:'institution'})
    await denied(f.write(policy(),adminUid),'permission-denied')
  })
  await test('Maxima admin can manage Maxima assignment',async()=>{
    const f=createFixture();const res=await f.write(policy(),adminUid);assert.equal(res.ok,true)
  })
  await test('Other teacher cannot manage resource',async()=>{
    const f=createFixture();const uid='teacher999'
    f.db.docs.set(`users/${uid}`,{role:'teacher',status:'approved',schoolId:'maxima',accountType:'institution'})
    await denied(f.write(policy(),uid),'permission-denied')
  })
  await test('Teacher cannot sponsor a student from another school',async()=>{
    const f=createFixture();f.db.docs.set(`users/${s1}`,{...f.db.docs.get(`users/${s1}`),schoolId:'other'})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Teacher cannot sponsor an individual learner',async()=>{
    const f=createFixture();f.db.docs.set(`users/${s1}`,{...f.db.docs.get(`users/${s1}`),accountType:'individual'})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Unapproved student rejected',async()=>{
    const f=createFixture();f.db.docs.set(`users/${s1}`,{...f.db.docs.get(`users/${s1}`),status:'pending'})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Deleted student rejected',async()=>{
    const f=createFixture();f.db.docs.set(`users/${s1}`,{...f.db.docs.get(`users/${s1}`),deleted:true})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Unassigned student rejected',async()=>{
    const f=createFixture();f.db.docs.delete(accessPath(s1,'writing',sourceId))
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Admin hidden assignment rejected',async()=>{
    const f=createFixture();const p=accessPath(s1,'writing',sourceId)
    f.db.docs.set(p,{...f.db.docs.get(p),adminHidden:true})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Inactive assignment rejected',async()=>{
    const f=createFixture();const p=accessPath(s1,'writing',sourceId)
    f.db.docs.set(p,{...f.db.docs.get(p),status:'inactive'})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Unrelated sourceCollection assignment rejected',async()=>{
    const f=createFixture();const p=accessPath(s1,'mock',mockId)
    f.db.docs.set(p,{...f.db.docs.get(p),sourceCollection:'writingHomeworks'})
    await denied(f.write(mockPolicy()),'permission-denied')
  })
  await test('Teacher cannot select students no longer assigned to teacher',async()=>{
    const f=createFixture();f.db.docs.set('classes/teacherGroup001',{...f.db.docs.get('classes/teacherGroup001'),studentIds:[s2,s3]})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Archived source rejected',async()=>{
    const f=createFixture();f.db.docs.set(writingSourcePath,{...f.db.docs.get(writingSourcePath),archived:true})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Inactive school rejected',async()=>{
    const f=createFixture();f.db.docs.set('schools/maxima',{status:'inactive'})
    await denied(f.write(policy()),'failed-precondition')
  })
  await test('Mock without Writing section rejected',async()=>{
    const f=createFixture();f.db.docs.set(mockSourcePath,{...f.db.docs.get(mockSourcePath),enabledSections:{writing:false}})
    await denied(f.write(mockPolicy()),'failed-precondition')
  })
  await test('Mock linked to a foreign school Writing resource rejected',async()=>{
    const f=createFixture();f.db.docs.set(writingSourcePath,{...f.db.docs.get(writingSourcePath),schoolId:'other'})
    await denied(f.write(mockPolicy()),'failed-precondition')
  })
  await test('Mock linked to archived Writing resource rejected',async()=>{
    const f=createFixture();f.db.docs.set(writingSourcePath,{...f.db.docs.get(writingSourcePath),archived:true})
    await denied(f.write(mockPolicy()),'failed-precondition')
  })
  await test('Duplicate students are rejected',async()=>{
    const f=createFixture();await denied(f.write(policy({studentIds:[s1,s1]})),'invalid-argument')
  })
  await test('Enabled with zero selected students is rejected',async()=>{
    const f=createFixture();await denied(f.write(policy({studentIds:[]})),'invalid-argument')
  })
  await test('Too many selected students rejected',async()=>{
    const f=createFixture();await denied(f.write(policy({studentIds:Array.from({length:61},(_,i)=>`student${String(i).padStart(3,'0')}`)})),'invalid-argument')
  })
  await test('Client cannot inject billing source or free credits',async()=>{
    const f=createFixture();await denied(f.write({...policy(),billing:'student'}),'invalid-argument')
    assert.equal(f.db.writes.length,0)
  })
  await test('Student UID must be a valid Firestore document ID',async()=>{
    const f=createFixture();await denied(f.write(policy({studentIds:['../users/admin']})),'invalid-argument')
  })
  await test('Corrupted stored policy cannot be silently overwritten',async()=>{
    const f=createFixture();f.db.docs.set(policyPath('writing',sourceId),{schoolId:'other'})
    await denied(f.write(policy()),'failed-precondition')
  })
  await test('Malformed student IDs stored in policy fail closed',async()=>{
    const f=createFixture();await f.write(policy())
    const p=policyPath('writing',sourceId)
    f.db.docs.set(p,{...f.db.docs.get(p),studentIds:['../admin']})
    await denied(f.read({contentType:'writing',contentId:sourceId}),'failed-precondition')
  })
  await test('Policy retrieval drops removed/hidden students',async()=>{
    const f=createFixture();await f.write(policy({studentIds:[s1,s2]}))
    const p=accessPath(s2,'writing',sourceId)
    f.db.docs.set(p,{...f.db.docs.get(p),adminHidden:true})
    const res=await f.read({contentType:'writing',contentId:sourceId})
    assert.deepEqual(res.studentIds,[s1])
  })
  await test('Cannot change policy while manager account deactivated',async()=>{
    const f=createFixture();f.db.docs.set(`users/${managerUid}`,{...f.db.docs.get(`users/${managerUid}`),deleted:true})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('Rules deny every browser access to sponsored policy documents',async()=>{
    const rules=fs.readFileSync(path.join(__dirname,'firestore.rules'),'utf8')
    assert.match(rules,/match\s*\/aiWritingSponsoredPolicies\/\{policyId\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false\s*;/)
  })
  await test('School cascade deletes sponsored policy documents',async()=>{
    const text=fs.readFileSync(path.join(__dirname,'functions/index.js'),'utf8')
    assert.match(text,/const SCHOOL_CASCADE_COLLECTIONS\s*=\s*\[[\s\S]*?'aiWritingSponsoredPolicies'/)
  })
  await test('Permanent student account deletion removes selected ID from policy',async()=>{
    const text=fs.readFileSync(path.join(__dirname,'functions/index.js'),'utf8')
    assert.match(text,/const STUDENT_LEGACY_REFERENCE_COLLECTIONS\s*=\s*\[[\s\S]*?'aiWritingSponsoredPolicies'/)
    assert.match(text,/const STUDENT_LEGACY_REFERENCE_FIELDS\s*=\s*\[[\s\S]*?'studentIds'/)
  })
  await test('Permanent content delete trigger cleans exact sponsored policy',async()=>{
    const text=fs.readFileSync(path.join(__dirname,'functions/index.js'),'utf8')
    assert.match(text,/async function cleanupStudentAccessOnSourceDelete[\s\S]*?aiWritingSponsoredPolicies\/\$\{contentType\}_\$\{id\}/)
  })
  await test('Only server callables can read and set policy and no trigger or provider is created',async()=>{
    const text=fs.readFileSync(path.join(__dirname,'functions/index.js'),'utf8')
    assert.match(text,/exports\.getAiWritingSponsoredPolicy\s*=\s*onCall/)
    assert.match(text,/exports\.setAiWritingSponsoredPolicy\s*=\s*onCall/)
    const moduleText=fs.readFileSync(path.join(__dirname,'functions/lib/aiWritingSponsoredPolicy.js'),'utf8')
    assert.doesNotMatch(moduleText,/fetch\(|https:\/\/api\.openai\.com|creditsRemaining\s*:/)
  })
  // P6-A2 authoritative current-class security cases.
  await test('P6-A2: stale teacherIds without any current class cannot authorize spending',async()=>{
    const f=createFixture();f.db.docs.delete('classes/teacherGroup001')
    assert.ok(f.db.docs.get(`users/${s1}`).teacherIds.includes(managerUid))
    await denied(f.write(policy()),'permission-denied')
    assert.equal(f.db.writes.length,0)
  })
  await test('P6-A2: revoked class membership disables existing policy for teacher and admin',async()=>{
    const f=createFixture();await f.write(policy())
    const cls=f.db.docs.get('classes/teacherGroup001');cls.studentIds=[s2,s3]
    f.db.docs.set('classes/teacherGroup001',cls)
    const teacherView=await f.read({contentType:'writing',contentId:sourceId})
    const adminView=await f.read({contentType:'writing',contentId:sourceId},adminUid)
    assert.equal(teacherView.enabled,false);assert.deepEqual(teacherView.studentIds,[])
    assert.equal(adminView.enabled,false);assert.deepEqual(adminView.studentIds,[])
    await denied(f.write(policy()),'permission-denied')
    assert.equal(f.db.writes.length,1)
  })
  await test('P6-A2: archived, system or foreign-school classes cannot grant a teacher AI',async()=>{
    for(const patch of [{archived:true},{system:true},{name:'ALL'},{schoolId:'elsewhere'},{deleted:true}]) {
      const f=createFixture()
      f.db.docs.set('classes/teacherGroup001',{
        ...f.db.docs.get('classes/teacherGroup001'),...patch
      })
      await denied(f.write(policy()),'permission-denied')
      assert.equal(f.db.writes.length,0)
    }
  })
  await test('P6-A2: student may have two currently active teachers on different classes',async()=>{
    const f=createFixture();const nextTeacher='teacher999'
    f.db.docs.set(`users/${nextTeacher}`,{
      role:'teacher',status:'approved',schoolId:'maxima',accountType:'institution'
    })
    const src=f.db.docs.get(writingSourcePath)
    f.db.docs.set(writingSourcePath,{...src,teacherId:'',teacherIds:[managerUid,nextTeacher]})
    f.db.docs.set('classes/otherGroup',{name:'Other',schoolId:'maxima',teacherId:nextTeacher,
      studentIds:[s1],archived:false})
    // Profile has no fresh teacher link for teacher999. Current class is authoritative.
    const res=await f.write(policy(),nextTeacher)
    assert.equal(res.enabled,true)
  })
  await test('P6-A2: source primary teacher overrules stale source teacherIds',async()=>{
    const f=createFixture();const src=f.db.docs.get(writingSourcePath)
    f.db.docs.set(writingSourcePath,{...src,teacherId:'teacher999',teacherIds:[managerUid,'teacher999']})
    await denied(f.write(policy()),'permission-denied')
  })
  await test('P6-A2: admin can select an assigned student even without an active class',async()=>{
    const f=createFixture();f.db.docs.delete('classes/teacherGroup001')
    assert.equal((await f.write(policy(),adminUid)).enabled,true)
    const res=await f.read({contentType:'writing',contentId:sourceId},adminUid)
    assert.equal(res.enabled,true);assert.deepEqual(res.studentIds,[s1])
  })
  await test('P6-A2: historical creator alone cannot authorize, even with a current class',async()=>{
    const f=createFixture();const src=f.db.docs.get(writingSourcePath)
    f.db.docs.set(writingSourcePath,{...src,teacherId:'',teacherIds:[],createdBy:managerUid})
    await denied(f.write(policy()),'permission-denied')
  })
  console.log(`\nP5B-3A sponsored policy: ${total-failed}/${total} PASS; ${failed} FAIL`)
  process.exitCode=failed?1:0
})().catch(error=>{console.error(error);process.exitCode=1})
