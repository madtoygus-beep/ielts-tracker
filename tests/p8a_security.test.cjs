'use strict'
// P8-A security regression tests. In-memory Firestore mock; provider is a local stub.
// No network access and no real AI request is possible from these tests.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const lib = name => require(path.join(root, 'functions/lib', name))
const { createAiWritingSponsoredEvaluationService } = lib('aiWritingSponsoredEvaluation')

const SID = 'student1234', S2 = 'student5678', S3 = 'student9999'
const TID = 'teacher1234', AID = 'admin123456', W = 'writing1234'
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code } }

// ---------- minimal in-memory Firestore ----------
function memoryDb(initial) {
  const docs = new Map(Object.entries(initial))
  const writes = []
  const snap = (p, d) => ({ exists: d !== undefined, id: p.split('/').pop(), ref: ref(p), data: () => d })
  function ref(p) { return { path: p, id: p.split('/').pop(), get: async () => snap(p, docs.get(p)) } }
  const query = (c, f, v) => ({ get: async () => ({ docs: [...docs.entries()]
    .filter(([k, d]) => k.startsWith(c + '/') && k.split('/').length === 2 && d[f] === v)
    .map(([k, d]) => snap(k, d)) }) })
  const apply = (p, d, merge) => {
    writes.push(p)
    const base = merge ? { ...(docs.get(p) || {}) } : {}
    for (const [k, v] of Object.entries(d)) { if (v && v.__delete) delete base[k]; else base[k] = v }
    docs.set(p, base)
  }
  const db = {
    docs, writes,
    doc: ref,
    collection: c => ({ where: (f, _o, v) => query(c, f, v) }),
    getAll: async (...refs) => Promise.all(refs.map(r => r.get())),
    runTransaction: async fn => {
      const queued = []
      const tx = {
        get: r => r.get(),
        set: (r, d, o) => queued.push(() => apply(r.path, d, o?.merge)),
        update: (r, d) => queued.push(() => apply(r.path, d, true)),
        create: (r, d) => queued.push(() => { if (docs.has(r.path)) throw new Error('exists'); apply(r.path, d) })
      }
      const out = await fn(tx); queued.forEach(q => q()); return out
    }
  }
  return db
}
let clock = Date.parse('2026-10-18T12:00:00.000Z')
const FieldValue = { serverTimestamp: () => { const ms = clock; return { toMillis: () => ms } }, delete: () => ({ __delete: true }) }
const schoolIdOf = d => d?.schoolId || 'maxima'
const accountTypeOf = d => d?.accountType || 'institution'
const essay = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

function validReport(wordCount = 300) {
  const c = { band: 6, explanation: 'ok', evidence: '' }
  return { isAiEstimate: true, teacherFinalScore: null, context: 'homework', writingMode: 'task2_only',
    isProvisionalMockEstimate: false, task1: null,
    task2: { wordCount, feedbackOnly: false, estimatedBand: 6, criteria: {
      taskAchievementOrResponse: c, coherenceAndCohesion: c, lexicalResource: c, grammaticalRangeAndAccuracy: c } },
    estimatedBand: 6, feedbackOnly: false }
}

function world({ attemptNumber = 1, control = null, policy = {}, submission = {} } = {}) {
  const submittedAt = '2026-10-18T10:00:00.000Z'
  const base = {
    [`users/${SID}`]: { role: 'student', status: 'approved', schoolId: 'maxima', accountType: 'institution' },
    [`users/${S2}`]: { role: 'student', status: 'approved', schoolId: 'maxima', accountType: 'institution' },
    [`users/${S3}`]: { role: 'student', status: 'approved', schoolId: 'maxima', accountType: 'institution' },
    [`users/${TID}`]: { role: 'teacher', status: 'approved', schoolId: 'maxima', accountType: 'institution' },
    [`users/${AID}`]: { role: 'admin', status: 'approved', schoolId: 'maxima', accountType: 'institution' },
    'schools/maxima': { status: 'active' },
    'aiWritingSchoolSettings/maxima': { schoolId: 'maxima', pilotEnabled: true },
    [`writingHomeworks/${W}`]: { schoolId: 'maxima', teacherId: TID, teacherIds: [TID], contentType: 'task2_only',
      task2: { prompt: 'Some people think...' } },
    'classes/c1': { teacherId: TID, schoolId: 'maxima', status: 'active', name: 'IELTS A', studentIds: [SID, S2] },
    [`aiWritingSponsoredPolicies/writing_${W}`]: { schoolId: 'maxima', enabled: true, billing: 'institution',
      context: 'homework', contentId: W, contentType: 'writing', sourceCollection: 'writingHomeworks',
      studentIds: [SID], updatedBy: TID, updatedAt: { toMillis: () => Date.parse('2026-10-18T09:00:00Z') }, ...policy },
    [`writingSubmissions/${SID}_${W}`]: { uid: SID, studentId: SID, schoolId: 'maxima', writingId: W,
      attemptNumber, submittedAt, writingMode: 'task2_only', task1Enabled: false, task2Enabled: true,
      task1Answer: '', task2Answer: essay(300), aiReviewChoice: 'ai', aiBillingMode: 'institution', ...submission }
  }
  for (const uid of [SID, S2, S3]) {
    base[`studentAccess/${uid}_writing_${W}`] = { uid, schoolId: 'maxima', contentId: W, contentType: 'writing',
      sourceCollection: 'writingHomeworks', accessType: 'assignment', status: 'active' }
  }
  if (control) {
    const { createHash } = require('crypto')
    base[`submissionAttemptControls/${createHash('sha256').update(`${SID}\u001fwriting\u001f${W}`).digest('hex')}`] = control
  }
  return memoryDb(base)
}

const trigger = (db, provider) => createAiWritingSponsoredEvaluationService({
  db, FieldValue, provider, getApiKey: () => 'sk-test-only-not-a-real-key-000', providerEnabled: () => true,
  schoolIdOf, getMockEnabledSections: () => ({}), getMockWritingMode: () => '',
  findCurrentSubmissionRecord: async () => ({ ref: db.doc(`writingSubmissions/${SID}_${W}`),
    data: db.docs.get(`writingSubmissions/${SID}_${W}`) }),
  submissionContentConfigFor: () => ({})
})
const event = (db, before) => ({ data: {
  before: before ? { exists: true, data: () => before } : { exists: false },
  after: { exists: true, data: () => db.docs.get(`writingSubmissions/${SID}_${W}`), ref: db.doc(`writingSubmissions/${SID}_${W}`) } } })

// ---------- P8-A: forged attempt numbers ----------
test('P8-A: attempt 2 without a server-consumed retake control is ignored (no paid call)', async () => {
  const db = world({ attemptNumber: 2 })
  let calls = 0
  const before = { ...db.docs.get(`writingSubmissions/${SID}_${W}`), attemptNumber: 1, submittedAt: '2026-10-18T09:30:00.000Z' }
  const out = await trigger(db, async () => { calls++ }).submit('homework', event(db, before))
  assert.equal(out.status, 'ineligible'); assert.equal(calls, 0)
})

test('P8-A: attempt 2 with consumed control for attempt 2 proceeds', async () => {
  const db = world({ attemptNumber: 2, control: { status: 'consumed', completedAttemptNumber: 2 } })
  const before = { ...db.docs.get(`writingSubmissions/${SID}_${W}`), attemptNumber: 1, submittedAt: '2026-10-18T09:30:00.000Z' }
  const out = await trigger(db, async () => ({ report: validReport(), model: 'stub' })).submit('homework', event(db, before))
  assert.equal(out.status, 'completed')
})


test('P8-A: legitimate first submission with institution choice still completes', async () => {
  const db = world()
  const out = await trigger(db, async () => ({ report: validReport(), model: 'stub' })).submit('homework', event(db, null))
  assert.equal(out.status, 'completed')
})

test('P8-A: Send to Teacher submission never reaches the provider', async () => {
  const db = world({ submission: { aiReviewChoice: 'teacher', aiBillingMode: 'none' } })
  let calls = 0
  const out = await trigger(db, async () => { calls++ }).submit('homework', event(db, null))
  assert.equal(out.status, 'ignored'); assert.equal(calls, 0)
})

test('P8-A: teacher review write on attempt 1 is not a new attempt', async () => {
  const db = world()
  const cur = db.docs.get(`writingSubmissions/${SID}_${W}`)
  db.docs.set(`writingSubmissions/${SID}_${W}`, { ...cur, reviewed: true, review: { overall: '6.5' } })
  let calls = 0
  const out = await trigger(db, async () => { calls++ }).submit('homework', event(db, cur))
  assert.equal(out.status, 'ignored'); assert.equal(calls, 0)
})
