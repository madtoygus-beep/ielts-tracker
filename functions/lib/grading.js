'use strict'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

function deepClone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function normalize(value) {
  return value === undefined || value === null
    ? ''
    : value.toString().trim().toLowerCase()
}

function normalizeTypedAnswer(value) {
  return normalize(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
}

const numberWords = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
  twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
}

function normalizeIELTSAnswer(value) {
  if (value === undefined || value === null) return ''

  const clean = value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:()]/g, '')
    .replace(/\s+/g, ' ')

  return numberWords[clean] || clean
}

function sortAnswers(value) {
  if (!Array.isArray(value)) return []
  return [...value].map(item => item?.toString().trim()).filter(Boolean).sort()
}

function countWords(value) {
  if (value === undefined || value === null) return 0
  return value.toString().trim().split(/\s+/).filter(Boolean).length
}

function isWithinWordLimit(value, maxWords) {
  if (!maxWords) return true
  return countWords(value) <= Number(maxWords)
}

function getAcceptedAnswers(mainAnswer, acceptedAnswers = '', normalizer = normalize) {
  const values = []

  if (mainAnswer) values.push(mainAnswer)

  if (acceptedAnswers) {
    acceptedAnswers
      .toString()
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .forEach(item => values.push(item))
  }

  return values.map(normalizer)
}

function isReadingBlankCorrect(userAnswer, mainAnswer, acceptedAnswers = '', maxWords = '') {
  if (!isWithinWordLimit(userAnswer, maxWords)) return false

  const cleanUser = normalize(userAnswer)
  const accepted = getAcceptedAnswers(mainAnswer, acceptedAnswers, normalize)

  if (!cleanUser || accepted.length === 0) return false
  return accepted.includes(cleanUser)
}

function getListeningWordCount(value) {
  const clean = normalizeIELTSAnswer(value)
  if (!clean) return 0
  return clean.split(' ').filter(Boolean).length
}

function isWithinListeningWordLimit(value, maxWords) {
  if (!maxWords) return true
  return getListeningWordCount(value) <= Number(maxWords)
}

function isListeningBlankCorrect(userAnswer, mainAnswer, acceptedAnswers = '', maxWords = '') {
  const cleanUser = normalizeIELTSAnswer(userAnswer)
  const accepted = getAcceptedAnswers(mainAnswer, acceptedAnswers, normalizeIELTSAnswer)

  if (!cleanUser || accepted.length === 0) return false
  if (!isWithinListeningWordLimit(userAnswer, maxWords)) return false
  return accepted.includes(cleanUser)
}

function isVocabularyTypedAnswerCorrect(userAnswer, mainAnswer, acceptedAnswers = '') {
  const cleanUser = normalizeTypedAnswer(userAnswer)
  if (!cleanUser) return false

  const accepted = getAcceptedAnswers(
    mainAnswer,
    acceptedAnswers,
    normalizeTypedAnswer
  )

  return accepted.includes(cleanUser)
}

function getBandFromPercentage(correct, total) {
  const percentage = total ? correct / total : 0

  if (percentage >= 0.97) return 9
  if (percentage >= 0.93) return 8.5
  if (percentage >= 0.87) return 8
  if (percentage >= 0.8) return 7.5
  if (percentage >= 0.72) return 7
  if (percentage >= 0.63) return 6.5
  if (percentage >= 0.53) return 6
  if (percentage >= 0.43) return 5.5
  if (percentage >= 0.33) return 5
  if (percentage >= 0.23) return 4.5

  return 4
}

function getReadingBand(correct, total) {
  if (total === 40) {
    if (correct >= 39) return 9
    if (correct >= 37) return 8.5
    if (correct >= 35) return 8
    if (correct >= 33) return 7.5
    if (correct >= 30) return 7
    if (correct >= 27) return 6.5
    if (correct >= 23) return 6
    if (correct >= 19) return 5.5
    if (correct >= 15) return 5
    if (correct >= 13) return 4.5
    if (correct >= 10) return 4
    return 3.5
  }

  return getBandFromPercentage(correct, total)
}

function getListeningBand(correct, total) {
  if (total === 40) {
    if (correct >= 39) return 9
    if (correct >= 37) return 8.5
    if (correct >= 35) return 8
    if (correct >= 32) return 7.5
    if (correct >= 30) return 7
    if (correct >= 26) return 6.5
    if (correct >= 23) return 6
    if (correct >= 18) return 5.5
    if (correct >= 16) return 5
    if (correct >= 13) return 4.5
    if (correct >= 10) return 4
    return 3.5
  }

  return getBandFromPercentage(correct, total)
}

function getVocabularyBand(correct, total) {
  if (!total) return 0
  return getBandFromPercentage(correct, total)
}

function addBreakdown(breakdown, type, correct, total) {
  const key = type || 'other'
  if (!breakdown[key]) breakdown[key] = { correct: 0, total: 0 }
  breakdown[key].correct += Number(correct) || 0
  breakdown[key].total += Number(total) || 0
}

function tableAnswerKey(questionId, rowId, cellIndex) {
  return `${questionId}_${rowId}_${cellIndex}`
}

function noteAnswerKey(questionId, paragraphId, partId) {
  return `${questionId}_${paragraphId}_${partId}`
}

function listeningCompletionAnswerKey(questionId, sectionId, itemId) {
  return `${questionId}_${sectionId}_${itemId}`
}

function mapAnswerKey(questionId, itemId) {
  return `${questionId}_${itemId}`
}

function matchingAnswerKey(questionId, itemId) {
  return `${questionId}_${itemId}`
}

function sanitizeReadingQuestion(question) {
  const q = deepClone(question || {})
  const answerCount = Array.isArray(q.answers) ? q.answers.length : 0

  delete q.answer
  delete q.answers
  delete q.acceptedAnswers
  delete q.correctAnswer

  if (answerCount > 0) q.answerCount = answerCount

  if (Array.isArray(q.paragraphs)) {
    q.paragraphs = q.paragraphs.map(paragraph => {
      const next = { ...paragraph }
      delete next.answer

      if (Array.isArray(next.parts)) {
        next.parts = next.parts.map(part => {
          const cleanPart = { ...part }
          delete cleanPart.answer
          delete cleanPart.acceptedAnswers
          delete cleanPart.correctAnswer
          return cleanPart
        })
      }

      return next
    })
  }

  if (Array.isArray(q.rows)) {
    q.rows = q.rows.map(row => ({
      ...row,
      cells: Array.isArray(row.cells)
        ? row.cells.map(cell => {
            const next = { ...cell }
            delete next.answer
            delete next.acceptedAnswers
            delete next.correctAnswer
            return next
          })
        : []
    }))
  }

  if (Array.isArray(q.items)) {
    q.items = q.items.map(item => {
      const next = { ...item }
      delete next.answer
      delete next.acceptedAnswers
      delete next.correctAnswer
      return next
    })
  }

  return q
}

function sanitizeReading(source) {
  const publicData = deepClone(source || {})
  publicData.questions = Array.isArray(publicData.questions)
    ? publicData.questions.map(sanitizeReadingQuestion)
    : []
  publicData.answerKeySeparated = true
  publicData.answerKeySchemaVersion = 1
  return publicData
}

function sanitizeListeningQuestion(question) {
  const q = deepClone(question || {})
  const answerCount = Array.isArray(q.answers) ? q.answers.length : 0

  delete q.answer
  delete q.answers
  delete q.acceptedAnswers
  delete q.correctAnswer

  if (answerCount > 0) q.answerCount = answerCount

  if (Array.isArray(q.rows)) {
    q.rows = q.rows.map(row => ({
      ...row,
      cells: Array.isArray(row.cells)
        ? row.cells.map(cell => {
            const next = { ...cell }
            delete next.answer
            delete next.acceptedAnswers
            delete next.correctAnswer
            return next
          })
        : []
    }))
  }

  if (Array.isArray(q.sections)) {
    q.sections = q.sections.map(section => ({
      ...section,
      parts: Array.isArray(section.parts)
        ? section.parts.map(part => {
            const next = { ...part }
            delete next.answer
            delete next.acceptedAnswers
            delete next.correctAnswer
            return next
          })
        : []
    }))
  }

  if (Array.isArray(q.mapItems)) {
    q.mapItems = q.mapItems.map(item => {
      const next = { ...item }
      delete next.answer
      delete next.acceptedAnswers
      delete next.correctAnswer
      return next
    })
  }

  if (Array.isArray(q.matchingItems)) {
    q.matchingItems = q.matchingItems.map(item => {
      const next = { ...item }
      delete next.answer
      delete next.acceptedAnswers
      delete next.correctAnswer
      return next
    })
  }

  return q
}

function sanitizeListening(source) {
  const publicData = deepClone(source || {})

  if (Array.isArray(publicData.parts)) {
    publicData.parts = publicData.parts.map(part => ({
      ...part,
      questions: Array.isArray(part.questions)
        ? part.questions.map(sanitizeListeningQuestion)
        : []
    }))
  }

  if (Array.isArray(publicData.questions)) {
    publicData.questions = publicData.questions.map(sanitizeListeningQuestion)
  }

  publicData.answerKeySeparated = true
  publicData.answerKeySchemaVersion = 1
  return publicData
}

function stableHash(value) {
  return Array.from(value || '').reduce(
    (hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0,
    7
  )
}

function getMatchingLetter(index) {
  let value = Number(index) + 1
  let label = ''

  while (value > 0) {
    value--
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }

  return label
}

function buildVocabularyMatchingOrder(source) {
  const questions = Array.isArray(source?.questions) ? source.questions : []
  const items = questions.filter(
    question => (question?.type || 'mcq') === 'match_definition'
  )

  if (source?.matchingShuffle !== true || items.length <= 1) {
    return items
  }

  const shift =
    (stableHash(source?.id || source?.title || 'vocabulary') % (items.length - 1)) + 1

  return [
    ...items.slice(shift),
    ...items.slice(0, shift)
  ]
}

function buildVocabularyDefinitionOrder(source) {
  return buildVocabularyMatchingOrder(source)
    .map(question => (question.definition || '').toString().trim())
}

function sanitizeVocabulary(source) {
  const publicData = deepClone(source || {})
  const definitions = buildVocabularyDefinitionOrder(source)

  publicData.questions = Array.isArray(publicData.questions)
    ? publicData.questions.map(question => {
        const q = { ...question }
        delete q.answer
        delete q.answerText
        delete q.acceptedAnswers
        delete q.correctAnswer

        if ((q.type || 'mcq') === 'match_definition') {
          delete q.definition
        }

        return q
      })
    : []

  publicData.matchingDefinitions = definitions
  publicData.answerKeySeparated = true
  publicData.answerKeySchemaVersion = 1
  return publicData
}

function gradeReading(source, answers = {}) {
  let correct = 0
  let total = 0
  const breakdown = {}

  for (const question of source?.questions || []) {
    const type = question?.type || 'mcq'

    if (type === 'matching') {
      let localCorrect = 0
      let localTotal = 0
      for (const paragraph of question.paragraphs || []) {
        localTotal++
        const user = answers?.[question.id]?.[paragraph.letter]?.toString()
        const expected = paragraph.answer?.toString()
        if (user && expected && user === expected) localCorrect++
      }
      correct += localCorrect
      total += localTotal
      addBreakdown(breakdown, type, localCorrect, localTotal)
      continue
    }

    if (type === 'matchingInformation' || type === 'sentenceEndings' || type === 'summaryOptions') {
      let localCorrect = 0
      let localTotal = 0
      for (const item of question.items || []) {
        localTotal++
        const user = answers?.[question.id]?.[item.id]?.toString()
        const expected = item.answer?.toString()
        if (user && expected && user === expected) localCorrect++
      }
      correct += localCorrect
      total += localTotal
      addBreakdown(breakdown, type, localCorrect, localTotal)
      continue
    }

    if (type === 'shortAnswer') {
      let localCorrect = 0
      let localTotal = 0
      for (const item of question.items || []) {
        localTotal++
        if (isReadingBlankCorrect(
          answers?.[question.id]?.[item.id],
          item.answer,
          item.acceptedAnswers,
          question.maxWords || 3
        )) {
          localCorrect++
        }
      }
      correct += localCorrect
      total += localTotal
      addBreakdown(breakdown, type, localCorrect, localTotal)
      continue
    }

    if (type === 'noteCompletion') {
      let localCorrect = 0
      let localTotal = 0
      for (const paragraph of question.paragraphs || []) {
        for (const part of paragraph.parts || []) {
          if (part.type !== 'blank') continue
          localTotal++
          const key = noteAnswerKey(question.id, paragraph.id, part.id)
          const user = answers[key]
          const ok = question.mode === 'choose'
            ? user?.toString() === part.answer?.toString()
            : isReadingBlankCorrect(user, part.answer, part.acceptedAnswers, part.maxWords)
          if (ok) localCorrect++
        }
      }
      correct += localCorrect
      total += localTotal
      addBreakdown(breakdown, type, localCorrect, localTotal)
      continue
    }

    if (type === 'table' || type === 'summary' || type === 'note') {
      let localCorrect = 0
      let localTotal = 0
      for (const row of question.rows || []) {
        for (let index = 0; index < (row.cells || []).length; index++) {
          const cell = row.cells[index]
          if (cell.type !== 'blank') continue
          localTotal++
          const key = tableAnswerKey(question.id, row.id, index)
          if (isReadingBlankCorrect(answers[key], cell.answer, cell.acceptedAnswers, cell.maxWords)) {
            localCorrect++
          }
        }
      }
      correct += localCorrect
      total += localTotal
      addBreakdown(breakdown, type, localCorrect, localTotal)
      continue
    }

    if (type === 'mcq' && question.mode === 'multi') {
      const selected = Array.isArray(answers[question.id])
        ? Array.from(new Set(
            answers[question.id].map(item => item?.toString()).filter(Boolean)
          ))
        : []
      const expected = Array.isArray(question.answers)
        ? question.answers.map(item => item?.toString()).filter(Boolean)
        : []
      const localCorrect = selected.filter(item => expected.includes(item)).length
      const localTotal = expected.length || 2
      correct += localCorrect
      total += localTotal
      addBreakdown(breakdown, 'mcq_multi', localCorrect, localTotal)
      continue
    }

    let ok = false
    if (type === 'fitb') {
      ok = isReadingBlankCorrect(
        answers[question.id],
        question.answer,
        question.acceptedAnswers,
        question.maxWords
      )
    } else {
      const user = normalize(answers[question.id])
      const expected = normalize(question.answer)
      ok = Boolean(user && expected && user === expected)
    }

    total++
    if (ok) correct++
    addBreakdown(breakdown, type, ok ? 1 : 0, 1)
  }

  return {
    correct,
    total,
    band: getReadingBand(correct, total),
    gradingBreakdown: breakdown,
    gradingSchemaVersion: 1
  }
}

function normalizeListeningParts(source) {
  if (Array.isArray(source?.parts) && source.parts.length) {
    return source.parts.map((part, index) => ({
      id: part.id || `part-${index + 1}`,
      title: part.title || `Part ${index + 1}`,
      instructions: part.instructions || '',
      questions: Array.isArray(part.questions) ? part.questions : []
    }))
  }

  return [{
    id: 'part-1',
    title: 'Part 1',
    instructions: '',
    questions: Array.isArray(source?.questions) ? source.questions : []
  }]
}

function gradeListening(source, answers = {}, options = {}) {
  const useBasicNormalization = options?.useBasicNormalization === true
  const normalizeAnswer = useBasicNormalization ? normalize : normalizeIELTSAnswer
  const isBlankCorrect = useBasicNormalization
    ? isReadingBlankCorrect
    : isListeningBlankCorrect

  let correct = 0
  let total = 0
  const breakdown = {}

  for (const part of normalizeListeningParts(source)) {
    for (const question of part.questions || []) {
      const type = question?.type || 'mcq'

      if (type === 'table' || type === 'note') {
        let localCorrect = 0
        let localTotal = 0
        for (const row of question.rows || []) {
          for (let index = 0; index < (row.cells || []).length; index++) {
            const cell = row.cells[index]
            if (cell.type !== 'blank') continue
            localTotal++
            const key = tableAnswerKey(question.id, row.id, index)
            if (isBlankCorrect(answers[key], cell.answer, cell.acceptedAnswers, cell.maxWords)) {
              localCorrect++
            }
          }
        }
        correct += localCorrect
        total += localTotal
        addBreakdown(breakdown, type, localCorrect, localTotal)
        continue
      }

      if (type === 'listeningCompletion') {
        let localCorrect = 0
        let localTotal = 0
        for (const section of question.sections || []) {
          for (const item of section.parts || []) {
            if (item.type !== 'blank') continue
            localTotal++
            const key = listeningCompletionAnswerKey(question.id, section.id, item.id)
            const user = answers[key]
            const ok = question.completionMode === 'choose'
              ? user?.toString().trim() === item.answer?.toString().trim()
              : isBlankCorrect(user, item.answer, item.acceptedAnswers, item.maxWords)
            if (ok) localCorrect++
          }
        }
        correct += localCorrect
        total += localTotal
        addBreakdown(breakdown, type, localCorrect, localTotal)
        continue
      }

      if (type === 'map') {
        let localCorrect = 0
        let localTotal = 0
        for (const item of question.mapItems || []) {
          localTotal++
          const user = normalizeAnswer(answers[mapAnswerKey(question.id, item.id)])
          const expected = normalizeAnswer(item.answer)
          if (user && expected && user === expected) localCorrect++
        }
        correct += localCorrect
        total += localTotal
        addBreakdown(breakdown, type, localCorrect, localTotal)
        continue
      }

      if (type === 'matching') {
        let localCorrect = 0
        let localTotal = 0
        for (const item of question.matchingItems || []) {
          localTotal++
          const user = normalizeAnswer(answers[matchingAnswerKey(question.id, item.id)])
          const expected = normalizeAnswer(item.answer)
          if (user && expected && user === expected) localCorrect++
        }
        correct += localCorrect
        total += localTotal
        addBreakdown(breakdown, type, localCorrect, localTotal)
        continue
      }

      if (type === 'mcq' && question.mode === 'multi') {
        const selected = Array.isArray(answers[question.id])
          ? Array.from(new Set(
              answers[question.id].map(item => item?.toString()).filter(Boolean)
            ))
          : []
        const expected = Array.isArray(question.answers)
          ? question.answers.map(item => item?.toString()).filter(Boolean)
          : []
        const localCorrect = selected.filter(item => expected.includes(item)).length
        const localTotal = expected.length || 2
        correct += localCorrect
        total += localTotal
        addBreakdown(breakdown, 'mcq_multi', localCorrect, localTotal)
        continue
      }

      const user = normalizeAnswer(answers[question.id])
      const expected = normalizeAnswer(question.answer)
      const ok = Boolean(user && expected && user === expected)
      total++
      if (ok) correct++
      addBreakdown(breakdown, type, ok ? 1 : 0, 1)
    }
  }

  return {
    correct,
    total,
    band: getListeningBand(correct, total),
    gradingBreakdown: breakdown,
    gradingSchemaVersion: 1
  }
}

function gradeVocabulary(source, answers = {}) {
  const questions = Array.isArray(source?.questions) ? source.questions : []
  const matchingOrder = buildVocabularyMatchingOrder(source)
  let correct = 0
  let total = 0
  const breakdown = {}

  for (const question of questions) {
    const type = question?.type || 'mcq'
    const selected = answers[question.id]
    let ok = false

    if (type === 'match_definition') {
      const selectedIndex = matchingOrder.findIndex((_, definitionIndex) =>
        getMatchingLetter(definitionIndex) === selected
      )

      if (selectedIndex >= 0) {
        ok = matchingOrder[selectedIndex]?.id === question.id
      }
    } else if (type === 'word_bank' || type === 'grammar_form') {
      ok = isVocabularyTypedAnswerCorrect(
        selected,
        question.answerText || question.answer,
        question.acceptedAnswers || ''
      )
    } else {
      const user = normalize(selected)
      const expected = normalize(question.answer)
      ok = Boolean(user) && Boolean(expected) && selected === question.answer
    }

    total++
    if (ok) correct++
    addBreakdown(breakdown, type, ok ? 1 : 0, 1)
  }

  const percentage = total ? Math.round((correct / total) * 100) : 0

  return {
    correct,
    total,
    percentage,
    band: getVocabularyBand(correct, total),
    gradingBreakdown: breakdown,
    gradingSchemaVersion: 1
  }
}

function getMockType(mock) {
  return mock?.mockType || mock?.contentType || 'full_mock'
}

function getMockEnabledSections(mock) {
  if (getMockType(mock) !== 'mini_mock') {
    return { listening: true, reading: true, writing: true }
  }

  if (mock?.enabledSections && typeof mock.enabledSections === 'object') {
    const stored = {
      listening: mock.enabledSections.listening === true,
      reading: mock.enabledSections.reading === true,
      writing: mock.enabledSections.writing === true
    }
    if (Object.values(stored).some(Boolean)) return stored
  }

  const listeningIds = Array.isArray(mock?.listeningIds)
    ? mock.listeningIds.filter(Boolean)
    : mock?.listeningId ? [mock.listeningId] : []
  const readingIds = Array.isArray(mock?.readingIds)
    ? mock.readingIds.filter(Boolean)
    : mock?.readingId ? [mock.readingId] : []
  const inferred = {
    listening: listeningIds.length > 0,
    reading: readingIds.length > 0,
    writing: Boolean(mock?.writingId)
  }

  return Object.values(inferred).some(Boolean)
    ? inferred
    : { listening: true, reading: true, writing: true }
}

function getMockWritingMode(mock, writing) {
  if (!getMockEnabledSections(mock).writing) return 'none'
  return mock?.writingMode || writing?.contentType || writing?.writingMode || writing?.writingType || 'full_writing'
}

function namespaceListeningForMock(listening) {
  const parts = normalizeListeningParts(listening)

  return {
    ...listening,
    parts: parts.map((part, partIndex) => {
      const sourcePartId = part.id || `part-${partIndex + 1}`
      return {
        ...part,
        id: `${listening.id}_${sourcePartId}`,
        originalPartId: part.id,
        listeningId: listening.id,
        questions: (part.questions || []).map((question, questionIndex) => ({
          ...question,
          originalQuestionId: question.id || '',
          id: `${listening.id}__${sourcePartId}__${question.id || questionIndex}`
        }))
      }
    })
  }
}

function mergeBreakdowns(target, source) {
  for (const [type, value] of Object.entries(source || {})) {
    addBreakdown(target, type, value.correct, value.total)
  }
}

function gradeMock(mock, listeningSources, readingSources, writingSource, payload) {
  const enabledSections = getMockEnabledSections(mock)
  const listeningAnswers = payload?.listeningAnswers || {}
  const readingAnswers = payload?.readingAnswers || {}
  const writingAnswers = payload?.writingAnswers || { task1: '', task2: '' }

  let listeningResult = {
    enabled: enabledSections.listening,
    correct: 0,
    total: 0,
    band: enabledSections.listening ? 4 : null,
    gradingBreakdown: {},
    gradingSchemaVersion: 1
  }

  if (enabledSections.listening) {
    const aggregate = { correct: 0, total: 0, gradingBreakdown: {} }
    for (const source of listeningSources || []) {
      const namespaced = namespaceListeningForMock(source)
      const result = gradeListening(namespaced, listeningAnswers, {
        useBasicNormalization: true
      })
      aggregate.correct += result.correct
      aggregate.total += result.total
      mergeBreakdowns(aggregate.gradingBreakdown, result.gradingBreakdown)
    }
    listeningResult = {
      enabled: true,
      correct: aggregate.correct,
      total: aggregate.total,
      band: getListeningBand(aggregate.correct, aggregate.total),
      gradingBreakdown: aggregate.gradingBreakdown,
      gradingSchemaVersion: 1
    }
  }

  const readingPassages = []
  let totalReadingCorrect = 0
  let totalReadingQuestions = 0
  const readingBreakdown = {}

  if (enabledSections.reading) {
    for (const reading of readingSources || []) {
      const result = gradeReading(reading, readingAnswers?.[reading.id] || {})
      readingPassages.push({
        readingId: reading.id,
        title: reading.title || '',
        correct: result.correct,
        total: result.total,
        band: result.band,
        gradingBreakdown: result.gradingBreakdown
      })
      totalReadingCorrect += result.correct
      totalReadingQuestions += result.total
      mergeBreakdowns(readingBreakdown, result.gradingBreakdown)
    }
  }

  const readingBand = enabledSections.reading
    ? getReadingBand(totalReadingCorrect, totalReadingQuestions)
    : null

  const writingMode = getMockWritingMode(mock, writingSource)
  const hasTask1 = enabledSections.writing && writingMode !== 'task2_only'
  const hasTask2 = enabledSections.writing && writingMode !== 'task1_only'

  const availableBands = [
    enabledSections.listening ? listeningResult.band : null,
    enabledSections.reading ? readingBand : null
  ].filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))

  const overallEstimate = availableBands.length
    ? Math.round((availableBands.reduce((sum, band) => sum + Number(band), 0) / availableBands.length) * 2) / 2
    : null

  return {
    enabledSections: { ...enabledSections },
    listening: listeningResult,
    reading: {
      enabled: enabledSections.reading,
      correct: totalReadingCorrect,
      total: totalReadingQuestions,
      band: readingBand,
      passages: readingPassages,
      gradingBreakdown: readingBreakdown,
      gradingSchemaVersion: 1
    },
    writing: {
      enabled: enabledSections.writing,
      status: enabledSections.writing ? 'pending_review' : 'not_included',
      writingMode,
      task1Enabled: hasTask1,
      task2Enabled: hasTask2,
      task1WordCount: hasTask1 ? countWords(writingAnswers.task1) : 0,
      task2WordCount: hasTask2 ? countWords(writingAnswers.task2) : 0
    },
    overallEstimate,
    gradingSchemaVersion: 1
  }
}

module.exports = {
  deepClone,
  sanitizeReading,
  sanitizeListening,
  sanitizeVocabulary,
  buildVocabularyDefinitionOrder,
  gradeReading,
  gradeListening,
  gradeVocabulary,
  gradeMock,
  getMockEnabledSections,
  getMockWritingMode,
  getReadingBand,
  getListeningBand,
  getVocabularyBand,
  getMatchingLetter,
  normalizeListeningParts
}
