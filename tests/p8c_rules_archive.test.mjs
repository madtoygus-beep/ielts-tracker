// P8-C direct Firestore security rules regression tests.
// Synthetic records only. Refuses to run unless using loopback Firestore Emulator.
// Run from MAXIMA project's root so it loads the deployed candidate firestore.rules.
import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

const S = 'p8c_test_student'
const OTHER = 'p8c_test_other'
const T = 'p8c_test_teacher'
const V = 'p8c_test_vocab'
const A = `${S}_vocabulary_${V}`
const H = process.env.FIRESTORE_EMULATOR_HOST || ''
let env

const studentDb = () => env.authenticatedContext(S).firestore()
const otherDb = () => env.authenticatedContext(OTHER).firestore()
const seedAccess = async (patch) => env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore()
  await updateDoc(doc(db, `studentAccess/${A}`), patch)
})

before(async () => {
  assert.match(H, /^(127\.0\.0\.1|localhost):8080$/, 'STOP: Only loopback Firestore emulator on port 8080 is permitted.')
  const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8')
  assert.match(rules, /get\('accessType', ''\) == 'assignment'/, 'STOP: P8-C accessType protection absent from rules.')
  env = await initializeTestEnvironment({
    projectId: 'demo-maxima-p8c-rules-extra',
    firestore: { host: '127.0.0.1', port: 8080, rules }
  })
})
after(async () => { await env?.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'schools/maxima'), { status: 'active' })
    await setDoc(doc(db, `users/${S}`), { role: 'student', status: 'approved', schoolId: 'maxima', teacherIds: [T] })
    await setDoc(doc(db, `users/${OTHER}`), { role: 'student', status: 'approved', schoolId: 'maxima' })
    await setDoc(doc(db, `users/${T}`), { role: 'teacher', status: 'approved', schoolId: 'maxima' })
    await setDoc(doc(db, `studentAccess/${A}`), {
      uid: S, schoolId: 'maxima', contentType: 'vocabulary', contentId: V,
      accessType: 'assignment', status: 'active', sourceCollection: 'vocabularyTests'
    })
    await setDoc(doc(db, `studentVocabularyTests/${V}`), { schoolId: 'maxima', title: 'Safe student projection' })
    await setDoc(doc(db, `vocabularyTests/${V}`), { schoolId: 'maxima', teacherId: T, answers: ['SECRET'] })
    await setDoc(doc(db, `vocabularySubmissions/${S}_${V}`), {
      uid: S, studentId: S, schoolId: 'maxima', vocabularyTestId: V, teacherId: T,
      submittedAt: '2026-10-20T00:00:00Z', answers: ['SECRET']
    })
  })
})

test('P8C-R1 active assignment can read answer-free projection', async () => {
  const snap = await assertSucceeds(getDoc(doc(studentDb(), `studentVocabularyTests/${V}`)))
  assert.equal(snap.data().title, 'Safe student projection')
})

test('P8C-R2 inactive unassigned archive cannot read live projection', async () => {
  await seedAccess({ accessType: 'unassigned_archive', status: 'inactive' })
  await assertFails(getDoc(doc(studentDb(), `studentVocabularyTests/${V}`)))
})

test('P8C-R3 archive marker cannot impersonate active assignment by spoofing active status', async () => {
  await seedAccess({ accessType: 'unassigned_archive', status: 'active' })
  await assertFails(getDoc(doc(studentDb(), `studentVocabularyTests/${V}`)))
})

test('P8C-R4 an inactive assignment is not readable', async () => {
  await seedAccess({ accessType: 'assignment', status: 'inactive' })
  await assertFails(getDoc(doc(studentDb(), `studentVocabularyTests/${V}`)))
})

test('P8C-R5 wrong-school entitlement does not grant access', async () => {
  await seedAccess({ schoolId: 'other_school' })
  await assertFails(getDoc(doc(studentDb(), `studentVocabularyTests/${V}`)))
})

test('P8C-R6 another institutional student cannot borrow the assignment', async () => {
  await assertFails(getDoc(doc(otherDb(), `studentVocabularyTests/${V}`)))
  await assertFails(getDoc(doc(otherDb(), `studentAccess/${A}`)))
})

test('P8C-R7 assigned student cannot read answer-key-bearing source', async () => {
  await assertFails(getDoc(doc(studentDb(), `vocabularyTests/${V}`)))
})

test('P8C-R8 archived student cannot read raw historic submission directly', async () => {
  await seedAccess({ accessType: 'unassigned_archive', status: 'inactive' })
  await assertFails(getDoc(doc(studentDb(), `vocabularySubmissions/${S}_${V}`)))
})

test('P8C-R9 student cannot directly edit their assignment or archive status', async () => {
  await assertFails(updateDoc(doc(studentDb(), `studentAccess/${A}`), { status: 'active', accessType: 'unassigned_archive' }))
})

test('P8C-R10 deactivated school cannot authorize active entitlement', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await updateDoc(doc(ctx.firestore(), 'schools/maxima'), { status: 'inactive' })
  })
  await assertFails(getDoc(doc(studentDb(), `studentVocabularyTests/${V}`)))
})
