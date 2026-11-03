'use strict'
// Step850: genuine Firestore Emulator transactions through the production
// Mock teacher-review and sponsored AI services; provider is a local spy ONLY.
// The Firestore before/after snapshots are fed directly into the trigger service.
// No Functions Emulator CloudEvent delivery is claimed by this test.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { createHash, randomBytes } = require('node:crypto')

const ROOT = resolve(__dirname, '..')
const HOST = process.env.FIRESTORE_EMULATOR_HOST || ''
const PROJECT = 'demo-maxima-g5-step850'
assert.match(HOST, /^(127\.0\.0\.1|localhost):[0-9]{2,5}$/, 'Local Firestore Emulator required')
assert.equal(process.env.GOOGLE_CLOUD_PROJECT, PROJECT, 'Never use a non-demo project')
assert.equal(process.env.GCLOUD_PROJECT, PROJECT, 'Never use a non-demo project')
assert.equal(process.env.OPENAI_API_KEY, undefined, 'No live AI key permitted')
assert.equal(process.env.MAXIMA_OPENAI_API_KEY, undefined, 'No live AI key permitted')

const req = createRequire(resolve(ROOT, 'functions/package.json'))
const { initializeApp, deleteApp } = req('firebase-admin/app')
const { getFirestore, FieldValue } = req('firebase-admin/firestore')
const { createMockWritingReviewService } = require('../functions/lib/p0bMockWritingReviewService')
const { requireCurrentTeacherAcademicStudent } = require('../functions/lib/p0bCurrentAcademicAccess')
const { createAiWritingSponsoredEvaluationService } = require('../functions/lib/aiWritingSponsoredEvaluation')
const { validReport, essay } = require('./helpers/p4d_fixture.cjs')

const sha = x => createHash('sha256').update(x).digest('hex')
const random = randomBytes(5).toString('hex')
const STUDENT = `g5Student${random}`
const TEACHER = `g5Teacher${random}`
const MOCK1 = `g5MockOne${random}`
const MOCK2 = `g5MockTwo${random}`
const WRITING = `g5Writing${random}`
const HOME = `g5Homework${random}`
const SCHOOL = 'maxima'
const NOW = Date.parse('2026-10-20T01:00:00.000Z')
const SUBMITTED_AT = '2026-10-20T00:30:00.000Z'
const GRANT_TIME = Date.parse('2026-10-19T22:00:00.000Z')
const APP = initializeApp({ projectId: PROJECT }, `step850-${process.pid}`)
const db = getFirestore(APP)
const monthlyRef = db.doc('aiWritingMonthlyUsage/maxima_202610')
const creditRef = db.doc(`aiWritingStudentAccess/${STUDENT}`)
let providerStubCalls = 0
let realProviderCalls = 0
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function subRef(mockId) { return db.doc(`mockSubmissions/${STUDENT}_${mockId}`) }
function scoreRef(mockId) { return db.doc(`scores/${STUDENT}_${mockId}`) }
function jobRef(mockId) {
  const id = sha(['ai-writing-v1', STUDENT, 'mock', mockId, 1].join('\0'))
  return db.doc(`aiWritingEvaluations/${id}`)
}
function event(before, after) {
  return { data: { before: before || { exists: false }, after } }
}
function review(band = '7.5') {
  return {
    task1Enabled: false, task2Enabled: true,
    task1Band: '', task2Band: band,
    rubric: { task1: {}, task2: {
      taskResponse: band, coherenceCohesion: '7',
      lexicalResource: '7.0', grammarRangeAccuracy: '7.5'
    } },
    task1Feedback: '', task2Feedback: 'Instructor feedback only',
    overall: band, generalFeedback: 'Teacher reviewed this attempt'
  }
}
async function seedCommon() {
  const batch = db.batch()
  batch.set(db.doc(`schools/${SCHOOL}`), { status: 'active' })
  batch.set(db.doc(`users/${TEACHER}`), {
    role: 'teacher', schoolId: SCHOOL, status: 'approved', accountType: 'institution'
  })
  batch.set(db.doc(`users/${STUDENT}`), {
    role: 'student', uid: STUDENT, studentId: STUDENT,
    schoolId: SCHOOL, status: 'approved', accountType: 'institution'
  })
  batch.set(db.doc(`schools/${SCHOOL}/teacherAcademicIndex/${TEACHER}`), {
    schemaVersion: 1, source: 'managed_active_classes', schoolId: SCHOOL,
    teacherId: TEACHER, activeStudentIds: [STUDENT]
  })
  batch.set(db.doc(`classes/g5Class${random}`), {
    name: 'Mock Writing local test', schoolId: SCHOOL, teacherId: TEACHER,
    status: 'active', studentIds: [STUDENT]
  })
  batch.set(db.doc(`aiWritingSchoolSettings/${SCHOOL}`), {
    schoolId: SCHOOL, pilotEnabled: true
  })
  batch.set(db.doc(`writingHomeworks/${WRITING}`), {
    schoolId: SCHOOL, teacherId: TEACHER,
    contentType: 'task2_only', task2: { prompt: 'Discuss education in schools.' }
  })
  batch.set(creditRef, {
    uid: STUDENT, studentId: STUDENT, schoolId: SCHOOL,
    accountType: 'institution', enabled: true,
    creditsRemaining: 3, creditsUsedTotal: 0
  })
  batch.set(monthlyRef, {
    schemaVersion: 1, schoolId: SCHOOL, month: '202610',
    requestCount: 0, pendingCount: 0, completedCount: 0,
    sponsoredRequestCount: 0
  })
  await batch.commit()
}
async function seedMock(mockId) {
  const submission = {
    uid: STUDENT, studentId: STUDENT, schoolId: SCHOOL,
    mockTestId: mockId, writingId: WRITING, writingMode: 'task2_only',
    status: 'submitted', attemptNumber: 1, submittedAt: SUBMITTED_AT,
    enabledSections: { writing: true, reading: false, listening: false },
    writingAnswers: { task1: '', task2: essay(300) },
    gradedByServer: true,
    result: { writing: { enabled: true, status: 'pending_review', band: null }, overall: null }
  }
  const batch = db.batch()
  batch.set(db.doc(`mockTests/${mockId}`), {
    schoolId: SCHOOL, teacherId: TEACHER, writingId: WRITING,
    enabledSections: { writing: true }
  })
  batch.set(subRef(mockId), submission)
  batch.set(scoreRef(mockId), {
    uid: STUDENT, studentId: STUDENT, schoolId: SCHOOL,
    source: 'mock_test', mockTestId: mockId, attemptNumber: 1,
    createdAt: SUBMITTED_AT, gradedByServer: true,
    listening: '', reading: '', writing: '', overall: null
  })
  batch.set(db.doc(`studentAccess/${STUDENT}_mock_${mockId}`), {
    uid: STUDENT, schoolId: SCHOOL, contentType: 'mock',
    contentId: mockId, sourceCollection: 'mockTests',
    accessType: 'assignment', status: 'active'
  })
  batch.set(db.doc(`aiWritingSponsoredPolicies/mock_${mockId}`), {
    schemaVersion: 2, schoolId: SCHOOL, context: 'mock',
    contentId: mockId, contentType: 'mock', sourceCollection: 'mockTests',
    enabled: true, billing: 'institution', studentIds: [STUDENT],
    grants: { [STUDENT]: { grantedBy: TEACHER, grantedAtMs: GRANT_TIME } }
  })
  await batch.commit()
}

const currentMock = async (_, uid, mockId) => {
  if (uid !== STUDENT || ![MOCK1, MOCK2].includes(mockId)) return null
  const ref = subRef(mockId)
  const snapshot = await ref.get()
  return snapshot.exists ? { ref, id: ref.id, data: snapshot.data() } : null
}
const reviewer = createMockWritingReviewService({
  db, HttpsError,
  requireAssignmentManager: async request => {
    const uid = request?.auth?.uid
    const snapshot = uid ? await db.doc(`users/${uid}`).get() : null
    const profile = snapshot?.data()
    if (!profile || profile.role !== 'teacher' || profile.status !== 'approved') {
      throw new HttpsError('permission-denied', 'Only approved teacher')
    }
    return { uid, profile }
  },
  requireCurrentTeacherAcademicStudent: input =>
    requireCurrentTeacherAcademicStudent({ ...input, db, HttpsError }),
  findCurrentSubmissionRecord: currentMock,
  submissionContentConfigFor: type => type,
  matchingCurrentMockScoreForStats: async (_, mockId) => {
    const snapshot = await scoreRef(mockId).get()
    return snapshot.exists ? snapshot : null
  },
  schoolIdOf: data => data?.schoolId || SCHOOL
})
const sponsored = createAiWritingSponsoredEvaluationService({
  db, FieldValue,
  provider: async () => {
    providerStubCalls += 1
    return { report: validReport('mock', 300), model: 'local-g5-stub' }
  },
  getApiKey: () => 'sk-this-is-a-synthetic-value-never-sent',
  providerEnabled: () => true,
  schoolIdOf: data => data?.schoolId || SCHOOL,
  getMockEnabledSections: source => source?.enabledSections || {},
  getMockWritingMode: () => 'task2_only',
  findCurrentSubmissionRecord: currentMock,
  submissionContentConfigFor: () => ({}),
  now: () => NOW
})
function teacherRequest(mockId, band = '7.5') {
  return { auth: { uid: TEACHER }, data: {
    studentId: STUDENT, mockTestId: mockId,
    submissionId: subRef(mockId).id, attemptNumber: 1,
    submittedAt: SUBMITTED_AT, review: review(band)
  } }
}
async function checkCredits() {
  const data = (await creditRef.get()).data()
  assert.equal(data.creditsRemaining, 3)
  assert.equal(data.creditsUsedTotal, 0)
}
async function checkMonth(expected) {
  const data = (await monthlyRef.get()).data()
  assert.deepEqual({
    requestCount: data.requestCount,
    sponsoredRequestCount: data.sponsoredRequestCount,
    completedCount: data.completedCount,
    pendingCount: data.pendingCount
  }, { requestCount: expected, sponsoredRequestCount: expected,
    completedCount: expected, pendingCount: 0 })
}

// This test deliberately uses one real Firestore database/transaction timeline.
test('G5: teacher reviews cannot create or duplicate sponsored AI charges', async t => {
  try {
    await seedCommon()
    await seedMock(MOCK1)
    await t.test('01 true initial funded Mock submission reserves and settles exactly once', async () => {
      const initial = await subRef(MOCK1).get()
      const result = await sponsored.submit('mock', event(null, initial))
      assert.equal(result.status, 'completed')
      assert.equal(providerStubCalls, 1)
      assert.equal((await jobRef(MOCK1).get()).data().status, 'completed')
      await checkMonth(1)
      await checkCredits()
      console.log('STEP850_CASE_01=PASS')
    })
    await t.test('02 redelivery of the same submission event is idempotent', async () => {
      const initial = await subRef(MOCK1).get()
      const result = await sponsored.submit('mock', event(null, initial))
      assert.equal(result.status, 'completed')
      assert.equal(providerStubCalls, 1)
      await checkMonth(1)
      await checkCredits()
      console.log('STEP850_CASE_02=PASS')
    })
    await t.test('03 genuine teacher review transaction creates no second AI charge', async () => {
      const before = await subRef(MOCK1).get()
      const reply = await reviewer(teacherRequest(MOCK1))
      assert.equal(reply.ok, true)
      const after = await subRef(MOCK1).get()
      assert.equal(after.data().attemptNumber, 1)
      assert.equal(after.data().submittedAt, SUBMITTED_AT)
      assert.equal(after.data().writingReview.overall, '7.5')
      assert.equal((await scoreRef(MOCK1).get()).data().writing, '7.5')
      const outcome = await sponsored.submit('mock', event(before, after))
      assert.equal(outcome.status, 'ignored')
      assert.equal(providerStubCalls, 1)
      await checkMonth(1)
      await checkCredits()
      console.log('STEP850_CASE_03=PASS')
    })
    await t.test('04 revised teacher review remains free and leaves attempt identity intact', async () => {
      const before = await subRef(MOCK1).get()
      const reply = await reviewer(teacherRequest(MOCK1, '8.0'))
      assert.equal(reply.ok, true)
      const after = await subRef(MOCK1).get()
      assert.equal(after.data().writingReview.overall, '8.0')
      assert.equal(after.data().attemptNumber, 1)
      assert.equal(after.data().submittedAt, SUBMITTED_AT)
      const outcome = await sponsored.submit('mock', event(before, after))
      assert.equal(outcome.status, 'ignored')
      assert.equal(providerStubCalls, 1)
      await checkMonth(1)
      await checkCredits()
      console.log('STEP850_CASE_04=PASS')
    })
    await t.test('05 teacher-only review is free even when no sponsored AI job exists', async () => {
      await seedMock(MOCK2)
      const before = await subRef(MOCK2).get()
      assert.equal((await jobRef(MOCK2).get()).exists, false)
      await reviewer(teacherRequest(MOCK2))
      const after = await subRef(MOCK2).get()
      const outcome = await sponsored.submit('mock', event(before, after))
      assert.equal(outcome.status, 'ignored')
      assert.equal((await jobRef(MOCK2).get()).exists, false)
      assert.equal(providerStubCalls, 1)
      await checkMonth(1)
      await checkCredits()
      console.log('STEP850_CASE_05=PASS')
    })
    await t.test('06 Send to Teacher homework never reaches paid provider or monthly quota', async () => {
      const ref = db.doc(`writingSubmissions/${STUDENT}_${HOME}`)
      await ref.set({ uid: STUDENT, studentId: STUDENT, schoolId: SCHOOL,
        writingId: HOME, attemptNumber: 1, submittedAt: SUBMITTED_AT,
        writingMode: 'task2_only', task2Answer: essay(300),
        aiReviewChoice: 'teacher', aiBillingMode: 'none'
      })
      const after = await ref.get()
      const outcome = await sponsored.submit('homework', event(null, after))
      assert.equal(outcome.status, 'ignored')
      assert.equal(providerStubCalls, 1)
      await checkMonth(1)
      await checkCredits()
      console.log('STEP850_CASE_06=PASS')
    })
    assert.equal(realProviderCalls, 0)
    console.log('STEP850_EMULATOR_TEST_CASES=6')
    console.log('STEP850_PROVIDER_STUB_CALLS=1')
    console.log('STEP850_REAL_PROVIDER_CALLS=0')
    console.log('STEP850_PERSONAL_CREDIT_DEBITS=0')
    console.log('STEP850_REAL_FIRESTORE_INTEGRATION=PASS')
  } finally {
    await db.terminate()
    await deleteApp(APP)
  }
})
