// P8-A Firestore rules tests. Run ONLY against the local emulator:
//   firebase emulators:exec --only firestore "node --test tests/rules_p8a_submission_updates.test.mjs"
// Never point this at production. Synthetic fixtures only.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, setDoc, updateDoc } from 'firebase/firestore'

let env
const T = 'teacher1234', S = 'student1234', W = 'writing1234', M = 'mock123456'

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-maxima-p8a',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }
  })
})
after(async () => { await env?.cleanup() })
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'schools/maxima'), { status: 'active' })
    await setDoc(doc(db, `users/${T}`), { role: 'teacher', status: 'approved', schoolId: 'maxima' })
    await setDoc(doc(db, `users/${S}`), { role: 'student', status: 'approved', schoolId: 'maxima', teacherIds: [T] })
    await setDoc(doc(db, `writingHomeworks/${W}`), { schoolId: 'maxima', teacherId: T, teacherIds: [T] })
    await setDoc(doc(db, `writingSubmissions/${S}_${W}`), {
      uid: S, studentId: S, schoolId: 'maxima', teacherId: T, teacherIds: [T], writingId: W,
      attemptNumber: 1, submittedAt: '2026-10-18T10:00:00.000Z', task2Answer: 'original',
      aiReviewChoice: 'teacher', aiBillingMode: 'none', reviewed: false, review: null
    })
    await setDoc(doc(db, `mockTests/${M}`), { schoolId: 'maxima', teacherId: T, teacherIds: [T] })
    await setDoc(doc(db, `mockSubmissions/${S}_${M}`), {
      uid: S, studentId: S, schoolId: 'maxima', teacherId: T, teacherIds: [T], mockTestId: M,
      attemptNumber: 1, submittedAt: '2026-10-18T10:00:00.000Z', status: 'submitted', result: { reading: { band: 6 }, listening: { band: 7 }, writing: { band: 5 }, overall: 6 }
    })
  })
})

const teacherDb = () => env.authenticatedContext(T).firestore()

test('teacher can still save a Writing review (existing UI payload)', async () => {
  await assertSucceeds(updateDoc(doc(teacherDb(), `writingSubmissions/${S}_${W}`), {
    reviewed: true, reviewedAt: '2026-10-18T11:00:00.000Z', reviewedBy: T, review: { overall: '6.5' }
  }))
})

for (const [label, patch] of [
  ['bump attempt + AI billing (would look like a new paid attempt)', { attemptNumber: 2, submittedAt: '2026-10-18T12:00:00.000Z', aiReviewChoice: 'ai', aiBillingMode: 'institution' }],
  ['rewrite student answer', { task2Answer: 'teacher text' }],
  ['move submission to another student', { uid: 'student9999', studentId: 'student9999' }]
]) {
  test(`teacher browser cannot ${label}`, async () => {
    await assertFails(updateDoc(doc(teacherDb(), `writingSubmissions/${S}_${W}`), patch))
  })
}

test('teacher can still save Mock Writing review fields', async () => {
  await assertSucceeds(updateDoc(doc(teacherDb(), `mockSubmissions/${S}_${M}`), {
    reviewedAt: 'x', reviewedBy: T, writingReview: { status: 'reviewed' }, result: { reading: { band: 6 }, listening: { band: 7 }, writing: { band: 6.5 }, overall: 6.5 }
  }))
})

test('teacher cannot rewrite Mock Reading or Listening score through result', async () => {
  const db = teacherDb()
  await assertFails(updateDoc(doc(db, `mockSubmissions/${S}_${M}`), {
    result: { reading: { band: 9 }, listening: { band: 9 }, writing: { band: 5 }, overall: 6 }
  }))
})

test('teacher can edit Mock Writing and overall but must preserve objective scores', async () => {
  const db = teacherDb()
  const result = {
    reading: { band: 6 }, listening: { band: 7 },
    writing: { band: 6.5, effectiveBandSource: 'teacher' },
    overall: 6.5, finalOverall: 6.5, reviewedOverall: 6.5,
    overallEstimate: 6.5
  }
  await assertSucceeds(updateDoc(doc(db, `mockSubmissions/${S}_${M}`), {
    reviewedAt: '2026-10-18T11:00:00.000Z', reviewedBy: T,
    writingReview: { overall: 6.5 }, result
  }))
})

test('teacher browser cannot bump a Mock attempt', async () => {
  await assertFails(updateDoc(doc(teacherDb(), `mockSubmissions/${S}_${M}`), {
    attemptNumber: 2, submittedAt: '2026-10-18T12:00:00.000Z'
  }))
})

test('student still cannot write submissions directly', async () => {
  const db = env.authenticatedContext(S).firestore()
  await assertFails(updateDoc(doc(db, `writingSubmissions/${S}_${W}`), { task2Answer: 'x' }))
})

test('sanity: rules file parsed', () => assert.ok(env))
