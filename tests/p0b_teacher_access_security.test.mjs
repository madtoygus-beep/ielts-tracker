// P0-B: local Firestore Emulator security tests. No production access.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, updateDoc, setDoc, getDocs, collection, query, where } from 'firebase/firestore'

const PROJECT = 'demo-maxima-p0b'
const HOST = process.env.FIRESTORE_EMULATOR_HOST || ''
const CURRENT = 'p0b_teacher_current', OLD = 'p0b_teacher_old'
const MOVED = 'p0b_teacher_moved', ARCHIVED = 'p0b_teacher_archived'
const STUDENT = 'p0b_student', ADMIN = 'p0b_admin'
const W = 'p0b_writing', SUB = `${STUDENT}_${W}`, SCORE = 'p0b_score'
let env
const dbFor = uid => env.authenticatedContext(uid).firestore()
const ref = (uid, path) => doc(dbFor(uid), path)
const scopeQuery = (uid, coll) => query(collection(dbFor(uid), coll),
  where('schoolId', '==', 'maxima'), where('teacherId', '==', uid))

before(async () => {
  assert.match(HOST, /^(127\.0\.0\.1|localhost):8081$/, 'STOP: local emulator:8081 required')
  assert.equal(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECT, PROJECT)
  const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8')
  assert.match(rules, /function teacherCurrentAcademicRecord\(data\)/)
  env = await initializeTestEnvironment({ projectId: PROJECT,
    firestore: { host: '127.0.0.1', port: 8081, rules } })
})
after(async () => { if (env) await env.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore()
    for (const school of ['maxima', 'other_school'])
      await setDoc(doc(db, `schools/${school}`), {status: 'active'})
    for (const [uid, extras] of Object.entries({
      [CURRENT]: {role: 'teacher', schoolId: 'maxima'},
      [OLD]: {role: 'teacher', schoolId: 'maxima'},
      [MOVED]: {role: 'teacher', schoolId: 'other_school'},
      [ARCHIVED]: {role: 'teacher', schoolId: 'maxima', archived: true},
      [STUDENT]: {role: 'student', schoolId: 'maxima', teacherIds: [CURRENT, OLD]},
      [ADMIN]: {role: 'admin', schoolId: 'maxima'}
    })) await setDoc(doc(db, `users/${uid}`), {status: 'approved', deleted: false, ...extras})
    const teacherIds = [OLD, CURRENT, MOVED, ARCHIVED]
    const source = {schoolId: 'maxima', teacherId: CURRENT, teacherIds, createdBy: OLD,
      archived: false}
    for (const [coll, id] of [['writingHomeworks', W], ['readings', 'p0b_reading'],
      ['listenings', 'p0b_listening'], ['mockTests', 'p0b_mock'], ['vocabularyTests', 'p0b_vocab']])
      await setDoc(doc(db, `${coll}/${id}`), source)
    const submission = {schoolId: 'maxima', uid: STUDENT, studentId: STUDENT,
      teacherId: CURRENT, teacherIds, submittedAt: '2026-10-20T12:00:00Z'}
    for (const [coll, id, extra] of [
      ['writingSubmissions', SUB, {writingId: W, task2Answer: 'SYNTHETIC TEST'}],
      ['readingSubmissions', 'p0b_readsub', {readingId: 'p0b_reading'}],
      ['listeningSubmissions', 'p0b_listsub', {listeningId: 'p0b_listening'}],
      ['mockSubmissions', 'p0b_mocksub', {mockTestId: 'p0b_mock'}],
      ['vocabularySubmissions', 'p0b_vocsub', {vocabularyTestId: 'p0b_vocab'}]
    ]) await setDoc(doc(db, `${coll}/${id}`), {...submission, ...extra})
    await setDoc(doc(db, `scores/${SCORE}`), {...submission, addedBy: OLD,
      source: 'mock_test', mockTestId: 'p0b_mock', writing: 6})
    await setDoc(doc(db, 'messages/p0b_message'), {schoolId: 'maxima', teacherId: OLD,
      teacherIds: [OLD], senderId: OLD, recipientIds: [STUDENT]})
  })
})

test('Current teacher retains writing get, list and review', async () => {
  await assertSucceeds(getDoc(ref(CURRENT, `writingSubmissions/${SUB}`)))
  await assertSucceeds(getDocs(scopeQuery(CURRENT, 'writingSubmissions')))
  await assertSucceeds(updateDoc(ref(CURRENT, `writingSubmissions/${SUB}`), {
    reviewed: true, reviewedAt: '2026-10-20T13:00:00Z', reviewedBy: CURRENT,
    review: {generalFeedback: 'Good progress'} }))
})
test('Current teacher retains score get, list and update', async () => {
  await assertSucceeds(getDoc(ref(CURRENT, `scores/${SCORE}`)))
  await assertSucceeds(getDocs(scopeQuery(CURRENT, 'scores')))
  await assertSucceeds(updateDoc(ref(CURRENT, `scores/${SCORE}`), {writing: 6.5}))
})
test('Former teacher: academic get and update denied despite old arrays and creator', async () => {
  for (const path of [`writingSubmissions/${SUB}`, `scores/${SCORE}`,
    'readingSubmissions/p0b_readsub', 'listeningSubmissions/p0b_listsub',
    'mockSubmissions/p0b_mocksub', 'vocabularySubmissions/p0b_vocsub'])
    await assertFails(getDoc(ref(OLD, path)))
  await assertFails(updateDoc(ref(OLD, `writingSubmissions/${SUB}`), {reviewed: true}))
  await assertFails(updateDoc(ref(OLD, `scores/${SCORE}`), {writing: 8}))
})
test('Moved school teacher: prior school academic data denied', async () => {
  await assertFails(getDoc(ref(MOVED, `writingSubmissions/${SUB}`)))
  await assertFails(getDoc(ref(MOVED, `scores/${SCORE}`)))
  await assertFails(updateDoc(ref(MOVED, `writingSubmissions/${SUB}`), {reviewed: true}))
  await assertFails(getDocs(query(collection(dbFor(MOVED), 'writingSubmissions'),
    where('teacherIds', 'array-contains', MOVED))))
  await assertFails(getDoc(ref(MOVED, `writingHomeworks/${W}`)))
})
test('Archived teacher profile: academic access is denied', async () => {
  await assertFails(getDoc(ref(ARCHIVED, `writingSubmissions/${SUB}`)))
  await assertFails(getDoc(ref(ARCHIVED, `scores/${SCORE}`)))
  await assertFails(updateDoc(ref(ARCHIVED, `writingSubmissions/${SUB}`), {reviewed: true}))
})
test('Stale arrays and addedBy are not academic list grants', async () => {
  for (const coll of ['writingSubmissions', 'scores'])
    await assertFails(getDocs(query(collection(dbFor(OLD), coll),
      where('schoolId', '==', 'maxima'), where('teacherIds', 'array-contains', OLD))))
  await assertFails(getDocs(query(collection(dbFor(OLD), 'scores'),
    where('schoolId', '==', 'maxima'), where('addedBy', '==', OLD))))
})
test('Teacher-created same-school content and message remain readable', async () => {
  await assertSucceeds(getDoc(ref(OLD, `writingHomeworks/${W}`)))
  await assertSucceeds(getDoc(ref(OLD, 'messages/p0b_message')))
})
test('Admin academic access retained; student cannot read answer record', async () => {
  await assertSucceeds(getDoc(ref(ADMIN, `writingSubmissions/${SUB}`)))
  await assertSucceeds(getDocs(collection(dbFor(ADMIN), 'scores')))
  await assertFails(getDoc(ref(STUDENT, `writingSubmissions/${SUB}`)))
})
test('Teacher cannot modify answers, identities or student attempt fields', async () => {
  await assertFails(updateDoc(ref(CURRENT, `writingSubmissions/${SUB}`), {teacherId: OLD}))
  await assertFails(updateDoc(ref(CURRENT, `writingSubmissions/${SUB}`), {task2Answer: 'ALTERED'}))
})
test('Current teacher cannot rewrite score owner or student while changing band', async () => {
  await assertFails(updateDoc(ref(CURRENT, `scores/${SCORE}`), {teacherId: OLD}))
  await assertFails(updateDoc(ref(CURRENT, `scores/${SCORE}`), {uid: 'p0b_another_student'}))
  await assertFails(updateDoc(ref(CURRENT, `scores/${SCORE}`), {schoolId: 'other_school'}))
  await assertFails(updateDoc(ref(CURRENT, `scores/${SCORE}`), {mockTestId: 'another_mock'}))
})
