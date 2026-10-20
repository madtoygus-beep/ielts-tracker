// P0-B2B Step711: canonical paired-identity OR-query diagnostic.
// DEMO FIRESTORE EMULATOR ONLY. Never writes to the real MAXIMA app or Firebase.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDocs, setDoc, collection, query, where, or, and } from 'firebase/firestore'

const PROJECT = 'demo-maxima-p0b'
const LAB = 'firestore.rules'
const REAL_SHA = 'b7be769dfad4ddb18c35cc262edace1c64423e5ba7dbc4f1f3bbc1f7a2ecbd2f'
const LAB_SHA = 'b7be769dfad4ddb18c35cc262edace1c64423e5ba7dbc4f1f3bbc1f7a2ecbd2f'
const INDEX_SHA = 'b93023c08fbf01895cdc42cba4b8854c3050a15f07045735bc7b30b9e5ab6618'
const T = 'step711_teacher'
const OLD = 'step711_old_teacher'
const ids = Array.from({length: 9}, (_, i) => `step711_student_${String(i + 1).padStart(2,'0')}`)
const removed = 'step711_removed_student'
const types = ['writingSubmissions', 'mockSubmissions', 'scores']
let env
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex')
const client = user => env.authenticatedContext(user).firestore()
const run = (role, type, selected) => {
  if (!selected.length) throw new Error('query requires student IDs')
  const clauses = selected.map(uid => and(where('uid','==',uid),where('studentId','==',uid)))
  // Firestore rejects a where() and composite filter as separate top-level
  // query constraints. Put every predicate under ONE outer and() tree.
  const paired = clauses.length === 1 ? clauses[0] : or(...clauses)
  return getDocs(query(collection(client(role), type),
    and(where('schoolId','==','maxima'), paired)))
}
async function readProbe(user, type, selected) {
  try {
    const snap = await run(user, type, selected)
    const docs = snap.docs.map(d => ({ id:d.id, uid:d.data().uid, studentId:d.data().studentId }))
    for (const row of docs) {
      assert.equal(row.uid, row.studentId, 'BLOCKER: mismatched identity reached teacher query')
      assert.ok(selected.includes(row.uid), 'BLOCKER: unexpected student in query')
    }
    return { allowed: true, docs }
  } catch (error) {
    // A denial is acceptable in a diagnostic sizing run, but any other error
    // (such as a missing Firestore index) MUST be surfaced separately.
    if (String(error?.code) !== 'permission-denied') throw error
    return { allowed: false, docs: [] }
  }
}

before(async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):8081$/,
    'STOP: only the local Firestore emulator on 8081')
  assert.equal(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECT, PROJECT,
    'STOP: only demo-maxima-p0b')
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),
    'security/p0b-teacher-access-20261020', 'STOP: wrong Git branch')
  assert.match(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}), /^28230ac/,
    'STOP: requires the Step701 checkpoint')
  assert.equal(hash('firestore.rules'), REAL_SHA, 'STOP: production-source rules changed')
  assert.equal(hash(LAB), LAB_SHA, 'STOP: LOCAL SOURCE candidate differ from reviewed candidate')
  assert.equal(hash('functions/lib/p0bAcademicMembershipIndex.js'), INDEX_SHA, 'STOP: academic index source changed')
  env = await initializeTestEnvironment({ projectId: PROJECT,
    firestore: { host:'127.0.0.1', port:8081, rules:readFileSync(LAB,'utf8') } })
})
after(async () => { if (env) await env.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore()
    await setDoc(doc(db,'schools/maxima'),{status:'active'})
    for (const [id,role] of [[T,'teacher'],[OLD,'teacher'],...ids.map(id=>[id,'student']),[removed,'student']]) {
      await setDoc(doc(db,`users/${id}`),{role,status:'approved',schoolId:'maxima',deleted:false})
    }
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${T}`),{
      schemaVersion:1,source:'managed_active_classes',teacherId:T,schoolId:'maxima',activeStudentIds:ids
    })
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${OLD}`),{
      schemaVersion:1,source:'managed_active_classes',teacherId:OLD,schoolId:'maxima',activeStudentIds:[]
    })
    for (const type of types) {
      for (const student of ids) {
        await setDoc(doc(db,`${type}/${student}`),{uid:student,studentId:student,schoolId:'maxima',teacherId:OLD})
      }
      await setDoc(doc(db,`${type}/wrong_student_id`),{
        uid:ids[0],studentId:removed,schoolId:'maxima',teacherId:T
      })
      await setDoc(doc(db,`${type}/wrong_uid`),{
        uid:removed,studentId:ids[0],schoolId:'maxima',teacherId:T
      })
      await setDoc(doc(db,`${type}/former`),{uid:removed,studentId:removed,schoolId:'maxima',teacherId:T})
      await setDoc(doc(db,`${type}/legacy`),{studentId:ids[0],schoolId:'maxima',teacherId:T})
    }
  })
})

test('paired OR queries across student groups never return mismatched identities',async () => {
  let permitted = 0
  for (const type of types) {
    for (const size of [1,3,5,7,9]) {
      const selection=ids.slice(0,size)
      const result=await readProbe(T,type,selection)
      console.log(`STEP711_OR ${type} SIZE_${size} ${result.allowed?'ALLOWED':'DENIED'} count=${result.docs.length}`)
      if (result.allowed) {
        permitted++
        assert.deepEqual(result.docs.map(x=>x.id).sort(), selection.slice().sort())
      }
    }
  }
  assert.ok(permitted >= 3, 'BLOCKER: paired OR queries never worked for active teacher')
  console.log(`STEP711_OR_SUMMARY AUTHORIZED=${permitted}/15`)
})

test('adding one former UID to an OR query fails closed for the whole query',async () => {
  for (const type of types) {
    const queryRef = run(T,type,[ids[0],removed])
    const err=await assertFails(queryRef)
    assert.equal(String(err.code),'permission-denied')
    console.log(`STEP711_MIXED ${type} DENIED`)
  }
})

test('old teacher cannot use paired OR query against current active students',async () => {
  for (const type of types) {
    const err=await assertFails(run(OLD,type,[ids[0],ids[1]]))
    assert.equal(String(err.code),'permission-denied')
    console.log(`STEP711_OLD_TEACHER ${type} DENIED`)
  }
})
