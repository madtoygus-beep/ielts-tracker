'use strict'

// P5B-3D. No network, Firebase credentials, real API keys or student records.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { createAiWritingEvaluationService, MAX_MONTHLY_SCHOOL_EVALUATIONS, LEASE_MS } =
  require('./functions/lib/aiWritingEvaluation')
const { gradeWithOpenAi, extractOutputJson, PILOT_MODEL, PROVIDER_URL } =
  require('./functions/lib/openAiWritingProvider')
const grading = require('./functions/lib/aiWritingGrading')

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
const t1 = 'Overall, the park was replaced by a hospital, while the river stayed unchanged. New shops appeared nearby and a new road connected the hospital with residential areas.'
const t2 = 'Schools should teach financial literacy because young people need to budget responsibly. Such lessons help teenagers save money, understand interest rates and avoid debt in adulthood.'
const studentUid = 'stu00001'
const today = Date.parse('2026-10-14T18:00:00Z')
const schoolId = 'maxima'
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const month = '202610'

class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
class FakeDB {
  constructor(seed = {}) { this.docs = new Map(Object.entries(structuredClone(seed))); this.chain = Promise.resolve() }
  doc(path) {
    const db = this
    return { path, id: path.split('/').pop(), get: async () => db.snapshot(path) }
  }
  snapshot(path) {
    const exists = this.docs.has(path)
    const value = exists ? structuredClone(this.docs.get(path)) : null
    return { exists, id: path.split('/').pop(), ref: this.doc(path), data: () => value }
  }
  async runTransaction(callback) {
    const work = async () => {
      const updates = []
      let wrote = false
      const tx = {
        get: async ref => { if (wrote) throw new Error('TRANSACTION READ AFTER WRITE'); return this.snapshot(ref.path) },
        set: (ref, data, options = {}) => {
          wrote = true
          updates.push(() => this.docs.set(ref.path, options.merge
            ? { ...(this.docs.get(ref.path) || {}), ...structuredClone(data) }
            : structuredClone(data)))
        },
        update: (ref, data) => {
          wrote = true
          updates.push(() => {
            if (!this.docs.has(ref.path)) throw new Error(`Cannot update absent doc ${ref.path}`)
            this.docs.set(ref.path, { ...this.docs.get(ref.path), ...structuredClone(data) })
          })
        },
        create: (ref, data) => {
          wrote = true
          updates.push(() => {
            if (this.docs.has(ref.path)) throw new Error('Document exists')
            this.docs.set(ref.path, structuredClone(data))
          })
        }
      }
      const result = await callback(tx)
      for (const action of updates) action()
      return result
    }
    const done = this.chain.then(work, work)
    this.chain = done.then(() => {}, () => {})
    return done
  }
}
const fv = { serverTimestamp: () => 'server-timestamp' }
function baseSeed({ credits = 5, studentEnabled = true, pilotEnabled = true } = {}) {
  return {
    [`users/${studentUid}`]: { role: 'student', status: 'approved', deleted: false,
      accountType: 'institution', schoolId },
    'schools/maxima': { status: 'active' },
    'aiWritingSchoolSettings/maxima': { schoolId, pilotEnabled },
    [`aiWritingStudentAccess/${studentUid}`]: {
      studentId: studentUid, uid: studentUid, schoolId, accountType: 'institution',
      enabled: studentEnabled, creditsRemaining: credits, creditsUsedTotal: 0,
      creditsAddedTotal: credits, creditsRemovedTotal: 0
    },
    'writingHomeworks/w1': {
      schoolId, contentType: 'full_writing',
      task1: { title: 'Map', prompt: 'Describe the town changes.', image: png },
      task2: { title: 'Schools', prompt: 'Should schools teach finance?' }
    },
    [`writingSubmissions/${studentUid}_w1`]: {
      uid: studentUid, studentId: studentUid, schoolId, writingId: 'w1',
      attemptNumber: 1, task1Answer: t1, task2Answer: t2,
      task1Enabled: true, task2Enabled: true, reviewed: false
    },
    [`studentAccess/${studentUid}_writing_w1`]: {
      uid: studentUid, schoolId, contentType: 'writing', contentId: 'w1',
      sourceCollection: 'writingHomeworks', accessType: 'assignment', status: 'active'
    },
    'mockTests/m1': { schoolId, writingId: 'w1', writingMode: 'full_writing',
      enabledSections: { writing: true, reading: true, listening: true } },
    [`mockSubmissions/${studentUid}_m1`]: {
      uid: studentUid, studentId: studentUid, schoolId, mockTestId: 'm1',
      attemptNumber: 1, writingId: 'w1', writingMode: 'full_writing',
      enabledSections: { writing: true, reading: true, listening: true },
      writingAnswers: { task1: t1, task2: t2 },
      result: { writing: { status: 'pending_review' }, overallEstimate: 6.5 }
    },
    [`studentAccess/${studentUid}_mock_m1`]: {
      uid: studentUid, schoolId, contentType: 'mock', contentId: 'm1',
      sourceCollection: 'mockTests', accessType: 'assignment', status: 'active'
    },
    'scores/stu00001_m1': { uid: studentUid, studentId: studentUid, schoolId,
      writing: '', overall: 6.5 }
  }
}
function reportFor(prepared) {
  function task(answer) {
    return {
      criteria: Object.fromEntries(grading.CRITERIA_KEYS.map(key => [key, {
        band: 6.5, explanation: 'Clear but can be improved.', evidence: answer.slice(0, 7)
      }])),
      overview: 'Good writing with some limitations.',
      strengths: ['Clear position'], priorities: ['Improve accuracy'],
      corrections: [{ original: answer.slice(0, 7), suggestion: 'Alternative', reason: 'More precise' }]
    }
  }
  return grading.normalizeAiWritingReport({
    task1: prepared.task1 ? task(prepared.task1.answer) : null,
    task2: prepared.task2 ? task(prepared.task2.answer) : null
  }, prepared)
}
function fixture({ seed = baseSeed(), provider = async prep => ({
  report: reportFor(prep), model: PILOT_MODEL, providerResponseId: 'resp_mock'
}), enabled = true, apiKey = `sk-${'x'.repeat(32)}`, at = today } = {}) {
  const db = new FakeDB(seed)
  let time = at
  const service = createAiWritingEvaluationService({
    db, FieldValue: fv, HttpsError: FakeHttpsError,
    requireStudent: async request => {
      const uid = request?.auth?.uid
      if (!uid) throw new FakeHttpsError('unauthenticated', 'Sign in.')
      const data = db.snapshot(`users/${uid}`).data()
      if (data?.role !== 'student' || data.status !== 'approved' || data.deleted ||
          data.accountType === 'individual') throw new FakeHttpsError('permission-denied', 'No student.')
      return { uid, profile: data, schoolId: data.schoolId }
    },
    requireStudentAttemptSource: async (student, cfg, contentId) => {
      const source = db.snapshot(`${cfg.sourceCollection}/${contentId}`).data()
      if (!source || source.schoolId !== student.schoolId || source.archived) {
        throw new FakeHttpsError('permission-denied', 'Content unavailable')
      }
      const access = db.snapshot(`studentAccess/${student.uid}_${cfg.contentType}_${contentId}`).data()
      if (!access || access.status !== 'active' || access.adminHidden) {
        throw new FakeHttpsError('permission-denied', 'Content hidden')
      }
      return source
    },
    submissionContentConfigFor: type => {
      if (type === 'writing') return { contentType: type, sourceCollection: 'writingHomeworks',
        submissionCollection: 'writingSubmissions' }
      if (type === 'mock') return { contentType: type, sourceCollection: 'mockTests',
        submissionCollection: 'mockSubmissions' }
      throw new FakeHttpsError('invalid-argument', 'No type')
    },
    findCurrentSubmissionRecord: async (cfg, uid, contentId) => {
      const ref = db.doc(`${cfg.submissionCollection}/${uid}_${contentId}`)
      const snap = await ref.get()
      return snap.exists ? { ref, id: ref.id, data: snap.data() } : null
    },
    getOpenSubmissionAttemptControl: async (cfg, uid, contentId) => {
      const hash = sha(`${uid}\u001f${cfg.contentType}\u001f${contentId}`)
      const data = db.snapshot(`submissionAttemptControls/${hash}`).data()
      return data?.status === 'open' ? data : null
    },
    schoolIdOf: value => value?.schoolId || 'maxima',
    getMockEnabledSections: mock => mock.enabledSections || {},
    getMockWritingMode: (mock, writing) => mock.writingMode || writing?.contentType || 'full_writing',
    provider, getApiKey: () => apiKey, providerEnabled: () => enabled,
    now: () => time
  })
  const homework = { auth: { uid: studentUid }, data: { context: 'homework', contentId: 'w1' } }
  const mock = { auth: { uid: studentUid }, data: { context: 'mock', contentId: 'm1' } }
  return { db, service, homework, mock, advance: ms => { time += ms }, currentTime: () => time }
}

let passed = 0, failed = 0
async function test(label, fn) {
  try { await fn(); passed++; console.log('PASS', label) }
  catch (e) { failed++; console.error('FAIL', label, e?.stack || e) }
}
const submissionTimestamp = '2026-10-15T02:00:00.000Z'
const earlier = new Date('2026-10-15T01:00:00.000Z')
const later = new Date('2026-10-15T03:00:00.000Z')
function sponsorSeed(context = 'homework') {
  const seed = baseSeed({ credits: 0, studentEnabled: false })
  // Completely remove personal credit entitlement to prove funded reports do not need it.
  delete seed[`aiWritingStudentAccess/${studentUid}`]
  const mock = context === 'mock'
  const contentType = mock ? 'mock' : 'writing'
  const contentId = mock ? 'm1' : 'w1'
  const sub = mock ? `mockSubmissions/${studentUid}_m1` : `writingSubmissions/${studentUid}_w1`
  seed[sub].submittedAt = submissionTimestamp
  seed[`aiWritingSponsoredPolicies/${contentType}_${contentId}`] = {
    schoolId, enabled: true, billing: 'institution', context, contentType, contentId,
    sourceCollection: mock ? 'mockTests' : 'writingHomeworks',
    studentIds: [studentUid], updatedAt: earlier
  }
  return seed
}
function fakeCompletedJob(context) {
  const mock = context === 'mock'
  const seed = sponsorSeed(context)
  const contentId = mock ? 'm1' : 'w1'
  const sub = seed[mock ? `mockSubmissions/${studentUid}_m1` : `writingSubmissions/${studentUid}_w1`]
  const source = seed['writingHomeworks/w1']
  const prepared = grading.prepareAiWritingEvaluation({ context, source, submission: sub })
  const fingerprint = sha(JSON.stringify(prepared))
  const jobId = sha(['ai-writing-v1', studentUid, context, contentId, 1].join('\0'))
  const jobRef = `aiWritingEvaluations/${jobId}`
  seed[jobRef] = {
    jobId, studentId: studentUid, uid: studentUid, schoolId, context, contentId,
    attemptNumber: 1, fingerprint, status: 'completed', billingMode: 'sponsored_auto',
    report: reportFor(prepared)
  }
  return { seed, jobRef }
}
async function run() {
  await test('Writing selected policy is visible without personal credits', async () => {
    const f = fixture({ seed: sponsorSeed() })
    const result = await f.service.getReport(f.homework)
    assert.equal(result.status, 'not_started')
    assert.equal(result.institutionFunded, true)
    assert.equal(f.db.snapshot(`aiWritingStudentAccess/${studentUid}`).exists, false)
  })
  await test('Mock selected policy is visible without personal credits', async () => {
    const f = fixture({ seed: sponsorSeed('mock') })
    const result = await f.service.getReport(f.mock)
    assert.equal(result.status, 'not_started'); assert.equal(result.institutionFunded, true)
  })
  await test('Unselected student cannot see sponsorship state', async () => {
    const seed = sponsorSeed(); seed['aiWritingSponsoredPolicies/writing_w1'].studentIds = ['anotherstudent']
    const result = await fixture({ seed }).service.getReport({ auth:{uid:studentUid}, data:{context:'homework',contentId:'w1'} })
    assert.equal(result.institutionFunded, false)
  })
  await test('Disabled teacher sponsorship is not shown', async () => {
    const seed=sponsorSeed();seed['aiWritingSponsoredPolicies/writing_w1'].enabled=false
    assert.equal((await fixture({seed}).service.getReport({auth:{uid:studentUid},data:{context:'homework',contentId:'w1'}})).institutionFunded,false)
  })
  await test('Policy created after submission is not shown', async () => {
    const seed=sponsorSeed();seed['aiWritingSponsoredPolicies/writing_w1'].updatedAt=later
    assert.equal((await fixture({seed}).service.getReport({auth:{uid:studentUid},data:{context:'homework',contentId:'w1'}})).institutionFunded,false)
  })
  await test('Missing policy timestamp cannot show sponsorship', async () => {
    const seed=sponsorSeed();delete seed['aiWritingSponsoredPolicies/writing_w1'].updatedAt
    assert.equal((await fixture({seed}).service.getReport({auth:{uid:studentUid},data:{context:'homework',contentId:'w1'}})).institutionFunded,false)
  })
  await test('School pilot disabled cannot show unsent sponsorship', async () => {
    const seed=sponsorSeed();seed['aiWritingSchoolSettings/maxima'].pilotEnabled=false
    assert.equal((await fixture({seed}).service.getReport({auth:{uid:studentUid},data:{context:'homework',contentId:'w1'}})).institutionFunded,false)
  })
  await test('Corrupted sponsorship identity is never accepted', async () => {
    const seed=sponsorSeed();seed['aiWritingSponsoredPolicies/writing_w1'].schoolId='foreign'
    assert.equal((await fixture({seed}).service.getReport({auth:{uid:studentUid},data:{context:'homework',contentId:'w1'}})).institutionFunded,false)
  })
  await test('Duplicate selected IDs are rejected', async () => {
    const seed=sponsorSeed();seed['aiWritingSponsoredPolicies/writing_w1'].studentIds.push(studentUid)
    assert.equal((await fixture({seed}).service.getReport({auth:{uid:studentUid},data:{context:'homework',contentId:'w1'}})).institutionFunded,false)
  })
  await test('Over-limit and invalid selected IDs are rejected', async () => {
    const seed=sponsorSeed();seed['aiWritingSponsoredPolicies/writing_w1'].studentIds = [studentUid, ...Array.from({length:60},(_,i)=>'student'+i)]
    assert.equal((await fixture({seed}).service.getReport({auth:{uid:studentUid},data:{context:'homework',contentId:'w1'}})).institutionFunded,false)
  })
  await test('Completed Writing sponsor report readable with no credit grant', async () => {
    const {seed}=fakeCompletedJob('homework');const f=fixture({seed})
    const result=await f.service.getReport(f.homework)
    assert.equal(result.status,'completed');assert.equal(result.institutionFunded,true)
    assert.equal(result.report.estimatedBand,6.5);assert.equal(result.report.isAiEstimate,true)
    assert.equal(f.db.snapshot(`aiWritingStudentAccess/${studentUid}`).exists,false)
  })
  await test('Completed Mock sponsor report readable but teacher score untouched', async () => {
    const {seed}=fakeCompletedJob('mock');const before=structuredClone(seed['scores/stu00001_m1'])
    const f=fixture({seed});const result=await f.service.getReport(f.mock)
    assert.equal(result.status,'completed');assert.equal(result.institutionFunded,true)
    assert.equal(result.report.isProvisionalMockEstimate,true)
    assert.equal(result.report.teacherFinalScore,null)
    assert.deepEqual(f.db.snapshot('scores/stu00001_m1').data(),before)
  })
  await test('Completed funded report survives pilot closure', async () => {
    const {seed}=fakeCompletedJob('homework');seed['aiWritingSchoolSettings/maxima'].pilotEnabled=false
    const f=fixture({seed});assert.equal((await f.service.getReport(f.homework)).status,'completed')
  })
  await test('Completed funded report survives teacher policy revocation', async () => {
    const {seed}=fakeCompletedJob('homework');seed['aiWritingSponsoredPolicies/writing_w1'].enabled=false
    const f=fixture({seed});assert.equal((await f.service.getReport(f.homework)).status,'completed')
  })
  await test('Processing sponsor report is marked institution-funded', async () => {
    const {seed,jobRef}=fakeCompletedJob('homework');seed[jobRef].status='processing';seed[jobRef].leaseUntilMs=today+30000
    const f=fixture({seed});const result=await f.service.getReport(f.homework)
    assert.equal(result.status,'processing');assert.equal(result.institutionFunded,true)
  })
  await test('Expired funded processing job refuses personal credit retry', async () => {
    const {seed,jobRef}=fakeCompletedJob('homework');seed[jobRef].status='processing';seed[jobRef].leaseUntilMs=today-30000
    const f=fixture({seed});const result=await f.service.getReport(f.homework)
    assert.equal(result.status,'failed');assert.equal(result.canRetry,false)
    assert.equal(result.institutionFunded,true)
  })
  await test('Failed funded job refuses personal credit retry', async () => {
    const {seed,jobRef}=fakeCompletedJob('homework');seed[jobRef].status='failed'
    const f=fixture({seed});const result=await f.service.getReport(f.homework)
    assert.equal(result.status,'failed');assert.equal(result.canRetry,false)
    assert.equal(result.institutionFunded,true)
  })
  await test('Foreign student never reads institution-funded report', async () => {
    const {seed}=fakeCompletedJob('homework');seed['users/foreignstudent']={role:'student',status:'approved',schoolId:'foreign',accountType:'institution'}
    const f=fixture({seed})
    await assert.rejects(f.service.getReport({auth:{uid:'foreignstudent'},data:{context:'homework',contentId:'w1'}}))
  })
  await test('Hidden assignment cannot retrieve sponsored report', async () => {
    const {seed}=fakeCompletedJob('homework');seed[`studentAccess/${studentUid}_writing_w1`].adminHidden=true
    const f=fixture({seed});await assert.rejects(f.service.getReport(f.homework),{code:'permission-denied'})
  })
  await test('Retake currently open cannot read stale sponsored report', async () => {
    const {seed}=fakeCompletedJob('homework');const controlId=sha(`${studentUid}\u001fwriting\u001fw1`)
    seed[`submissionAttemptControls/${controlId}`]={status:'open'}
    const f=fixture({seed});await assert.rejects(f.service.getReport(f.homework),{code:'failed-precondition'})
  })
  await test('No request produces a paid provider call or student credit operation', async () => {
    const {seed}=fakeCompletedJob('mock');const f=fixture({seed})
    await f.service.getReport(f.mock)
    assert.equal([...f.db.docs.keys()].some(k => k.startsWith('aiWritingCreditOperations/')),false)
    assert.equal(f.db.snapshot(`aiWritingStudentAccess/${studentUid}`).exists,false)
  })
  console.log(`P5B-3D funded report service offline: ${passed}/${passed+failed} PASS; ${failed} FAIL`)
  if (failed) process.exitCode = 1
}
run().catch(e=>{console.error(e.stack || e);process.exitCode=1})
