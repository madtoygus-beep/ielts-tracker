'use strict'
// Only synthetic records, in the hard-coded loopback emulator/demo project.
const { test, before, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const parser = require('@babel/parser')
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8290'
const projectId = 'demo-maxima-attempt-restart'
const req = createRequire(require('node:path').resolve(__dirname, '../functions/package.json'))
const { initializeApp, deleteApp } = req('firebase-admin/app')
const { getFirestore, FieldValue } = req('firebase-admin/firestore')
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing')
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore')
const { createAttemptRestartService, mockSpeakingAttemptId, vocabularyDraftId } = require('../functions/lib/attemptRestart')
const { createSpeakingService } = require('../functions/lib/speaking/service')
const { requireCurrentTeacherAcademicStudent } = require('../functions/lib/p0bCurrentAcademicAccess')
const app = initializeApp({ projectId }, 'attempt-restart-tests'), db = getFirestore(app)
class Fault extends Error { constructor(code, message) { super(message); this.code = code } }
const schoolIdOf = data => data?.schoolId || 'maxima'
const sourceText = fs.readFileSync('functions/index.js', 'utf8')
const ast = parser.parse(sourceText)
const declarations = new Map(ast.program.body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, sourceText.slice(node.start, node.end)]))
// The Admin SDK uses instanceof Promise. Bridge VM promises into its own realm.
const contextDb = { doc: db.doc.bind(db), collection: db.collection.bind(db), runTransaction: fn => db.runTransaction(async tx => await fn(tx)) }
const context = vm.createContext({ db: contextDb, FieldValue, HttpsError: Fault, schoolIdOf, createHash,
  vocabularyDraftId, attemptGeneration: value => typeof value === 'string' ? value : '',
  ATTEMPT_SCHEMA_VERSION: 1, ATTEMPT_CONTROL_COLLECTION: 'submissionAttemptControls', ATTEMPT_HISTORY_COLLECTION: 'submissionAttemptHistory', RESULT_DELETE_MAX_RECORDS: 400,
  toPlain: value => JSON.parse(JSON.stringify(value)) })
for (const name of ['attemptControlId', 'attemptHistoryId', 'attemptNumberOf', 'submissionMatchesContent', 'attemptHistoryPayload', 'createImmutableSubmission', 'replaceCurrentSubmissionForOpenAttempt', 'clearCurrentVocabularyDraft', 'resultDeleteFingerprint', 'collectManagedResultDeletion']) {
  vm.runInContext(declarations.get(name), context)
}
const service = createAttemptRestartService({ db, FieldValue, HttpsError: Fault, schoolIdOf,
  requireCurrentTeacherAcademicStudent, attemptControlId: context.attemptControlId,
  attemptHistoryId: context.attemptHistoryId, attemptHistoryPayload: context.attemptHistoryPayload })
context.attemptRestarts = service
const configs = Object.entries({ reading: ['readings', 'readingId'], listening: ['listenings', 'listeningId'],
  writing: ['writingHomeworks', 'writingId'], vocabulary: ['vocabularyTests', 'vocabularyTestId'], mock: ['mockTests', 'mockTestId'] })
  .map(([contentType, [sourceCollection, field]]) => ({ contentType, sourceCollection, submissionCollection: `${contentType}Submissions`, parentFields: [field] }))
context.OBJECTIVE_CONFIG = { vocabulary: configs.find(item => item.contentType === 'vocabulary') }
const source = { title: 'Synthetic exam', teacherId: 'T1', schoolId: 'maxima' }
const student = { uid: 'S1', schoolId: 'maxima', profile: { name: 'Synthetic learner' } }
const accessRef = config => db.doc(`studentAccess/S1_${config.contentType}_exam1`)
const submissionRef = config => db.doc(`${config.submissionCollection}/S1_exam1`)
const submission = (config, extra = {}) => ({ uid: 'S1', studentId: 'S1', schoolId: 'maxima',
  [config.parentFields[0]]: 'exam1', attemptNumber: 1, answers: { q1: 'saved answer' }, result: { band: 6 }, ...extra })
async function currentRecord(config) { const snap = await submissionRef(config).get(); return snap.exists ? { id: snap.id, ref: snap.ref, data: snap.data() } : null }
async function restart(config, options = {}) {
  return service.startFresh({ manager: { uid: 'T1', profile: { role: 'teacher', schoolId: 'maxima' } }, config,
    contentId: 'exam1', studentId: 'S1', source, accessRef: accessRef(config), current: await currentRecord(config),
    mockScore: config.contentType === 'mock' ? { ref: db.doc('scores/S1_exam1') } : null,
    expectedGeneration: '', ...options })
}
const denied = (promise, code = 'permission-denied') => assert.rejects(promise, error => error.code === code)
let env
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8290,
    rules: fs.readFileSync('firestore.rules', 'utf8') } })
})
beforeEach(async () => {
  await env.clearFirestore()
  const batch = db.batch()
  batch.set(db.doc('schools/maxima'), { status: 'active' })
  for (const [uid, role] of [['T1', 'teacher'], ['T2', 'teacher'], ['A1', 'admin'], ['S1', 'student'], ['S2', 'student']]) {
    batch.set(db.doc(`users/${uid}`), { role, schoolId: 'maxima', status: 'approved' })
  }
  batch.set(db.doc('schools/maxima/teacherAcademicIndex/T1'), { schemaVersion: 1, source: 'managed_active_classes', teacherId: 'T1', schoolId: 'maxima', activeStudentIds: ['S1'] })
  batch.set(db.doc('schools/maxima/teacherAcademicIndex/T2'), { schemaVersion: 1, source: 'managed_active_classes', teacherId: 'T2', schoolId: 'maxima', activeStudentIds: ['S2'] })
  for (const config of configs) {
    batch.set(db.doc(`${config.sourceCollection}/exam1`), source)
    for (const uid of ['S1', 'S2']) batch.set(db.doc(`studentAccess/${uid}_${config.contentType}_exam1`), {
      uid, schoolId: 'maxima', contentType: config.contentType, contentId: 'exam1', sourceCollection: config.sourceCollection,
      accessType: 'assignment', status: 'active' })
  }
  await batch.commit()
})
after(async () => { await env?.cleanup(); await db.terminate(); await deleteApp(app) })

for (const config of configs) {
  test(`${config.contentType}: reset unsubmitted work; old clients are fenced, new submission works`, async () => {
    const result = await restart(config)
    assert.equal(result.nextAttemptNumber, 1)
    assert.equal((await submissionRef(config).get()).exists, false)
    assert.equal((await db.collection('submissionAttemptHistory').get()).empty, true)
    assert.equal((await db.doc(`studentAccess/S2_${config.contentType}_exam1`).get()).data().attemptGeneration, undefined)
    const audit = (await db.collection('submissionAttemptRestarts').get()).docs[0].data()
    assert.equal(audit.restartedBy, 'T1'); assert.equal(audit.previousGeneration, '')
    // Exercise the actual production immutable-write helper with the old payload.
    await denied(context.createImmutableSubmission(config, student, 'exam1', submission(config)), 'failed-precondition')
    assert.equal((await submissionRef(config).get()).exists, false)
    await context.createImmutableSubmission(config, student, 'exam1', submission(config, { attemptGeneration: result.attemptGeneration }))
    assert.equal((await submissionRef(config).get()).data().attemptGeneration, result.attemptGeneration)
  })
  test(`${config.contentType}: completed attempt and review survive a fresh retake and another reset`, async () => {
    const original = submission(config, { review: { overall: 6.5 }, submittedAt: '2026-11-22T10:00:00Z' })
    await submissionRef(config).set(original)
    if (config.contentType === 'mock') await db.doc('scores/S1_exam1').set({ uid: 'S1', reading: 6, speaking: 7 })
    const first = await restart(config)
    assert.deepEqual((await submissionRef(config).get()).data(), original)
    const cid = context.attemptControlId('S1', config.contentType, 'exam1')
    const history = db.doc(`submissionAttemptHistory/${context.attemptHistoryId(cid, 1)}`)
    assert.equal((await history.get()).data().submissionSnapshot.review.overall, 6.5)
    const second = await restart(config, { expectedGeneration: first.attemptGeneration })
    assert.equal(second.nextAttemptNumber, 2)
    await denied(context.replaceCurrentSubmissionForOpenAttempt({ config, student, contentId: 'exam1', source,
      current: await currentRecord(config), submissionData: submission(config, { attemptGeneration: first.attemptGeneration }) }), 'failed-precondition')
    const saved = await context.replaceCurrentSubmissionForOpenAttempt({ config, student, contentId: 'exam1', source,
      current: await currentRecord(config), submissionData: submission(config, { attemptGeneration: second.attemptGeneration }),
      ...(config.contentType === 'mock' ? { scoreRecord: { ref: db.doc('scores/S1_exam1') }, scoreData: { uid: 'S1', reading: 7 } } : {}) })
    assert.equal(saved.attemptNumber, 2)
    assert.equal((await db.doc(`submissionAttemptControls/${cid}`).get()).data().status, 'consumed')
    assert.equal((await history.get()).data().submissionSnapshot.review.overall, 6.5)
    if (config.contentType === 'mock') assert.equal((await history.get()).data().scoreSnapshot.speaking, 7)
  })
}
test('concurrent teacher clicks commit only one reset; a later explicit reset requires the latest generation', async () => {
  const config = configs[0]
  const results = await Promise.allSettled([restart(config), restart(config)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal((await db.collection('submissionAttemptRestarts').get()).size, 1)
  const generation = (await accessRef(config).get()).data().attemptGeneration
  const second = await restart(config, { expectedGeneration: generation })
  assert.notEqual(second.attemptGeneration, generation)
})
test('learner submission wins the race: stale teacher state cannot discard it', async () => {
  const config = configs[0]
  await submissionRef(config).set(submission(config))
  await denied(restart(config, { current: null }), 'aborted')
  assert.equal((await db.collection('submissionAttemptRestarts').get()).size, 0)
  assert.equal((await submissionRef(config).get()).data().answers.q1, 'saved answer')
})
test('simultaneous first submission and teacher reset serialize without accepting a stale result', async () => {
  const config = configs[0]
  const results = await Promise.allSettled([restart(config, { current: null }),
    context.createImmutableSubmission(config, student, 'exam1', submission(config))])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  const saved = await submissionRef(config).get(), access = (await accessRef(config).get()).data()
  if (saved.exists) { assert.equal(access.attemptGeneration, undefined); assert.equal(results[0].status, 'rejected') }
  else { assert(access.attemptGeneration); assert.equal(results[1].status, 'rejected') }
})
test('current class authority, source, student and assignment are checked in the transaction', async () => {
  const config = configs[0]
  for (const manager of [{ uid: 'S1', profile: { role: 'teacher' } }, { uid: 'T2', profile: { role: 'teacher', schoolId: 'maxima' } }]) {
    await denied(restart(config, { manager }))
  }
  await accessRef(config).update({ status: 'inactive' }); await denied(restart(config))
  await accessRef(config).update({ status: 'active', adminHidden: true }); await denied(restart(config))
  await accessRef(config).update({ adminHidden: false })
  await db.doc('schools/maxima/teacherAcademicIndex/T1').update({ activeStudentIds: [] }); await denied(restart(config))
  assert.equal((await db.collection('submissionAttemptRestarts').get()).size, 0)
})
test('vocabulary rules: legacy drafts work, reset archives them, old/missing generations cannot overwrite or delete the new draft', async () => {
  const config = configs.find(item => item.contentType === 'vocabulary')
  const client = env.authenticatedContext('S1').firestore(), ref = doc(client, 'vocabularyDrafts/S1_exam1')
  const draft = { uid: 'S1', studentId: 'S1', schoolId: 'maxima', teacherId: 'T1', teacherIds: ['T1'],
    vocabularyTestId: 'exam1', answers: { q1: 'old answer' }, timeLeft: 42, updatedAt: new Date().toISOString() }
  await assertSucceeds(setDoc(ref, draft))
  const result = await restart(config)
  const freshRef = doc(client, `vocabularyDrafts/${vocabularyDraftId('S1', 'exam1', result.attemptGeneration)}`)
  const audit = (await db.collection('submissionAttemptRestarts').get()).docs[0].data()
  assert.equal(audit.vocabularyDraftSnapshot.answers.q1, 'old answer')
  await assertFails(setDoc(ref, { ...draft, answers: { q1: 'stale' } }))
  await assertFails(setDoc(ref, { ...draft, attemptGeneration: 23 }))
  await assertFails(setDoc(ref, { ...draft, attemptGeneration: result.attemptGeneration, answers: {} }))
  await assertSucceeds(setDoc(freshRef, { ...draft, attemptGeneration: result.attemptGeneration, answers: {} }))
  // A legacy mergeFields request cannot inherit the new session's generation:
  // it writes a different document, and that legacy document is now fenced.
  await assertFails(setDoc(ref, draft, { mergeFields: Object.keys(draft) }))
  await assertFails(updateDoc(freshRef, { attemptGeneration: '', answers: { q1: 'stale' } }))
  await assertFails(deleteDoc(freshRef))
  assert.deepEqual((await getDoc(freshRef)).data().answers, {})
  await assertFails(setDoc(doc(client, 'studentAccess/S1_vocabulary_exam1'), { attemptGeneration: 'forged' }))
  await assertFails(getDoc(doc(env.authenticatedContext('S2').firestore(), 'studentAccess/S1_vocabulary_exam1')))
  for (const uid of ['S1', 'T1']) await assertFails(getDoc(doc(env.authenticatedContext(uid).firestore(), (await db.collection('submissionAttemptRestarts').get()).docs[0].ref.path)))
})
test('production submit callables carry the generation through grading and final commits for all five types', () => {
  for (const kind of ['Reading', 'Listening', 'Writing', 'Vocabulary', 'Mock']) {
    const name = `submit${kind}Secure`
    const node = ast.program.body.find(node => node.type === 'ExpressionStatement' && node.expression.left?.property?.name === name)
    const code = sourceText.slice(node.start, node.end)
    assert(code.includes('attemptRestarts.assertCurrent('), `${name} must fence preflight`)
    assert(code.includes('attemptGeneration: attemptGeneration(data.attemptGeneration)'), `${name} must carry the captured generation`)
  }
})
test('late vocabulary submission cleanup cannot delete a draft from the teacher-reset session', async () => {
  const config = context.OBJECTIVE_CONFIG.vocabulary, fresh = await restart(config)
  const ref = db.doc(`vocabularyDrafts/${vocabularyDraftId('S1', 'exam1', fresh.attemptGeneration)}`)
  await ref.set({ uid: 'S1', studentId: 'S1', vocabularyTestId: 'exam1', attemptGeneration: fresh.attemptGeneration, answers: { q1: 'new answer' } })
  await context.clearCurrentVocabularyDraft(student, 'exam1', '')
  assert.equal((await ref.get()).data().answers.q1, 'new answer')
  await context.clearCurrentVocabularyDraft(student, 'exam1', fresh.attemptGeneration)
  assert.equal((await ref.get()).exists, false)
})
test('restart audit is scoped into the existing permanent result-deletion preview', async () => {
  const config = configs[0]
  await restart(config)
  const preview = await context.collectManagedResultDeletion({ config, studentId: 'S1', contentId: 'exam1', schoolId: 'maxima' })
  assert.equal(preview.counts.attemptRestarts, 1)
  assert.equal(preview.records.filter(row => row.snap.ref.path.startsWith('submissionAttemptRestarts/')).length, 1)
})
test('each reset preserves the previous generation of Vocabulary drafts and the deletion preview includes all of them', async () => {
  const config = context.OBJECTIVE_CONFIG.vocabulary
  const first = await restart(config)
  await db.doc(`vocabularyDrafts/${vocabularyDraftId('S1', 'exam1', first.attemptGeneration)}`).set({ uid: 'S1', studentId: 'S1', schoolId: 'maxima', vocabularyTestId: 'exam1', attemptGeneration: first.attemptGeneration, answers: { q1: 'first generation' } })
  const second = await restart(config, { expectedGeneration: first.attemptGeneration })
  const rows = (await db.collection('submissionAttemptRestarts').get()).docs.map(row => row.data())
  assert.equal(rows.find(row => row.attemptGeneration === second.attemptGeneration).vocabularyDraftSnapshot.answers.q1, 'first generation')
  await db.doc(`vocabularyDrafts/${vocabularyDraftId('S1', 'exam1', second.attemptGeneration)}`).set({ uid: 'S1', studentId: 'S1', schoolId: 'maxima', vocabularyTestId: 'exam1', attemptGeneration: second.attemptGeneration, answers: {} })
  const preview = await context.collectManagedResultDeletion({ config, studentId: 'S1', contentId: 'exam1', schoolId: 'maxima' })
  assert.equal(preview.counts.vocabularyDrafts, 2)
  assert.equal(preview.counts.attemptRestarts, 2)
})
test('standalone Speaking reset creates a new head and new preparation timer in real transactions', async () => {
  const actor = async request => { const uid = request.auth.uid; return { uid, profile: (await db.doc(`users/${uid}`).get()).data(), schoolId: 'maxima' } }
  const speaking = createSpeakingService({ db, HttpsError: Fault, schoolIdOf,
    requireCurrentTeacherAcademicStudent, requireStudent: actor, requireAssignmentManager: actor,
    requireAssignedMock: async () => { throw Error('No parent Mock in this fixture') },
    bucket: {}, provider: async () => { throw Error('AI must not run') } })
  const call = (op, data = {}, uid = 'S1') => speaking.call({ auth: { uid }, data: { op, ...data } })
  await db.doc('speakingTasks/task1').set({ title: 'Synthetic Part 2', schoolId: 'maxima', teacherId: 'T1', assignedTo: ['S1'], config: { enabled: true, questions: [{ part: 2, text: 'Describe a useful skill.', seconds: 120 }] } })
  const old = await call('start', { taskId: 'task1' }); await call('beginQuestion', { attemptId: old.id })
  const next = await call('restartAttempt', { attemptId: old.id }, 'T1')
  await denied(call('beginQuestion', { attemptId: old.id }), 'failed-precondition')
  const fresh = await call('start', { taskId: 'task1' })
  assert.equal(fresh.id, next.attemptId); assert.deepEqual(fresh.answers, [])
  assert.equal(fresh.current, null); assert.equal(fresh.aiAvailable, false)
  const timing = await call('beginQuestion', { attemptId: fresh.id })
  assert.equal(timing.recordAt - timing.startedAt, 60000)
  assert.equal((await call('get', { attemptId: old.id, staff: true }, 'T1')).isLatestAttempt, false)
})
test('Mock Speaking uses a distinct ID per reset while preserving the legacy ID for untouched assignments', () => {
  const old = mockSpeakingAttemptId('S1', 'exam1', 1)
  assert.equal(old, createHash('sha256').update('S1\0exam1\x001').digest('hex'))
  assert.notEqual(old, mockSpeakingAttemptId('S1', 'exam1', 1, 'fresh'))
  assert.notEqual(mockSpeakingAttemptId('S1', 'exam1', 1, 'fresh'), mockSpeakingAttemptId('S1', 'exam1', 2, 'fresh'))
})
