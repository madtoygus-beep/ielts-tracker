// P0-B2B Step712: canonical-index student profile query feasibility.
// Demo Firestore Emulator ONLY. This file never changes real databases/rules.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { collection, doc, documentId, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore'

const PROJECT = 'demo-maxima-p0b'
const LAB = 'firestore.rules'
const REAL_SHA = 'b7be769dfad4ddb18c35cc262edace1c64423e5ba7dbc4f1f3bbc1f7a2ecbd2f'
const LAB_SHA = 'b7be769dfad4ddb18c35cc262edace1c64423e5ba7dbc4f1f3bbc1f7a2ecbd2f'
const INDEX_SHA = 'b93023c08fbf01895cdc42cba4b8854c3050a15f07045735bc7b30b9e5ab6618'
const T = 'step712_teacher'
const OLD = 'step712_old_teacher'
const ids = Array.from({length:9}, (_,i) => `step712_student_${String(i+1).padStart(2,'0')}`)
const removed = 'step712_former_student'
const blocked = 'step712_archived_student'
let env
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex')
const dbOf = uid => env.authenticatedContext(uid).firestore()
const studentQuery = (uid, selected) => getDocs(query(collection(dbOf(uid),'users'),where(documentId(),'in', selected)))
const code = e => String(e?.code || '')
async function probe(uid, selected) {
  try {
    const snap = await studentQuery(uid, selected)
    const found = snap.docs.map(d => d.id)
    assert.ok(found.every(id => selected.includes(id)),'Unexpected profile outside selected IDs')
    return { allowed:true, found }
  } catch (e) {
    if (code(e) !== 'permission-denied') throw e
    return { allowed:false, found:[] }
  }
}

before(async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):8081$/, 'STOP: only local Emulator port 8081')
  assert.equal(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECT, PROJECT, 'STOP: wrong demo project')
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(), 'security/p0b-teacher-access-20261020', 'STOP: wrong branch')
  assert.match(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}), /^28230ac/, 'STOP: Step701 checkpoint missing')
  assert.equal(hash('firestore.rules'),REAL_SHA,'STOP: source rules differ from reviewed baseline')
  assert.equal(hash(LAB),LAB_SHA,'STOP: local source candidate differs')
  assert.equal(hash('functions/lib/p0bAcademicMembershipIndex.js'),INDEX_SHA,'STOP: index writer differs')
  env=await initializeTestEnvironment({projectId:PROJECT, firestore:{host:'127.0.0.1',port:8081,rules:readFileSync(LAB,'utf8')}})
})
after(async () => { if(env) await env.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async context => {
    const db=context.firestore()
    await setDoc(doc(db,'schools/maxima'),{status:'active'})
    for (const [id,role,status,archived] of [
      [T,'teacher','approved',false],[OLD,'teacher','approved',false],
      ...ids.map(id=>[id,'student','approved',false]),
      [removed,'student','approved',false],
      [blocked,'student','approved',true]]) {
      await setDoc(doc(db,`users/${id}`),{role,status,archived,deleted:false,schoolId:'maxima',teacherIds:[OLD]})
    }
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${T}`),{
      schemaVersion:1,source:'managed_active_classes',teacherId:T,schoolId:'maxima',activeStudentIds:[...ids,blocked]
    })
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${OLD}`),{
      schemaVersion:1,source:'managed_active_classes',teacherId:OLD,schoolId:'maxima',activeStudentIds:[]
    })
  })
})

test('teacher can get own index, never another index or enumerate indexes', async () => {
  const own=await assertSucceeds(getDoc(doc(dbOf(T),`schools/maxima/teacherAcademicIndex/${T}`)))
  assert.ok(own.exists())
  assert.deepEqual(own.data().activeStudentIds,[...ids,blocked])
  await assertFails(getDoc(doc(dbOf(OLD),`schools/maxima/teacherAcademicIndex/${T}`)))
  await assertFails(getDocs(collection(dbOf(T),'schools/maxima/teacherAcademicIndex')))
  console.log('STEP712_CANONICAL_INDEX OWN_GET=ALLOWED OTHER_GET=DENIED LIST=DENIED')
})

test('direct user profiles respect current active membership, not legacy teacherIds', async () => {
  const allowed=await assertSucceeds(getDoc(doc(dbOf(T),`users/${ids[0]}`)))
  assert.ok(allowed.exists())
  await assertFails(getDoc(doc(dbOf(T),`users/${removed}`)))
  await assertFails(getDoc(doc(dbOf(T),`users/${blocked}`)))
  await assertFails(getDoc(doc(dbOf(OLD),`users/${ids[0]}`)))
  console.log('STEP712_PROFILE_GET ACTIVE=ALLOWED FORMER=DENIED ARCHIVED=DENIED STALE_TEACHER=DENIED')
})

test('documentId IN profile groups - diagnostic size budget',async()=>{
  let allowed=0
  for(const n of [1,3,5,7,9]) {
    const result=await probe(T,ids.slice(0,n))
    console.log(`STEP712_PROFILE_IN SIZE_${n} ${result.allowed?'ALLOWED':'DENIED'} count=${result.found.length}`)
    if(result.allowed) {
      allowed++
      assert.deepEqual(result.found.slice().sort(),ids.slice(0,n).sort())
    }
  }
  assert.ok(allowed>=1,'BLOCKER: even single-ID canonical profile query refused')
  console.log(`STEP712_PROFILE_IN_SUMMARY AUTHORIZED=${allowed}/5`)
})

test('mixed authorized/removed/archived ID groups are always denied',async()=>{
  for(const v of [removed,blocked]) {
    const r=await probe(T,[ids[0],v])
    assert.equal(r.allowed,false,`BLOCKER: ${v} included with authorized profile`)
    console.log(`STEP712_PROFILE_MIXED ${v} DENIED`)
  }
})

test('old teacher cannot list even one current student via documentId IN',async()=>{
  const r=await probe(OLD,[ids[0]])
  assert.equal(r.allowed,false,'BLOCKER: stale teacher acquired current student profile')
  console.log('STEP712_OLD_TEACHER_PROFILE_IN DENIED')
})
