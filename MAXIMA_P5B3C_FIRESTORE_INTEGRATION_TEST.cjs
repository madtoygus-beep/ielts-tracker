'use strict'

// P5B-3C: Firestore Emulator-backed verification of sponsored auto evaluation.
// Absolutely no real OpenAI call, cloud Firestore access, student credit charge,
// Firebase deployment, or secret access. Only run inside demo-maxima-tracker.

const assert = require('node:assert/strict')
const { randomBytes, createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const path = require('node:path')

const DEMO_PROJECT = 'demo-maxima-tracker'
const month = '202610'
const NOW = Date.parse('2026-10-15T12:00:00Z')
const SUBMITTED_AT = '2026-10-15T10:00:00.000Z'
const POLICY_AT = '2026-10-15T09:00:00.000Z'
const MOCK_SECRET = 'sk-emulator-stub-no-real-api-request-000001'

// Fail closed BEFORE initializing an SDK or touching a database.
const host = process.env.FIRESTORE_EMULATOR_HOST || ''
const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
let firebaseProject = ''
try {
  firebaseProject = JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId || ''
} catch (_) {
  console.error('REFUSED: FIREBASE_CONFIG is malformed.')
  process.exit(2)
}
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) ||
    (project && project !== DEMO_PROJECT) ||
    (firebaseProject && firebaseProject !== DEMO_PROJECT)) {
  console.error('REFUSED: Must run against the local demo-maxima-tracker Firestore Emulator.')
  process.exit(2)
}

let admin
try {
  // Resolve dependencies from the deployed Functions code's own package root.
  const functionsRequire = createRequire(path.join(__dirname, 'functions', 'package.json'))
  admin = functionsRequire('firebase-admin')
} catch (error) {
  console.error('firebase-admin not installed under functions/. Install Functions dependencies locally before running this test.')
  process.exit(2)
}

const {
  createAiWritingSponsoredEvaluationService
} = require('./functions/lib/aiWritingSponsoredEvaluation')
const { normalizeAiWritingReport } = require('./functions/lib/aiWritingGrading')

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex')
const suffix = () => randomBytes(6).toString('hex')
const appName = 'p5b3c-real-firestore-' + suffix()
const app = admin.initializeApp({ projectId: DEMO_PROJECT }, appName)
const db = admin.firestore(app)
const FieldValue = admin.firestore.FieldValue
const Timestamp = admin.firestore.Timestamp
const monthlyRef = db.doc(`aiWritingMonthlyUsage/maxima_${month}`)
const makeEvent = (after, before = null) => ({
  data: {
    before: before || { exists: false },
    after
  }
})

function providerReport(prepared) {
  const task = () => ({
    criteria: {
      taskAchievementOrResponse: { band: 6.5, explanation: 'Task addressed.', evidence: '' },
      coherenceAndCohesion: { band: 6.5, explanation: 'Well organized.', evidence: '' },
      lexicalResource: { band: 6.5, explanation: 'Accurate vocabulary.', evidence: '' },
      grammaticalRangeAndAccuracy: { band: 6.5, explanation: 'Mostly accurate.', evidence: '' }
    },
    overview: 'Develops the main point.', strengths: [], priorities: [], corrections: []
  })
  return normalizeAiWritingReport({
    task1: prepared.task1 ? task() : null,
    task2: prepared.task2 ? task() : null
  }, prepared)
}

async function fixture({ context = 'homework', selected = true, pilotEnabled = true,
  autoEnabled = true, userType = 'institution', onProvider = null } = {}) {
  const id = suffix()
  const uid = `stu${id}`
  const contentId = context === 'mock' ? `mock${id}` : `wr${id}`
  const linkedWritingId = `link${id}`
  const contentType = context === 'mock' ? 'mock' : 'writing'
  const sourceCollection = context === 'mock' ? 'mockTests' : 'writingHomeworks'
  const submissionCollection = context === 'mock' ? 'mockSubmissions' : 'writingSubmissions'
  const sourceField = context === 'mock' ? 'mockTestId' : 'writingId'
  const sourceRef = db.doc(`${sourceCollection}/${contentId}`)
  const subRef = db.doc(`${submissionCollection}/${uid}_${contentId}`)
  const policyRef = db.doc(`aiWritingSponsoredPolicies/${contentType}_${contentId}`)
  const assignmentRef = db.doc(`studentAccess/${uid}_${contentType}_${contentId}`)
  const creditRef = db.doc(`aiWritingStudentAccess/${uid}`)
  const jobId = sha(['ai-writing-v1', uid, context, contentId, 1].join('\0'))
  const jobRef = db.doc(`aiWritingEvaluations/${jobId}`)
  const submission = {
    uid, studentId: uid, schoolId: 'maxima', attemptNumber: 1,
    submittedAt: SUBMITTED_AT, writingMode: 'task2_only', task1Enabled: false,
    task2Enabled: true,
    ...(context === 'mock' ? {
      mockTestId: contentId, writingId: linkedWritingId,
      enabledSections: { writing: true }, status: 'submitted',
      writingAnswers: { task1: '', task2: 'Education improves quality of life.' },
      teacherFinalScore: 7.0, teacherNotes: 'Original human review.'
    } : {
      writingId: contentId, task1Answer: '',
      task2Answer: 'Education improves quality of life.'
    })
  }
  const writingSource = {
    schoolId: 'maxima', contentType: 'task2_only',
    task2: { title: 'Task 2', prompt: 'Discuss the value of education.' }
  }
  const source = context === 'mock' ? {
    schoolId: 'maxima', writingId: linkedWritingId,
    enabledSections: { writing: true, listening: false, reading: false }
  } : writingSource

  const writes = [
    db.doc(`users/${uid}`).set({
      role: 'student', status: 'approved', schoolId: 'maxima', accountType: userType
    }),
    db.doc('schools/maxima').set({ status: 'active' }),
    db.doc('aiWritingSchoolSettings/maxima').set({ schoolId: 'maxima', pilotEnabled }),
    sourceRef.set(source),
    policyRef.set({
      enabled: true, schoolId: 'maxima', contentId, contentType, context,
      sourceCollection, studentIds: selected ? [uid] : [`else${id}`],
      billing: 'institution', updatedAt: Timestamp.fromDate(new Date(POLICY_AT))
    }),
    assignmentRef.set({
      uid, schoolId: 'maxima', contentId, contentType, sourceCollection,
      accessType: 'assignment', status: 'active', adminHidden: false
    }),
    creditRef.set({
      uid, schoolId: 'maxima', creditsRemaining: 5,
      creditsUsedTotal: 0, testMarker: id
    }),
    subRef.set(submission)
  ]
  if (context === 'mock') {
    writes.push(db.doc(`writingHomeworks/${linkedWritingId}`).set(writingSource))
  }
  await Promise.all(writes)

  let calls = 0
  const service = createAiWritingSponsoredEvaluationService({
    db, FieldValue,
    getApiKey: () => MOCK_SECRET,
    providerEnabled: () => autoEnabled,
    provider: async (prepared, key) => {
      assert.equal(key, MOCK_SECRET)
      calls += 1
      if (onProvider) return onProvider(prepared, {
        db, uid, subRef, policyRef, creditRef, jobRef, monthlyRef
      })
      return { report: providerReport(prepared), model: 'local-fake-grader', providerResponseId: 'emulator-only' }
    },
    schoolIdOf: obj => obj?.schoolId || 'maxima',
    getMockEnabledSections: obj => obj?.enabledSections || { writing: false },
    getMockWritingMode: (_mockSource, writing) => writing?.contentType,
    submissionContentConfigFor: type => ({
      submissionCollection: type === 'mock' ? 'mockSubmissions' : 'writingSubmissions'
    }),
    findCurrentSubmissionRecord: async (config, studentUid, assignmentId) => {
      const ref = db.doc(`${config.submissionCollection}/${studentUid}_${assignmentId}`)
      const snap = await ref.get()
      return snap.exists ? { ref: snap.ref, data: snap.data() } : null
    },
    now: () => NOW
  })
  const initial = await subRef.get()
  return {
    context, uid, contentId, contentType, subRef, sourceRef,
    policyRef, assignmentRef, creditRef, jobRef, submission,
    service, initial,
    calls: () => calls,
    evaluate: (snap = initial, before = null) => service.submit(context, makeEvent(snap, before)),
    jobFor: attempt => db.doc(`aiWritingEvaluations/${sha(['ai-writing-v1', uid, context, contentId, attempt].join('\0'))}`)
  }
}

async function monthly() {
  const snap = await monthlyRef.get()
  return snap.exists ? snap.data() : null
}

async function hasDoc(ref) { return (await ref.get()).exists }

async function test(name, run) {
  // Every scenario has its own source/submission. Clear just the demo budget.
  await monthlyRef.delete()
  try {
    await run()
    console.log('PASS', name)
    return true
  } catch (e) {
    console.error('FAIL', name, e?.stack || e)
    return false
  }
}

async function main() {
  let passed = 0
  let failed = 0
  const check = async (label, callback) => {
    if (await test(label, callback)) passed += 1
    else failed += 1
  }

  await check('OFF switch prevents any job, budget or provider call', async () => {
    const f = await fixture({ autoEnabled: false })
    assert.equal((await f.evaluate()).status, 'disabled')
    assert.equal(f.calls(), 0)
    assert.equal(await hasDoc(f.jobRef), false)
    assert.equal(await monthly(), null)
  })

  await check('Writing completes one institutional job with valid IELTS rubric', async () => {
    const f = await fixture()
    const beforeCredits = (await f.creditRef.get()).data()
    assert.equal((await f.evaluate()).status, 'completed')
    const job = (await f.jobRef.get()).data()
    assert.equal(job.billing, 'institution')
    assert.equal(job.billingMode, 'sponsored_auto')
    assert.equal(job.status, 'completed')
    assert.equal(job.report.isAiEstimate, true)
    assert.equal(job.report.estimatedBand, 6.5)
    assert.equal(Object.keys(job.report.task2.criteria).length, 4)
    assert.equal(job.report.teacherFinalScore, null)
    assert.equal(f.calls(), 1)
    assert.deepEqual((await f.creditRef.get()).data(), beforeCredits)
    const budget = await monthly()
    assert.equal(budget.requestCount, 1)
    assert.equal(budget.sponsoredRequestCount, 1)
    assert.equal(budget.pendingCount, 0)
    assert.equal(budget.completedCount, 1)
  })

  await check('Duplicate and concurrent delivery makes only one reserved model call', async () => {
    const f = await fixture()
    const results = await Promise.all([f.evaluate(), f.evaluate(), f.evaluate()])
    // Duplicate events may all return 'completed' if the first request
    // finishes before other transactions read the existing job. That is
    // correct replay behavior, not evidence of multiple provider calls.
    assert.equal(results.length, 3)
    assert.ok(results.every(x => ['completed', 'already_started'].includes(x.status)),
      `Unexpected duplicate delivery status: ${results.map(x => x.status).join(', ')}`)
    assert.ok(results.some(x => x.status === 'completed'))
    // Count actual provider invocations and Firestore reservations instead.
    assert.equal(f.calls(), 1)
    const budget = await monthly()
    assert.equal(budget.requestCount, 1)
    assert.equal(budget.sponsoredRequestCount, 1)
    assert.equal(budget.pendingCount, 0)
    assert.equal(budget.completedCount, 1)
    assert.equal((await f.jobRef.get()).data().status, 'completed')
    assert.equal((await f.evaluate()).status, 'completed')
    assert.equal(f.calls(), 1)
    assert.equal((await monthly()).requestCount, 1)
  })

  await check('Teacher feedback update never triggers an AI request', async () => {
    const f = await fixture()
    const before = f.initial
    await f.subRef.update({ teacherFeedback: 'Human review, no paid evaluation.' })
    const after = await f.subRef.get()
    assert.equal((await f.evaluate(after, before)).status, 'ignored')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('Unselected student cannot consume an institution budget', async () => {
    const f = await fixture({ selected: false })
    assert.equal((await f.evaluate()).status, 'ineligible')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('School pilot disabled prevents paid evaluation', async () => {
    const f = await fixture({ pilotEnabled: false })
    assert.equal((await f.evaluate()).status, 'ineligible')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('Individual account cannot receive institution-sponsored evaluation', async () => {
    const f = await fixture({ userType: 'individual' })
    assert.equal((await f.evaluate()).status, 'ineligible')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('Policy enabled after submission never spends retroactively', async () => {
    const f = await fixture()
    await f.policyRef.update({ updatedAt: Timestamp.fromDate(new Date('2026-10-15T10:05:00Z')) })
    assert.equal((await f.evaluate()).status, 'ineligible')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('Quota at 60 stops billing and provider calls', async () => {
    const f = await fixture()
    await monthlyRef.set({
      schemaVersion: 1, schoolId: 'maxima', month,
      requestCount: 60, sponsoredRequestCount: 60,
      pendingCount: 0, completedCount: 60
    })
    assert.equal((await f.evaluate()).status, 'budget_exhausted')
    assert.equal(f.calls(), 0)
    assert.equal(await hasDoc(f.jobRef), false)
    assert.equal((await monthly()).requestCount, 60)
  })

  await check('Wrong-school quota document fails closed', async () => {
    const f = await fixture()
    await monthlyRef.set({
      schemaVersion: 1, schoolId: 'not-maxima', month,
      requestCount: 0, sponsoredRequestCount: 0,
      pendingCount: 0, completedCount: 0
    })
    assert.equal((await f.evaluate()).status, 'invalid_budget')
    assert.equal(f.calls(), 0)
  })

  await check('Existing student-funded evaluation job cannot be overwritten', async () => {
    const f = await fixture()
    await f.jobRef.set({
      jobId: f.jobRef.id, studentId: f.uid, contentId: f.contentId,
      context: f.context, attemptNumber: 1, billing: 'student',
      status: 'processing', leaseId: 'already-student-funded'
    })
    assert.equal((await f.evaluate()).status, 'already_started')
    assert.equal(f.calls(), 0)
    assert.equal((await f.jobRef.get()).data().billing, 'student')
    assert.equal(await monthly(), null)
  })

  await check('Provider failure records failed job without charging a student', async () => {
    const f = await fixture({ onProvider: () => { throw new Error('emulated-provider-failure') } })
    const beforeCredits = (await f.creditRef.get()).data()
    assert.equal((await f.evaluate()).status, 'failed')
    assert.equal(f.calls(), 1)
    assert.equal((await f.jobRef.get()).data().status, 'failed')
    assert.equal((await monthly()).pendingCount, 0)
    assert.equal((await monthly()).requestCount, 1)
    assert.deepEqual((await f.creditRef.get()).data(), beforeCredits)
  })

  await check('Policy revocation during fake evaluation suppresses saved AI score', async () => {
    const f = await fixture({
      onProvider: async (prepared, { policyRef }) => {
        await policyRef.update({ enabled: false })
        return { report: providerReport(prepared), model: 'local-fake-grader' }
      }
    })
    assert.equal((await f.evaluate()).status, 'failed')
    assert.equal(f.calls(), 1)
    const job = (await f.jobRef.get()).data()
    assert.equal(job.status, 'failed')
    assert.equal(job.report, undefined)
    assert.equal((await monthly()).pendingCount, 0)
    assert.equal((await monthly()).requestCount, 1)
  })

  await check('Changed answer during fake provider call cannot settle AI report', async () => {
    const f = await fixture({
      onProvider: async (prepared, { subRef }) => {
        await subRef.update({ task2Answer: 'Student revised this answer after submit.' })
        return { report: providerReport(prepared), model: 'local-fake-grader' }
      }
    })
    assert.equal((await f.evaluate()).status, 'failed')
    assert.equal((await f.jobRef.get()).data().report, undefined)
    assert.equal((await monthly()).pendingCount, 0)
  })

  await check('Mock Task 2 produces provisional AI report without changing teacher score', async () => {
    const f = await fixture({ context: 'mock' })
    const teacherBefore = (await f.subRef.get()).data()
    const creditsBefore = (await f.creditRef.get()).data()
    assert.equal((await f.evaluate()).status, 'completed')
    const job = (await f.jobRef.get()).data()
    assert.equal(job.context, 'mock')
    assert.equal(job.report.isProvisionalMockEstimate, true)
    assert.equal(job.report.teacherFinalScore, null)
    assert.equal(job.report.task1, null)
    assert.equal(job.report.task2.estimatedBand, 6.5)
    assert.equal((await f.subRef.get()).data().teacherFinalScore, teacherBefore.teacherFinalScore)
    assert.equal((await f.subRef.get()).data().teacherNotes, teacherBefore.teacherNotes)
    assert.deepEqual((await f.creditRef.get()).data(), creditsBefore)
  })

  await check('Second valid attempt has a separate AI job and shared monthly cost', async () => {
    const f = await fixture()
    assert.equal((await f.evaluate()).status, 'completed')
    const original = (await f.subRef.get())
    await f.subRef.update({
      attemptNumber: 2,
      submittedAt: '2026-10-15T10:30:00.000Z',
      task2Answer: 'A second valid, completed Writing attempt.'
    })
    const second = await f.subRef.get()
    assert.equal((await f.evaluate(second, original)).status, 'completed')
    assert.equal(await hasDoc(f.jobFor(1)), true)
    assert.equal((await f.jobFor(2).get()).data().status, 'completed')
    assert.equal(f.calls(), 2)
    assert.equal((await monthly()).requestCount, 2)
  })

  await check('Stale first attempt event cannot evaluate overwritten submission', async () => {
    const f = await fixture()
    await f.subRef.update({
      attemptNumber: 2, submittedAt: '2026-10-15T10:30:00.000Z',
      task2Answer: 'Second Writing answer.'
    })
    assert.equal((await f.evaluate(f.initial)).status, 'stale')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('Archived Writing source blocks model call', async () => {
    const f = await fixture()
    await f.sourceRef.update({ archived: true })
    assert.equal((await f.evaluate()).status, 'ineligible')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('Archived student account blocks model call', async () => {
    const f = await fixture()
    await db.doc(`users/${f.uid}`).update({ archived: true })
    assert.equal((await f.evaluate()).status, 'ineligible')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  await check('Invalid policy selection list fails closed in a real transaction', async () => {
    const f = await fixture()
    await f.policyRef.update({ studentIds: [f.uid, f.uid] })
    assert.equal((await f.evaluate()).status, 'ineligible')
    assert.equal(f.calls(), 0)
    assert.equal(await monthly(), null)
  })

  console.log(`\nP5B-3C real Firestore Emulator integration: ${passed}/${passed + failed} PASS, ${failed} FAIL`)
  if (failed) process.exitCode = 1
}

main()
  .catch(error => {
    console.error('FATAL P5B-3C emulator test failure:', error?.stack || error)
    process.exitCode = 1
  })
  .finally(() => admin.app(appName).delete())
