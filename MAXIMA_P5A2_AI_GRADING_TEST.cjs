'use strict'

const assert = require('node:assert/strict')
const { join } = require('node:path')
const grading = require(join(__dirname, 'functions/lib/aiWritingGrading.js'))
const {
  countWords, roundHalf, averageFourBands,
  prepareAiWritingEvaluation, normalizeAiWritingReport,
  buildOpenAiEvaluationRequest, parseAiWritingJsonOutput
} = grading

let pass = 0
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`) }
  catch (error) {
    console.error(`FAIL ${name}: ${error?.stack || error}`)
    process.exitCode = 1
  }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
const TASK1_ANSWER = 'Overall, the city developed substantially. The former park became a hospital, whereas the river remained unchanged. Additionally, several new residential buildings appeared near the centre, while the main road was extended to connect the surrounding neighbourhoods with the station.'
const TASK2_ANSWER = 'Some people suggest that schools should teach financial literacy. I agree because basic budgeting skills can prevent debt and help young people make responsible decisions.'

function source(mode = 'full_writing') {
  return {
    contentType: mode,
    task1: { title: 'Map change', prompt: 'The maps show a town in 2000 and 2020. Summarise the main features.', image: PNG },
    task2: { title: 'Finance', prompt: 'Schools should teach financial literacy. Discuss your opinion.' }
  }
}
function submission() {
  return { task1Answer: TASK1_ANSWER, task2Answer: TASK2_ANSWER }
}
function oneTaskReport(text, bands = [6, 6.5, 7, 6.5], quote = '') {
  const criteria = {}
  for (const [index, key] of grading.CRITERIA_KEYS.entries()) {
    criteria[key] = {
      band: bands[index],
      explanation: `Specific criterion observation ${index}.`,
      evidence: quote
    }
  }
  return {
    criteria, overview: 'Clear response with some limitations.',
    strengths: ['States a clear position.', 'Develops an example.'],
    priorities: ['Improve cohesion.', 'Check article use.'],
    corrections: quote ? [{ original: quote, suggestion: 'A revised phrase', reason: 'Improves accuracy.' }] : []
  }
}
function reports(t1 = oneTaskReport(TASK1_ANSWER, [6.5, 6.5, 6.5, 6.5], 'former park'),
  t2 = oneTaskReport(TASK2_ANSWER, [7.5, 7.5, 7.5, 7.5], 'financial literacy')) {
  return { task1: t1, task2: t2 }
}
function prepared(mode = 'full_writing', context = 'homework') {
  return prepareAiWritingEvaluation({ source: source(mode), submission: submission(), context })
}

// Input shape and cross-task protections.
test('Word count ignores repeated whitespace', () => assert.equal(countWords(' a   b\n c  '), 3))
test('Word count handles an empty response', () => assert.equal(countWords('  '), 0))
test('Band arithmetic rounds 6.25 to 6.5', () => assert.equal(roundHalf(6.25), 6.5))
test('Band arithmetic rounds 6.24 to 6.0', () => assert.equal(roundHalf(6.24), 6))
test('Criterion average yields valid 0.5 band', () => assert.equal(averageFourBands([6, 6.5, 7, 6.5]), 6.5))
test('Criterion average rejects missing criteria', () => assert.throws(() => averageFourBands([6, 6.5]), /Four/))
test('Criterion average rejects invalid points', () => assert.throws(() => averageFourBands([6, 10, 6, 6]), /IELTS band/))
test('Task 1 and Task 2 are enabled for full writing', () => assert.equal(prepared().task2Enabled && prepared().task1Enabled, true))
test('Task 1 visual data URL is preserved for source interpretation', () => assert.equal(prepared().task1.image, PNG))
test('Task 1 word count belongs to original answer', () => assert.equal(prepared().task1.wordCount, countWords(TASK1_ANSWER)))
test('Task 2 word count belongs to original answer', () => assert.equal(prepared().task2.wordCount, countWords(TASK2_ANSWER)))
test('Task 1 minimum 150 words declared', () => assert.equal(prepared().task1.recommendedMinimumWords, 150))
test('Task 2 minimum 250 words declared', () => assert.equal(prepared().task2.recommendedMinimumWords, 250))
test('Task 1 only mode excludes Task 2', () => assert.equal(prepared('task1_only').task2, null))
test('Task 2 only mode excludes Task 1 image', () => assert.equal(prepared('task2_only').task1, null))
test('Mock context remains distinct', () => assert.equal(prepared('full_writing', 'mock').context, 'mock'))
test('Unknown context rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: source(), submission: submission(), context: 'self-study' }), /context/))
test('Unknown writing mode rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: source('evil_mode'), submission: submission() }), /mode/))
test('No source object rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: null, submission: submission() }), /plain object/))
test('No submission object rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: source(), submission: null }), /plain object/))
test('No answer must never spend credits', () => assert.throws(() => prepareAiWritingEvaluation({ source: source(), submission: { task1Answer: ' ', task2Answer: '' } }), /empty/))
test('Unexpected task flags rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: source(), submission: { ...submission(), task1Enabled: false } }), /disagree/))
test('Missing task1 image rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: { ...source(), task1: { prompt: 'hi' } }, submission: submission() }), /Task 1 visual/))
test('Untrusted remote image URL rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: { ...source(), task1: { prompt: 'hi', image: 'https://evil.example/map.png' } }, submission: submission() }), /trusted/))
test('SVG/script image rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: { ...source(), task1: { prompt: 'hi', image: 'data:image/svg+xml;base64,PHN2Zy8+' } }, submission: submission() }), /trusted/))
test('Bogus image bytes rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: { ...source(), task1: { prompt: 'hi', image: `data:image/png;base64,${Buffer.alloc(64).toString('base64')}` } }, submission: submission() }), /content/))
test('Base64 padding errors rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: { ...source(), task1: { prompt: 'hi', image: 'data:image/png;base64,A===' } }, submission: submission() }), /trusted/))
test('Missing Task 2 prompt rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: { ...source(), task2: { prompt: ' ' } }, submission: submission() }), /Task 2 prompt/))
test('Oversized Task 2 answer rejected', () => assert.throws(() => prepareAiWritingEvaluation({ source: source('task2_only'), submission: { task2Answer: 'a'.repeat(80001) } }), /80000/))
test('Task 2 source mode ignores Task 1 contents safely', () => assert.equal(prepareAiWritingEvaluation({ source: source('task2_only'), submission: { task1Answer: 'ignore', task2Answer: TASK2_ANSWER } }).task1, null))
test('Mock answers adapt writingAnswers shape', () => assert.equal(prepareAiWritingEvaluation({ source: source(), submission: { writingAnswers: { task1: TASK1_ANSWER, task2: TASK2_ANSWER } }, context: 'mock' }).task2.answer, TASK2_ANSWER))

// Provider payload is created but never sent; ensure source image is actually provided.
test('OpenAI request uses JSON schema strict formatting', () => {
  const payload = buildOpenAiEvaluationRequest(prepared(), 'gpt-5-mini')
  assert.equal(payload.text.format.type, 'json_schema')
  assert.equal(payload.text.format.strict, true)
  assert.deepEqual(payload.text.format.schema.required, ['task1', 'task2'])
})
test('OpenAI request has store=false for privacy', () => assert.equal(buildOpenAiEvaluationRequest(prepared(), 'gpt-5-mini').store, false))
test('OpenAI request contains task1 input_image', () => assert.equal(buildOpenAiEvaluationRequest(prepared(), 'gpt-5-mini').input[1].content[1].type, 'input_image'))
test('OpenAI request image matches actual source', () => assert.equal(buildOpenAiEvaluationRequest(prepared(), 'gpt-5-mini').input[1].content[1].image_url, PNG))
test('Task2-only request has no image', () => assert.equal(buildOpenAiEvaluationRequest(prepared('task2_only'), 'gpt-5-mini').input[1].content.length, 1))
test('Client does not select arbitrary model', () => assert.throws(() => buildOpenAiEvaluationRequest(prepared(), 'bad model;'), /model/))
test('Schema disallows extra fields', () => assert.equal(buildOpenAiEvaluationRequest(prepared(), 'gpt-5-mini').text.format.schema.additionalProperties, false))
test('Schema requires all four criteria', () => assert.equal(buildOpenAiEvaluationRequest(prepared(), 'gpt-5-mini').text.format.schema.properties.task1.anyOf[0].properties.criteria.required.length, 4))
test('Provider request contains no API key', () => assert.equal(JSON.stringify(buildOpenAiEvaluationRequest(prepared(), 'gpt-5-mini')).includes('sk-'), false))

// Model results are untrusted: calculate bands on backend, check text evidence.
test('Model overall band is recomputed, not trusted', () => {
  const result = normalizeAiWritingReport({ ...reports(), estimatedBand: 9 }, prepared())
  assert.equal(result.estimatedBand, 7)
})
test('Task 2 is double-weighted', () => {
  const result = normalizeAiWritingReport(reports(), prepared())
  assert.equal(result.task1.estimatedBand, 6.5)
  assert.equal(result.task2.estimatedBand, 7.5)
  assert.equal(result.estimatedBand, 7)
})
test('Results always explicitly labelled AI estimates', () => assert.equal(normalizeAiWritingReport(reports(), prepared()).isAiEstimate, true))
test('Mock results remain provisional and teacher score null', () => {
  const report = normalizeAiWritingReport(reports(), prepared('full_writing', 'mock'))
  assert.equal(report.isProvisionalMockEstimate, true)
  assert.equal(report.teacherFinalScore, null)
})
test('Homework results do not require teacher approval', () => assert.equal(normalizeAiWritingReport(reports(), prepared()).isProvisionalMockEstimate, false))
test('Unverified criterion quotations are removed', () => {
  const raw = reports()
  raw.task2.criteria.lexicalResource.evidence = 'This quotation is invented and does not exist.'
  const result = normalizeAiWritingReport(raw, prepared())
  assert.equal(result.task2.criteria.lexicalResource.evidence, '')
  assert.equal(result.totalUnverifiedEvidence, 1)
})
test('Verified literal quotes are preserved', () => assert.equal(normalizeAiWritingReport(reports(), prepared()).task2.criteria.lexicalResource.evidence, 'financial literacy'))
test('Unverified correction originals are dropped', () => {
  const raw = reports()
  raw.task1.corrections.push({ original: 'Not actually written', suggestion: 'foo', reason: 'bar' })
  const result = normalizeAiWritingReport(raw, prepared())
  assert.equal(result.task1.corrections.length, 1)
  assert.equal(result.totalUnverifiedEvidence, 1)
})
test('Empty Task 1 is scored zero regardless of model invention', () => {
  const prep = prepareAiWritingEvaluation({ source: source(), submission: { task1Answer: '', task2Answer: TASK2_ANSWER } })
  const report = normalizeAiWritingReport(reports(), prep)
  assert.equal(report.task1.estimatedBand, 0)
  assert.equal(report.estimatedBand, 5)
})
test('Empty Task 2 is scored zero regardless of model invention', () => {
  const prep = prepareAiWritingEvaluation({ source: source(), submission: { task1Answer: TASK1_ANSWER, task2Answer: '' } })
  const report = normalizeAiWritingReport(reports(), prep)
  assert.equal(report.task2.estimatedBand, 0)
  assert.equal(report.estimatedBand, 2)
})
test('Task1-only report computes only Task1 score', () => assert.equal(normalizeAiWritingReport({ task1: reports().task1, task2: null }, prepared('task1_only')).estimatedBand, 6.5))
test('Task2-only report computes only Task2 score', () => assert.equal(normalizeAiWritingReport({ task1: null, task2: reports().task2 }, prepared('task2_only')).estimatedBand, 7.5))
test('Short answers are flagged, not mechanically capped', () => {
  const report = normalizeAiWritingReport(reports(), prepared())
  assert.equal(report.task1.belowRecommendedLength, true)
  assert.equal(report.task2.belowRecommendedLength, true)
  assert.equal(report.task2.estimatedBand, 7.5)
})
test('Bogus half-step score rejected', () => {
  const raw = reports()
  raw.task2.criteria.coherenceAndCohesion.band = 7.2
  assert.throws(() => normalizeAiWritingReport(raw, prepared()), /IELTS band/)
})
test('Criterion score >9 rejected', () => {
  const raw = reports()
  raw.task1.criteria.coherenceAndCohesion.band = 9.5
  assert.throws(() => normalizeAiWritingReport(raw, prepared()), /IELTS band/)
})
test('Criterion score below 1 rejected for nonempty task', () => {
  const raw = reports()
  raw.task1.criteria.coherenceAndCohesion.band = 0
  assert.throws(() => normalizeAiWritingReport(raw, prepared()), /IELTS band/)
})
test('Missing explanation rejected', () => {
  const raw = reports()
  raw.task1.criteria.coherenceAndCohesion.explanation = ''
  assert.throws(() => normalizeAiWritingReport(raw, prepared()), /non-empty/)
})
test('Missing task report rejected', () => assert.throws(() => normalizeAiWritingReport({ task1: reports().task1 }, prepared()), /plain object/))
test('Raw JSON output parsed correctly', () => assert.equal(parseAiWritingJsonOutput(JSON.stringify(reports()), prepared()).estimatedBand, 7))
test('Invalid JSON output rejected', () => assert.throws(() => parseAiWritingJsonOutput('{', prepared()), /not valid JSON/))
test('Non-string model output rejected', () => assert.throws(() => parseAiWritingJsonOutput(null, prepared()), /missing/))
test('Overlong provider response rejected', () => assert.throws(() => parseAiWritingJsonOutput(' '.repeat(100001), prepared()), /too large/))
test('Reports do not embed source image or full student essay', () => {
  const result = normalizeAiWritingReport(reports(), prepared())
  assert.equal(JSON.stringify(result).includes(PNG), false)
  assert.equal(JSON.stringify(result).includes(TASK2_ANSWER), false)
})
test('Prepared eval flags no missing task2 image requirement', () => {
  const prep = prepared('task2_only')
  assert.equal(prep.task2.prompt.length > 0, true)
})

if (!process.exitCode) console.log(`\nP5A-2A pure grading tests: ${pass}/${pass} PASS`)
else console.error(`\nP5A-2A pure grading tests: ${pass} PASS, test failures occurred`)
