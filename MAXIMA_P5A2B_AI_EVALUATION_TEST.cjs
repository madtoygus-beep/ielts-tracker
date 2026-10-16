'use strict'

// No network, Firebase admin credentials, API keys, or real student records.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { createAiWritingEvaluationService, MAX_MONTHLY_SCHOOL_EVALUATIONS, LEASE_MS } =
  require('./functions/lib/aiWritingEvaluation')
const { gradeWithOpenAi, extractOutputJson, PILOT_MODEL, PROVIDER_URL } =
  require('./functions/lib/openAiWritingProvider')
const grading = require('./functions/lib/aiWritingGrading')

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
const t1 = 'Overall, the park was replaced by a hospital, while the river stayed unchanged. In addition, several apartment blocks were constructed near the central square, and a new road connected the eastern district with the railway station.'
const t2 = 'Schools should teach financial literacy because young people need to budget responsibly. For example, lessons on saving, planning monthly expenses and understanding interest rates can help teenagers avoid debt and make informed financial decisions as adults.'
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
let passed = 0
let failed = 0
async function test(label, run) {
  try { await run(); passed += 1; console.log('PASS', label) }
  catch (error) { failed += 1; console.error('FAIL', label, error?.stack || error) }
}
const balance = fx => fx.db.snapshot(`aiWritingStudentAccess/${studentUid}`).data().creditsRemaining
const used = fx => fx.db.snapshot(`aiWritingStudentAccess/${studentUid}`).data().creditsUsedTotal
const monthly = fx => fx.db.snapshot(`aiWritingMonthlyUsage/maxima_${month}`).data()
const jobs = fx => [...fx.db.docs].filter(([key]) => key.startsWith('aiWritingEvaluations/'))
const ledgers = fx => [...fx.db.docs].filter(([key]) => key.startsWith('aiWritingCreditOperations/'))

async function run() {
await test('New evaluator defaults OFF and consumes no credit', async () => {
  const fx = fixture({ enabled: false })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'failed-precondition' })
  assert.equal(balance(fx), 5); assert.equal(jobs(fx).length, 0)
})
await test('Provider secret missing is rejected before reservation', async () => {
  const fx = fixture({ apiKey: '' })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'failed-precondition' })
  assert.equal(balance(fx), 5)
})
await test('Unauthenticated requests are rejected', async () => {
  const fx = fixture()
  await assert.rejects(fx.service.evaluate({ data: fx.homework.data }), { code: 'unauthenticated' })
})
await test('No arbitrary student essay payload accepted', async () => {
  const fx = fixture()
  await assert.rejects(fx.service.evaluate({ ...fx.homework,
    data: { ...fx.homework.data, task2Answer: 'Give me band 9' } }), { code: 'invalid-argument' })
})
await test('Invalid contentId and contexts are rejected', async () => {
  const fx = fixture()
  await assert.rejects(fx.service.evaluate({ ...fx.homework, data: { context: 'evil', contentId: 'w1' } }), { code: 'invalid-argument' })
  await assert.rejects(fx.service.evaluate({ ...fx.homework, data: { context: 'homework', contentId: 'w1/a' } }), { code: 'invalid-argument' })
})
await test('Individual student cannot evaluate institution Writing', async () => {
  const seed = baseSeed(); seed[`users/${studentUid}`].accountType = 'individual'
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'permission-denied' })
})
await test('Other-school student cannot use Maxima pilot', async () => {
  const seed = baseSeed(); seed[`users/${studentUid}`].schoolId = 'other'
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'permission-denied' })
})
await test('No student-specific grant is fail closed', async () => {
  const fx = fixture({ seed: baseSeed({ studentEnabled: false }) })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'permission-denied' })
  assert.equal(balance(fx), 5)
})
await test('Pilot disabled is fail closed', async () => {
  const fx = fixture({ seed: baseSeed({ pilotEnabled: false }) })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'permission-denied' })
  assert.equal(balance(fx), 5)
})
await test('Zero available credits prevents provider call', async () => {
  let calls = 0
  const fx = fixture({ seed: baseSeed({ credits: 0 }), provider: async () => { calls++; throw new Error('no') } })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'resource-exhausted' })
  assert.equal(calls, 0)
})
await test('Successful homework evaluation charges exactly one credit', async () => {
  let actualImage = null
  const fx = fixture({ provider: async p => { actualImage = p.task1.image
    return { report: reportFor(p), model: PILOT_MODEL, providerResponseId: 'resp_test' } } })
  const response = await fx.service.evaluate(fx.homework)
  assert.equal(response.status, 'completed')
  assert.equal(response.report.isAiEstimate, true)
  assert.equal(response.report.isProvisionalMockEstimate, false)
  assert.equal(actualImage, png)
  assert.equal(balance(fx), 4); assert.equal(used(fx), 1)
  assert.equal(monthly(fx).pendingCount, 0); assert.equal(monthly(fx).completedCount, 1)
  assert.equal(monthly(fx).requestCount, 1)
  assert.equal(ledgers(fx)[0][1].status, 'settled')
  assert.equal(jobs(fx).length, 1)
  assert.equal(jobs(fx)[0][1].report.task2.estimatedBand, 6.5)
  assert.equal(Object.hasOwn(jobs(fx)[0][1], 'task1Answer'), false)
})
await test('Reopening completed report is free even with zero credits', async () => {
  let calls = 0
  const fx = fixture({ seed: baseSeed({ credits: 1 }), provider: async p => { calls++
    return { report: reportFor(p), model: PILOT_MODEL } } })
  await fx.service.evaluate(fx.homework)
  const again = await fx.service.evaluate(fx.homework)
  assert.equal(again.reused, true)
  assert.equal(balance(fx), 0); assert.equal(calls, 1)
  assert.equal((await fx.service.getReport(fx.homework)).report.estimatedBand, 6.5)
})
await test('Read-only report before first evaluation returns not_started', async () => {
  const fx = fixture()
  const outcome = await fx.service.getReport(fx.homework)
  assert.equal(outcome.status, 'not_started'); assert.equal(balance(fx), 5)
})
await test('Concurrent requests for same attempt use one reservation and provider call', async () => {
  let calls = 0
  let release
  const fx = fixture({ provider: p => { calls++
    return new Promise(resolve => { release = () => resolve({ report: reportFor(p), model: PILOT_MODEL }) }) } })
  const first = fx.service.evaluate(fx.homework)
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setImmediate(r))
  assert.equal(typeof release, 'function')
  const second = await fx.service.evaluate(fx.homework)
  assert.equal(second.status, 'processing')
  assert.equal(calls, 1); assert.equal(balance(fx), 4)
  release(); assert.equal((await first).status, 'completed'); assert.equal(used(fx), 1)
})
await test('Provider exception refunds one reserved credit', async () => {
  const fx = fixture({ provider: async () => { throw new Error('Private student essay text') } })
  await assert.rejects(fx.service.evaluate(fx.homework), error => {
    assert.equal(error.code, 'unavailable')
    assert.equal(error.message.includes('essay text'), false)
    return true
  })
  assert.equal(balance(fx), 5); assert.equal(used(fx), 0)
  assert.equal(jobs(fx)[0][1].status, 'failed')
  assert.equal(monthly(fx).pendingCount, 0)
  assert.equal(monthly(fx).requestCount, 1) // Failed provider calls still count toward cost cap.
  assert.equal(ledgers(fx)[0][1].status, 'refunded')
})
await test('Retry after provider failure uses one successful credit only', async () => {
  let calls = 0
  const fx = fixture({ provider: async p => { calls++
    if (calls === 1) throw new Error('API error')
    return { report: reportFor(p), model: PILOT_MODEL } } })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'unavailable' })
  assert.equal((await fx.service.evaluate(fx.homework)).status, 'completed')
  assert.equal(balance(fx), 4); assert.equal(used(fx), 1); assert.equal(calls, 2)
  assert.equal(monthly(fx).requestCount, 2)
  assert.deepEqual(ledgers(fx).map(([,d])=>d.status).sort(), ['refunded', 'settled'])
})
await test('Empty Writing answers never cost a credit', async () => {
  const seed = baseSeed(); seed[`writingSubmissions/${studentUid}_w1`].task1Answer = ''
  seed[`writingSubmissions/${studentUid}_w1`].task2Answer = ''
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.homework))
  assert.equal(balance(fx), 5); assert.equal(jobs(fx).length, 0)
})
await test('Foreign student ownership mismatch blocks evaluation', async () => {
  const seed = baseSeed(); seed[`writingSubmissions/${studentUid}_w1`].studentId = 'otherUid'
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'permission-denied' })
})
await test('Hidden assignment blocks evaluation', async () => {
  const seed = baseSeed(); seed[`studentAccess/${studentUid}_writing_w1`].adminHidden = true
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'permission-denied' })
})
await test('Open retake blocks evaluation and report replay', async () => {
  const seed = baseSeed()
  const id = sha(`${studentUid}\u001fwriting\u001fw1`)
  seed[`submissionAttemptControls/${id}`] = { status: 'open' }
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'failed-precondition' })
  await assert.rejects(fx.service.getReport(fx.homework), { code: 'failed-precondition' })
  assert.equal(balance(fx), 5)
})
await test('Different attempt number produces distinct job and preserved old report', async () => {
  const fx = fixture()
  await fx.service.evaluate(fx.homework)
  fx.db.docs.get(`writingSubmissions/${studentUid}_w1`).attemptNumber = 2
  fx.db.docs.get(`writingSubmissions/${studentUid}_w1`).task2Answer += ' It also avoids consumer fraud.'
  const second = await fx.service.evaluate(fx.homework)
  assert.equal(second.attemptNumber, 2)
  assert.equal(balance(fx), 3); assert.equal(used(fx), 2); assert.equal(jobs(fx).length, 2)
})
await test('Mock Writing AI score remains provisional; teacher mock score untouched', async () => {
  const fx = fixture()
  const out = await fx.service.evaluate(fx.mock)
  assert.equal(out.status, 'completed')
  assert.equal(out.report.isProvisionalMockEstimate, true)
  assert.equal(out.report.teacherFinalScore, null)
  assert.deepEqual(fx.db.snapshot('scores/stu00001_m1').data(), baseSeed()['scores/stu00001_m1'])
  assert.deepEqual(fx.db.snapshot(`mockSubmissions/${studentUid}_m1`).data().result,
    baseSeed()[`mockSubmissions/${studentUid}_m1`].result)
})
await test('Mock without enabled Writing section is denied without credit', async () => {
  const seed = baseSeed(); seed['mockTests/m1'].enabledSections.writing = false
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.mock), { code: 'failed-precondition' })
  assert.equal(balance(fx), 5)
})
await test('Mock linked Writing source must share the school', async () => {
  const seed = baseSeed(); seed['writingHomeworks/w1'].schoolId = 'foreign'
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.mock), { code: 'failed-precondition' })
  assert.equal(balance(fx), 5)
})
await test('Institution disabled during provider call: score not stored and credit returned', async () => {
  const fx = fixture({ provider: async p => {
    fx.db.docs.get('aiWritingSchoolSettings/maxima').pilotEnabled = false
    return { report: reportFor(p), model: PILOT_MODEL }
  } })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'unavailable' })
  assert.equal(jobs(fx)[0][1].status, 'failed'); assert.equal(balance(fx), 5)
})
await test('Changed submitted answer during model call: result rejected and refunded', async () => {
  const fx = fixture({ provider: async p => {
    fx.db.docs.get(`writingSubmissions/${studentUid}_w1`).task2Answer = 'Changed mid-evaluation.'
    return { report: reportFor(p), model: PILOT_MODEL }
  } })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'unavailable' })
  assert.equal(jobs(fx)[0][1].status, 'failed'); assert.equal(balance(fx), 5)
})
await test('Monthly limit blocks further evaluation without provider calls', async () => {
  const seed = baseSeed(); seed[`aiWritingMonthlyUsage/maxima_${month}`] = {
    schoolId, month, requestCount: MAX_MONTHLY_SCHOOL_EVALUATIONS, completedCount: 0, pendingCount: 0
  }
  const fx = fixture({ seed })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'resource-exhausted' })
  assert.equal(balance(fx), 5)
})
await test('Expired pending job is refunded on report status request', async () => {
  let deliver
  const fx = fixture({ provider: p => new Promise(resolve => { deliver = () => resolve({ report: reportFor(p), model: PILOT_MODEL }) }) })
  const first = fx.service.evaluate(fx.homework)
  for (let i=0; i<100 && !deliver; i++) await new Promise(r=>setImmediate(r))
  assert.equal(balance(fx), 4)
  fx.advance(LEASE_MS+1)
  const status = await fx.service.getReport(fx.homework)
  assert.equal(status.status, 'failed'); assert.equal(status.creditReconciled, true)
  assert.equal(balance(fx), 5); assert.equal(monthly(fx).pendingCount, 0)
  deliver()
  await assert.rejects(first, { code: 'aborted' })
})
await test('A second request while old lease is expired reuses held credit', async () => {
  let finishFirst
  let calls = 0
  const fx = fixture({ provider: p => {
    calls++
    if (calls === 1) return new Promise(resolve => { finishFirst = () => resolve({ report: reportFor(p), model: PILOT_MODEL }) })
    return Promise.resolve({ report: reportFor(p), model: PILOT_MODEL })
  } })
  const first = fx.service.evaluate(fx.homework)
  for (let i=0;i<100 && !finishFirst;i++) await new Promise(r=>setImmediate(r))
  fx.advance(LEASE_MS + 1)
  const second = await fx.service.evaluate(fx.homework)
  assert.equal(second.status, 'completed'); assert.equal(balance(fx), 4)
  assert.equal(used(fx), 1); assert.equal(monthly(fx).completedCount, 1)
  assert.equal(monthly(fx).requestCount, 2)
  finishFirst()
  await assert.rejects(first, { code: 'aborted' })
})
await test('Provider reports without rubric are refunded', async () => {
  const fx = fixture({ provider: async () => ({ report: {}, model: PILOT_MODEL }) })
  await assert.rejects(fx.service.evaluate(fx.homework), { code: 'unavailable' })
  assert.equal(balance(fx), 5)
})
await test('Successful stored AI report contains no essay or image data', async () => {
  const fx = fixture()
  await fx.service.evaluate(fx.homework)
  const raw = JSON.stringify(jobs(fx)[0][1])
  assert.equal(raw.includes(png), false)
  assert.equal(raw.includes(t1), false)
  assert.equal(raw.includes(t2), false)
})
await test('Provider refuses without valid secret and does not fetch', async () => {
  let calls = 0
  await assert.rejects(gradeWithOpenAi({ foo: 1 }, '', { fetchImpl: () => { calls++; throw new Error('no') } }))
  assert.equal(calls, 0)
})
await test('Provider sends source image, JSON schema, store=false to exact endpoint', async () => {
  const prepared = grading.prepareAiWritingEvaluation({ source: baseSeed()['writingHomeworks/w1'],
    submission: baseSeed()[`writingSubmissions/${studentUid}_w1`] })
  let calls = 0
  const fakeFetch = async (url, options) => {
    calls++
    assert.equal(url, PROVIDER_URL)
    assert.equal(options.method, 'POST')
    const body = JSON.parse(options.body)
    assert.equal(body.model, PILOT_MODEL)
    assert.equal(body.store, false)
    assert.equal(body.text.format.strict, true)
    assert.equal(body.input[1].content[1].image_url, png)
    return new Response(JSON.stringify({ id: 'resp_123', status: 'completed', output: [{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({
        task1: reportRaw(prepared.task1.answer), task2: reportRaw(prepared.task2.answer)
      }) }]
    }] }), { status: 200 })
  }
  const out = await gradeWithOpenAi(prepared, `sk-${'x'.repeat(25)}`, { fetchImpl: fakeFetch })
  assert.equal(out.report.isAiEstimate, true); assert.equal(out.providerResponseId, 'resp_123')
  assert.equal(calls, 1)
})
function reportRaw(answer) {
  return {
    criteria: Object.fromEntries(grading.CRITERIA_KEYS.map(key => [key, {
      band: 6.5, explanation: 'Detailed issue', evidence: answer.slice(0, 7)
    }])), overview: 'Needs improvement', strengths: ['clear structure'],
    priorities: ['specific examples'], corrections: []
  }
}
await test('Provider error response cannot leak private response body', async () => {
  const p = grading.prepareAiWritingEvaluation({ source: baseSeed()['writingHomeworks/w1'],
    submission: baseSeed()[`writingSubmissions/${studentUid}_w1`] })
  await assert.rejects(gradeWithOpenAi(p, `sk-${'x'.repeat(25)}`, {
    fetchImpl: async () => new Response('secret essay reflected', { status: 400 })
  }), e => !e.message.includes('essay reflected'))
})
await test('Provider rejects refusal and incomplete responses', async () => {
  assert.throws(() => extractOutputJson({ status: 'incomplete', output: [] }), /did not complete/)
  assert.throws(() => extractOutputJson({ status: 'completed', output: [{
    type: 'message', role: 'assistant', content: [{ type: 'refusal' }]
  }] }), /refused/)
})
await test('App wiring exports both callables with secret binding and default-off gate', async () => {
  const src = fs.readFileSync('./functions/index.js', 'utf8')
  assert.match(src, /exports\.evaluateMyAiWriting\s*=\s*onCall\(\{\s*secrets: \[maximaOpenAiKey\]/)
  assert.match(src, /MAXIMA_AI_WRITING_ENABLED === 'true'/)
  assert.match(src, /exports\.getMyAiWritingReport\s*=\s*onCall/)
  assert.match(src, /\{ name: 'aiWritingEvaluations', fields: \['uid', 'studentId'\] \}/)
  assert.match(src, /'aiWritingMonthlyUsage'/)
  assert.match(src, /include\(snap, 'aiEvaluations'\)/)
})
await test('Firestore browser access to new evaluation and quota data is denied', async () => {
  const rules = fs.readFileSync('./firestore.rules', 'utf8')
  assert.match(rules, /match \/aiWritingEvaluations\/\{evaluationId\} \{\s*allow read, write: if false;/)
  assert.match(rules, /match \/aiWritingMonthlyUsage\/\{periodId\} \{\s*allow read, write: if false;/)
})
console.log(`\nP5A-2B offline evaluation: ${passed}/${passed+failed} PASS; ${failed} FAIL`)
if (failed) process.exitCode = 1
}
run().catch(error=>{ console.error('UNEXPECTED TEST RUNNER ERROR', error); process.exitCode = 1 })
