'use strict'
// Synthetic adapter regression checks; no student data, network or paid provider.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CRITERIA_KEYS, prepareAiWritingEvaluation, normalizeAiWritingReport,
  buildOpenAiEvaluationRequest, validAiWritingReport } = require('../functions/lib/aiWritingGrading')
const answer = Array.from({ length: 40 }, (_, i) => `sample${i}`).join(' ')
const image = 'data:image/png;base64,' + Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(32)
]).toString('base64')
function prepared(mode = 'task2_only') {
  return prepareAiWritingEvaluation({ source: { contentType: mode,
    task1: { prompt: 'Compare the two charts in 1998 and 2023.', image },
    task2: { prompt: 'Explain a benefit and a drawback of online shopping.' } },
    submission: { task1Answer: answer, task2Answer: answer } })
}
function task(bands) {
  return { criteria: Object.fromEntries(CRITERIA_KEYS.map((key,i) => [key,
    { band: bands[i], explanation: `Synthetic criterion ${i}`, evidence: 'sample0 sample1' }])),
    overview: 'Synthetic overview', strengths: ['Synthetic strength'],
    priorities: ['Synthetic priority'], corrections: [] }
}
test('different criterion bands remain independent and underlength has no fixed penalty', () => {
  const input = prepared()
  const before = JSON.stringify(input)
  const result = normalizeAiWritingReport({ task1: null, task2: task([5,5,5,4]) }, input)
  assert.deepEqual(CRITERIA_KEYS.map(k => result.task2.criteria[k].band), [5,5,5,4])
  assert.equal(result.task2.estimatedBand, 5)
  assert.equal(result.task2.belowRecommendedLength, true)
  assert.equal(result.task2.wordCount, 40)
  assert.equal(validAiWritingReport(result, input), true)
  assert.equal(JSON.stringify(input), before)
})
test('Band 2.5 is retained instead of being raised to 5', () => {
  const result = normalizeAiWritingReport({ task1:null, task2:task([2,3,2,3]) }, prepared())
  assert.equal(result.estimatedBand, 2.5)
})
test('full Writing retains Task 2 double weighting without changing criteria', () => {
  const input = prepared('full_writing')
  const result = normalizeAiWritingReport({ task1:task([4,4,4,4]), task2:task([7,7,7,7]) }, input)
  assert.equal(result.estimatedBand, 6)
  assert.equal(validAiWritingReport(result, input), true)
})
test('imagined student evidence and correction originals are removed', () => {
  const raw = task([5,5,5,5])
  raw.criteria.lexicalResource.evidence = 'invented student wording'
  raw.corrections = [{ original:'invented student wording', suggestion:'New text', reason:'Synthetic' }]
  const result = normalizeAiWritingReport({ task1:null, task2:raw }, prepared())
  assert.equal(result.task2.criteria.lexicalResource.evidence, '')
  assert.equal(result.task2.corrections.length, 0)
  assert.equal(result.totalUnverifiedEvidence, 2)
})
test('evaluation request retains the actual source visual, prompt and server word count', () => {
  const input = prepared('full_writing')
  const request = buildOpenAiEvaluationRequest(input, 'test-model')
  const parts = request.input[1].content
  const data = JSON.parse(parts[0].text)
  assert.equal(parts[1].image_url, image)
  assert.equal(data.task1.prompt, input.task1.prompt)
  assert.equal(data.task1.answer, answer)
  assert.equal(data.task1.wordCount, 40)
  assert.equal(data.task2.prompt, input.task2.prompt)
  assert.equal(request.store, false)
})
