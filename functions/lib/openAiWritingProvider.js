'use strict'

// P5A-2B: OpenAI Responses transport, not a student-facing endpoint.
// The key is obtained only inside an explicitly secret-bound Cloud Function.
// Never log the request/response body: both may contain student work.
const { buildOpenAiEvaluationRequest, parseAiWritingJsonOutput } = require('./aiWritingGrading')

const PROVIDER_URL = 'https://api.openai.com/v1/responses'
const PILOT_MODEL = 'gpt-5-mini'
const MAX_PROVIDER_RESPONSE_BYTES = 350000

async function readLimitedText(response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const buffers = []
    let n = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.byteLength
      if (n > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('AI provider response is too large.')
      }
      buffers.push(Buffer.from(value))
    }
    return Buffer.concat(buffers).toString('utf8')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('AI provider response is too large.')
  return text
}

function extractOutputJson(response) {
  if (!response || typeof response !== 'object' || response.status !== 'completed') {
    throw new Error('AI provider did not complete the evaluation.')
  }
  const fragments = []
  for (const output of Array.isArray(response.output) ? response.output : []) {
    if (output?.type !== 'message' || output?.role !== 'assistant') continue
    for (const part of Array.isArray(output.content) ? output.content : []) {
      if (part?.type === 'refusal') throw new Error('AI provider refused this evaluation.')
      if (part?.type === 'output_text' && typeof part.text === 'string') fragments.push(part.text)
    }
  }
  if (fragments.length !== 1) throw new Error('Expected exactly one structured AI report.')
  return fragments[0]
}

async function gradeWithOpenAi(prepared, apiKey, { fetchImpl = globalThis.fetch, timeoutMs = 90000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-') || apiKey.length < 20) {
    throw new Error('OpenAI API secret is not configured.')
  }
  if (typeof fetchImpl !== 'function') throw new Error('HTTPS fetch is unavailable.')
  const body = buildOpenAiEvaluationRequest(prepared, PILOT_MODEL)
  // Intentional: no automatic provider retries, which could incur multiple API charges.
  const response = await fetchImpl(PROVIDER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const responseText = await readLimitedText(response)
  if (!response.ok) {
    // OpenAI errors sometimes echo input; never return or log the response text.
    throw new Error(`AI provider request failed (HTTP ${Number(response.status) || 0}).`)
  }
  let providerResponse
  try { providerResponse = JSON.parse(responseText) } catch (_) {
    throw new Error('AI provider returned malformed JSON.')
  }
  const output = extractOutputJson(providerResponse)
  const report = parseAiWritingJsonOutput(output, prepared)
  return { report, model: PILOT_MODEL, providerResponseId: typeof providerResponse.id === 'string'
    ? providerResponse.id.slice(0, 120) : '' }
}

module.exports = { PILOT_MODEL, PROVIDER_URL, extractOutputJson, gradeWithOpenAi }
