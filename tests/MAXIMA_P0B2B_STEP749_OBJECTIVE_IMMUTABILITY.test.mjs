// Step749: objective submission integrity, client Firestore rules in demo Emulator only.
// NO production connection; verifies teacher read permissions but rejects ALL
// direct teacher edits to server-scored Reading, Listening and Vocabulary.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, updateDoc, setDoc } from 'firebase/firestore'

const PROJECT='demo-maxima-p0b'
const RULES_SHA='9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const BRANCH='security/p0b-teacher-access-20261020'
const T='step749_active_teacher',OLD='step749_old_teacher',ADMIN='step749_admin'
const S='step749_fake_student'
const TARGETS=['readingSubmissions','listeningSubmissions','vocabularySubmissions']
let env
const client=uid=>env.authenticatedContext(uid).firestore()
const path=collectionName=>`${collectionName}/step749_fake_result`
const hash=x=>createHash('sha256').update(readFileSync(x)).digest('hex')
async function seed() {
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore()
    await setDoc(doc(db,'schools/maxima'),{status:'active'})
    for (const [uid,role] of [[T,'teacher'],[OLD,'teacher'],[ADMIN,'admin'],[S,'student']]) {
      await setDoc(doc(db,`users/${uid}`),{
        role,status:'approved',schoolId:'maxima',deleted:false,archived:false,
        teacherIds:role==='student'?[OLD]:[]
      })
    }
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${T}`),{
      schemaVersion:1,source:'managed_active_classes',teacherId:T,
      schoolId:'maxima',activeStudentIds:[S]
    })
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${OLD}`),{
      schemaVersion:1,source:'managed_active_classes',teacherId:OLD,
      schoolId:'maxima',activeStudentIds:[]
    })
    for (const collectionName of TARGETS) {
      await setDoc(doc(db,path(collectionName)),{
        schoolId:'maxima',uid:S,studentId:S,
        teacherId:OLD,teacherIds:[OLD],submittedAt:'2026-10-20T12:00:00Z',
        answers:{q1:'original student answer'},result:{correct:5,band:6},
        score:5,reviewed:false,excludedFromStats:false
      })
    }
  })
}

async function denied(uid, target, patch) {
  const result=await assertFails(updateDoc(doc(client(uid),path(target)),patch))
  assert.equal(result.code,'permission-denied', `${uid} ${target} ${JSON.stringify(patch)}`)
}

before(async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'', /^(127\.0\.0\.1|localhost):8081$/, 'STOP: local Emulator 8081 required')
  assert.equal(process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||PROJECT,PROJECT,'STOP: only demo project')
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),BRANCH,'STOP: wrong branch')
  assert.doesNotThrow(()=>execFileSync('git',['merge-base','--is-ancestor','9c7b233','HEAD']), 'STOP: required security baseline missing')
  assert.equal(hash('firestore.rules'),RULES_SHA,'STOP: Step749 vetted Rules hash differs')
  env=await initializeTestEnvironment({projectId:PROJECT,
    firestore:{host:'127.0.0.1',port:8081,rules:readFileSync('firestore.rules','utf8')}
  })
})
after(async()=>{if(env)await env.cleanup()})
beforeEach(async()=>{await env.clearFirestore();await seed()})

test('new teacher can read each existing objective result; former owner cannot',async()=>{
  for(const target of TARGETS){
    const snap=await assertSucceeds(getDoc(doc(client(T),path(target))))
    assert.equal(snap.data()?.studentId,S)
    await assertFails(getDoc(doc(client(OLD),path(target))))
  }
})

test('current teacher cannot alter any original student answers',async()=>{
  for(const target of TARGETS){
    await denied(T,target,{answers:{q1:'teacher-supplied answer'}})
    await denied(T,target,{'answers.q1':'nested edit'})
  }
})

test('current teacher cannot replace computed scores or results',async()=>{
  for(const target of TARGETS){
    await denied(T,target,{score:40})
    await denied(T,target,{result:{correct:40,band:9}})
  }
})

test('current teacher cannot forge identities, submission timestamps or metadata',async()=>{
  for(const target of TARGETS){
    await denied(T,target,{uid:T})
    await denied(T,target,{studentId:T})
    await denied(T,target,{submittedAt:'2000-01-01T00:00:00Z'})
    await denied(T,target,{teacherId:T})
  }
})

test('current teacher cannot toggle browser review flags or excluded stats',async()=>{
  for(const target of TARGETS){
    await denied(T,target,{reviewed:true,reviewedBy:T})
    await denied(T,target,{excludedFromStats:true})
    await denied(T,target,{statsExcludedBy:T})
  }
})

test('student and former teacher cannot modify objective submissions',async()=>{
  for(const target of TARGETS){
    await denied(S,target,{score:40})
    await denied(OLD,target,{score:40})
  }
})

test('admin retains existing support repair rights, but stats require audited backend',async()=>{
  for(const target of TARGETS){
    await assertSucceeds(updateDoc(doc(client(ADMIN),path(target)),{
      adminCorrectionNote:'Synthetic support repair test'
    }))
    await denied(ADMIN,target,{excludedFromStats:true})
    const snap=await getDoc(doc(client(ADMIN),path(target)))
    assert.equal(snap.data()?.adminCorrectionNote,'Synthetic support repair test')
  }
})

test('removing canonical class membership immediately revokes teacher reads and writes',async()=>{
  await env.withSecurityRulesDisabled(async ctx=>{
    await updateDoc(doc(ctx.firestore(),`schools/maxima/teacherAcademicIndex/${T}`),{
      activeStudentIds:[]
    })
  })
  for(const target of TARGETS){
    await assertFails(getDoc(doc(client(T),path(target))))
    await denied(T,target,{answers:{q1:'forgery'}})
  }
})
