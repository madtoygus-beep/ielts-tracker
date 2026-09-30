import { useEffect, useMemo, useState } from 'react'
import { auth, db } from '../firebase'
import { doc, getDoc } from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const TYPE_CONFIG = {
  reading: {
    collection: 'readings',
    label: 'Reading',
    editPath: id => `/edit-reading/${id}`
  },
  listening: {
    collection: 'listenings',
    label: 'Listening',
    editPath: id => `/edit-listening/${id}`
  },
  writing: {
    collection: 'writingHomeworks',
    label: 'Writing',
    editPath: id => `/edit-writing/${id}`
  },
  vocabulary: {
    collection: 'vocabularyTests',
    label: 'Vocabulary',
    editPath: id => `/edit-vocabulary/${id}`
  },
  mock: {
    collection: 'mockTests',
    label: 'Mock',
    editPath: id => `/edit-mock/${id}`
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function getMockType(mock) {
  return mock?.mockType || mock?.contentType || 'full_mock'
}

function getMockTypeLabel(mock) {
  return getMockType(mock) === 'mini_mock'
    ? 'Mini Mock'
    : 'Full Mock'
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

  const inferred = {
    listening: Boolean(
      mock?.listeningId ||
      mock?.listeningIds?.filter(Boolean).length
    ),
    reading: Boolean(
      mock?.readingId ||
      mock?.readingIds?.filter(Boolean).length
    ),
    writing: Boolean(mock?.writingId)
  }

  return Object.values(inferred).some(Boolean)
    ? inferred
    : { listening: true, reading: true, writing: true }
}

function getMockSectionTimes(mock) {
  const isMini = getMockType(mock) === 'mini_mock'
  const enabled = getMockEnabledSections(mock)
  const defaults = isMini
    ? { listening: 15, reading: 30, writing: 30 }
    : { listening: 35, reading: 60, writing: 60 }
  const stored = mock?.sectionTimeLimits || {}

  const result = {}

  for (const section of ['listening', 'reading', 'writing']) {
    const value = Number(stored[section] ?? mock?.[`${section}TimeLimit`])
    result[section] = !enabled[section]
      ? 0
      : !Number.isFinite(value) || value <= 0
        ? defaults[section]
        : Math.max(5, Math.min(180, Math.round(value)))
  }

  return result
}

function getMockTotalTime(mock) {
  const times = getMockSectionTimes(mock)

  return times.listening + times.reading + times.writing
}

function getMockWritingMode(mock, writing) {
  if (!getMockEnabledSections(mock).writing) return 'none'

  return (
    mock?.writingMode ||
    writing?.contentType ||
    writing?.writingMode ||
    writing?.writingType ||
    'full_writing'
  )
}

function getMockWritingLabel(mock, writing) {
  const mode = getMockWritingMode(mock, writing)

  if (mode === 'none') return 'No Writing'
  if (mode === 'task1_only') return 'Writing Task 1'
  if (mode === 'task2_only') return 'Writing Task 2'

  return 'Full Writing'
}


function getMockFlowLabel(mock, writing) {
  const enabled = getMockEnabledSections(mock)

  return [
    enabled.listening ? 'Listening' : null,
    enabled.reading ? 'Reading' : null,
    enabled.writing ? getMockWritingLabel(mock, writing) : null
  ]
    .filter(Boolean)
    .join(' · ')
}

function getText(value) {
  if (!value) return ''

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'object') {
    return (
      value.prompt ||
      value.title ||
      value.text ||
      value.question ||
      value.statement ||
      ''
    )
  }

  return value.toString()
}

function getImage(value) {
  if (!value || typeof value !== 'object') return ''

  return (
    value.image ||
    value.imageUrl ||
    value.url ||
    value.fileUrl ||
    value.downloadURL ||
    ''
  )
}

function getWritingTaskSource(writing, taskNumber) {
  if (taskNumber === 1) {
    return (
      writing?.task1Prompt ||
      writing?.task1Question ||
      writing?.task1 ||
      writing?.taskOnePrompt ||
      writing?.taskOne ||
      writing?.prompt1 ||
      null
    )
  }

  return (
    writing?.task2Prompt ||
    writing?.task2Question ||
    writing?.task2 ||
    writing?.taskTwoPrompt ||
    writing?.taskTwo ||
    writing?.prompt2 ||
    null
  )
}

function getWritingTaskText(writing, taskNumber) {
  const source = getWritingTaskSource(writing, taskNumber)

  return (
    getText(source) ||
    (taskNumber === 1
      ? 'Task 1 prompt is missing.'
      : 'Task 2 prompt is missing.')
  )
}

function getWritingTaskImage(writing, taskNumber) {
  const source = getWritingTaskSource(writing, taskNumber)

  if (taskNumber === 1) {
    return (
      getImage(source) ||
      writing?.task1Image ||
      writing?.task1ImageUrl ||
      ''
    )
  }

  return (
    getImage(source) ||
    writing?.task2Image ||
    writing?.task2ImageUrl ||
    ''
  )
}

function getQuestionText(question) {
  return (
    question?.question ||
    question?.prompt ||
    question?.text ||
    question?.statement ||
    question?.sentence ||
    question?.word ||
    question?.title ||
    'Question'
  )
}

function getItemText(item) {
  return (
    item?.question ||
    item?.prompt ||
    item?.text ||
    item?.statement ||
    item?.sentence ||
    item?.label ||
    item?.title ||
    [item?.beforeText, item?.afterText].filter(Boolean).join(' ') ||
    ''
  )
}

function getAcceptedAnswerText(item) {
  const alternatives = Array.isArray(item?.acceptedAnswers)
    ? item.acceptedAnswers
    : item?.acceptedAnswers
      ? item.acceptedAnswers
          .toString()
          .split(',')
          .map(answer => answer.trim())
          .filter(Boolean)
      : []

  const answers = [
    item?.answerText || item?.answer,
    ...alternatives
  ].filter(Boolean)

  return answers.join(' / ')
}

function getManualQuestionNumber(item) {
  const value =
    item?.questionNumber ||
    item?.questionNo ||
    item?.qNumber ||
    item?.manualQuestionNumber ||
    item?.displayNumber ||
    ''

  return value?.toString().trim() || null
}

function getQuestionCount(question) {
  if (question?.type === 'shortAnswer') {
    return toArray(question.items).length
  }

  if (question?.type === 'matching') {
    return (
      question.paragraphs?.length ||
      question.matchingItems?.length ||
      1
    )
  }

  if (
    question?.type === 'matchingInformation' ||
    question?.type === 'sentenceEndings' ||
    question?.type === 'summaryOptions'
  ) {
    return question.items?.length || 1
  }

  if (question?.type === 'noteCompletion') {
    let count = 0

    question.paragraphs?.forEach(paragraph => {
      paragraph.parts?.forEach(part => {
        if (part.type === 'blank') count++
      })
    })

    return count || 1
  }

  if (
    question?.type === 'table' ||
    question?.type === 'summary' ||
    question?.type === 'note'
  ) {
    let count = 0

    question.rows?.forEach(row => {
      row.cells?.forEach(cell => {
        if (cell.type === 'blank') count++
      })
    })

    return count || 1
  }

  if (question?.type === 'listeningCompletion') {
    let count = 0

    question.sections?.forEach(section => {
      section.parts?.forEach(part => {
        if (part.type === 'blank') count++
      })
    })

    return count || 1
  }

  if (question?.type === 'map') {
    return question.mapItems?.length || 1
  }

  if (question?.type === 'mcq' && question?.mode === 'multi') {
    return question.answers?.length || 2
  }

  return 1
}

function getRangeLabel(questions, index) {
  const start =
    questions
      .slice(0, index)
      .reduce((sum, question) => sum + getQuestionCount(question), 0) + 1

  const count = getQuestionCount(questions[index])
  if (count === 0) return 'No questions'
  const end = start + count - 1

  return count > 1 ? `Q${start}-${end}` : `Q${start}`
}

function getListeningQuestionNumbers(parts, partIndex, questionIndex, questionOffset = 0) {
  const part = parts?.[partIndex]
  const question = part?.questions?.[questionIndex]
  if (!question) return []

  let start = questionOffset + 1
  for (let p = 0; p < partIndex; p++) {
    start += toArray(parts[p]?.questions).reduce(
      (sum, item) => sum + getQuestionCount(item), 0
    )
  }
  start += toArray(part?.questions).slice(0, questionIndex).reduce(
    (sum, item) => sum + getQuestionCount(item), 0
  )

  let items = null
  if (question.type === 'table' || question.type === 'note') {
    items = toArray(question.rows).flatMap(row =>
      toArray(row.cells).filter(cell => cell.type === 'blank')
    )
  } else if (question.type === 'listeningCompletion') {
    items = toArray(question.sections).flatMap(section =>
      toArray(section.parts).filter(item => item.type === 'blank')
    )
  } else if (question.type === 'map') {
    items = toArray(question.mapItems)
  } else if (question.type === 'matching') {
    items = toArray(question.matchingItems)
  }

  if (items) {
    return items.map((item, index) => getManualQuestionNumber(item) || start + index)
  }

  const manualStart = getManualQuestionNumber(question)
  const count = getQuestionCount(question)
  if (manualStart && !Number.isFinite(Number(manualStart))) return [manualStart]
  const first = manualStart ? Number(manualStart) : start
  return Array.from({ length: count }, (_, index) => first + index)
}

function getListeningRangeLabel(parts, partIndex, questionIndex, questionOffset = 0) {
  const numbers = getListeningQuestionNumbers(parts, partIndex, questionIndex, questionOffset)
  if (numbers.length === 0) return 'No questions'
  return numbers.length > 1
    ? `Q${numbers[0]}-${numbers[numbers.length - 1]}`
    : `Q${numbers[0]}`
}

function normalizeListeningParts(listening) {
  if (listening?.parts?.length) {
    return listening.parts.map((part, index) => ({
      id: part.id || `part-${index + 1}`,
      title: part.title || `Part ${index + 1}`,
      instructions: part.instructions || '',
      questions: toArray(part.questions)
    }))
  }

  return [
    {
      id: 'part-1',
      title: 'Listening Questions',
      instructions: listening?.instructions || '',
      questions: toArray(listening?.questions)
    }
  ]
}

function AnswerBadge({ children }) {
  return (
    <div className="mt-2 text-xs font-medium text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
      Answer: {children || 'Not set'}
    </div>
  )
}

function TextAnswer({
  value,
  onChange,
  placeholder = 'Type an answer...',
  disabled = false
}) {
  return (
    <input
      value={value || ''}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 disabled:bg-gray-50"
    />
  )
}

// Preview inputs are local only: no submission, score, timer or database write.
function ShortAnswerPreviewInput({ inputId, value, onChange, maxWords }) {
  const parsedLimit = Number(maxWords)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 3
  const wordCount = String(value ?? '').trim().split(/\s+/).filter(Boolean).length
  const overLimit = wordCount > limit

  return (
    <div>
      <input
        id={inputId}
        value={value ?? ''}
        onChange={event => onChange(event.target.value)}
        placeholder="Type your answer..."
        autoComplete="off"
        spellCheck={false}
        aria-invalid={overLimit}
        aria-describedby={`${inputId}-help`}
        className={`w-full min-w-0 border rounded-xl px-3 py-2.5 text-sm outline-none ${
          overLimit
            ? 'border-red-300 focus:border-red-400 bg-red-50'
            : 'border-gray-200 focus:border-purple-400 bg-white'
        }`}
      />
      <div id={`${inputId}-help`} className="flex flex-wrap justify-between gap-2 mt-2">
        <span className={`text-xs ${overLimit ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
          {overLimit ? `Too many words - maximum ${limit}` : `Maximum ${limit} words`}
        </span>
        <span className="text-xs text-gray-400">
          {wordCount} word{wordCount === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  )
}

function OptionButtons({
  options,
  selected,
  onSelect,
  multi = false,
  disabled = false
}) {
  const selectedValues = Array.isArray(selected)
    ? selected
    : selected
      ? [selected]
      : []

  return (
    <div className="flex flex-col gap-2">
      {toArray(options).map((option, index) => {
        const letter = letters[index]
        const active = selectedValues.includes(letter)

        return (
          <button
            key={`${letter}-${index}`}
            type="button"
            onClick={() => onSelect(letter)}
            disabled={disabled}
            className={`text-left border rounded-xl px-4 py-3 text-sm transition-all ${
              active
                ? 'bg-purple-600 border-purple-600 text-white'
                : 'bg-white border-gray-200 text-gray-700 hover:border-purple-300'
            } disabled:opacity-60`}
          >
            <span className="font-semibold mr-2">
              {letter}.
            </span>
            {option}
            {multi && active && (
              <span className="float-right text-xs opacity-80">
                Selected
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function SelectAnswer({
  value,
  onChange,
  options,
  placeholder = 'Choose...',
  disabled = false
}) {
  return (
    <select
      value={value || ''}
      onChange={event => onChange(event.target.value)}
      disabled={disabled}
      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-purple-400 disabled:bg-gray-50"
    >
      <option value="">
        {placeholder}
      </option>

      {toArray(options).map((option, index) => {
        const value =
          typeof option === 'object'
            ? option.value
            : letters[index]

        const label =
          typeof option === 'object'
            ? option.label
            : `${letters[index]}. ${option}`

        return (
          <option key={`${value}-${index}`} value={value}>
            {label}
          </option>
        )
      })}
    </select>
  )
}

function QuestionShell({
  label,
  typeLabel,
  children,
  showAnswers,
  answer
}) {
  return (
    <div className="border border-gray-100 rounded-2xl p-5 bg-white">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <span className="text-xs font-semibold text-gray-400">
          {label}
        </span>

        <span className="text-xs bg-purple-50 text-purple-600 px-2.5 py-1 rounded-full">
          {typeLabel}
        </span>
      </div>

      {children}

      {showAnswers && answer !== undefined && (
        <AnswerBadge>{answer}</AnswerBadge>
      )}
    </div>
  )
}

function ReadingPreview({
  reading,
  answerPrefix,
  answers,
  setAnswer,
  showAnswers
}) {
  const questions = toArray(reading?.questions)

  const setMulti = (key, letter, max = 2) => {
    const current = Array.isArray(answers[key]) ? answers[key] : []
    const next = current.includes(letter)
      ? current.filter(item => item !== letter)
      : current.length < max
        ? [...current, letter]
        : current

    setAnswer(key, next)
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6 min-w-0">
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm min-w-0">
        <h2 className="text-lg font-bold text-gray-900 mb-4">
          Reading Passage
        </h2>

        {reading?.passageMode === 'sections' && reading?.paragraphs?.length ? (
          <div className="space-y-6">
            {reading.paragraphs.map(paragraph => (
              <div key={paragraph.id || paragraph.letter}>
                <h3 className="font-semibold text-gray-900 mb-2">
                  Paragraph {paragraph.letter}
                </h3>

                <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                  {paragraph.text}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
            {reading?.passage || 'Passage text is missing.'}
          </p>
        )}
      </div>

      <div className="space-y-5 min-w-0">
        {questions.map((question, index) => {
          const keyBase = `${answerPrefix}:${question.id || index}`
          const label = getRangeLabel(questions, index)

          if (question.type === 'matching' && question.paragraphs?.length) {
            const headingOptions = toArray(reading?.headings).map(
              (heading, headingIndex) => ({
                value: String(headingIndex + 1),
                label: `${headingIndex + 1}. ${heading}`
              })
            )

            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel="Matching Headings"
                showAnswers={false}
              >
                {question.instruction && (
                  <p className="text-sm text-gray-600 mb-4">
                    {question.instruction}
                  </p>
                )}

                <div className="space-y-4">
                  {question.paragraphs.map(paragraph => {
                    const fieldKey = `${keyBase}:${paragraph.letter}`

                    return (
                      <div key={paragraph.letter}>
                        <p className="text-sm font-medium text-gray-800 mb-2">
                          Paragraph {paragraph.letter}
                        </p>

                        <SelectAnswer
                          value={answers[fieldKey]}
                          onChange={value => setAnswer(fieldKey, value)}
                          options={headingOptions}
                          placeholder="Choose a heading"
                        />

                        {showAnswers && (
                          <AnswerBadge>
                            {paragraph.answer}
                          </AnswerBadge>
                        )}
                      </div>
                    )
                  })}
                </div>
              </QuestionShell>
            )
          }

          if (question.type === 'matchingInformation') {
            const sourceLetters = question.sectionLetters?.length
              ? question.sectionLetters
              : toArray(reading?.paragraphs).map(paragraph => paragraph.letter)

            const paragraphLetters = toArray(sourceLetters).map(letter => ({
              value: letter,
              label: `Paragraph ${letter}`
            }))

            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel="Matching Information"
                showAnswers={false}
              >
                {question.instruction && (
                  <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                    {question.instruction}
                  </p>
                )}

                <div className="space-y-4">
                  {toArray(question.items).map((item, itemIndex) => {
                    const itemId = item.id || itemIndex
                    const fieldKey = `${keyBase}:${itemId}`

                    return (
                      <div key={itemId}>
                        <p className="text-sm text-gray-800 mb-2">
                          {getItemText(item)}
                        </p>

                        <SelectAnswer
                          value={answers[fieldKey]}
                          onChange={value => setAnswer(fieldKey, value)}
                          options={paragraphLetters}
                          placeholder="Choose a paragraph"
                        />

                        {showAnswers && (
                          <AnswerBadge>
                            {item.answer}
                          </AnswerBadge>
                        )}
                      </div>
                    )
                  })}
                </div>
              </QuestionShell>
            )
          }

          if (question.type === 'sentenceEndings') {
            const endings = toArray(question.endings)

            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel="Sentence Endings"
                showAnswers={false}
              >
                {question.instruction && (
                  <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                    {question.instruction}
                  </p>
                )}

                <div className="space-y-4">
                  {toArray(question.items).map((item, itemIndex) => {
                    const itemId = item.id || itemIndex
                    const fieldKey = `${keyBase}:${itemId}`

                    return (
                      <div
                        key={itemId}
                        className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                      >
                        <p className="text-xs font-semibold text-purple-600 mb-2">
                          Sentence {itemIndex + 1}
                        </p>

                        <p className="text-sm font-medium text-gray-800 mb-3 whitespace-pre-wrap">
                          {item.sentence || getItemText(item) || 'Sentence stem is missing.'}
                        </p>

                        <SelectAnswer
                          value={answers[fieldKey]}
                          onChange={value => setAnswer(fieldKey, value)}
                          options={endings}
                          placeholder="Choose the correct ending"
                        />

                        {showAnswers && (
                          <AnswerBadge>
                            {item.answer}
                          </AnswerBadge>
                        )}
                      </div>
                    )
                  })}
                </div>

                {endings.length > 0 && (
                  <div className="mt-5 bg-purple-50 border border-purple-100 rounded-xl p-4">
                    <p className="text-xs font-semibold text-purple-700 uppercase tracking-wide mb-3">
                      Sentence endings
                    </p>

                    <div className="space-y-2">
                      {endings.map((ending, endingIndex) => (
                        <div
                          key={`${endingIndex}-${ending}`}
                          className="grid grid-cols-[28px_minmax(0,1fr)] gap-2 text-sm text-gray-700"
                        >
                          <span className="font-semibold text-purple-700">
                            {letters[endingIndex]}.
                          </span>
                          <span className="whitespace-pre-wrap">
                            {ending || 'Ending text is missing.'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </QuestionShell>
            )
          }

          if (question.type === 'shortAnswer') {
            const items = toArray(question.items)
            const startNumber =
              questions
                .slice(0, index)
                .reduce((sum, item) => sum + getQuestionCount(item), 0) + 1

            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel="Short-answer Questions"
                showAnswers={false}
              >
                {question.title && (
                  <h3 className="font-semibold text-gray-900 mb-2">
                    {question.title}
                  </h3>
                )}

                {question.instruction && (
                  <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                    {question.instruction}
                  </p>
                )}

                {items.length === 0 && (
                  <p className="text-sm text-amber-700 bg-amber-50 rounded-xl p-4">
                    No short-answer questions are available in this section.
                  </p>
                )}

                <div className="space-y-4">
                  {items.map((item, itemIndex) => {
                    const itemId = item.id || itemIndex
                    const fieldKey = `${keyBase}:${itemId}`
                    const questionNumber = startNumber + itemIndex

                    return (
                      <div
                        key={itemId}
                        className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                      >
                        <label htmlFor={fieldKey} className="block text-sm font-medium text-gray-800 mb-3 whitespace-pre-wrap">
                          <span className="font-bold text-purple-600 mr-2">
                            Q{questionNumber}
                          </span>
                          {item.question || item.prompt || getItemText(item) || 'Question text is missing.'}
                        </label>

                        <ShortAnswerPreviewInput
                          inputId={fieldKey}
                          value={answers[fieldKey]}
                          onChange={value => setAnswer(fieldKey, value)}
                          maxWords={question.maxWords}
                        />

                        {showAnswers && (
                          <AnswerBadge>
                            {getAcceptedAnswerText(item)}
                          </AnswerBadge>
                        )}
                      </div>
                    )
                  })}
                </div>
              </QuestionShell>
            )
          }

          if (question.type === 'summaryOptions') {
            const options = toArray(question.options)

            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel="Summary Completion with Options"
                showAnswers={false}
              >
                {question.instruction && (
                  <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                    {question.instruction}
                  </p>
                )}

                {question.title && (
                  <h3 className="font-semibold text-gray-900 mb-4">
                    {question.title}
                  </h3>
                )}

                <div className="space-y-4">
                  {toArray(question.items).map((item, itemIndex) => {
                    const itemId = item.id || itemIndex
                    const fieldKey = `${keyBase}:${itemId}`

                    return (
                      <div
                        key={itemId}
                        className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                      >
                        <p className="text-xs font-semibold text-purple-600 mb-2">
                          Question {item.number || itemIndex + 1}
                        </p>

                        {item.beforeText && (
                          <p className="text-sm text-gray-800 mb-2 whitespace-pre-wrap">
                            {item.beforeText}
                          </p>
                        )}

                        <SelectAnswer
                          value={answers[fieldKey]}
                          onChange={value => setAnswer(fieldKey, value)}
                          options={options}
                          placeholder="Choose an option"
                        />

                        {item.afterText && (
                          <p className="text-sm text-gray-800 mt-2 whitespace-pre-wrap">
                            {item.afterText}
                          </p>
                        )}

                        {showAnswers && (
                          <AnswerBadge>
                            {item.answer}
                          </AnswerBadge>
                        )}
                      </div>
                    )
                  })}
                </div>

                {options.length > 0 && (
                  <div className="mt-5 bg-purple-50 border border-purple-100 rounded-xl p-4">
                    <p className="text-xs font-semibold text-purple-700 uppercase tracking-wide mb-3">
                      Options
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {options.map((option, optionIndex) => (
                        <div
                          key={`${optionIndex}-${option}`}
                          className="grid grid-cols-[28px_minmax(0,1fr)] gap-2 text-sm text-gray-700"
                        >
                          <span className="font-semibold text-purple-700">
                            {letters[optionIndex]}.
                          </span>
                          <span className="whitespace-pre-wrap">
                            {option || 'Option text is missing.'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </QuestionShell>
            )
          }

          if (question.type === 'noteCompletion') {
            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel="Note Completion"
                showAnswers={false}
              >
                {question.instruction && (
                  <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                    {question.instruction}
                  </p>
                )}

                {question.title && (
                  <h3 className="font-semibold text-gray-900 mb-4">
                    {question.title}
                  </h3>
                )}

                <div className="space-y-4">
                  {toArray(question.paragraphs).map((paragraph, paragraphIndex) => (
                    <div key={paragraph.id || paragraphIndex}>
                      {paragraph.heading && (
                        <p className="font-semibold text-gray-800 mb-2">
                          {paragraph.heading}
                        </p>
                      )}

                      <div className="space-y-3 min-w-0">
                        {toArray(paragraph.parts).map((part, partIndex) => {
                          if (part.type !== 'blank') {
                            return (
                              <span
                                key={part.id || partIndex}
                                className="text-sm text-gray-700 whitespace-pre-wrap"
                              >
                                {part.content || part.text || ''}
                              </span>
                            )
                          }

                          const fieldKey =
                            `${keyBase}:${paragraph.id || paragraphIndex}:${part.id || partIndex}`

                          return (
                            <div key={part.id || partIndex}>
                              {question.mode === 'choose' ? (
                                <SelectAnswer
                                  value={answers[fieldKey]}
                                  onChange={value => setAnswer(fieldKey, value)}
                                  options={toArray(question.options)}
                                />
                              ) : (
                                <TextAnswer
                                  value={answers[fieldKey]}
                                  onChange={value => setAnswer(fieldKey, value)}
                                />
                              )}

                              {showAnswers && (
                                <AnswerBadge>
                                  {getAcceptedAnswerText(part)}
                                </AnswerBadge>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </QuestionShell>
            )
          }

          if (
            question.type === 'table' ||
            question.type === 'summary' ||
            question.type === 'note'
          ) {
            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel={
                  question.type === 'table'
                    ? 'Table Completion'
                    : question.type === 'summary'
                      ? 'Summary Completion'
                      : 'Note Completion'
                }
                showAnswers={false}
              >
                {question.instruction && (
                  <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                    {question.instruction}
                  </p>
                )}

                {question.title && (
                  <h3 className="font-semibold text-gray-900 mb-4">
                    {question.title}
                  </h3>
                )}

                <div className="overflow-x-auto">
                  <table className="min-w-[620px] w-full border-collapse">
                    {toArray(question.columns).length > 0 && (
                      <thead>
                        <tr>
                          {question.columns.map((column, columnIndex) => (
                            <th key={columnIndex} scope="col" className="border border-gray-200 p-3 text-left text-sm font-semibold bg-gray-50">
                              {getText(column)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {toArray(question.rows).map((row, rowIndex) => (
                        <tr key={row.id || rowIndex}>
                          {toArray(row.cells).map((cell, cellIndex) => {
                            const fieldKey =
                              `${keyBase}:${row.id || rowIndex}:${cellIndex}`

                            return (
                              <td
                                key={cellIndex}
                                className="border border-gray-200 p-3 align-top text-sm"
                              >
                                {cell.type === 'blank' ? (
                                  <div>
                                    <TextAnswer
                                      value={answers[fieldKey]}
                                      onChange={value => setAnswer(fieldKey, value)}
                                    />

                                    {showAnswers && (
                                      <AnswerBadge>
                                        {getAcceptedAnswerText(cell)}
                                      </AnswerBadge>
                                    )}
                                  </div>
                                ) : (
                                  <span className="whitespace-pre-wrap">
                                    {cell.text}
                                  </span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </QuestionShell>
            )
          }

          if (question.type === 'mcq') {
            const fieldKey = keyBase
            const multi = question.mode === 'multi'
            const correctAnswer = multi
              ? toArray(question.answers).join(', ')
              : question.answer

            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel={multi ? 'MCQ — Choose TWO' : 'MCQ'}
                showAnswers={showAnswers}
                answer={correctAnswer}
              >
                <p className="text-sm text-gray-800 mb-4">
                  {getQuestionText(question)}
                </p>

                <OptionButtons
                  options={question.options}
                  selected={answers[fieldKey]}
                  multi={multi}
                  onSelect={letter => {
                    if (multi) {
                      setMulti(
                        fieldKey,
                        letter,
                        question.answers?.length || 2
                      )
                    } else {
                      setAnswer(fieldKey, letter)
                    }
                  }}
                />
              </QuestionShell>
            )
          }

          if (question.type === 'tfng') {
            const fieldKey = keyBase

            return (
              <QuestionShell
                key={keyBase}
                label={label}
                typeLabel="True / False / Not Given"
                showAnswers={showAnswers}
                answer={question.answer}
              >
                <p className="text-sm text-gray-800 mb-4">
                  {getQuestionText(question)}
                </p>

                <OptionButtons
                  options={['TRUE', 'FALSE', 'NOT GIVEN']}
                  selected={
                    answers[fieldKey]
                      ? letters[
                          ['TRUE', 'FALSE', 'NOT GIVEN'].indexOf(
                            answers[fieldKey]
                          )
                        ]
                      : ''
                  }
                  onSelect={letter => {
                    const values = ['TRUE', 'FALSE', 'NOT GIVEN']
                    setAnswer(fieldKey, values[letters.indexOf(letter)])
                  }}
                />
              </QuestionShell>
            )
          }

          const fieldKey = keyBase

          return (
            <QuestionShell
              key={keyBase}
              label={label}
              typeLabel={
                question.type === 'fitb'
                  ? 'Fill in the Blank'
                  : question.type || 'Question'
              }
              showAnswers={showAnswers}
              answer={getAcceptedAnswerText(question)}
            >
              <p className="text-sm text-gray-800 mb-4">
                {getQuestionText(question)}
              </p>

              <TextAnswer
                value={answers[fieldKey]}
                onChange={value => setAnswer(fieldKey, value)}
              />
            </QuestionShell>
          )
        })}
      </div>
    </div>
  )
}

function ListeningPreview({
  listening,
  answerPrefix,
  answers,
  setAnswer,
  showAnswers,
  questionOffset = 0
}) {
  const parts = normalizeListeningParts(listening)

  const setMulti = (key, letter, max = 2) => {
    const current = Array.isArray(answers[key]) ? answers[key] : []
    const next = current.includes(letter)
      ? current.filter(item => item !== letter)
      : current.length < max
        ? [...current, letter]
        : current

    setAnswer(key, next)
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-gray-900">
              {listening?.title || 'Listening Preview'}
            </h2>

            {listening?.instructions && (
              <p className="text-sm text-gray-500 mt-2 whitespace-pre-wrap">
                {listening.instructions}
              </p>
            )}
          </div>

          <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1.5 rounded-full">
            Audio replay and seeking are enabled in preview
          </span>
        </div>

        {listening?.audioUrl ? (
          <audio
            controls
            preload="metadata"
            src={listening.audioUrl}
            className="w-full mt-5"
          />
        ) : (
          <p className="text-sm text-amber-600 bg-amber-50 rounded-xl px-4 py-3 mt-5">
            No audio file is attached.
          </p>
        )}
      </div>

      {parts.map((part, partIndex) => {
        const questions = toArray(part.questions)

        return (
          <div
            key={part.id || partIndex}
            className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm"
          >
            <h3 className="text-lg font-bold text-gray-900 mb-1">
              {part.title || `Part ${partIndex + 1}`}
            </h3>

            {part.instructions && (
              <p className="text-sm text-gray-500 mb-5">
                {part.instructions}
              </p>
            )}

            <div className="space-y-5">
              {questions.map((question, index) => {
                const keyBase =
                  `${answerPrefix}:${part.id || partIndex}:${question.id || index}`
                const label = getListeningRangeLabel(parts, partIndex, index, questionOffset)
                const displayNumbers = getListeningQuestionNumbers(parts, partIndex, index, questionOffset)

                if (
                  question.type === 'table' ||
                  question.type === 'note'
                ) {
                  let blankIndex = 0
                  return (
                    <QuestionShell
                      key={keyBase}
                      label={label}
                      typeLabel={
                        question.type === 'table'
                          ? 'Table Completion'
                          : 'Note Completion'
                      }
                      showAnswers={false}
                    >
                      {question.instruction && (
                        <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                          {question.instruction}
                        </p>
                      )}

                      {question.title && (
                        <h4 className="font-semibold text-gray-900 mb-4">
                          {question.title}
                        </h4>
                      )}

                      <div className="overflow-x-auto">
                        <table className="min-w-[620px] w-full border-collapse">
                          {toArray(question.columns).length > 0 && (
                            <thead>
                              <tr>
                                {question.columns.map((column, columnIndex) => (
                                  <th key={columnIndex} scope="col" className="border border-gray-200 p-3 text-left text-sm font-semibold bg-gray-50">
                                    {getText(column)}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                          )}
                          <tbody>
                            {toArray(question.rows).map((row, rowIndex) => (
                              <tr key={row.id || rowIndex}>
                                {toArray(row.cells).map((cell, cellIndex) => {
                                  const fieldKey =
                                    `${keyBase}:${row.id || rowIndex}:${cellIndex}`
                                  const number = cell.type === 'blank' ? displayNumbers[blankIndex++] : null

                                  return (
                                    <td
                                      key={cellIndex}
                                      className="border border-gray-200 p-3 align-top text-sm"
                                    >
                                      {cell.type === 'blank' ? (
                                        <div>
                                          <p className="text-xs font-semibold text-purple-600 mb-2">Q{number}</p>
                                          <TextAnswer
                                            value={answers[fieldKey]}
                                            onChange={value =>
                                              setAnswer(fieldKey, value)
                                            }
                                          />

                                          {showAnswers && (
                                            <AnswerBadge>
                                              {getAcceptedAnswerText(cell)}
                                            </AnswerBadge>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="whitespace-pre-wrap">
                                          {cell.text}
                                        </span>
                                      )}
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </QuestionShell>
                  )
                }

                if (question.type === 'listeningCompletion') {
                  let blankIndex = 0
                  return (
                    <QuestionShell
                      key={keyBase}
                      label={label}
                      typeLabel="Listening Completion"
                      showAnswers={false}
                    >
                      {question.instruction && (
                        <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                          {question.instruction}
                        </p>
                      )}

                      {(question.completionTitle || question.title || question.heading) && (
                        <h4 className="font-semibold text-gray-900 mb-4">
                          {question.completionTitle || question.title || question.heading}
                        </h4>
                      )}

                      <div className="space-y-5">
                        {toArray(question.sections).map((section, sectionIndex) => (
                          <div key={section.id || sectionIndex}>
                            {(section.title || section.heading) && (
                              <h4 className="font-semibold text-gray-900 mb-3">
                                {section.title || section.heading}
                              </h4>
                            )}

                            <div className="space-y-3">
                              {toArray(section.parts).map((item, itemIndex) => {
                                if (item.type !== 'blank') {
                                  return (
                                    <span
                                      key={item.id || itemIndex}
                                      className="text-sm text-gray-700 whitespace-pre-wrap"
                                    >
                                      {item.content || item.text || ''}
                                    </span>
                                  )
                                }

                                const fieldKey =
                                  `${keyBase}:${section.id || sectionIndex}:${item.id || itemIndex}`
                                const number = displayNumbers[blankIndex++]

                                return (
                                  <div key={item.id || itemIndex}>
                                    <p className="text-xs font-semibold text-purple-600 mb-2">Q{number}</p>
                                    {question.completionMode === 'choose' ? (
                                      <SelectAnswer
                                        value={answers[fieldKey]}
                                        onChange={value =>
                                          setAnswer(fieldKey, value)
                                        }
                                        options={toArray(question.options)}
                                      />
                                    ) : (
                                      <TextAnswer
                                        value={answers[fieldKey]}
                                        onChange={value =>
                                          setAnswer(fieldKey, value)
                                        }
                                      />
                                    )}

                                    {showAnswers && (
                                      <AnswerBadge>
                                        {getAcceptedAnswerText(item)}
                                      </AnswerBadge>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </QuestionShell>
                  )
                }

                if (
                  question.type === 'map' ||
                  question.type === 'matching'
                ) {
                  const items =
                    question.type === 'map'
                      ? toArray(question.mapItems)
                      : toArray(question.matchingItems)

                  const imageUrl =
                    question.mapImage ||
                    question.mapImageUrl ||
                    question.image ||
                    question.imageUrl ||
                    ''

                  const selectOptions =
                    question.type === 'map'
                      ? toArray(question.mapLocations).map((location, locationIndex) => ({
                          value: location.label || letters[locationIndex],
                          label: location.text
                            ? `${location.label || letters[locationIndex]}. ${location.text}`
                            : location.label || letters[locationIndex]
                        }))
                      : toArray(question.options)

                  return (
                    <QuestionShell
                      key={keyBase}
                      label={label}
                      typeLabel={
                        question.type === 'map'
                          ? 'Map Labelling'
                          : 'Matching'
                      }
                      showAnswers={false}
                    >
                      {question.instruction && (
                        <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                          {question.instruction}
                        </p>
                      )}

                      {question.matchingTitle && question.type === 'matching' && (
                        <h4 className="font-semibold text-gray-900 mb-4">
                          {question.matchingTitle}
                        </h4>
                      )}

                      {imageUrl && (
                        <img
                          src={imageUrl}
                          alt="Listening question"
                          className="w-full max-h-[520px] object-contain rounded-xl border border-gray-100 mb-5"
                        />
                      )}

                      <div className="space-y-4">
                        {items.map((item, itemIndex) => {
                          const itemId = item.id || itemIndex
                          const fieldKey = `${keyBase}:${itemId}`

                          return (
                            <div key={itemId}>
                              <p className="text-sm text-gray-800 mb-2">
                                <span className="font-semibold text-purple-600 mr-2">Q{displayNumbers[itemIndex]}</span>
                                {getItemText(item) || `Item ${itemIndex + 1}`}
                              </p>

                              {selectOptions.length ? (
                                <SelectAnswer
                                  value={answers[fieldKey]}
                                  onChange={value =>
                                    setAnswer(fieldKey, value)
                                  }
                                  options={selectOptions}
                                />
                              ) : (
                                <TextAnswer
                                  value={answers[fieldKey]}
                                  onChange={value =>
                                    setAnswer(fieldKey, value)
                                  }
                                />
                              )}

                              {showAnswers && (
                                <AnswerBadge>
                                  {item.answer}
                                </AnswerBadge>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </QuestionShell>
                  )
                }

                if (question.type === 'tfng') {
                  const fieldKey = keyBase
                  const values = ['TRUE', 'FALSE', 'NOT GIVEN']

                  return (
                    <QuestionShell
                      key={keyBase}
                      label={label}
                      typeLabel="True / False / Not Given"
                      showAnswers={showAnswers}
                      answer={question.answer}
                    >
                      <p className="text-sm text-gray-800 mb-4">
                        {getQuestionText(question)}
                      </p>

                      <OptionButtons
                        options={values}
                        selected={
                          answers[fieldKey]
                            ? letters[values.indexOf(answers[fieldKey])]
                            : ''
                        }
                        onSelect={letter =>
                          setAnswer(fieldKey, values[letters.indexOf(letter)])
                        }
                      />
                    </QuestionShell>
                  )
                }

                if (question.type === 'mcq') {
                  const fieldKey = keyBase
                  const multi = question.mode === 'multi'
                  const correctAnswer = multi
                    ? toArray(question.answers).join(', ')
                    : question.answer

                  return (
                    <QuestionShell
                      key={keyBase}
                      label={label}
                      typeLabel={multi ? 'MCQ — Choose TWO' : 'MCQ'}
                      showAnswers={showAnswers}
                      answer={correctAnswer}
                    >
                      <p className="text-sm text-gray-800 mb-4">
                        {getQuestionText(question)}
                      </p>

                      <OptionButtons
                        options={question.options}
                        selected={answers[fieldKey]}
                        multi={multi}
                        onSelect={letter => {
                          if (multi) {
                            setMulti(
                              fieldKey,
                              letter,
                              question.answers?.length || 2
                            )
                          } else {
                            setAnswer(fieldKey, letter)
                          }
                        }}
                      />
                    </QuestionShell>
                  )
                }

                const fieldKey = keyBase

                return (
                  <QuestionShell
                    key={keyBase}
                    label={label}
                    typeLabel={question.type || 'Question'}
                    showAnswers={showAnswers}
                    answer={getAcceptedAnswerText(question)}
                  >
                    <p className="text-sm text-gray-800 mb-4">
                      {getQuestionText(question)}
                    </p>

                    <TextAnswer
                      value={answers[fieldKey]}
                      onChange={value => setAnswer(fieldKey, value)}
                    />
                  </QuestionShell>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WritingPreview({
  writing,
  answerPrefix,
  answers,
  setAnswer,
  modeOverride = ''
}) {
  const mode =
    modeOverride ||
    writing?.contentType ||
    writing?.writingMode ||
    writing?.writingType ||
    'full_writing'

  const hasTask1 = mode !== 'task2_only'
  const hasTask2 = mode !== 'task1_only'

  return (
    <div className="space-y-6">
      {hasTask1 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="text-xl font-bold text-gray-900">
                Writing Task 1
              </h2>

              <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
                Suggested time: 20 minutes
              </span>
            </div>

            {getWritingTaskImage(writing, 1) && (
              <img
                src={getWritingTaskImage(writing, 1)}
                alt="Writing Task 1"
                className="w-full max-h-[520px] object-contain rounded-xl border border-gray-100 mb-5"
              />
            )}

            <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
              {getWritingTaskText(writing, 1)}
            </p>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
            <h3 className="font-semibold text-gray-800 mb-3">
              Teacher test area
            </h3>

            <textarea
              value={answers[`${answerPrefix}:task1`] || ''}
              onChange={event =>
                setAnswer(`${answerPrefix}:task1`, event.target.value)
              }
              rows={18}
              placeholder="Type here to test the student writing area..."
              className="w-full resize-y border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            />

            <p className="text-xs text-gray-400 mt-2">
              No answer is saved or submitted.
            </p>
          </div>
        </div>
      )}

      {hasTask2 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="text-xl font-bold text-gray-900">
                Writing Task 2
              </h2>

              <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
                Suggested time: 40 minutes
              </span>
            </div>

            {getWritingTaskImage(writing, 2) && (
              <img
                src={getWritingTaskImage(writing, 2)}
                alt="Writing Task 2"
                className="w-full max-h-[520px] object-contain rounded-xl border border-gray-100 mb-5"
              />
            )}

            <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
              {getWritingTaskText(writing, 2)}
            </p>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
            <h3 className="font-semibold text-gray-800 mb-3">
              Teacher test area
            </h3>

            <textarea
              value={answers[`${answerPrefix}:task2`] || ''}
              onChange={event =>
                setAnswer(`${answerPrefix}:task2`, event.target.value)
              }
              rows={18}
              placeholder="Type here to test the student writing area..."
              className="w-full resize-y border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            />

            <p className="text-xs text-gray-400 mt-2">
              Writing has no fixed answer key. Nothing is saved.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function VocabularyPreview({
  test,
  answerPrefix,
  answers,
  setAnswer,
  showAnswers
}) {
  const questions = toArray(test?.questions)
  const matchingQuestions = questions.filter(
    question => question?.type === 'match_definition'
  )

  const parseWordBank = value =>
    (value || '')
      .split(/\r?\n|,|\s+[-\u2013\u2014]\s+/)
      .map(item => item.trim())
      .filter(Boolean)

  return (
    <div className="space-y-5">
      {questions.map((question, index) => {
        const fieldKey = `${answerPrefix}:${question.id || index}`
        const type = question?.type || 'mcq'

        if (type === 'match_definition') {
          const wordOptions = matchingQuestions.map(item => ({
            value: item.id,
            label: item.word || item.question || 'Word'
          }))

          return (
            <QuestionShell
              key={fieldKey}
              label={`Q${index + 1}`}
              typeLabel="Match Definition"
              showAnswers={false}
            >
              {question.taskTitle && (
                <h3 className="font-semibold text-gray-900 mb-2">
                  {question.taskTitle}
                </h3>
              )}

              {question.instruction && (
                <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                  {question.instruction}
                </p>
              )}

              <p className="text-sm text-gray-800 mb-3">
                {question.definition || getQuestionText(question)}
              </p>

              <SelectAnswer
                value={answers[fieldKey]}
                onChange={value => setAnswer(fieldKey, value)}
                options={wordOptions}
                placeholder="Choose the matching word"
              />

              {showAnswers && (
                <AnswerBadge>
                  {question.word || question.question || 'Not set'}
                </AnswerBadge>
              )}
            </QuestionShell>
          )
        }

        if (type === 'word_bank') {
          const words = parseWordBank(question.wordBank)

          return (
            <QuestionShell
              key={fieldKey}
              label={`Q${index + 1}`}
              typeLabel="Word Bank"
              showAnswers={false}
            >
              {(question.sectionTitle || question.taskTitle) && (
                <h3 className="font-semibold text-gray-900 mb-2">
                  {question.sectionTitle || question.taskTitle}
                </h3>
              )}

              {question.instruction && (
                <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                  {question.instruction}
                </p>
              )}

              {words.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4 bg-purple-50 border border-purple-100 rounded-xl p-3">
                  {words.map((word, wordIndex) => (
                    <span
                      key={`${word}-${wordIndex}`}
                      className="text-xs bg-white border border-purple-100 text-purple-700 px-3 py-1.5 rounded-full"
                    >
                      {word}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-sm text-gray-800 mb-3 whitespace-pre-wrap">
                {question.sentence || question.question || 'Sentence is missing.'}
              </p>

              <TextAnswer
                value={answers[fieldKey]}
                onChange={value => setAnswer(fieldKey, value)}
                placeholder="Type the correct word or phrase..."
              />

              {showAnswers && (
                <AnswerBadge>
                  {getAcceptedAnswerText(question)}
                </AnswerBadge>
              )}
            </QuestionShell>
          )
        }

        if (type === 'grammar_form') {
          return (
            <QuestionShell
              key={fieldKey}
              label={`Q${index + 1}`}
              typeLabel="Grammar Form"
              showAnswers={false}
            >
              {question.taskTitle && (
                <h3 className="font-semibold text-gray-900 mb-2">
                  {question.taskTitle}
                </h3>
              )}

              {question.instruction && (
                <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
                  {question.instruction}
                </p>
              )}

              {question.grammarNote && (
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-gray-700 leading-6 whitespace-pre-wrap mb-4">
                  {question.grammarNote}
                </div>
              )}

              <p className="text-sm text-gray-800 mb-2 whitespace-pre-wrap">
                {question.sentence || question.question || 'Sentence is missing.'}
              </p>

              {question.baseWord && (
                <p className="text-sm font-semibold text-gray-900 mb-3">
                  {question.baseWord}
                </p>
              )}

              <TextAnswer
                value={answers[fieldKey]}
                onChange={value => setAnswer(fieldKey, value)}
                placeholder="Type the correct form..."
              />

              {showAnswers && (
                <AnswerBadge>
                  {getAcceptedAnswerText(question)}
                </AnswerBadge>
              )}
            </QuestionShell>
          )
        }

        return (
          <QuestionShell
            key={fieldKey}
            label={`Q${index + 1}`}
            typeLabel="Vocabulary MCQ"
            showAnswers={showAnswers}
            answer={question.answer}
          >
            {question.sectionTitle && (
              <h3 className="font-semibold text-gray-900 mb-3">
                {question.sectionTitle}
              </h3>
            )}

            <p className="text-sm text-gray-800 mb-4">
              {getQuestionText(question)}
            </p>

            <OptionButtons
              options={question.options}
              selected={answers[fieldKey]}
              onSelect={letter => setAnswer(fieldKey, letter)}
            />
          </QuestionShell>
        )
      })}
    </div>
  )
}

export default function TeacherPreview() {
  const { type, id } = useParams()
  const navigate = useNavigate()

  const config = TYPE_CONFIG[type]

  const [profile, setProfile] = useState(null)
  const [content, setContent] = useState(null)
  const [mockResources, setMockResources] = useState({
    listenings: [],
    readings: [],
    writing: null
  })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [showAnswers, setShowAnswers] = useState(false)
  const [answers, setAnswers] = useState({})
  const [activeMockTab, setActiveMockTab] = useState('overview')

  const backPath = profile?.role === 'admin' ? '/admin' : '/teacher'

  const setAnswer = (key, value) => {
    setAnswers(previous => ({
      ...previous,
      [key]: value
    }))
  }

  useEffect(() => {
    setAnswers({})
    setContent(null)
    setMockResources({ listenings: [], readings: [], writing: null })
    setShowAnswers(false)
    setActiveMockTab('overview')
    setLoadError('')
    setLoading(true)
  }, [type, id])

  useEffect(() => {
    let active = true

    const unsubscribe = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        if (!config) {
          throw new Error('Unsupported preview type.')
        }

        const profileSnap = await getDoc(
          doc(db, 'users', currentUser.uid)
        )

        if (!profileSnap.exists()) {
          await signOut(auth)
          navigate('/login')
          return
        }

        const profileData = profileSnap.data()

        if (
          profileData.deleted === true ||
          profileData.status !== 'approved' ||
          !['teacher', 'admin'].includes(profileData.role)
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        if (!active) return

        setProfile(profileData)

        const contentSnap = await getDoc(
          doc(db, config.collection, id)
        )

        if (!contentSnap.exists()) {
          throw new Error(`${config.label} content was not found.`)
        }

        const loadedContent = {
          id: contentSnap.id,
          ...contentSnap.data()
        }

        if (!active) return

        setContent(loadedContent)

        if (type === 'mock') {
          const enabled = getMockEnabledSections(loadedContent)
          const readingIds = !enabled.reading
            ? []
            : Array.isArray(loadedContent.readingIds)
            ? loadedContent.readingIds.filter(Boolean)
            : loadedContent.readingId
              ? [loadedContent.readingId]
              : []

          const listeningIds = !enabled.listening
            ? []
            : Array.isArray(loadedContent.listeningIds)
            ? loadedContent.listeningIds.filter(Boolean)
            : loadedContent.listeningId
              ? [loadedContent.listeningId]
              : []

          if (enabled.reading && readingIds.length === 0) {
            throw new Error('This mock includes Reading, but no Reading resource is linked.')
          }
          if (enabled.listening && listeningIds.length === 0) {
            throw new Error('This mock includes Listening, but no Listening resource is linked.')
          }
          if (enabled.writing && !loadedContent.writingId) {
            throw new Error('This mock includes Writing, but no Writing resource is linked.')
          }

          const [readingDocs, listeningDocs, writingSnap] =
            await Promise.all([
              Promise.all(
                readingIds.map(readingId =>
                  getDoc(doc(db, 'readings', readingId))
                )
              ),
              Promise.all(
                listeningIds.map(listeningId =>
                  getDoc(doc(db, 'listenings', listeningId))
                )
              ),
              enabled.writing && loadedContent.writingId
                ? getDoc(
                    doc(
                      db,
                      'writingHomeworks',
                      loadedContent.writingId
                    )
                  )
                : Promise.resolve(null)
            ])

          if (!active) return

          if (readingDocs.some(snapshot => !snapshot.exists())) {
            throw new Error('One or more Reading resources linked to this mock were not found. Check Edit Content.')
          }
          if (listeningDocs.some(snapshot => !snapshot.exists())) {
            throw new Error('One or more Listening resources linked to this mock were not found. Check Edit Content.')
          }
          if (enabled.writing && (!writingSnap || !writingSnap.exists())) {
            throw new Error('The Writing resource linked to this mock was not found. Check Edit Content.')
          }

          setMockResources({
            readings: readingDocs
              .filter(snapshot => snapshot.exists())
              .map(snapshot => ({
                id: snapshot.id,
                ...snapshot.data()
              })),
            listenings: listeningDocs
              .filter(snapshot => snapshot.exists())
              .map(snapshot => ({
                id: snapshot.id,
                ...snapshot.data()
              })),
            writing:
              writingSnap && writingSnap.exists()
                ? {
                    id: writingSnap.id,
                    ...writingSnap.data()
                  }
                : null
          })
        }

        setLoading(false)
      } catch (error) {
        console.error(error)

        if (active) {
          setLoadError(
            error?.message ||
              'The preview could not be loaded. Check permissions and content links.'
          )
          setLoading(false)
        }
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [config, id, navigate, type])

  const mockTabs = useMemo(() => {
    if (type !== 'mock') return []

    const enabled = getMockEnabledSections(content)

    return [
      { key: 'overview', label: 'Overview' },
      ...(enabled.listening
        ? mockResources.listenings.map((item, index) => ({
            key: `listening-${index}`,
            label: `Listening ${index + 1}`,
            type: 'listening',
            questionOffset: mockResources.listenings.slice(0, index).reduce(
              (sum, resource) => sum + normalizeListeningParts(resource).reduce(
                (total, part) => total + toArray(part.questions).reduce(
                  (count, question) => count + getQuestionCount(question), 0
                ), 0
              ), 0
            ),
            item
          }))
        : []),
      ...(enabled.reading
        ? mockResources.readings.map((item, index) => ({
            key: `reading-${index}`,
            label: `Reading ${index + 1}`,
            type: 'reading',
            item
          }))
        : []),
      ...(enabled.writing && mockResources.writing
        ? [
            {
              key: 'writing',
              label: getMockWritingLabel(
                content,
                mockResources.writing
              ),
              type: 'writing',
              item: mockResources.writing
            }
          ]
        : [])
    ]
  }, [mockResources, type, content])

  const activeMockItem = mockTabs.find(tab => tab.key === activeMockTab)

  const previewLabel =
    type === 'mock'
      ? getMockTypeLabel(content)
      : config?.label || 'Content'

  if (loading) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
        <div className="bg-white border border-gray-100 rounded-2xl px-8 py-7 shadow-sm text-center">
          <div className="w-10 h-10 border-4 border-purple-100 border-t-purple-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm font-medium text-gray-700">
            Loading teacher preview...
          </p>
        </div>
      </div>
    )
  }

  if (loadError || !content) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
        <div className="max-w-xl w-full bg-white border border-red-100 rounded-2xl p-8 shadow-sm text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-3">
            Preview could not be opened
          </h1>

          <p className="text-sm text-gray-500 mb-6">
            {loadError || 'Content is missing.'}
          </p>

          <button
            onClick={() => navigate(backPath)}
            className="bg-purple-600 text-white px-5 py-3 rounded-xl text-sm font-medium"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <div className="sticky top-0 z-50 bg-amber-500 text-white shadow-sm">
        <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em]">
              Teacher Preview Mode
            </p>

            <p className="text-xs text-amber-50 mt-1">
              Nothing entered here is submitted, scored, saved to Firestore or added to student analytics.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {type !== 'writing' && (
              <button
                type="button"
                onClick={() => setShowAnswers(previous => !previous)}
                className="text-xs bg-white text-amber-700 px-3 py-2 rounded-xl font-semibold hover:bg-amber-50"
              >
                {showAnswers ? 'Hide Answer Key' : 'Show Answer Key'}
              </button>
            )}

            {config?.editPath && (
              <button
                type="button"
                onClick={() => navigate(config.editPath(id))}
                className="text-xs bg-amber-700 text-white px-3 py-2 rounded-xl font-semibold hover:bg-amber-800"
              >
                Edit Content
              </button>
            )}

            <button
              type="button"
              onClick={() => navigate(backPath)}
              className="text-xs bg-gray-900 text-white px-3 py-2 rounded-xl font-semibold hover:bg-black"
            >
              ← Back to Dashboard
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-6">
        <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs uppercase tracking-wider text-purple-600 font-semibold mb-2">
                {previewLabel} Preview
              </p>

              <h1 className="text-2xl font-bold text-gray-900">
                {content.title || `Untitled ${previewLabel}`}
              </h1>

              {content.instructions && type !== 'listening' && (
                <p className="text-sm text-gray-500 mt-3 whitespace-pre-wrap">
                  {content.instructions}
                </p>
              )}
            </div>

            <div className="flex gap-2 flex-wrap">
              {type === 'mock' && (
                <>
                  <span className={`text-xs px-3 py-1.5 rounded-full ${
                    getMockType(content) === 'mini_mock'
                      ? 'bg-blue-50 text-blue-700'
                      : 'bg-purple-50 text-purple-700'
                  }`}>
                    {getMockTypeLabel(content)}
                  </span>

                  {getMockEnabledSections(content).writing && (
                    <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1.5 rounded-full">
                      {getMockWritingLabel(
                        content,
                        mockResources.writing
                      )}
                    </span>
                  )}

                  <span className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full">
                    {getMockTotalTime(content)} minutes
                  </span>
                </>
              )}

              {content.archived === true && (
                <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1.5 rounded-full">
                  Archived content
                </span>
              )}

              <span className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full">
                Student assignment not required
              </span>

              <span className="text-xs bg-green-50 text-green-700 px-3 py-1.5 rounded-full">
                Safe preview
              </span>
            </div>
          </div>
        </div>

        {type === 'reading' && (
          <ReadingPreview
            reading={content}
            answerPrefix={`reading:${content.id}`}
            answers={answers}
            setAnswer={setAnswer}
            showAnswers={showAnswers}
          />
        )}

        {type === 'listening' && (
          <ListeningPreview
            listening={content}
            answerPrefix={`listening:${content.id}`}
            answers={answers}
            setAnswer={setAnswer}
            showAnswers={showAnswers}
          />
        )}

        {type === 'writing' && (
          <WritingPreview
            writing={content}
            answerPrefix={`writing:${content.id}`}
            answers={answers}
            setAnswer={setAnswer}
          />
        )}

        {type === 'vocabulary' && (
          <VocabularyPreview
            test={content}
            answerPrefix={`vocabulary:${content.id}`}
            answers={answers}
            setAnswer={setAnswer}
            showAnswers={showAnswers}
          />
        )}

        {type === 'mock' && (
          <div>
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm mb-6 overflow-x-auto">
              <div className="flex gap-2 min-w-max">
                {mockTabs.map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveMockTab(tab.key)}
                    className={`px-4 py-2.5 rounded-xl text-sm font-semibold ${
                      activeMockTab === tab.key
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {activeMockTab === 'overview' && (
              <div className={`grid grid-cols-1 ${
                Object.values(getMockEnabledSections(content)).filter(Boolean).length >= 3
                  ? 'md:grid-cols-3'
                  : Object.values(getMockEnabledSections(content)).filter(Boolean).length === 2
                    ? 'md:grid-cols-2'
                    : ''
              } gap-4`}>
                {getMockEnabledSections(content).listening && (
                  <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                    <p className="text-xs text-gray-400 mb-1">
                      Listening resources
                    </p>
                    <p className="text-3xl font-bold text-purple-600">
                      {mockResources.listenings.length}
                    </p>
                  </div>
                )}

                {getMockEnabledSections(content).reading && (
                  <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                    <p className="text-xs text-gray-400 mb-1">
                      Reading resources
                    </p>
                    <p className="text-3xl font-bold text-blue-600">
                      {mockResources.readings.length}
                    </p>
                  </div>
                )}

                {getMockEnabledSections(content).writing && (
                  <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                    <p className="text-xs text-gray-400 mb-1">
                      Writing format
                    </p>
                    <p className="text-lg font-bold text-amber-600">
                      {mockResources.writing
                        ? getMockWritingLabel(
                            content,
                            mockResources.writing
                          )
                        : 'Missing'}
                    </p>
                  </div>
                )}

                <div className="md:col-span-full bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                  <h2 className="font-semibold text-gray-900 mb-3">
                    Preview behaviour
                  </h2>

                  <p className="text-sm text-gray-600 leading-6">
                    {getMockTypeLabel(content)} · {getMockFlowLabel(content, mockResources.writing)} · {getMockTotalTime(content)} minutes total. All included sections are unlocked in Preview. Timers, auto-submit, listening replay restrictions, section locks, submissions and score records are disabled.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
                    {Object.entries(getMockSectionTimes(content))
                      .filter(([, minutes]) => minutes > 0)
                      .map(([section, minutes]) => (
                        <div
                          key={section}
                          className="bg-gray-50 rounded-xl p-4"
                        >
                          <p className="text-xs text-gray-400 capitalize">
                            {section}
                          </p>
                          <p className="text-xl font-bold text-gray-800 mt-1">
                            {minutes} min
                          </p>
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeMockItem?.type === 'listening' && (
              <ListeningPreview
                listening={activeMockItem.item}
                questionOffset={activeMockItem.questionOffset || 0}
                answerPrefix={`mock:${content.id}:listening:${activeMockItem.item.id}`}
                answers={answers}
                setAnswer={setAnswer}
                showAnswers={showAnswers}
              />
            )}

            {activeMockItem?.type === 'reading' && (
              <ReadingPreview
                reading={activeMockItem.item}
                answerPrefix={`mock:${content.id}:reading:${activeMockItem.item.id}`}
                answers={answers}
                setAnswer={setAnswer}
                showAnswers={showAnswers}
              />
            )}

            {activeMockItem?.type === 'writing' && (
              <WritingPreview
                writing={activeMockItem.item}
                answerPrefix={`mock:${content.id}:writing:${activeMockItem.item.id}`}
                answers={answers}
                setAnswer={setAnswer}
                modeOverride={getMockWritingMode(
                  content,
                  activeMockItem.item
                )}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
