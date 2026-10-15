'use strict'
/*
 * MAXIMA Mock Writing regression, all synthetic data on Firestore Emulator.
 * NO production access, NO Admin SDK, NO mutation of source project.
 * This is intentionally a regression on the checked-in firestore.rules; it
 * does not infer what rules are currently deployed in production.
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const PROJECT = 'demo-maxima-tracker'
const host = process.env.FIRESTORE_EMULATOR_HOST || ''
if (!/^(127\.0\.0\.1|localhost):\d{2,5}$/.test(host)) {
  console.error('SAFETY STOP: FIRESTORE_EMULATOR_HOST must be localhost.')
  process.exit(2)
}
if ((process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== PROJECT) ||
    (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== PROJECT)) {
  console.error('SAFETY STOP: Unexpected project ID.')
  process.exit(2)
}

const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing')
const { doc, getDocFromServer, setDoc, updateDoc, serverTimestamp } = require('firebase/firestore')

const U = 'mock-regression-student'
const T = 'mock-regression-teacher'
const T2 = 'mock-regression-other-teacher'
const M = 'mock-regression-mini'
const MF = 'mock-regression-full'
const W = 'mock-regression-writing'
const W2 = 'mock-regression-other-writing'
const M2 = 'mock-regression-stolen-writing'
const SCHOOL = 'maxima'
let passed = 0, failed = 0

async function expect(label, fn) {
  try { await fn(); passed++; console.log('PASS ' + label) }
  catch (err) { failed++; console.error('FAIL ' + label + ' :: ' + (err?.code || '') + ' ' + (err?.message || err)) }
}
const asData = async (db, name, value) => setDoc(doc(db, name), value)

async function main() {
  const rules = fs.readFileSync(path.resolve(__dirname, 'firestore.rules'), 'utf8')
  if (!rules.includes('match /mockResourceAccess/') || !rules.includes('studentCanGetMockResource')) {
    throw new Error('Missing scoped Mock Writing rules: aborting.')
  }
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules } })
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore()
      await asData(db, 'schools/maxima', { status: 'active' })
      await asData(db, `users/${U}`, { role: 'student', status: 'approved', schoolId: SCHOOL, deleted: false })
      await asData(db, `users/${T}`, { role: 'teacher', status: 'approved', schoolId: SCHOOL, deleted: false })
      await asData(db, `users/${T2}`, { role: 'teacher', status: 'approved', schoolId: SCHOOL, deleted: false })
      for (const id of [M, MF]) {
        await asData(db, `mockTests/${id}`, {
          schoolId: SCHOOL, createdBy: T, teacherId: T, teacherIds: [T],
          mockType: id === M ? 'mini_mock' : 'full_mock', archived: false,
          visibility: 'private', enabledSections: { listening: false, reading: false, writing: true },
          writingId: W
        })
        await asData(db, `studentAccess/${U}_mock_${id}`, {
          uid: U, contentType: 'mock', contentId: id,
          status: 'active', schoolId: SCHOOL
        })
      }
      await asData(db, `writingHomeworks/${W}`, {
        schoolId: SCHOOL, createdBy: T, teacherId: T, teacherIds: [T],
        visibility: 'private', archived: false,
        task1Prompt: 'Synthetic Task 1', task2Prompt: 'Synthetic Task 2'
      })
      await asData(db, `mockTests/${M2}`, {
        schoolId: SCHOOL, createdBy: T, teacherId: T, teacherIds: [T],
        mockType: 'mini_mock', archived: false, visibility: 'private',
        enabledSections: { listening: false, reading: false, writing: true },
        writingId: W2
      })
      await asData(db, `studentAccess/${U}_mock_${M2}`, {
        uid: U, contentType: 'mock', contentId: M2, status: 'active', schoolId: SCHOOL
      })
      await asData(db, `writingHomeworks/${W2}`, {
        schoolId: SCHOOL, createdBy: T2, teacherId: T2, teacherIds: [T2],
        visibility: 'private', archived: false,
        task2Prompt: 'Synthetic private, unrelated source'
      })
    })
    const s = env.authenticatedContext(U).firestore()
    await expect('student reads its active Mini Mock', () => assertSucceeds(getDocFromServer(doc(s, `mockTests/${M}`))))
    await expect('student reads its active Full Mock', () => assertSucceeds(getDocFromServer(doc(s, `mockTests/${MF}`))))
    await expect('private Writing without grant is denied', () => assertFails(getDocFromServer(doc(s, `writingHomeworks/${W}`))))

    const referencePath = `mockResourceAccess/${U}/writingHomeworks/${W}`
    const mkRef = mockTestId => ({
      uid: U, mockTestId, sourceCollection: 'writingHomeworks',
      sourceId: W, schemaVersion: 1, updatedAt: serverTimestamp()
    })
    await expect('student can create valid linked Writing reference',
      () => assertSucceeds(setDoc(doc(s, referencePath), mkRef(M))))
    await expect('student reads its own Writing reference',
      () => assertSucceeds(getDocFromServer(doc(s, referencePath))))
    await expect('student reads linked private Writing through Mini Mock',
      () => assertSucceeds(getDocFromServer(doc(s, `writingHomeworks/${W}`))))

    await env.withSecurityRulesDisabled(async ctx => {
      await asData(ctx.firestore(), referencePath, {
        uid: U, mockTestId: MF, sourceCollection: 'writingHomeworks',
        sourceId: W, schemaVersion: 1
      })
    })
    await expect('existing Full Mock reference permits linked Writing read',
      () => assertSucceeds(getDocFromServer(doc(s, `writingHomeworks/${W}`))))

    await env.withSecurityRulesDisabled(async ctx => {
      await asData(ctx.firestore(), `mockResourceAccess/${U}/writingHomeworks/${W2}`, {
        uid: U, mockTestId: MF, sourceCollection: 'writingHomeworks',
        sourceId: W2, schemaVersion: 1
      })
    })
    await expect('forged reference to unrelated Writing stays denied',
      () => assertFails(getDocFromServer(doc(s, `writingHomeworks/${W2}`))))
    await env.withSecurityRulesDisabled(async ctx => {
      await asData(ctx.firestore(), `mockResourceAccess/${U}/writingHomeworks/${W2}`, {
        uid: U, mockTestId: M2, sourceCollection: 'writingHomeworks',
        sourceId: W2, schemaVersion: 1
      })
    })
    await expect('different teacher private Writing stays denied despite mock link',
      () => assertFails(getDocFromServer(doc(s, `writingHomeworks/${W2}`))))

    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), `studentAccess/${U}_mock_${MF}`), { status: 'inactive' })
    })
    await expect('revoked Full Mock reference cannot read Writing',
      () => assertFails(getDocFromServer(doc(s, `writingHomeworks/${W}`))))
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), `studentAccess/${U}_mock_${MF}`), { status: 'active' })
      await updateDoc(doc(ctx.firestore(), `mockTests/${MF}`), { archived: true })
    })
    await expect('archived Full Mock reference cannot read Writing',
      () => assertFails(getDocFromServer(doc(s, `writingHomeworks/${W}`))))
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), `mockTests/${MF}`), { archived: false })
    })
    await expect('restored active Full Mock reference permits Writing again',
      () => assertSucceeds(getDocFromServer(doc(s, `writingHomeworks/${W}`))))

    // All fixtures are isolated from live Firestore. No user data in outputs.
    console.log(`\nMAXIMA MOCK WRITING RULES REGRESSION: ${passed}/${passed + failed} PASS, ${failed} FAIL`)
    if (failed) process.exitCode = 1
  } finally {
    await env.cleanup()
  }
}
main().catch(e => { console.error('TEST ERROR:', e?.stack || e); process.exitCode = 1 })
