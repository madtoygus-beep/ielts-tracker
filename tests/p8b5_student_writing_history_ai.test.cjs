'use strict'
// P8-B5: read-only exact-attempt AI result tests. NO real Firebase or AI calls.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { createStudentWritingHistoryAiService } = require('../functions/lib/studentWritingHistoryAi')

const SID = 'student1234'
const W = 'writing1234'
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const prepare = ({ context, source, submission }) => ({
  context, prompt: source.task2.prompt, answer: submission.task2Answer,
  writingMode: source.contentType
})
const valid = (report, prepared) => Boolean(report?.isAiEstimate === true &&
  report.context === prepared.context && report.task2?.estimatedBand === report.estimatedBand)
function world(overrides = {}) {
  const student = { uid: SID, schoolId: 'maxima', profile: { accountType: 'institution' } }
  const source = { title: 'PILOT W03', schoolId: 'maxima',
    contentType: 'task2_only', task2: { prompt: 'Essay prompt' } }
  const submission = { uid: SID, studentId: SID, schoolId: 'maxima', writingId: W,
    attemptNumber: 1, task2Answer: 'A complete Writing essay' }
  const submissionId = `${SID}_${W}`
  const jobId = sha(['ai-writing-v1', SID, 'homework', W, 1].join('\0'))
  const report = { isAiEstimate: true, context: 'homework', estimatedBand: 7.5,
    feedbackOnly: false, task2: { estimatedBand: 7.5 } }
  const job = { jobId, studentId: SID, schoolId: 'maxima', context: 'homework',
    contentType: 'writing', contentId: W, attemptNumber: 1,
    submissionId, fingerprint: sha(JSON.stringify(prepare({ context: 'homework', source, submission }))),
    status: 'completed', report, billingMode: 'student_credit' }
  const documents = new Map([[`aiWritingEvaluations/${jobId}`, job]])
  const reads = []
  const db = { doc: path => ({ get: async () => {
    reads.push(path)
    const value = documents.get(path)
    return { exists: value !== undefined, data: () => value }
  } }) }
  const service = createStudentWritingHistoryAiService({ db,
    prepareAiWritingEvaluation: prepare, validAiWritingReport: valid })
  const args = { student, source, contentId: W, attemptNumber: 1, submission, submissionId }
  return { args, job, report, documents, reads, db, service, ...overrides }
}

test('B5: exact current Writing job yields band-only summary', async () => {
  const w = world()
  const result = await w.service.readSavedReport(w.args)
  assert.equal(result.status, 'completed')
  assert.equal(result.estimatedBand, 7.5)
  assert.equal(result.attemptNumber, 1)
  assert.equal(Object.hasOwn(result, 'report'), false)
  assert.equal(w.reads.length, 1)
})

test('B5: expanded historical review reads full SAVED report, no AI request', async () => {
  const w = world()
  const result = await w.service.readSavedReport({ ...w.args, includeReport: true })
  assert.deepEqual(result.report, w.report)
  assert.equal(result.status, 'completed')
  assert.equal(w.reads.length, 1)
})

test('B5: different student cannot read another student report', async () => {
  const w = world()
  const result = await w.service.readSavedReport({ ...w.args,
    student: { uid: 'other12345', schoolId: 'maxima', profile: { accountType: 'institution' } } })
  assert.equal(result, null)
  assert.equal(w.reads.length, 0)
})

test('B5: old attempt cannot borrow a newer attempt report', async () => {
  const w = world()
  const result = await w.service.readSavedReport({ ...w.args,
    attemptNumber: 2, submission: { ...w.args.submission, attemptNumber: 2 } })
  assert.equal(result, null)
  assert.equal(w.reads.length, 1)
})

test('B5: wrong sourceSubmissionId cannot borrow a job', async () => {
  const w = world()
  assert.equal(await w.service.readSavedReport({ ...w.args, submissionId: 'otherSubmission' }), null)
})

test('B5: changed answer or teacher-edited prompt invalidates stale fingerprint', async () => {
  const w = world()
  assert.equal(await w.service.readSavedReport({ ...w.args,
    submission: { ...w.args.submission, task2Answer: 'Changed essay text' } }), null)
  assert.equal(await w.service.readSavedReport({ ...w.args,
    source: { ...w.args.source, task2: { prompt: 'Updated prompt' } } }), null)
})

test('B5: tampered job identity, ownership, invalid report, noncompleted all fail closed', async () => {
  for (const patch of [
    { studentId: 'other12345' }, { schoolId: 'other-school' },
    { contentId: 'other-content' }, { contentType: 'mock' },
    { attemptNumber: 2 }, { status: 'processing' },
    { fingerprint: 'bad' }, { report: { isAiEstimate: false } }
  ]) {
    const w = world()
    w.documents.set(`aiWritingEvaluations/${w.job.jobId}`, { ...w.job, ...patch })
    assert.equal(await w.service.readSavedReport(w.args), null, JSON.stringify(patch))
  }
})

test('B5: institution account required, archived/deleting accounts denied', async () => {
  for (const student of [
    { uid: SID, schoolId: 'other-school', profile: {} },
    { uid: SID, schoolId: 'maxima', profile: { accountType: 'individual' } },
    { uid: SID, schoolId: 'maxima', profile: { archived: true } },
    { uid: SID, schoolId: 'maxima', profile: { permanentDeleteInProgress: true } }
  ]) {
    const w = world()
    assert.equal(await w.service.readSavedReport({ ...w.args, student }), null)
    assert.equal(w.reads.length, 0)
  }
})

test('B5: short answer with feedback only has no fabricated band', async () => {
  const w = world()
  const report = { ...w.report, estimatedBand: null, feedbackOnly: true,
    task2: { estimatedBand: null } }
  w.documents.set(`aiWritingEvaluations/${w.job.jobId}`, { ...w.job, report })
  const result = await w.service.readSavedReport(w.args)
  assert.equal(result?.estimatedBand, null)
  assert.equal(result?.feedbackOnly, true)
})

test('B5: sponsored existing report is read-only and does not spend credits', async () => {
  const w = world()
  w.documents.set(`aiWritingEvaluations/${w.job.jobId}`, { ...w.job, billingMode: 'sponsored_auto' })
  const result = await w.service.readSavedReport(w.args)
  assert.equal(result?.institutionFunded, true)
  assert.equal(typeof w.db?.runTransaction, 'undefined')
})

test('B5: missing saved job is null and has no retry path', async () => {
  const w = world()
  w.documents.clear()
  assert.equal(await w.service.readSavedReport(w.args), null)
  const source = readFileSync(require.resolve('../functions/lib/studentWritingHistoryAi'), 'utf8')
  assert.doesNotMatch(source, /evaluateMyAiWriting|gradeWithOpenAi|runTransaction|tx\.update|\.set\(/)
})

test('B5: integration uses existing authorized history/review endpoints', () => {
  const index = readFileSync('functions/index.js', 'utf8')
  const studentUi = readFileSync('src/pages/StudentDashboard.jsx', 'utf8')
  const presentation = readFileSync('src/components/AiWritingStudentPanel.jsx', 'utf8')
  const historyStart = index.indexOf('exports.getStudentSubmissionAttemptHistory =')
  const reviewStart = index.indexOf('exports.getStudentSubmissionAttemptReview =')
  const history = index.slice(historyStart, reviewStart)
  const review = index.slice(reviewStart, index.indexOf('exports.getCompletedObjectiveReview', reviewStart))
  assert.match(history, /requireStudent\(request\)/)
  assert.match(history, /access\.status === 'active'/)
  assert.match(history, /studentWritingHistoryAi\.readSavedReport/)
  assert.match(history, /sourceTitles: Object\.fromEntries\(currentSourceTitles\), aiResults/)
  assert.match(review, /requireStudentAttemptSource\(student, config, contentId\)/)
  assert.match(review, /getOpenSubmissionAttemptControl/)
  assert.match(review, /submission: selected, submissionId: selectedSubmissionId, includeReport: true/)
  assert.match(studentUi, /writingAiResults\[reviewKey\]/)
  assert.match(studentUi, /AiWritingSavedReport aiResult=\{payload\.aiResult\}/)
  assert.match(presentation, /export function AiWritingSavedReport/)
})

test('B5: previous submission and AI/student payment routes remain present', () => {
  const index = readFileSync('functions/index.js', 'utf8')
  const policy = readFileSync('src/services/aiWritingStudentPolicy.js', 'utf8')
  assert.match(index, /exports\.evaluateMyAiWriting = onCall/)
  assert.match(index, /exports\.getMyAiWritingReport = onCall/)
  assert.match(policy, /attempt !== currentAttemptNumber/)
})

test('B5: real history callable resolves first-attempt title and AI band without prior snapshot', async () => {
  const vm = require('node:vm')
  const index = readFileSync('functions/index.js', 'utf8')
  const start = index.indexOf('exports.getStudentSubmissionAttemptHistory = onCall(')
  const end = index.indexOf('// Q2B: Exact selected-attempt review.', start)
  assert.ok(start > 0 && end > start)
  const fragment = index.slice(start, end)
  const student = { uid: SID, schoolId: 'maxima', profile: { accountType: 'institution' } }
  const access = { uid: SID, schoolId: 'maxima', contentId: W,
    accessType: 'assignment', contentType: 'writing', sourceCollection: 'writingHomeworks', status: 'active' }
  const source = { title: 'PILOT W03 - IELTS Academic Writing Task 2', schoolId: 'maxima' }
  const submission = { uid: SID, studentId: SID, schoolId: 'maxima', writingId: W,
    attemptNumber: 1, task2Answer: 'The saved essay', submittedAt: '2026-10-19T10:00:00Z' }
  const doc = (id, data) => ({ id, exists: true, data: () => data })
  const collection = name => ({ where: () => ({ where: () => ({ get: async () => ({
    docs: name === 'studentAccess' ? [doc('access', access)] : [] }) }),
    get: async () => ({ docs: [] }) }) })
  const ctx = {
    Buffer,
    exports: {}, onCall: fn => fn, requireStudent: async () => student,
    submissionContentConfigFor: () => ({ contentType: 'writing', sourceCollection: 'writingHomeworks',
      submissionCollection: 'writingSubmissions', parentFields: ['writingId'] }),
    ATTEMPT_HISTORY_COLLECTION: 'submissionAttemptHistory',
    db: {
      collection,
      doc: path => ({ path, id: path.split('/').pop() }),
      getAll: async (...refs) => refs.map(ref => doc(ref.id, source))
    },
    studentAttemptHistoryMatches: () => true,
    schoolIdOf: data => data.schoolId || 'maxima',
    submissionAttemptSummary: () => ({}),
    getStudentOwnedResultSnapshots: async () => [{ id: `${SID}_${W}`, data: submission }],
    submissionMatchesContent: (_config, record, id) => record.writingId === id,
    chooseLegacyCurrentSubmission: () => null,
    submissionHasMeaningfulAnswers: () => true,
    submittedAtMillis: () => 0,
    attemptNumberOf: data => data.attemptNumber || 1,
    studentWritingHistoryAi: { readSavedReport: async ({ contentId, attemptNumber, submissionId }) => {
      assert.equal(contentId, W)
      assert.equal(submissionId, `${SID}_${W}`)
      assert.equal(attemptNumber, 1)
      return { contentId, attemptNumber, status: 'completed', estimatedBand: 7.5, feedbackOnly: false }
    } }
  }
  vm.runInNewContext(fragment, ctx, { filename: 'studentWritingHistoryCallable.js', timeout: 3000 })
  const result = await ctx.exports.getStudentSubmissionAttemptHistory({ data: { contentType: 'writing' } })
  assert.equal(result.sourceTitles[W], source.title)
  assert.equal(result.attempts.length, 0)
  assert.equal(result.aiResults[0].estimatedBand, 7.5)
  assert.equal(Object.hasOwn(result, 'submissions'), false)
})

test('B5: hidden assignment has no source title or AI summary', async () => {
  const vm = require('node:vm')
  const index = readFileSync('functions/index.js', 'utf8')
  const start = index.indexOf('exports.getStudentSubmissionAttemptHistory = onCall(')
  const end = index.indexOf('// Q2B: Exact selected-attempt review.', start)
  const fragment = index.slice(start, end)
  let aiCalls = 0
  const ctx = {
    Buffer,
    exports: {}, onCall: fn => fn,
    requireStudent: async () => ({ uid: SID, schoolId: 'maxima' }),
    submissionContentConfigFor: () => ({ contentType: 'writing', sourceCollection: 'writingHomeworks',
      submissionCollection: 'writingSubmissions', parentFields: ['writingId'] }),
    ATTEMPT_HISTORY_COLLECTION: 'submissionAttemptHistory',
    db: { collection: name => ({ where: () => ({ where: () => ({ get: async () => ({
      docs: name === 'studentAccess' ? [{ data: () => ({ uid: SID, schoolId: 'maxima',
        accessType: 'assignment', contentType: 'writing', contentId: W,
        sourceCollection: 'writingHomeworks', status: 'active', adminHidden: true }) }] : [] }) }),
      get: async () => ({ docs: [] }) }) }) },
    studentAttemptHistoryMatches: () => true,
    schoolIdOf: d => d.schoolId || 'maxima',
    getStudentOwnedResultSnapshots: async () => [{ id: `${SID}_${W}`,
      data: { writingId: W, attemptNumber: 1 } }],
    studentWritingHistoryAi: { readSavedReport: async () => { aiCalls++; return null } }
  }
  vm.runInNewContext(fragment, ctx, { filename: 'studentWritingHistoryHidden.js', timeout: 3000 })
  const result = await ctx.exports.getStudentSubmissionAttemptHistory({ data: { contentType: 'writing' } })
  assert.equal(Object.keys(result.sourceTitles).length, 0)
  assert.equal(result.aiResults.length, 0)
  assert.equal(aiCalls, 0)
})
