// Step713: real-source Rules, local Firestore Emulator only, no cloud writes.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

const PROJECT='demo-maxima-p0b'
const EXPECTED_SHA='b7be769dfad4ddb18c35cc262edace1c64423e5ba7dbc4f1f3bbc1f7a2ecbd2f'
const T='step713_teacher', OLD='step713_old_teacher', S='step713_student'
let env
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const ctx=id=>env.authenticatedContext(id).firestore()
const ref=(id,path)=>doc(ctx(id),path)

before(async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/,'STOP: local emulator required')
  assert.equal(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECT,PROJECT)
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),'security/p0b-teacher-access-20261020')
  assert.match(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),/^28230ac/)
  assert.equal(sha('firestore.rules'),EXPECTED_SHA,'STOP: Rules candidate changed')
  env=await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:8081,rules:readFileSync('firestore.rules','utf8')}})
})
after(async()=>{if(env) await env.cleanup()})
beforeEach(async()=>{
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore()
    await setDoc(doc(db,'schools/maxima'),{status:'active'})
    for(const [id,role] of [[T,'teacher'],[OLD,'teacher'],[S,'student']]) {
      await setDoc(doc(db,`users/${id}`),{
        role,status:'approved',schoolId:'maxima',deleted:false,archived:false,
        teacherIds:[T,OLD]
      })
    }
    for(const [id,members] of [[T,[S]],[OLD,[]]]) {
      await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${id}`),{
        schemaVersion:1,source:'managed_active_classes',schoolId:'maxima',teacherId:id,activeStudentIds:members
      })
    }
    await setDoc(doc(db,'scores/legacy_teacher_score'),{
      uid:S,studentId:S,schoolId:'maxima',teacherId:OLD,teacherIds:[OLD],
      addedBy:OLD,source:'mock_test',mockTestId:'step713_mock',attemptNumber:1,
      writing:5.5,date:'2026-10-21',createdAt:'2026-10-21T00:00:00Z'
    })
  })
})
test('transferred student: newly admitted teacher updates existing band, preserves original score identity',async()=>{
  await assertSucceeds(updateDoc(ref(T,'scores/legacy_teacher_score'),{
    writing:7,updatedBy:T,updatedAt:'2026-10-21T01:00:00Z'
  }))
  const snap=await assertSucceeds(getDoc(ref(T,'scores/legacy_teacher_score')))
  assert.equal(snap.data().writing,7)
  assert.equal(snap.data().teacherId,OLD)
  assert.equal(snap.data().addedBy,OLD)
  assert.deepEqual(snap.data().teacherIds,[OLD])
  await assertFails(getDoc(ref(OLD,'scores/legacy_teacher_score')))
  console.log('STEP713_TRANSFER_SCORE_UPDATE ALLOWED IDENTITY_PRESERVED OLD_DENIED')
})
test('no teacher can rewrite score identity / source / moderation fields',async()=>{
  for(const fake of [
    {teacherId:T}, {uid:T}, {studentId:T}, {schoolId:'other'},
    {source:'manual'}, {mockTestId:'other'}, {attemptNumber:2},
    {excludedFromStats:true}
  ]) {
    const err=await assertFails(updateDoc(ref(T,'scores/legacy_teacher_score'),{
      writing:8,...fake
    }))
    assert.equal(String(err.code),'permission-denied')
  }
  const snap=await assertSucceeds(getDoc(ref(T,'scores/legacy_teacher_score')))
  assert.equal(snap.data().writing,5.5,'denied writes must not apply')
  console.log('STEP713_SCORE_TAMPER 8/8 DENIED UNCHANGED')
})
