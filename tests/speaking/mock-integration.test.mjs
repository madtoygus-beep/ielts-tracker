import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockSpeakingSummary } from '../../src/services/mockSpeakingSummary.js'
import { createStudentSpeakingLibrary } from '../../src/services/studentSpeakingLibrary.js'

const questions = [1, 2, 3].map((part, index) => ({ id: `q${index + 1}`, part }))
test('Mock review counts actual recordings and keeps missing or interrupted answers visible', () => {
  const attempt = { status: 'submitted', questions, answers: [{ questionId: 'q1', duration: 20 }, { questionId: 'q2', duration: 60, interrupted: true }, { questionId: 'q3', duration: 0, interrupted: true }] }
  const before = structuredClone(attempt)
  assert.deepEqual(mockSpeakingSummary(attempt), { total: 3, recorded: 2, missing: 1, interrupted: 2, submitted: true })
  assert.deepEqual(attempt, before)
  assert.deepEqual(mockSpeakingSummary(null, { questions }), { total: 3, recorded: 0, missing: 3, interrupted: 0, submitted: false })
})
test('Mock review deduplicates answer receipts without inventing recordings or scores', () => {
  const summary = mockSpeakingSummary({ status: 'reviewed', questions, answers: [{ questionId: 'q1', duration: 20 }, { questionId: 'q1', duration: 20 }, { questionId: 'q2', duration: 120 }, { questionId: 'q3', duration: 30 }] })
  assert.equal(summary.recorded, 3); assert.equal(summary.missing, 0); assert.equal(summary.submitted, true)
  assert.equal(summary.band, undefined)
})
test('Full and Mini Mock use only authoritative exam calls; no homework pages or report reads occur between questions', async () => {
  for (const mockId of ['full-mock', 'mini-mock']) {
    const calls = []
    const attempt = { id: `${mockId}-attempt`, mockId, taskId: '', mode: 'mock', questions, answers: [], status: 'recording', nextIndex: 0 }
    const library = createStudentSpeakingLibrary(async (op, data) => {
      calls.push({ op, ...data })
      if (op === 'beginQuestion') return { startedAt: 1, recordAt: 8001, deadline: 38001 }
      if (op === 'saveAnswer') { attempt.answers.push({ questionId: questions[data.index].id, duration: data.index === 1 ? 60 : 20 }); attempt.nextIndex++ }
      if (op === 'submit') attempt.status = 'submitted'
      return structuredClone(attempt)
    })
    await library.api('start', { mockId, attemptGeneration: 'generation-one' })
    for (let index = 0; index < questions.length; index++) {
      await library.api('beginQuestion', { attemptId: attempt.id })
      await library.api('saveAnswer', { attemptId: attempt.id, index })
    }
    await library.api('submit', { attemptId: attempt.id })
    assert.deepEqual(calls.map(call => call.op), ['start', 'beginQuestion', 'saveAnswer', 'beginQuestion', 'saveAnswer', 'beginQuestion', 'saveAnswer', 'submit'])
    assert.equal(calls[0].attemptGeneration, 'generation-one')
    assert.equal(library.getSnapshot().attempts[0].status, 'submitted')
    assert.equal(library.getSnapshot().total, 0, 'Mock Speaking never becomes standalone homework')
  }
})
test('Mock result reads share a short cache; refreshing still reaches the server and no list is fetched', async () => {
  const calls = [], completed = { id: 'mock-done', mockId: 'mock', status: 'submitted', questions, answers: [] }
  const library = createStudentSpeakingLibrary(async (op, data) => { calls.push({ op, ...data }); return completed })
  assert.equal(calls.length, 0, 'building a result view itself makes no requests')
  await Promise.all([library.api('get', { attemptId: completed.id }), library.api('get', { attemptId: completed.id })])
  await library.api('get', { attemptId: completed.id })
  assert.equal(calls.length, 1)
  await library.api('get', { attemptId: completed.id, forceRefresh: true })
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.op === 'get'))
})
test('a new Mock generation always starts on the server and keeps the old attempt separate', async () => {
  const calls = []
  const library = createStudentSpeakingLibrary(async (op, data) => {
    calls.push({ op, ...data })
    return { id: `mock-${data.attemptGeneration}`, mockId: data.mockId, status: 'recording', questions, answers: [], nextIndex: 0 }
  })
  const original = await library.api('start', { mockId: 'mock', attemptGeneration: '' })
  const fresh = await library.api('start', { mockId: 'mock', attemptGeneration: 'teacher-fresh' })
  assert.notEqual(original.id, fresh.id)
  assert.equal(calls.length, 2); assert.equal(calls[1].attemptGeneration, 'teacher-fresh')
  assert.equal(library.getSnapshot().attempts.length, 2)
})
