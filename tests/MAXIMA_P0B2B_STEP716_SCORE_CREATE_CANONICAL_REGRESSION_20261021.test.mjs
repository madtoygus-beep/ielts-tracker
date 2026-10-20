// MAXIMA Step716 — real-source score CREATE security regression (local Emulator only)
// SOURCE EXPECTATION: historical teacherIds are compatibility metadata, not ACL.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

const PROJECT='demo-maxima-p0b'
const RULES_SHA='b7be769dfad4ddb18c35cc262edace1c64423e5ba7dbc4f1f3bbc1f7a2ecbd2f'
const NEW='step716_new_teacher'
const OLD='step716_old_teacher'
const ADMIN='step716_admin'
const STUDENT='step716_transferred_student'
const OTHER='step716_other_student'
let env
let counter=0
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const dbOf=uid=>env.authenticatedContext(uid).firestore()
const ref=(uid,id)=>doc(dbOf(uid),`scores/${id}`)
const nextId=prefix=>`${prefix}_${++counter}`
const validManual=(extra={})=>({
  uid:STUDENT,studentId:STUDENT,schoolId:'maxima',
  teacherId:NEW,teacherIds:[NEW],addedBy:NEW,
  source:'manual',date:'2026-10-21',
  reading:6,listening:6,writing:6,speaking:6,overall:6,
  ...extra
})
const validMock=(extra={})=>({
  uid:STUDENT,studentId:STUDENT,schoolId:'maxima',
  teacherId:NEW,teacherIds:[NEW],
  updatedBy:NEW,updatedAt:'2026-10-21T01:50:00Z',
  source:'mock_test',mockTestId:'step716_mock',attemptNumber:1,
  date:'2026-10-21',writing:6.5,overall:6.5,
  ...extra
})

before(async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/,'STOP: local Firestore Emulator required')
  assert.equal(process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||PROJECT,PROJECT,'STOP: demo project only')
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),
    'security/p0b-teacher-access-20261020','STOP: wrong branch')
  assert.match(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),/^28230ac/,'STOP: wrong checkpoint')
  assert.equal(hash('firestore.rules'),RULES_SHA,'STOP: verified local rules changed')
  env=await initializeTestEnvironment({projectId:PROJECT,firestore:{
    host:'127.0.0.1',port:8081,rules:readFileSync('firestore.rules','utf8')
  }})
})
after(async()=>{if(env)await env.cleanup()})
beforeEach(async()=>{
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async privileged=>{
    const db=privileged.firestore()
    await setDoc(doc(db,'schools/maxima'),{status:'active'})
    for(const id of [NEW,OLD]) await setDoc(doc(db,`users/${id}`),{
      role:'teacher',status:'approved',schoolId:'maxima',deleted:false,archived:false
    })
    await setDoc(doc(db,`users/${ADMIN}`),{
      role:'admin',status:'approved',schoolId:'maxima',deleted:false,archived:false
    })
    await setDoc(doc(db,`users/${STUDENT}`),{
      role:'student',status:'approved',schoolId:'maxima',deleted:false,archived:false,
      teacherIds:[OLD] // intentional stale legacy metadata
    })
    await setDoc(doc(db,`users/${OTHER}`),{
      role:'student',status:'approved',schoolId:'maxima',deleted:false,archived:false,
      teacherIds:[OLD,NEW]
    })
    for(const [id,students] of [[NEW,[STUDENT]],[OLD,[]]]){
      await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${id}`),{
        schemaVersion:1,source:'managed_active_classes',schoolId:'maxima',teacherId:id,
        activeStudentIds:students
      })
    }
  })
})

async function deniedAndUnwritten(uid,payload,prefix){
  const id=nextId(prefix)
  const err=await assertFails(setDoc(ref(uid,id),payload))
  assert.equal(err.code,'permission-denied')
  // rules-unit-testing's privileged helper may not forward return value;
  // use a scoped mutable to guarantee we check the actual database.
  let persisted=null
  await env.withSecurityRulesDisabled(async privileged=>{
    persisted=(await getDoc(doc(privileged.firestore(),`scores/${id}`))).exists()
  })
  assert.equal(persisted,false,`${prefix}: forbidden write actually persisted`)
}

test('transferred teacher can create MANUAL score without stale profile teacherIds update',async()=>{
  const id=nextId('manual')
  await assertSucceeds(setDoc(ref(NEW,id),validManual()))
  const saved=await assertSucceeds(getDoc(ref(NEW,id)))
  assert.equal(saved.data().teacherId,NEW)
  assert.equal(saved.data().addedBy,NEW)
  assert.deepEqual(saved.data().teacherIds,[NEW])
  console.log('STEP716_TRANSFER_MANUAL CREATE=ALLOWED LEGACY_TEACHER_IDS=STALE')
})

test('transferred teacher can create first MOCK score without addedBy',async()=>{
  const id=nextId('mock')
  await assertSucceeds(setDoc(ref(NEW,id),validMock()))
  const saved=await assertSucceeds(getDoc(ref(NEW,id)))
  assert.equal(saved.data().teacherId,NEW)
  assert.equal('addedBy' in saved.data(),false)
  assert.equal(saved.data().updatedBy,NEW)
  console.log('STEP716_TRANSFER_MOCK CREATE=ALLOWED ADDED_BY=ABSENT')
})

test('former teacher cannot create score despite stale user.teacherIds',async()=>{
  await deniedAndUnwritten(OLD,validManual({teacherId:OLD,teacherIds:[OLD],addedBy:OLD}), 'old_teacher')
  console.log('STEP716_OLD_TEACHER CREATE=DENIED UNCHANGED')
})

test('new score attribution forged by active teacher is rejected and not persisted',async()=>{
  const fakes=[
    {teacherId:OLD},
    {teacherIds:[OLD]},
    {teacherIds:[OLD,NEW]},
    {teacherIds:[]},
    {addedBy:OLD},
    {updatedBy:OLD},
    {createdBy:OLD},
    {reviewedBy:OLD},
    {teacherId:''},
  ]
  for(const fake of fakes) await deniedAndUnwritten(NEW,validManual(fake),'attribution')
  console.log(`STEP716_ATTRIBUTION_TAMPER ${fakes.length}/${fakes.length} DENIED UNCHANGED`)
})

test('mock score missing addedBy is allowed ONLY with self updatedBy, manual not allowed',async()=>{
  const missingUpdatedBy=validMock()
  delete missingUpdatedBy.updatedBy
  await deniedAndUnwritten(NEW,missingUpdatedBy,'mock_no_updated_by')
  await deniedAndUnwritten(NEW,validMock({updatedBy:OLD}),'mock_wrong_updated_by')
  const missingAddedBy=validManual()
  delete missingAddedBy.addedBy
  await deniedAndUnwritten(NEW,missingAddedBy,'manual_no_added_by')
  console.log('STEP716_PROVENANCE_GUARD MOCK/MANUAL 3/3 DENIED')
})

test('both uid and studentId must match current active student; full schoolId required',async()=>{
  for(const bad of [
    {studentId:OTHER},
    {uid:OTHER},
    {studentId:''},
    {uid:''},
    {schoolId:''},
    {schoolId:'other_school'},
  ]) await deniedAndUnwritten(NEW,validManual(bad),'identity')
  console.log('STEP716_IDENTITY_GUARD 6/6 DENIED UNCHANGED')
})

test('removed or other student cannot be granted score CREATE through legacy links',async()=>{
  const other=validManual({uid:OTHER,studentId:OTHER})
  await deniedAndUnwritten(NEW,other,'other_student')
  await env.withSecurityRulesDisabled(async privileged=>{
    await updateDoc(doc(privileged.firestore(),`schools/maxima/teacherAcademicIndex/${NEW}`),{activeStudentIds:[]})
  })
  await deniedAndUnwritten(NEW,validManual(),'revoked')
  console.log('STEP716_REMOVED_INDEX CREATE=DENIED IMMEDIATELY')
})

test('admin server-support browser path remains authorized',async()=>{
  const id=nextId('admin')
  await assertSucceeds(setDoc(ref(ADMIN,id),validManual({teacherId:OLD,teacherIds:[OLD],addedBy:OLD})))
  const saved=await assertSucceeds(getDoc(ref(ADMIN,id)))
  assert.equal(saved.data().teacherId,OLD)
  console.log('STEP716_ADMIN_CREATE ALLOWED')
})
