// Institutional IELTS objective scoring; deliberately independent of Writing.
// Full IELTS Listening and Academic Reading use 40 items. On shorter exercises,
// these are ESTIMATES from a rounded 40-item equivalent, not official test scores.
// Must match functions/lib/grading.js; tested exhaustively for all valid counts.

export function getReadingBand(correct, total) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return 0
  // Short tests use a 40-question equivalent: estimated IELTS band.
  const raw = Math.max(0, Math.min(40, Math.round(correct * 40 / total)))
  if (raw >= 39) return 9
  if (raw >= 37) return 8.5
  if (raw >= 35) return 8
  if (raw >= 33) return 7.5
  if (raw >= 30) return 7
  if (raw >= 27) return 6.5
  if (raw >= 23) return 6
  if (raw >= 19) return 5.5
  if (raw >= 15) return 5
  if (raw >= 13) return 4.5
  if (raw >= 10) return 4
  if (raw >= 8) return 3.5
  if (raw >= 6) return 3
  if (raw >= 4) return 2.5
  if (raw >= 2) return 2
  return 1
}

export function getListeningBand(correct, total) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return 0
  // Short tests use a 40-question equivalent: estimated IELTS band.
  const raw = Math.max(0, Math.min(40, Math.round(correct * 40 / total)))
  if (raw >= 39) return 9
  if (raw >= 37) return 8.5
  if (raw >= 35) return 8
  if (raw >= 32) return 7.5
  if (raw >= 30) return 7
  if (raw >= 26) return 6.5
  if (raw >= 23) return 6
  if (raw >= 18) return 5.5
  if (raw >= 16) return 5
  if (raw >= 13) return 4.5
  if (raw >= 11) return 4
  if (raw >= 8) return 3.5
  if (raw >= 6) return 3
  if (raw >= 4) return 2.5
  if (raw >= 2) return 2
  return 1
}


export function objectiveAccuracy(correct, total) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) ||
      total <= 0 || correct < 0 || correct > total) return null
  return Math.round((correct / total) * 100)
}

// Reading/Listening homework is accuracy based. Vocabulary is not an IELTS
// section and must not receive a fabricated IELTS Band score.
export function formatHomeworkScore(result) {
  const correct = result?.correct
  const total = result?.total
  const percent = objectiveAccuracy(correct, total)
  return percent === null ? 'Result unavailable'
    : `${correct}/${total} correct · ${percent}%`
}

// For legacy stored results, trust verifiable raw counts over a stale old band.
// No raw counts -> retain an existing valid band as historical, not recalculated.
export function savedObjectiveBand(kind, result) {
  if (!result || typeof result !== 'object') return null
  if (Number.isFinite(result.correct) && Number.isFinite(result.total)) {
    if (result.total <= 0 || result.correct < 0 || result.correct > result.total)
      return null
    if (kind === 'listening') return getListeningBand(result.correct, result.total)
    if (kind === 'reading') return getReadingBand(result.correct, result.total)
    return null
  }
  const value = result.band ?? result.estimatedBand
  if (value === null || value === undefined || value === '') return null
  const band = Number(value)
  return Number.isFinite(band) && band >= 1 && band <= 9 &&
    band * 2 === Math.round(band * 2) ? band : null
}

// IELTS multi-answer MCQs give partial credit for valid up-to-N selections.
// Extra selections (or forged duplicated choices) cannot increase the score.
export function scoreMultipleAnswers(selectedAnswers, correctAnswers) {
  const expected = Array.isArray(correctAnswers)
    ? [...new Set(correctAnswers.map(v => v?.toString().trim()).filter(Boolean))]
    : []
  const selectedRaw = Array.isArray(selectedAnswers)
    ? selectedAnswers.map(v => v?.toString().trim()).filter(Boolean)
    : []
  const selected = [...new Set(selectedRaw)]
  const total = expected.length || 2
  if (selected.length !== selectedRaw.length || selected.length > total) {
    return { correct: 0, total }
  }
  return { correct: selected.filter(v => expected.includes(v)).length, total }
}

// Keep the Listening review/preview normalization identical to the server.
// This deliberately does not affect Reading text answers or Writing.
const listeningNumberWords = {
  zero:'0', one:'1', two:'2', three:'3', four:'4', five:'5',
  six:'6', seven:'7', eight:'8', nine:'9', ten:'10', eleven:'11',
  twelve:'12', thirteen:'13', fourteen:'14', fifteen:'15', sixteen:'16',
  seventeen:'17', eighteen:'18', nineteen:'19', twenty:'20'
}

export function normalizeIELTSListeningAnswer(value) {
  if (value === undefined || value === null) return ''
  const clean = value.toString().trim().toLowerCase()
    .replace(/[.,!?;:()]/g, '').replace(/\s+/g, ' ')
  return listeningNumberWords[clean] || clean
}

export function isIELTSListeningBlankCorrect(userAnswer, mainAnswer, acceptedAnswers = '', maxWords = '') {
  const clean = normalizeIELTSListeningAnswer(userAnswer)
  const acceptable = [mainAnswer, ...(acceptedAnswers ? acceptedAnswers.toString().split(',') : [])]
    .map(normalizeIELTSListeningAnswer).filter(Boolean)
  if (!clean || !acceptable.includes(clean)) return false
  if (maxWords && clean.split(' ').filter(Boolean).length > Number(maxWords)) return false
  return true
}
