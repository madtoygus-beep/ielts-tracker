import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { auth, db } from '../firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit
} from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const LISTENING_DURATION = 35 * 60
const READING_DURATION = 60 * 60
const WRITING_DURATION = 60 * 60

const MINI_MOCK_DEFAULT_MINUTES = {
  listening: 15,
  reading: 30,
  writing: 30
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
    return {
      listening: true,
      reading: true,
      writing: true
    }
  }

  if (mock?.enabledSections && typeof mock.enabledSections === 'object') {
    const stored = {
      listening: mock.enabledSections.listening === true,
      reading: mock.enabledSections.reading === true,
      writing: mock.enabledSections.writing === true
    }

    if (Object.values(stored).some(Boolean)) {
      return stored
    }
  }

  const listeningIds = Array.isArray(mock?.listeningIds)
    ? mock.listeningIds.filter(Boolean)
    : mock?.listeningId
      ? [mock.listeningId]
      : []
  const readingIds = Array.isArray(mock?.readingIds)
    ? mock.readingIds.filter(Boolean)
    : mock?.readingId
      ? [mock.readingId]
      : []
  const inferred = {
    listening: listeningIds.length > 0,
    reading: readingIds.length > 0,
    writing: Boolean(mock?.writingId)
  }

  return Object.values(inferred).some(Boolean)
    ? inferred
    : {
        listening: true,
        reading: true,
        writing: true
      }
}

function getMockSectionMinutes(mock, section) {
  const enabledSections = getMockEnabledSections(mock)

  if (!enabledSections[section]) return 0
  const isMiniMock = getMockType(mock) === 'mini_mock'
  const fullDefaults = {
    listening: LISTENING_DURATION / 60,
    reading: READING_DURATION / 60,
    writing: WRITING_DURATION / 60
  }
  const defaults = isMiniMock
    ? MINI_MOCK_DEFAULT_MINUTES
    : fullDefaults

  const stored = mock?.sectionTimeLimits || {}
  const legacyKey = `${section}TimeLimit`
  const value = Number(stored[section] ?? mock?.[legacyKey])

  if (!Number.isFinite(value) || value <= 0) {
    return defaults[section]
  }

  return Math.max(5, Math.min(180, Math.round(value)))
}

function getMockSectionSeconds(mock, section) {
  return getMockSectionMinutes(mock, section) * 60
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

function getWritingModeLabel(mode) {
  if (mode === 'none') return 'No Writing'
  if (mode === 'task1_only') return 'Writing Task 1'
  if (mode === 'task2_only') return 'Writing Task 2'

  return 'Writing Task 1 + Task 2'
}

function getMockFlowLabel(mock, writingMode) {
  const enabled = getMockEnabledSections(mock)

  return [
    enabled.listening ? 'Listening' : null,
    enabled.reading ? 'Reading' : null,
    enabled.writing ? getWritingModeLabel(writingMode) : null
  ]
    .filter(Boolean)
    .join(' → ')
}

function normalize(value) {
  return value?.toString().trim().toLowerCase()
}

function sortAnswers(value) {
  if (!Array.isArray(value)) return []
  return [...value].map(v => v?.toString().trim()).sort()
}

function tableAnswerKey(questionId, rowId, cellIndex) {
  return `${questionId}_${rowId}_${cellIndex}`
}

function listeningCompletionAnswerKey(questionId, sectionId, itemId) {
  return `${questionId}_${sectionId}_${itemId}`
}

function noteAnswerKey(questionId, paragraphId, partId) {
  return `${questionId}_${paragraphId}_${partId}`
}

function mapAnswerKey(questionId, itemId) {
  return `${questionId}_${itemId}`
}

function matchingAnswerKey(questionId, itemId) {
  return `${questionId}_${itemId}`
}

function countWords(value) {
  return value
    ?.toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean).length || 0
}

function isWithinWordLimit(value, maxWords) {
  if (!maxWords) return true
  return countWords(value) <= Number(maxWords)
}

function getAcceptedAnswers(mainAnswer, acceptedAnswers) {
  const list = []

  if (mainAnswer) list.push(mainAnswer)

  if (acceptedAnswers) {
    acceptedAnswers
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .forEach(item => list.push(item))
  }

  return list.map(normalize)
}

function isBlankCorrect(userAnswer, mainAnswer, acceptedAnswers = '', maxWords = '') {
  if (!isWithinWordLimit(userAnswer, maxWords)) return false

  const cleanUser = normalize(userAnswer)
  const accepted = getAcceptedAnswers(mainAnswer, acceptedAnswers)

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

function getReadingQuestionCount(question) {
  if (question.type === 'matching') return question.paragraphs?.length || 0

  if (question.type === 'matchingInformation') return question.items?.length || 0

  if (question.type === 'sentenceEndings') return question.items?.length || 0

  if (question.type === 'summaryOptions') return question.items?.length || 0

  if (question.type === 'noteCompletion') {
    let count = 0

    question.paragraphs?.forEach(paragraph => {
      paragraph.parts?.forEach(part => {
        if (part.type === 'blank') count++
      })
    })

    return count || 1
  }

  if (question.type === 'mcq' && question.mode === 'multi') {
    return question.answers?.length || 2
  }

  if (question.type === 'table' || question.type === 'summary') {
    let count = 0

    question.rows?.forEach(row => {
      row.cells?.forEach(cell => {
        if (cell.type === 'blank') count++
      })
    })

    return count || 1
  }

  return 1
}

function getTotalReadingQuestionCount(reading) {
  if (!reading?.questions?.length) return 0

  return reading.questions.reduce(
    (sum, question) => sum + getReadingQuestionCount(question),
    0
  )
}

function getQuestionRangeLabel(questions, question, index) {
  const start =
    questions
      .slice(0, index)
      .reduce((sum, item) => sum + getReadingQuestionCount(item), 0) + 1

  const count = getReadingQuestionCount(question)
  const end = start + count - 1

  return count > 1 ? `Q${start}-${end}` : `Q${start}`
}

function extractPromptText(value) {
  if (!value) return null
  if (typeof value === 'string') return value

  if (typeof value === 'object') {
    return value.prompt || value.title || value.text || value.question || null
  }

  return null
}

function extractPromptImage(value) {
  if (!value || typeof value !== 'object') return null

  return (
    value.image ||
    value.imageUrl ||
    value.url ||
    value.fileUrl ||
    value.downloadURL ||
    null
  )
}

function getWritingTask1Source(writing) {
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

function getWritingTask2Source(writing) {
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

function getWritingTask1Prompt(writing) {
  return extractPromptText(getWritingTask1Source(writing)) || 'Writing Task 1 prompt is missing.'
}

function getWritingTask2Prompt(writing) {
  return extractPromptText(getWritingTask2Source(writing)) || 'Writing Task 2 prompt is missing.'
}

function getWritingTask1Image(writing) {
  return (
    extractPromptImage(getWritingTask1Source(writing)) ||
    writing?.task1Image ||
    writing?.task1ImageUrl ||
    null
  )
}

function getWritingTask2Image(writing) {
  return (
    extractPromptImage(getWritingTask2Source(writing)) ||
    writing?.task2Image ||
    writing?.task2ImageUrl ||
    null
  )
}

function formatTime(seconds) {
  if (seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function normalizeListeningParts(listening) {
  if (listening?.parts?.length) {
    return listening.parts.map((part, index) => ({
      id: part.id || `part-${index + 1}`,
      title: part.title || `Part ${index + 1}`,
      instructions: part.instructions || '',
      questions: part.questions?.length ? part.questions : []
    }))
  }

  return [
    {
      id: 'part-1',
      title: 'Part 1',
      instructions: '',
      questions: listening?.questions?.length ? listening.questions : []
    }
  ]
}

function getListeningQuestionCount(question) {
  if (question.type === 'table' || question.type === 'note') {
    let count = 0

    question.rows?.forEach(row => {
      row.cells?.forEach(cell => {
        if (cell.type === 'blank') count++
      })
    })

    return count || 1
  }

  if (question.type === 'listeningCompletion') {
    let count = 0

    question.sections?.forEach(section => {
      section.parts?.forEach(part => {
        if (part.type === 'blank') count++
      })
    })

    return count || 1
  }

  if (question.type === 'map') {
    return question.mapItems?.length || 0
  }

  if (question.type === 'matching') {
    return question.matchingItems?.length || 0
  }

  if (question.type === 'mcq' && question.mode === 'multi') {
    return question.answers?.length || 2
  }

  return 1
}

function getListeningPartQuestionTotal(part) {
  return (part.questions || []).reduce(
    (sum, question) => sum + getListeningQuestionCount(question),
    0
  )
}

function getListeningQuestionDisplayNumbers(parts, partId, targetQuestion) {
  let number = 1

  for (const part of parts || []) {
    for (const question of part.questions || []) {
      if (question.id === targetQuestion?.id) {
        if (question.type === 'table' || question.type === 'note') {
          const numbers = []

          for (const row of question.rows || []) {
            for (let index = 0; index < (row.cells || []).length; index++) {
              const cell = row.cells[index]
              if (cell.type !== 'blank') continue
              numbers.push(getManualQuestionNumber(cell) || number)
              number++
            }
          }

          return numbers
        }

        if (question.type === 'listeningCompletion') {
          const numbers = []

          for (const section of question.sections || []) {
            for (const item of section.parts || []) {
              if (item.type !== 'blank') continue
              numbers.push(getManualQuestionNumber(item) || number)
              number++
            }
          }

          return numbers
        }

        if (question.type === 'map') {
          return (question.mapItems || []).map(item => {
            const displayNumber = getManualQuestionNumber(item) || number
            number++
            return displayNumber
          })
        }

        if (question.type === 'matching') {
          return (question.matchingItems || []).map(item => {
            const displayNumber = getManualQuestionNumber(item) || number
            number++
            return displayNumber
          })
        }

        if (question.type === 'mcq' && question.mode === 'multi') {
          const count = question.answers?.length || 2
          const first = getManualQuestionNumber(question) || number
          const firstAsNumber = Number(first)

          if (Number.isFinite(firstAsNumber)) {
            return Array.from({ length: count }, (_, index) => firstAsNumber + index)
          }

          return [first]
        }

        return [getManualQuestionNumber(question) || number]
      }

      number += getListeningQuestionCount(question)
    }
  }

  return []
}

function getListeningQuestionRangeLabel(parts, partId, questionIndex) {
  const part = (parts || []).find(item => item.id === partId)
  const question = part?.questions?.[questionIndex]
  const numbers = getListeningQuestionDisplayNumbers(parts, partId, question)

  if (numbers.length > 1) {
    return `Q${numbers[0]}-${numbers[numbers.length - 1]}`
  }

  if (numbers.length === 1) {
    return `Q${numbers[0]}`
  }

  return `Q${questionIndex + 1}`
}

function getListeningSingleQuestionNumber(parts, partId, questionId) {
  let number = 1

  for (const part of parts || []) {
    for (const question of part.questions || []) {
      if (question.id === questionId) {
        return getManualQuestionNumber(question) || number
      }

      number += getListeningQuestionCount(question)
    }
  }

  return number
}

function getListeningMapQuestionNumber(parts, partId, questionId, itemId) {
  let number = 1

  for (const part of parts || []) {
    for (const question of part.questions || []) {
      if (question.id === questionId) {
        for (const item of question.mapItems || []) {
          if (part.id === partId && item.id === itemId) {
            return getManualQuestionNumber(item) || number
          }

          number++
        }

        return number
      }

      number += getListeningQuestionCount(question)
    }
  }

  return number
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

function getListeningBlankQuestionNumber(parts, partId, questionId, rowId, cellIndex) {
  let number = 1

  for (const part of parts || []) {
    for (const question of part.questions || []) {
      if (question.id === questionId) {
        for (const row of question.rows || []) {
          for (let index = 0; index < (row.cells || []).length; index++) {
            const cell = row.cells[index]

            if (cell.type !== 'blank') continue

            if (part.id === partId && row.id === rowId && index === cellIndex) {
              return getManualQuestionNumber(cell) || number
            }

            number++
          }
        }

        return number
      }

      number += getListeningQuestionCount(question)
    }
  }

  return number
}

function getListeningCompletionQuestionNumber(parts, partId, questionId, sectionId, itemId) {
  let number = 1

  for (const part of parts || []) {
    for (const question of part.questions || []) {
      if (question.id === questionId) {
        for (const section of question.sections || []) {
          for (const item of section.parts || []) {
            if (item.type !== 'blank') continue

            if (part.id === partId && section.id === sectionId && item.id === itemId) {
              return getManualQuestionNumber(item) || number
            }

            number++
          }
        }

        return number
      }

      number += getListeningQuestionCount(question)
    }
  }

  return number
}

function getListeningMatchingQuestionNumber(parts, partId, questionId, itemId) {
  let number = 1

  for (const part of parts || []) {
    for (const question of part.questions || []) {
      if (question.id === questionId) {
        for (const item of question.matchingItems || []) {
          if (part.id === partId && item.id === itemId) {
            return getManualQuestionNumber(item) || number
          }

          number++
        }

        return number
      }

      number += getListeningQuestionCount(question)
    }
  }

  return number
}

function getReadingBlankQuestionNumber(reading, questionId, rowId, cellIndex) {
  let number = 1

  for (const question of reading?.questions || []) {
    if (question.id === questionId) {
      for (const row of question.rows || []) {
        for (let index = 0; index < (row.cells || []).length; index++) {
          const cell = row.cells[index]

          if (cell.type !== 'blank') continue

          if (row.id === rowId && index === cellIndex) {
            return number
          }

          number++
        }
      }

      return number
    }

    number += getReadingQuestionCount(question)
  }

  return number
}

function getReadingNoteBlankQuestionNumber(reading, questionId, paragraphId, partId) {
  let number = 1

  for (const question of reading?.questions || []) {
    if (question.id === questionId) {
      for (const paragraph of question.paragraphs || []) {
        for (const part of paragraph.parts || []) {
          if (part.type !== 'blank') continue

          if (paragraph.id === paragraphId && part.id === partId) {
            return number
          }

          number++
        }
      }

      return number
    }

    number += getReadingQuestionCount(question)
  }

  return number
}


function normalizeId(value) {
  return value === undefined || value === null
    ? ''
    : value.toString().trim().toLowerCase()
}

function uniqueCleanValues(values) {
  return Array.from(
    new Set(
      values
        .filter(value => value !== undefined && value !== null)
        .map(value => value.toString().trim())
        .filter(Boolean)
    )
  )
}

function getSourceTeacherIds(source) {
  const explicitTeacherIds = Array.isArray(source?.teacherIds)
    ? source.teacherIds
    : []

  if (explicitTeacherIds.length > 0) {
    return uniqueCleanValues(explicitTeacherIds)
  }

  return uniqueCleanValues([
    source?.teacherId,
    source?.createdBy
  ])
}

function getCurrentUserAssignmentValues(user, profile) {
  if (!user) return []

  return uniqueCleanValues([
    user.uid,
    user.email,
    user.email?.toLowerCase(),
    profile?.uid,
    profile?.id,
    profile?.email,
    profile?.email?.toLowerCase()
  ])
}

function getAssignmentValues(item) {
  return [
    ...(Array.isArray(item?.assignTo) ? item.assignTo : []),
    ...(Array.isArray(item?.assignedTo) ? item.assignedTo : []),
    ...(Array.isArray(item?.studentIds) ? item.studentIds : []),
    ...(Array.isArray(item?.assignedStudentIds) ? item.assignedStudentIds : []),
    ...(Array.isArray(item?.assignedEmails) ? item.assignedEmails : [])
  ]
}

function isAssignedToCurrentUser(item, user, profile) {
  const assignedValues = getAssignmentValues(item).map(normalizeId).filter(Boolean)
  const currentUserValues = getCurrentUserAssignmentValues(user, profile)
    .map(normalizeId)
    .filter(Boolean)

  if (assignedValues.length === 0) return false

  return currentUserValues.some(value => assignedValues.includes(value))
}

function isHiddenForCurrentUser(item, user, profile) {
  if (!Array.isArray(item?.hiddenFor)) return false

  const hiddenValues = item.hiddenFor.map(normalizeId).filter(Boolean)
  const currentUserValues = getCurrentUserAssignmentValues(user, profile)
    .map(normalizeId)
    .filter(Boolean)

  return currentUserValues.some(value => hiddenValues.includes(value))
}

function getSavedMockState(storageKey) {
  try {
    const saved = localStorage.getItem(storageKey)
    return saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
}

export default function DoMockTest() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [mock, setMock] = useState(null)
  const [listenings, setListenings] = useState([])
  const [readings, setReadings] = useState([])
  const [writing, setWriting] = useState(null)
  const [loading, setLoading] = useState(true)
  const [alreadySubmitted, setAlreadySubmitted] = useState(false)

  const [sectionIndex, setSectionIndex] = useState(0)
  const [maxUnlockedSectionIndex, setMaxUnlockedSectionIndex] = useState(0)
  const [listeningAnswers, setListeningAnswers] = useState({})
  const [readingAnswers, setReadingAnswers] = useState({})
  const [writingAnswers, setWritingAnswers] = useState({
    task1: '',
    task2: ''
  })

  const [listeningTimeLeft, setListeningTimeLeft] = useState(LISTENING_DURATION)
  const [readingTimeLeft, setReadingTimeLeft] = useState(READING_DURATION)
  const [writingTimeLeft, setWritingTimeLeft] = useState(WRITING_DURATION)

  const [listeningStarted, setListeningStarted] = useState(false)
  const [readingStarted, setReadingStarted] = useState(false)
  const [writingStarted, setWritingStarted] = useState(false)

  const [listeningLocked, setListeningLocked] = useState(false)
  const [readingLocked, setReadingLocked] = useState(false)
  const [writingLocked, setWritingLocked] = useState(false)

  const [finalResult, setFinalResult] = useState(null)
  const [completedSubmission, setCompletedSubmission] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const submittingRef = useRef(false)
  const handleSubmitMockRef = useRef(null)
  const restoredRef = useRef(false)
  const loadingRef = useRef(true)
  const audioRef = useRef(null)
  const audioLastTimeRef = useRef(0)
  const audioSeekLockRef = useRef(false)
  const listeningTickRef = useRef(null)
  const readingTickRef = useRef(null)
  const writingTickRef = useRef(null)
  const tabSwitchCountRef = useRef(0)
  const pendingListeningAutoPlayRef = useRef(false)
  const readingPassageScrollRef = useRef(null)
  const readingQuestionsScrollRef = useRef(null)

  const [audioStarted, setAudioStarted] = useState(false)
  const [audioLocked, setAudioLocked] = useState(false)
  const [audioWarning, setAudioWarning] = useState('')
  const [audioCurrentTime, setAudioCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [tabWarning, setTabWarning] = useState('')

  const storageKey = useMemo(() => {
    return user?.uid && id ? `mock_progress_${id}_${user.uid}` : null
  }, [id, user?.uid])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  useEffect(() => {
    let isActive = true

    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        if (!isActive) return

        const profileSnap = await getDoc(doc(db, 'users', currentUser.uid))

        if (!isActive) return

        if (!profileSnap.exists()) {
          await signOut(auth)
          navigate('/login')
          return
        }

        const profile = profileSnap.data()

        if (
          profile.deleted === true ||
          profile.status !== 'approved' ||
          profile.role !== 'student'
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        setUser(currentUser)

        const mockSnap = await getDoc(doc(db, 'mockTests', id))

        if (!isActive) return

        if (!mockSnap.exists()) {
          alert('Mock test not found.')
          navigate('/student')
          return
        }

        const mockData = {
          id: mockSnap.id,
          ...mockSnap.data()
        }

        if (!isAssignedToCurrentUser(mockData, currentUser, profile)) {
          alert('This mock test is not assigned to you.')
          navigate('/student')
          return
        }

        if (isHiddenForCurrentUser(mockData, currentUser, profile) || mockData.archived === true) {
          alert('This mock test is no longer available.')
          navigate('/student')
          return
        }

        setMock(mockData)
        setListeningTimeLeft(
          getMockSectionSeconds(mockData, 'listening')
        )
        setReadingTimeLeft(
          getMockSectionSeconds(mockData, 'reading')
        )
        setWritingTimeLeft(
          getMockSectionSeconds(mockData, 'writing')
        )

        const existingQuery = query(
          collection(db, 'mockSubmissions'),
          where('uid', '==', currentUser.uid),
          where('mockTestId', '==', id),
          orderBy('submittedAt', 'desc'),
          limit(1)
        )

        const existingSnap = await getDocs(existingQuery)

        if (!isActive) return

        if (!existingSnap.empty) {
          setAlreadySubmitted(true)

          const submission = {
            id: existingSnap.docs[0].id,
            ...existingSnap.docs[0].data()
          }

          setCompletedSubmission(submission)
          setFinalResult(submission.result || null)
          setListeningAnswers(submission.listeningAnswers || {})
          setReadingAnswers(submission.readingAnswers || {})
          setWritingAnswers(
            submission.writingAnswers || {
              task1: '',
              task2: ''
            }
          )

          const key = `mock_progress_${id}_${currentUser.uid}`
          localStorage.removeItem(key)
        }

        const enabledSections = getMockEnabledSections(mockData)

        if (!Object.values(enabledSections).some(Boolean)) {
          throw new Error('Mini Mock does not include any enabled section.')
        }

        setListeningLocked(!enabledSections.listening)
        setReadingLocked(!enabledSections.reading)
        setWritingLocked(!enabledSections.writing)
        setAudioLocked(!enabledSections.listening)

        const readingIds = enabledSections.reading
          ? Array.isArray(mockData.readingIds)
            ? mockData.readingIds.filter(Boolean)
            : mockData.readingId
              ? [mockData.readingId]
              : []
          : []

        const listeningIds = enabledSections.listening
          ? Array.isArray(mockData.listeningIds)
            ? mockData.listeningIds.filter(Boolean)
            : mockData.listeningId
              ? [mockData.listeningId]
              : []
          : []

        if (enabledSections.listening && listeningIds.length === 0) {
          throw new Error('Mock test is missing a Listening resource.')
        }

        if (enabledSections.reading && readingIds.length === 0) {
          throw new Error('Mock test is missing a Reading resource.')
        }

        if (enabledSections.writing && !mockData.writingId) {
          throw new Error('Mock test is missing a Writing resource.')
        }

        const [listeningDocs, readingDocs, writingSnap] = await Promise.all([
          enabledSections.listening
            ? Promise.all(
                listeningIds.map(listeningId =>
                  getDoc(doc(db, 'listenings', listeningId))
                )
              )
            : Promise.resolve([]),
          enabledSections.reading
            ? Promise.all(
                readingIds.map(readingId =>
                  getDoc(doc(db, 'readings', readingId))
                )
              )
            : Promise.resolve([]),
          enabledSections.writing
            ? getDoc(doc(db, 'writingHomeworks', mockData.writingId))
            : Promise.resolve(null)
        ])

        if (!isActive) return

        const loadedListenings = listeningDocs
          .filter(snap => snap.exists())
          .map(snap => ({ id: snap.id, ...snap.data() }))

        if (
          enabledSections.listening &&
          loadedListenings.length !== listeningIds.length
        ) {
          throw new Error(
            'One or more Listening tests linked to this mock could not be loaded.'
          )
        }

        const loadedReadings = readingDocs
          .filter(snap => snap.exists())
          .map(snap => ({ id: snap.id, ...snap.data() }))

        if (
          enabledSections.reading &&
          loadedReadings.length !== readingIds.length
        ) {
          throw new Error(
            'One or more Reading passages linked to this mock could not be loaded.'
          )
        }

        if (
          enabledSections.writing &&
          (!writingSnap || !writingSnap.exists())
        ) {
          throw new Error('Writing test was not found.')
        }

        setListenings(loadedListenings)
        setReadings(loadedReadings)
        setWriting(
          writingSnap && writingSnap.exists()
            ? { id: writingSnap.id, ...writingSnap.data() }
            : null
        )

        setLoading(false)
      } catch (error) {
        console.error(error)
        if (isActive) {
          alert(error?.message || 'Could not load mock test.')
          navigate('/student')
        }
      }
    })

    return () => {
      isActive = false
      unsub()
    }
  }, [id, navigate])

  useEffect(() => {
    if (!storageKey || restoredRef.current || loading) return
    if (alreadySubmitted || finalResult) return

    const saved = getSavedMockState(storageKey)

    if (!saved) {
      restoredRef.current = true
      return
    }

    const restoredSectionIndex = saved.sectionIndex ?? 0
    setSectionIndex(restoredSectionIndex)
    setMaxUnlockedSectionIndex(saved.maxUnlockedSectionIndex ?? restoredSectionIndex)
    setListeningAnswers(saved.listeningAnswers || {})
    setReadingAnswers(saved.readingAnswers || {})
    setWritingAnswers(saved.writingAnswers || { task1: '', task2: '' })

    const restoredListeningStarted = Boolean(saved.listeningStarted)
    const restoredReadingStarted = Boolean(saved.readingStarted)
    const restoredWritingStarted = Boolean(saved.writingStarted)

    const savedAt = new Date(saved.updatedAt || 0).getTime()
    const elapsedSinceSave = Number.isFinite(savedAt) && savedAt > 0
      ? Math.max(0, Math.floor((Date.now() - savedAt) / 1000))
      : 0

    const enabledSections = getMockEnabledSections(mock)

    const savedListeningLocked =
      !enabledSections.listening ||
      Boolean(saved.listeningLocked) ||
      restoredReadingStarted ||
      restoredWritingStarted

    const savedReadingLocked =
      !enabledSections.reading ||
      Boolean(saved.readingLocked) ||
      restoredWritingStarted

    const savedWritingLocked =
      !enabledSections.writing ||
      Boolean(saved.writingLocked)

    const restoredListeningTime =
      restoredListeningStarted && !savedListeningLocked
        ? Math.max(
            (saved.listeningTimeLeft ?? getMockSectionSeconds(mock, 'listening')) -
              elapsedSinceSave,
            0
          )
        : saved.listeningTimeLeft ?? getMockSectionSeconds(mock, 'listening')

    const restoredReadingTime =
      restoredReadingStarted && !savedReadingLocked
        ? Math.max(
            (saved.readingTimeLeft ?? getMockSectionSeconds(mock, 'reading')) -
              elapsedSinceSave,
            0
          )
        : saved.readingTimeLeft ?? getMockSectionSeconds(mock, 'reading')

    const restoredWritingTime =
      restoredWritingStarted && !savedWritingLocked
        ? Math.max(
            (saved.writingTimeLeft ?? getMockSectionSeconds(mock, 'writing')) -
              elapsedSinceSave,
            0
          )
        : saved.writingTimeLeft ?? getMockSectionSeconds(mock, 'writing')

    setListeningTimeLeft(restoredListeningTime)
    setReadingTimeLeft(restoredReadingTime)
    setWritingTimeLeft(restoredWritingTime)

    setListeningStarted(
      enabledSections.listening && restoredListeningStarted
    )
    setReadingStarted(
      enabledSections.reading && restoredReadingStarted
    )
    setWritingStarted(
      enabledSections.writing && restoredWritingStarted
    )

    setListeningLocked(savedListeningLocked || restoredListeningTime <= 0)
    setReadingLocked(savedReadingLocked || restoredReadingTime <= 0)
    setWritingLocked(savedWritingLocked || restoredWritingTime <= 0)

    setAudioStarted(Boolean(saved.audioStarted))
    setAudioLocked(
      Boolean(saved.audioLocked) ||
      savedListeningLocked ||
      restoredListeningTime <= 0
    )

    tabSwitchCountRef.current = Number(saved.tabSwitchCount) || 0

    restoredRef.current = true
  }, [storageKey, loading, alreadySubmitted, finalResult, mock])

  useEffect(() => {
    if (!storageKey || loading || alreadySubmitted || finalResult) return

    const timeout = setTimeout(() => {
      const data = {
        sectionIndex,
        maxUnlockedSectionIndex,
        listeningAnswers,
        readingAnswers,
        writingAnswers,
        listeningTimeLeft,
        readingTimeLeft,
        writingTimeLeft,
        listeningStarted,
        readingStarted,
        writingStarted,
        listeningLocked,
        readingLocked,
        writingLocked,
        audioStarted,
        audioLocked,
        tabSwitchCount: tabSwitchCountRef.current,
        updatedAt: new Date().toISOString()
      }

      localStorage.setItem(storageKey, JSON.stringify(data))
    }, 300)

    return () => clearTimeout(timeout)
  }, [
    storageKey,
    loading,
    alreadySubmitted,
    finalResult,
    sectionIndex,
    maxUnlockedSectionIndex,
    listeningAnswers,
    readingAnswers,
    writingAnswers,
    listeningTimeLeft,
    readingTimeLeft,
    writingTimeLeft,
    listeningStarted,
    readingStarted,
    writingStarted,
    listeningLocked,
    readingLocked,
    writingLocked,
    audioStarted,
    audioLocked
  ])

  useEffect(() => {
    if (alreadySubmitted || finalResult) return

    const handleBeforeUnload = event => {
      if (loadingRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [alreadySubmitted, finalResult])

  const listeningParts = useMemo(() => {
    return listenings.flatMap((listeningItem, listeningIndex) => {
      const normalizedParts = normalizeListeningParts(listeningItem)

      return normalizedParts.map((part, partIndex) => {
        const sourcePartId = part.id || `part-${partIndex + 1}`

        return {
          ...part,
          id: `${listeningItem.id}_${sourcePartId}`,
          originalPartId: part.id,
          listeningId: listeningItem.id,
          listeningTitle: listeningItem.title || `Listening ${listeningIndex + 1}`,
          listeningAudioUrl: listeningItem.audioUrl || '',
          listeningInstructions: listeningItem.instructions || '',
          questions: (part.questions || []).map((question, questionIndex) => ({
            ...question,
            originalQuestionId: question.id || '',
            id: `${listeningItem.id}__${sourcePartId}__${question.id || questionIndex}`
          })),
          displayTitle:
            listenings.length > 1
              ? `L${listeningIndex + 1}`
              : part.title || `Part ${partIndex + 1}`
        }
      })
    })
  }, [listenings])

  const enabledSections = useMemo(
    () => getMockEnabledSections(mock),
    [mock]
  )

  const writingMode = useMemo(
    () => getMockWritingMode(mock, writing),
    [mock, writing]
  )

  const hasWritingTask1 =
    enabledSections.writing && writingMode !== 'task2_only'
  const hasWritingTask2 =
    enabledSections.writing && writingMode !== 'task1_only'
  const mockTypeLabel = getMockTypeLabel(mock)
  const isMiniMock = getMockType(mock) === 'mini_mock'
  const mockFlowLabel = getMockFlowLabel(mock, writingMode)

  const sections = useMemo(() => {
    const flow = [{ key: 'intro', label: 'Start' }]

    if (enabledSections.listening) {
      flow.push(
        ...listeningParts.map((part, index) => ({
          key: `listening-${index}`,
          label: `L${index + 1}`,
          listeningPart: part,
          listeningPartIndex: index
        }))
      )
    }

    if (enabledSections.reading) {
      if (enabledSections.listening) {
        flow.push({
          key: 'prepare-reading',
          label: 'Prepare Reading',
          transitionFrom: 'listening'
        })
      }

      flow.push(
        ...readings.map((reading, index) => ({
          key: `reading-${index}`,
          label: `Reading ${index + 1}`,
          reading,
          readingIndex: index
        }))
      )
    }

    if (enabledSections.writing) {
      if (enabledSections.reading || enabledSections.listening) {
        flow.push({
          key: 'prepare-writing',
          label: 'Prepare Writing',
          transitionFrom: enabledSections.reading
            ? 'reading'
            : 'listening'
        })
      }

      if (hasWritingTask1) {
        flow.push({
          key: 'writing-task1',
          label: 'Writing T1'
        })
      }

      if (hasWritingTask2) {
        flow.push({
          key: 'writing-task2',
          label: 'Writing T2'
        })
      }
    }

    flow.push({ key: 'review', label: 'Review' })

    return flow
  }, [
    readings,
    listeningParts,
    enabledSections,
    hasWritingTask1,
    hasWritingTask2
  ])

  const activeSection = sections[sectionIndex] || sections[0]

  const hasAnswerValue = value => {
    if (Array.isArray(value)) {
      return value.filter(Boolean).length > 0
    }

    if (value && typeof value === 'object') {
      return Object.values(value).some(item => hasAnswerValue(item))
    }

    return (
      value !== undefined &&
      value !== null &&
      value.toString().trim() !== ''
    )
  }

  const getListeningPartProgress = part => {
    let answered = 0
    let total = 0

    ;(part?.questions || []).forEach(question => {
      if (question.type === 'table' || question.type === 'note') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type !== 'blank') return

            total++

            if (
              hasAnswerValue(
                listeningAnswers[
                  tableAnswerKey(question.id, row.id, cellIndex)
                ]
              )
            ) {
              answered++
            }
          })
        })

        return
      }

      if (question.type === 'listeningCompletion') {
        question.sections?.forEach(section => {
          section.parts?.forEach(item => {
            if (item.type !== 'blank') return

            total++

            if (
              hasAnswerValue(
                listeningAnswers[
                  listeningCompletionAnswerKey(
                    question.id,
                    section.id,
                    item.id
                  )
                ]
              )
            ) {
              answered++
            }
          })
        })

        return
      }

      if (question.type === 'map') {
        question.mapItems?.forEach(item => {
          total++

          if (
            hasAnswerValue(
              listeningAnswers[mapAnswerKey(question.id, item.id)]
            )
          ) {
            answered++
          }
        })

        return
      }

      if (question.type === 'matching') {
        question.matchingItems?.forEach(item => {
          total++

          if (
            hasAnswerValue(
              listeningAnswers[
                matchingAnswerKey(question.id, item.id)
              ]
            )
          ) {
            answered++
          }
        })

        return
      }

      if (question.type === 'mcq' && question.mode === 'multi') {
        const required = question.answers?.length || 2
        const selected = Array.isArray(listeningAnswers[question.id])
          ? listeningAnswers[question.id].filter(Boolean)
          : []

        total += required
        answered += Math.min(selected.length, required)
        return
      }

      total++

      if (hasAnswerValue(listeningAnswers[question.id])) {
        answered++
      }
    })

    return {
      answered,
      total,
      complete: total > 0 && answered >= total
    }
  }

  const getReadingProgress = reading => {
    let answered = 0
    let total = 0
    const answerSet = readingAnswers[reading?.id] || {}

    ;(reading?.questions || []).forEach(question => {
      if (question.type === 'matching') {
        question.paragraphs?.forEach(paragraph => {
          total++

          if (
            hasAnswerValue(
              answerSet[question.id]?.[paragraph.letter]
            )
          ) {
            answered++
          }
        })

        return
      }

      if (
        question.type === 'matchingInformation' ||
        question.type === 'sentenceEndings' ||
        question.type === 'summaryOptions'
      ) {
        question.items?.forEach(item => {
          total++

          if (hasAnswerValue(answerSet[question.id]?.[item.id])) {
            answered++
          }
        })

        return
      }

      if (question.type === 'noteCompletion') {
        question.paragraphs?.forEach(paragraph => {
          paragraph.parts?.forEach(part => {
            if (part.type !== 'blank') return

            total++

            if (
              hasAnswerValue(
                answerSet[
                  noteAnswerKey(
                    question.id,
                    paragraph.id,
                    part.id
                  )
                ]
              )
            ) {
              answered++
            }
          })
        })

        return
      }

      if (
        question.type === 'table' ||
        question.type === 'summary' ||
        question.type === 'note'
      ) {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type !== 'blank') return

            total++

            if (
              hasAnswerValue(
                answerSet[
                  tableAnswerKey(question.id, row.id, cellIndex)
                ]
              )
            ) {
              answered++
            }
          })
        })

        return
      }

      if (question.type === 'mcq' && question.mode === 'multi') {
        const required = question.answers?.length || 2
        const selected = Array.isArray(answerSet[question.id])
          ? answerSet[question.id].filter(Boolean)
          : []

        total += required
        answered += Math.min(selected.length, required)
        return
      }

      total++

      if (hasAnswerValue(answerSet[question.id])) {
        answered++
      }
    })

    return {
      answered,
      total,
      complete: total > 0 && answered >= total
    }
  }

  const getListeningOverallProgress = () =>
    listeningParts.reduce(
      (summary, part) => {
        const progress = getListeningPartProgress(part)

        return {
          answered: summary.answered + progress.answered,
          total: summary.total + progress.total
        }
      },
      { answered: 0, total: 0 }
    )

  const getReadingOverallProgress = () =>
    readings.reduce(
      (summary, reading) => {
        const progress = getReadingProgress(reading)

        return {
          answered: summary.answered + progress.answered,
          total: summary.total + progress.total
        }
      },
      { answered: 0, total: 0 }
    )

  const getActiveSectionProgress = () => {
    if (activeSection.key?.startsWith('listening-')) {
      return getListeningPartProgress(activeSection.listeningPart)
    }

    if (activeSection.key?.startsWith('reading-')) {
      return getReadingProgress(activeSection.reading)
    }

    return null
  }


  useEffect(() => {
    const timeout = setTimeout(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })

      if (readingPassageScrollRef.current) {
        readingPassageScrollRef.current.scrollTop = 0
      }

      if (readingQuestionsScrollRef.current) {
        readingQuestionsScrollRef.current.scrollTop = 0
      }
    }, 0)

    return () => clearTimeout(timeout)
  }, [sectionIndex])

  useEffect(() => {
    if (!activeSection.key?.startsWith('listening-')) return

    setAudioStarted(false)
    setAudioLocked(false)
    setAudioWarning('')
    setAudioCurrentTime(0)
    setAudioDuration(0)
    audioLastTimeRef.current = 0
    audioSeekLockRef.current = false

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
  }, [activeSection.key])

  useEffect(() => {
    if (!activeSection.key?.startsWith('listening-')) return
    if (!pendingListeningAutoPlayRef.current) return

    const timeout = setTimeout(() => {
      if (!audioRef.current || listeningLocked || audioLocked) {
        pendingListeningAutoPlayRef.current = false
        return
      }

      audioRef.current.play()
        .then(() => {
          setAudioStarted(true)
          setAudioWarning('')
        })
        .catch(() => {
          setAudioWarning('Your browser blocked automatic audio playback. Please click Play to start the listening audio.')
        })
        .finally(() => {
          pendingListeningAutoPlayRef.current = false
        })
    }, 250)

    return () => clearTimeout(timeout)
  }, [activeSection.key, listeningLocked, audioLocked])

  useEffect(() => {
    if (!listeningStarted || listeningLocked) return

    if (listeningTimeLeft <= 0) {
      setListeningLocked(true)
      setAudioLocked(true)
      return
    }

    listeningTickRef.current = Date.now()

    const interval = setInterval(() => {
      setListeningTimeLeft(prev => {
        const now = Date.now()
        const elapsed = Math.max(
          1,
          Math.floor((now - (listeningTickRef.current || now)) / 1000)
        )

        listeningTickRef.current = now

        const next = Math.max(prev - elapsed, 0)

        if (next <= 0) {
          setListeningLocked(true)
          setAudioLocked(true)
          return 0
        }

        return next
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [listeningStarted, listeningLocked, listeningTimeLeft])

  useEffect(() => {
    if (!readingStarted || readingLocked) return

    if (readingTimeLeft <= 0) {
      setReadingLocked(true)
      return
    }

    readingTickRef.current = Date.now()

    const interval = setInterval(() => {
      setReadingTimeLeft(prev => {
        const now = Date.now()
        const elapsed = Math.max(
          1,
          Math.floor((now - (readingTickRef.current || now)) / 1000)
        )

        readingTickRef.current = now

        const next = Math.max(prev - elapsed, 0)

        if (next <= 0) {
          setReadingLocked(true)
          return 0
        }

        return next
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [readingStarted, readingLocked, readingTimeLeft])

  useEffect(() => {
    if (!writingStarted || writingLocked) return

    if (writingTimeLeft <= 0) {
      setWritingLocked(true)
      return
    }

    writingTickRef.current = Date.now()

    const interval = setInterval(() => {
      setWritingTimeLeft(prev => {
        const now = Date.now()
        const elapsed = Math.max(
          1,
          Math.floor((now - (writingTickRef.current || now)) / 1000)
        )

        writingTickRef.current = now

        const next = Math.max(prev - elapsed, 0)

        if (next <= 0) {
          setWritingLocked(true)
          return 0
        }

        return next
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [writingStarted, writingLocked, writingTimeLeft])

  useEffect(() => {
    if (
      !listeningStarted ||
      listeningTimeLeft > 0 ||
      !activeSection.key?.startsWith('listening-')
    ) {
      return
    }

    const nextSectionIndex = sections.findIndex(
      (section, index) =>
        index > sectionIndex &&
        !section.key.startsWith('listening-')
    )

    if (nextSectionIndex < 0) return

    setListeningLocked(true)
    setAudioLocked(true)

    if (audioRef.current) {
      audioRef.current.pause()
    }

    setSectionIndex(nextSectionIndex)
    setMaxUnlockedSectionIndex(previous =>
      Math.max(previous, nextSectionIndex)
    )
  }, [
    listeningStarted,
    listeningTimeLeft,
    activeSection.key,
    sections,
    sectionIndex
  ])

  useEffect(() => {
    if (
      !readingStarted ||
      readingTimeLeft > 0 ||
      !activeSection.key?.startsWith('reading-')
    ) {
      return
    }

    const nextSectionIndex = sections.findIndex(
      (section, index) =>
        index > sectionIndex &&
        !section.key.startsWith('reading-')
    )

    if (nextSectionIndex < 0) return

    setReadingLocked(true)
    setSectionIndex(nextSectionIndex)
    setMaxUnlockedSectionIndex(previous =>
      Math.max(previous, nextSectionIndex)
    )
  }, [
    readingStarted,
    readingTimeLeft,
    activeSection.key,
    sections,
    sectionIndex
  ])

  useEffect(() => {
    if (activeSection.key?.startsWith('listening-') && !listeningStarted && !listeningLocked) {
      setListeningStarted(true)
    }

    if (activeSection.key?.startsWith('reading-') && !readingStarted && !readingLocked) {
      setReadingStarted(true)
    }

    if (
      (activeSection.key === 'writing-task1' || activeSection.key === 'writing-task2') &&
      !writingStarted &&
      !writingLocked
    ) {
      setWritingStarted(true)
    }
  }, [
    activeSection.key,
    listeningStarted,
    readingStarted,
    writingStarted,
    listeningLocked,
    readingLocked,
    writingLocked,
    enabledSections
  ])

  const handleListeningAnswer = (questionId, value) => {
    if (listeningLocked) return

    setListeningAnswers(prev => ({
      ...prev,
      [questionId]: value
    }))
  }

  const handleListeningMultiAnswer = (questionId, letter) => {
    if (listeningLocked) return

    setListeningAnswers(prev => {
      const current = Array.isArray(prev[questionId]) ? prev[questionId] : []
      const updated = current.includes(letter)
        ? current.filter(item => item !== letter)
        : current.length < 2
          ? [...current, letter]
          : current

      return {
        ...prev,
        [questionId]: updated
      }
    })
  }

  const handleListeningTableAnswer = (questionId, rowId, cellIndex, value) => {
    if (listeningLocked) return

    setListeningAnswers(prev => ({
      ...prev,
      [tableAnswerKey(questionId, rowId, cellIndex)]: value
    }))
  }

  const handleListeningCompletionAnswer = (questionId, sectionId, itemId, value) => {
    if (listeningLocked) return

    setListeningAnswers(prev => ({
      ...prev,
      [listeningCompletionAnswerKey(questionId, sectionId, itemId)]: value
    }))
  }

  const handleListeningMapAnswer = (questionId, itemId, value) => {
    if (listeningLocked) return

    setListeningAnswers(prev => ({
      ...prev,
      [mapAnswerKey(questionId, itemId)]: value
    }))
  }

  const handleListeningMatchingAnswer = (questionId, itemId, value) => {
    if (listeningLocked) return

    setListeningAnswers(prev => ({
      ...prev,
      [matchingAnswerKey(questionId, itemId)]: value
    }))
  }

  const handleReadingAnswer = (readingId, questionId, value) => {
    if (readingLocked) return

    setReadingAnswers(prev => ({
      ...prev,
      [readingId]: {
        ...(prev[readingId] || {}),
        [questionId]: value
      }
    }))
  }

  const handleReadingMultiAnswer = (readingId, questionId, letter) => {
    if (readingLocked) return

    setReadingAnswers(prev => {
      const readingSet = prev[readingId] || {}
      const current = Array.isArray(readingSet[questionId]) ? readingSet[questionId] : []
      const updated = current.includes(letter)
        ? current.filter(item => item !== letter)
        : current.length < 2
          ? [...current, letter]
          : current

      return {
        ...prev,
        [readingId]: {
          ...readingSet,
          [questionId]: updated
        }
      }
    })
  }

  const handleReadingMatching = (readingId, questionId, paragraphLetter, value) => {
    if (readingLocked) return

    setReadingAnswers(prev => {
      const readingSet = prev[readingId] || {}
      const currentQuestion = readingSet[questionId] || {}

      return {
        ...prev,
        [readingId]: {
          ...readingSet,
          [questionId]: {
            ...currentQuestion,
            [paragraphLetter]: value
          }
        }
      }
    })
  }

  const handleReadingMatchingInformation = (readingId, questionId, itemId, value) => {
    if (readingLocked) return

    setReadingAnswers(prev => {
      const readingSet = prev[readingId] || {}
      const currentQuestion = readingSet[questionId] || {}

      return {
        ...prev,
        [readingId]: {
          ...readingSet,
          [questionId]: {
            ...currentQuestion,
            [itemId]: value
          }
        }
      }
    })
  }

  const handleReadingSentenceEnding = (readingId, questionId, itemId, value) => {
    if (readingLocked) return

    setReadingAnswers(prev => {
      const readingSet = prev[readingId] || {}
      const currentQuestion = readingSet[questionId] || {}

      return {
        ...prev,
        [readingId]: {
          ...readingSet,
          [questionId]: {
            ...currentQuestion,
            [itemId]: value
          }
        }
      }
    })
  }

  const handleReadingSummaryOption = (readingId, questionId, itemId, value) => {
    if (readingLocked) return

    setReadingAnswers(prev => {
      const readingSet = prev[readingId] || {}
      const currentQuestion = readingSet[questionId] || {}

      return {
        ...prev,
        [readingId]: {
          ...readingSet,
          [questionId]: {
            ...currentQuestion,
            [itemId]: value
          }
        }
      }
    })
  }

  const handleReadingTableAnswer = (readingId, questionId, rowId, cellIndex, value) => {
    if (readingLocked) return

    const key = tableAnswerKey(questionId, rowId, cellIndex)

    setReadingAnswers(prev => ({
      ...prev,
      [readingId]: {
        ...(prev[readingId] || {}),
        [key]: value
      }
    }))
  }

  const handleReadingNoteCompletion = (readingId, questionId, paragraphId, partId, value) => {
    if (readingLocked) return

    const key = noteAnswerKey(questionId, paragraphId, partId)

    setReadingAnswers(prev => ({
      ...prev,
      [readingId]: {
        ...(prev[readingId] || {}),
        [key]: value
      }
    }))
  }

  const isReadingNotePartCorrect = (readingId, question, paragraph, part) => {
    const key = noteAnswerKey(question.id, paragraph.id, part.id)
    const userAnswer = readingAnswers[readingId]?.[key]

    if (question.mode === 'choose') {
      return userAnswer?.toString() === part.answer?.toString()
    }

    return isBlankCorrect(
      userAnswer,
      part.answer,
      part.acceptedAnswers
    )
  }

  const getReadingNoteOptionText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.options?.[index] || `Option ${letter}`
  }

  const isReadingHeadingUsed = (readingId, question, headingValue) => {
    if (!headingValue) return false

    return Object.values(readingAnswers[readingId]?.[question.id] || {}).some(
      selected => selected?.toString() === headingValue?.toString()
    )
  }

  const isReadingHeadingUsedByOtherParagraph = (
    readingId,
    question,
    currentParagraphLetter,
    headingValue
  ) => {
    if (!headingValue) return false

    return Object.entries(readingAnswers[readingId]?.[question.id] || {}).some(
      ([paragraphLetter, selected]) =>
        paragraphLetter !== currentParagraphLetter &&
        selected?.toString() === headingValue?.toString()
    )
  }

  const getReadingHeadingOptionLabel = (
    readingId,
    question,
    currentParagraphLetter,
    headingValue,
    heading
  ) => {
    const usedByOther = isReadingHeadingUsedByOtherParagraph(
      readingId,
      question,
      currentParagraphLetter,
      headingValue
    )

    return usedByOther
      ? `${headingValue}. ${heading} — Used`
      : `${headingValue}. ${heading}`
  }

  const isReadingNormalCorrect = (readingId, question) => {
    const value = readingAnswers[readingId]?.[question.id]

    if (question.type === 'mcq' && question.mode === 'multi') {
      return sortAnswers(value).join('|') === sortAnswers(question.answers || []).join('|')
    }

    return normalize(value) === normalize(question.answer)
  }

  const isReadingSentenceEndingCorrect = (readingId, question, item) => {
    const value = readingAnswers[readingId]?.[question.id]?.[item.id]

    return value?.toString() === item.answer?.toString()
  }

  const isReadingSummaryOptionCorrect = (readingId, question, item) => {
    const value = readingAnswers[readingId]?.[question.id]?.[item.id]

    return value?.toString() === item.answer?.toString()
  }

  const isReadingMatchingInformationCorrect = (readingId, question, item) => {
    const value = readingAnswers[readingId]?.[question.id]?.[item.id]

    return value?.toString() === item.answer?.toString()
  }

  const getReadingMultiAnswerScore = (readingId, question) => {
    const selected = Array.isArray(readingAnswers[readingId]?.[question.id])
      ? readingAnswers[readingId][question.id].map(item => item?.toString())
      : []

    const correctAnswers = Array.isArray(question.answers)
      ? question.answers.map(item => item?.toString())
      : []

    const correctCount = selected.filter(answer =>
      correctAnswers.includes(answer)
    ).length

    return {
      correct: correctCount,
      total: correctAnswers.length || 2
    }
  }

  const getListeningMultiAnswerScore = question => {
    const selected = Array.isArray(listeningAnswers[question.id])
      ? listeningAnswers[question.id].map(item => item?.toString())
      : []

    const correctAnswers = Array.isArray(question.answers)
      ? question.answers.map(item => item?.toString())
      : []

    const correctCount = selected.filter(answer =>
      correctAnswers.includes(answer)
    ).length

    return {
      correct: correctCount,
      total: correctAnswers.length || 2
    }
  }

  const isListeningCompletionPartCorrect = (question, section, item) => {
    const key = listeningCompletionAnswerKey(question.id, section.id, item.id)
    const userAnswer = listeningAnswers[key]

    if (question.completionMode === 'choose') {
      return userAnswer?.toString().trim() === item.answer?.toString().trim()
    }

    return isBlankCorrect(
      userAnswer,
      item.answer,
      item.acceptedAnswers,
      item.maxWords
    )
  }

  const getListeningCompletionOptionText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.options?.[index] || `Option ${letter}`
  }

  const isListeningMatchingItemCorrect = (question, item) => {
    const key = matchingAnswerKey(question.id, item.id)
    const userAnswer = listeningAnswers[key]

    return normalize(userAnswer) === normalize(item.answer)
  }

  const getListeningMatchingOptionText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.options?.[index] || `Option ${letter}`
  }

  const isListeningNormalCorrect = question => {
    const value = listeningAnswers[question.id]

    if (question.type === 'mcq' && question.mode === 'multi') {
      return sortAnswers(value).join('|') === sortAnswers(question.answers || []).join('|')
    }

    return normalize(value) === normalize(question.answer)
  }

  const scoreListening = () => {
    if (!listenings.length) {
      return { correct: 0, total: 0, band: 0 }
    }

    let correct = 0
    let total = 0

    listeningParts.forEach(part => {
      part.questions?.forEach(question => {
      if (question.type === 'table' || question.type === 'note') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type === 'blank') {
              total++
              const userAnswer = listeningAnswers[tableAnswerKey(question.id, row.id, cellIndex)]

              if (
                isBlankCorrect(
                  userAnswer,
                  cell.answer,
                  cell.acceptedAnswers,
                  cell.maxWords
                )
              ) {
                correct++
              }
            }
          })
        })

        return
      }

      if (question.type === 'listeningCompletion') {
        question.sections?.forEach(section => {
          section.parts?.forEach(item => {
            if (item.type !== 'blank') return

            total++

            if (isListeningCompletionPartCorrect(question, section, item)) {
              correct++
            }
          })
        })

        return
      }

      if (question.type === 'map') {
        question.mapItems?.forEach(item => {
          total++
          const userAnswer = listeningAnswers[mapAnswerKey(question.id, item.id)]

          if (normalize(userAnswer) === normalize(item.answer)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'matching') {
        question.matchingItems?.forEach(item => {
          total++

          if (isListeningMatchingItemCorrect(question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'mcq' && question.mode === 'multi') {
        const score = getListeningMultiAnswerScore(question)

        correct += score.correct
        total += score.total

        return
      }

      total++

      if (isListeningNormalCorrect(question)) {
        correct++
      }
      })
    })

    return {
      correct,
      total,
      band: getListeningBand(correct, total)
    }
  }

  const scoreReading = reading => {
    if (!reading || !Array.isArray(reading.questions)) {
      return { correct: 0, total: 0, band: 0 }
    }

    let correct = 0
    let total = 0

    reading.questions.forEach(question => {
      if (question.type === 'matching') {
        question.paragraphs?.forEach(paragraph => {
          total++
          const userAnswer = readingAnswers[reading.id]?.[question.id]?.[paragraph.letter]

          if (userAnswer?.toString() === paragraph.answer?.toString()) {
            correct++
          }
        })

        return
      }

      if (question.type === 'matchingInformation') {
        question.items?.forEach(item => {
          total++

          if (isReadingMatchingInformationCorrect(reading.id, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'sentenceEndings') {
        question.items?.forEach(item => {
          total++

          if (isReadingSentenceEndingCorrect(reading.id, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'summaryOptions') {
        question.items?.forEach(item => {
          total++

          if (isReadingSummaryOptionCorrect(reading.id, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'noteCompletion') {
        question.paragraphs?.forEach(paragraph => {
          paragraph.parts?.forEach(part => {
            if (part.type !== 'blank') return

            total++

            if (isReadingNotePartCorrect(reading.id, question, paragraph, part)) {
              correct++
            }
          })
        })

        return
      }

      if (question.type === 'mcq' && question.mode === 'multi') {
        const score = getReadingMultiAnswerScore(reading.id, question)

        correct += score.correct
        total += score.total

        return
      }

      if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type === 'blank') {
              total++
              const userAnswer =
                readingAnswers[reading.id]?.[tableAnswerKey(question.id, row.id, cellIndex)]

              if (
                isBlankCorrect(
                  userAnswer,
                  cell.answer,
                  cell.acceptedAnswers,
                  cell.maxWords
                )
              ) {
                correct++
              }
            }
          })
        })

        return
      }

      total++

      if (isReadingNormalCorrect(reading.id, question)) {
        correct++
      }
    })

    return {
      correct,
      total,
      band: getReadingBand(correct, total)
    }
  }

  const getMockResult = () => {
    const listeningResult = enabledSections.listening
      ? scoreListening()
      : {
          enabled: false,
          correct: 0,
          total: 0,
          band: null
        }

    const readingResults = enabledSections.reading
      ? readings.map(reading => ({
          readingId: reading.id,
          title: reading.title,
          ...scoreReading(reading)
        }))
      : []

    const totalReadingCorrect = readingResults.reduce(
      (sum, item) => sum + item.correct,
      0
    )

    const totalReadingQuestions = readingResults.reduce(
      (sum, item) => sum + item.total,
      0
    )

    const readingBand = enabledSections.reading
      ? getReadingBand(
          totalReadingCorrect,
          totalReadingQuestions
        )
      : null

    const availableBands = [
      enabledSections.listening ? listeningResult.band : null,
      enabledSections.reading ? readingBand : null
    ].filter(
      value =>
        value !== null &&
        value !== undefined &&
        value !== '' &&
        Number.isFinite(Number(value))
    )

    const overallEstimate = availableBands.length
      ? Math.round(
          (availableBands.reduce((sum, band) => sum + Number(band), 0) /
            availableBands.length) *
            2
        ) / 2
      : null

    return {
      enabledSections: { ...enabledSections },
      listening: {
        ...listeningResult,
        enabled: enabledSections.listening
      },
      reading: {
        enabled: enabledSections.reading,
        correct: totalReadingCorrect,
        total: totalReadingQuestions,
        band: readingBand,
        passages: readingResults
      },
      writing: {
        enabled: enabledSections.writing,
        status: enabledSections.writing
          ? 'pending_review'
          : 'not_included',
        writingMode,
        task1Enabled: hasWritingTask1,
        task2Enabled: hasWritingTask2,
        task1WordCount: hasWritingTask1
          ? countWords(writingAnswers.task1)
          : 0,
        task2WordCount: hasWritingTask2
          ? countWords(writingAnswers.task2)
          : 0
      },
      overallEstimate
    }
  }

  const handleStartAudio = () => {
    if (!audioRef.current || listeningLocked || audioLocked || audioStarted) {
      return
    }

    audioRef.current.play().catch(() => {
      setAudioWarning(
        'Your browser blocked audio playback. Please click Start Audio again.'
      )
    })
  }

  const handleAudioPlay = () => {
    if (listeningLocked || audioLocked) {
      audioRef.current?.pause()
      return
    }

    setAudioStarted(true)
    setAudioWarning('')
  }

  const handleAudioPause = () => {
    if (!audioStarted || listeningLocked || audioLocked) return

    setAudioWarning('Audio cannot be paused during the listening section.')

    setTimeout(() => {
      if (!audioRef.current || listeningLocked || audioLocked) return
      audioRef.current.play().catch(() => {})
    }, 100)
  }

  const handleAudioSeeking = () => {
    if (!audioRef.current || audioSeekLockRef.current) return

    const currentTime = audioRef.current.currentTime
    const allowedTime = audioLastTimeRef.current
    const difference = currentTime - allowedTime

    if (Math.abs(difference) <= 0.35) return

    audioSeekLockRef.current = true
    audioRef.current.currentTime = allowedTime

    setAudioWarning(
      difference > 0
        ? 'Fast-forwarding is disabled during the listening section.'
        : 'Rewinding is disabled during the listening section.'
    )

    window.setTimeout(() => {
      audioSeekLockRef.current = false
    }, 120)
  }

  const handleAudioTimeUpdate = () => {
    if (!audioRef.current || audioRef.current.seeking || audioSeekLockRef.current) {
      return
    }

    const currentTime = audioRef.current.currentTime

    if (currentTime >= audioLastTimeRef.current) {
      audioLastTimeRef.current = currentTime
      setAudioCurrentTime(currentTime)
    }
  }

  const handleAudioLoadedMetadata = () => {
    if (!audioRef.current) return

    const duration = Number(audioRef.current.duration)

    setAudioDuration(Number.isFinite(duration) ? duration : 0)
    setAudioCurrentTime(audioRef.current.currentTime || 0)
  }

  const handleAudioEnded = () => {
    if (audioDuration > 0) {
      setAudioCurrentTime(audioDuration)
    }

    setAudioLocked(true)
    setAudioWarning('Listening audio finished. You cannot replay it.')
  }

  const handleSubmitMock = useCallback(async ({ auto = false } = {}) => {
    if (submittingRef.current) return

    if (alreadySubmitted) {
      if (!auto) alert('You already submitted this mock test.')
      return
    }

    if (!user || !mock) return

    if (!auto) {
      const shortWritingChecks = [
        hasWritingTask1
          ? {
              label: 'Task 1',
              words: countWords(writingAnswers.task1),
              minimum: 50
            }
          : null,
        hasWritingTask2
          ? {
              label: 'Task 2',
              words: countWords(writingAnswers.task2),
              minimum: 100
            }
          : null
      ]
        .filter(Boolean)
        .filter(item => item.words < item.minimum)

      if (shortWritingChecks.length > 0) {
        const warningLines = shortWritingChecks
          .map(item => `${item.label}: ${item.words} words`)
          .join('\n')

        const continueAnyway = window.confirm(
          `Your writing answer looks very short.\n\n${warningLines}\n\nSubmit anyway?`
        )

        if (!continueAnyway) return
      }

      const ok = window.confirm(
        `Submit this ${mockTypeLabel}? You cannot edit it after submission.`
      )

      if (!ok) return
    }

    submittingRef.current = true
    setSubmitting(true)

    try {
      const existingQuery = query(
        collection(db, 'mockSubmissions'),
        where('uid', '==', user.uid),
        where('mockTestId', '==', mock.id),
        orderBy('submittedAt', 'desc'),
        limit(1)
      )

      const existingSnap = await getDocs(existingQuery)

      if (!existingSnap.empty) {
        setAlreadySubmitted(true)

        const existingSubmission = {
          id: existingSnap.docs[0].id,
          ...existingSnap.docs[0].data()
        }

        setCompletedSubmission(existingSubmission)
        setFinalResult(existingSubmission.result || null)
        setListeningAnswers(existingSubmission.listeningAnswers || {})
        setReadingAnswers(existingSubmission.readingAnswers || {})
        setWritingAnswers(
          existingSubmission.writingAnswers || {
            task1: '',
            task2: ''
          }
        )

        if (storageKey) {
          localStorage.removeItem(storageKey)
        }

        if (!auto) {
          alert('You already submitted this mock test.')
        }

        return
      }

      const result = getMockResult()
      const submittedAt = new Date().toISOString()
      const listeningIds = Array.isArray(mock.listeningIds)
        ? mock.listeningIds.filter(Boolean)
        : mock.listeningId
          ? [mock.listeningId]
          : []

      const readingIds = Array.isArray(mock.readingIds)
        ? mock.readingIds.filter(Boolean)
        : mock.readingId
          ? [mock.readingId]
          : []

      const submissionTeacherIds = getSourceTeacherIds(mock)

      await addDoc(collection(db, 'mockSubmissions'), {
        uid: user.uid,
        studentId: user.uid,
        studentEmail: user.email || '',
        schoolId: mock.schoolId || 'maxima',
        teacherId: submissionTeacherIds[0] || '',
        teacherIds: submissionTeacherIds,
        mockTestId: mock.id,
        title: mock.title || 'Untitled Mock Test',
        mockType: getMockType(mock),
        contentType: getMockType(mock),
        enabledSections: { ...enabledSections },
        writingMode,
        task1Enabled: hasWritingTask1,
        task2Enabled: hasWritingTask2,
        sectionTimeLimits: {
          listening: getMockSectionMinutes(mock, 'listening'),
          reading: getMockSectionMinutes(mock, 'reading'),
          writing: getMockSectionMinutes(mock, 'writing')
        },
        listeningId: listeningIds[0] || '',
        listeningIds,
        readingIds,
        writingId: mock.writingId || '',
        listeningAnswers: listeningAnswers || {},
        readingAnswers: readingAnswers || {},
        writingAnswers: {
          task1: writingAnswers?.task1 || '',
          task2: writingAnswers?.task2 || ''
        },
        result,
        autoSubmitted: auto,
        tabSwitchCount: tabSwitchCountRef.current,
        timing: {
          listeningTimeLeft,
          readingTimeLeft,
          writingTimeLeft,
          listeningLocked,
          readingLocked,
          writingLocked
        },
        submittedAt,
        status: 'submitted'
      })

      try {
        await addDoc(collection(db, 'scores'), {
          uid: user.uid,
          studentId: user.uid,
          studentEmail: user.email || '',
          schoolId: mock.schoolId || 'maxima',
          teacherId: submissionTeacherIds[0] || '',
          teacherIds: submissionTeacherIds,
          date: submittedAt.slice(0, 10),
          source: 'mock_test',
          mockTestId: mock.id,
          listening: enabledSections.listening
            ? result.listening?.band || ''
            : '',
          reading: enabledSections.reading
            ? result.reading?.band || ''
            : '',
          writing: '',
          speaking: '',
          overall: result.overallEstimate ?? '',
          createdAt: submittedAt
        })
      } catch (scoreError) {
        console.warn('Mock test was submitted, but score history could not be created.', scoreError)
      }

      if (storageKey) {
        localStorage.removeItem(storageKey)
      }

      setCompletedSubmission({
        mockTestId: mock.id,
        listeningAnswers: listeningAnswers || {},
        readingAnswers: readingAnswers || {},
        writingAnswers: {
          task1: writingAnswers?.task1 || '',
          task2: writingAnswers?.task2 || ''
        },
        result
      })
      setFinalResult(result)
      setAlreadySubmitted(true)
      setSectionIndex(sections.length - 1)
    } catch (error) {
      console.error('Could not submit mock test.', error)
      alert(error?.message || 'Could not submit mock test.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [
    alreadySubmitted,
    user,
    mock,
    writingAnswers,
    storageKey,
    listeningAnswers,
    readingAnswers,
    readings,
    listenings,
    listeningParts,
    sections.length,
    listeningTimeLeft,
    readingTimeLeft,
    writingTimeLeft,
    listeningLocked,
    readingLocked,
    writingLocked,
    writingMode,
    hasWritingTask1,
    hasWritingTask2,
    enabledSections,
    mockTypeLabel
  ])

  useEffect(() => {
    handleSubmitMockRef.current = handleSubmitMock
  }, [handleSubmitMock])

  useEffect(() => {
    const handleVisibility = () => {
      if (loadingRef.current || alreadySubmitted || finalResult) return

      if (document.hidden) {
        tabSwitchCountRef.current += 1
        return
      }

      if (tabSwitchCountRef.current === 1) {
        setTabWarning('Warning: Do not leave the mock test tab. If you leave again, the test will be submitted automatically.')
        alert('Warning: Do not leave the mock test tab. If you leave again, the test will be submitted automatically.')
      }

      if (tabSwitchCountRef.current >= 2) {
        setTabWarning('You left the mock test tab more than once. Your test is being submitted automatically.')
        alert('You left the mock test tab more than once. Your test will be submitted automatically.')
        handleSubmitMockRef.current?.({ auto: true })
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [alreadySubmitted, finalResult])

  useEffect(() => {
    if (loading || alreadySubmitted || finalResult) return
    if (!listeningStarted && !readingStarted && !writingStarted) return

    const allEnabledSectionsLocked =
      (!enabledSections.listening || listeningLocked) &&
      (!enabledSections.reading || readingLocked) &&
      (!enabledSections.writing || writingLocked)

    if (allEnabledSectionsLocked) {
      handleSubmitMockRef.current?.({ auto: true })
    }
  }, [
    loading,
    alreadySubmitted,
    finalResult,
    listeningStarted,
    readingStarted,
    writingStarted,
    listeningLocked,
    readingLocked,
    writingLocked,
    enabledSections
  ])

  const handleExitMock = () => {
    if (alreadySubmitted || finalResult) {
      navigate('/student')
      return
    }

    const confirmed = window.confirm(
      'Exit the mock test?\n\nYour current answers are saved on this device, but the active section timer will continue while you are away.'
    )

    if (!confirmed) return

    navigate('/student')
  }

  const isSectionAccessible = index => {
    if (index > maxUnlockedSectionIndex) return false

    const targetSection = sections[index]
    const key = targetSection?.key

    if (!key) return false

    if (key === 'prepare-reading' || key === 'prepare-writing') {
      return index === sectionIndex
    }

    if (key.startsWith('listening-') && listeningLocked) {
      return index === sectionIndex
    }

    if (key.startsWith('reading-') && readingLocked) {
      return index === sectionIndex
    }

    if ((key === 'writing-task1' || key === 'writing-task2') && writingLocked) {
      return index === sectionIndex
    }

    return true
  }

  const lockListeningSection = () => {
    setListeningLocked(true)
    setAudioLocked(true)
    setAudioWarning('Listening section is locked. You cannot return to Listening after starting Reading.')

    if (audioRef.current) {
      audioRef.current.pause()
    }
  }

  const lockReadingSection = () => {
    setReadingLocked(true)
  }

  const goToSection = nextIndex => {
    const safeIndex = Math.max(0, Math.min(nextIndex, sections.length - 1))
    const targetSection = sections[safeIndex]

    if (targetSection?.key?.startsWith('listening-')) {
      pendingListeningAutoPlayRef.current = true
    }

    setSectionIndex(safeIndex)
    setMaxUnlockedSectionIndex(prev => Math.max(prev, safeIndex))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const nextSection = () => {
    if (
      activeSection.key === 'prepare-reading' ||
      activeSection.key === 'prepare-writing'
    ) {
      const targetLabel =
        activeSection.key === 'prepare-reading'
          ? 'Reading'
          : 'Writing'
      const previousLabel =
        activeSection.transitionFrom === 'reading'
          ? 'Reading'
          : 'Listening'
      const confirmed = window.confirm(
        `Start ${targetLabel} now?

${previousLabel} will be permanently locked and you will not be able to return to it.`
      )

      if (!confirmed) return

      if (activeSection.transitionFrom === 'reading') {
        lockReadingSection()
      } else {
        lockListeningSection()
      }

      goToSection(sectionIndex + 1)
      return
    }

    const progress = getActiveSectionProgress()

    if (
      progress &&
      !progress.complete &&
      !(
        activeSection.key?.startsWith('listening-')
          ? listeningLocked
          : readingLocked
      )
    ) {
      const confirmed = window.confirm(
        `This section has ${Math.max(
          progress.total - progress.answered,
          0
        )} unanswered question(s). Continue anyway?`
      )

      if (!confirmed) return
    }

    if (activeSection.key === 'writing-task1') {
      const task1Words = countWords(writingAnswers.task1)

      if (task1Words < 150) {
        const confirmed = window.confirm(
          `Task 1 currently has ${task1Words} words. The recommended minimum is 150 words. ${
            hasWritingTask2
              ? 'Continue to Task 2?'
              : 'Continue to Review?'
          }`
        )

        if (!confirmed) return
      }
    }

    if (activeSection.key === 'writing-task2') {
      const task2Words = countWords(writingAnswers.task2)

      if (task2Words < 250) {
        const confirmed = window.confirm(
          `Task 2 currently has ${task2Words} words. The recommended minimum is 250 words. Continue to Review?`
        )

        if (!confirmed) return
      }
    }

    goToSection(sectionIndex + 1)
  }

  const prevSection = () => {
    setSectionIndex(prev => {
      let target = Math.max(prev - 1, 0)

      while (target > 0 && !isSectionAccessible(target)) {
        target = Math.max(target - 1, 0)
      }

      return isSectionAccessible(target) ? target : prev
    })

    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleSectionTabClick = index => {
    if (!isSectionAccessible(index)) return

    const targetSection = sections[index]

    if (targetSection?.key?.startsWith('listening-')) {
      pendingListeningAutoPlayRef.current = true
    }

    setSectionIndex(index)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const getActiveTimerInfo = () => {
    if (activeSection.key?.startsWith('listening-')) {
      return {
        label: 'Listening',
        time: listeningTimeLeft,
        locked: listeningLocked,
        started: listeningStarted
      }
    }

    if (activeSection.key?.startsWith('reading-')) {
      return {
        label: 'Reading',
        time: readingTimeLeft,
        locked: readingLocked,
        started: readingStarted
      }
    }

    if (activeSection.key === 'writing-task1' || activeSection.key === 'writing-task2') {
      return {
        label: 'Writing',
        time: writingTimeLeft,
        locked: writingLocked,
        started: writingStarted
      }
    }

    return null
  }

  const timerInfo = getActiveTimerInfo()

  const renderSectionTimerCard = () => {
    if (!timerInfo) return null

    return (
      <div
        className={`border rounded-2xl p-5 mb-6 ${
          timerInfo.locked
            ? 'bg-red-50 border-red-100'
            : timerInfo.time < 300
              ? 'bg-amber-50 border-amber-100'
              : 'bg-purple-50 border-purple-100'
        }`}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
              Active Section Timer
            </p>

            <p
              className={`text-lg font-bold ${
                timerInfo.locked
                  ? 'text-red-600'
                  : timerInfo.time < 300
                    ? 'text-amber-600'
                    : 'text-purple-700'
              }`}
            >
              {timerInfo.label}
            </p>
          </div>

          <div
            className={`font-mono text-4xl font-bold ${
              timerInfo.locked
                ? 'text-red-600'
                : timerInfo.time < 300
                  ? 'text-amber-600'
                  : 'text-purple-700'
            }`}
          >
            {timerInfo.locked ? 'TIME UP' : formatTime(timerInfo.time)}
          </div>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          When the timer reaches zero, this section is locked and answers are saved as they are.
        </p>
      </div>
    )
  }

  const renderListeningCompletion = (question, partId) => (
    <div>
      {question.instruction && (
        <p className="text-sm text-gray-700 mb-4">
          {question.instruction}
        </p>
      )}

      <div className="bg-white border border-gray-100 rounded-xl p-5">
        {question.completionTitle && (
          <p className="font-semibold text-gray-900 text-center mb-5">
            {question.completionTitle}
          </p>
        )}

        <div className="space-y-4">
          {question.sections?.map(section => (
            <div key={section.id}>
              {section.heading && (
                <p className="text-sm font-bold text-gray-900 mb-1">
                  {section.heading}
                </p>
              )}

              <div className="text-sm md:text-[15px] text-gray-800 leading-8">
                {section.parts?.map((item, itemIndex) => {
                  if (item.type === 'text') {
                    return (
                      <span key={itemIndex} className="whitespace-pre-wrap">
                        {item.content}
                      </span>
                    )
                  }

                  const key = listeningCompletionAnswerKey(
                    question.id,
                    section.id,
                    item.id
                  )

                  const questionNumber = getListeningCompletionQuestionNumber(
                    listeningParts,
                    partId,
                    question.id,
                    section.id,
                    item.id
                  )

                  if (question.completionMode === 'choose') {
                    return (
                      <span key={item.id} className="inline-flex items-center gap-2 mx-1">
                        <span className="text-xs font-semibold text-gray-400">
                          Q{questionNumber}
                        </span>

                        <select
                          value={listeningAnswers[key] || ''}
                          onChange={e =>
                            handleListeningCompletionAnswer(
                              question.id,
                              section.id,
                              item.id,
                              e.target.value
                            )
                          }
                          className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-purple-400 bg-white"
                        >
                          <option value="">Choose</option>

                          {question.options?.map((option, optionIndex) => {
                            if (!option?.trim()) return null

                            const letter = letters[optionIndex]

                            return (
                              <option key={letter} value={letter}>
                                {letter}. {option}
                              </option>
                            )
                          })}
                        </select>
                      </span>
                    )
                  }

                  return (
                    <span key={item.id} className="inline-flex items-center gap-2 mx-1">
                      <span className="text-xs font-semibold text-gray-400">
                        Q{questionNumber}
                      </span>

                      <input
                        value={listeningAnswers[key] || ''}
                        onChange={e =>
                          handleListeningCompletionAnswer(
                            question.id,
                            section.id,
                            item.id,
                            e.target.value
                          )
                        }
                        placeholder="answer"
                        className="inline-block w-[150px] border border-gray-200 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-purple-400 bg-white"
                      />
                    </span>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {question.completionMode === 'choose' && (
        <div className="bg-white border border-gray-100 rounded-xl p-4 mt-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Options
          </p>

          <div className="space-y-2">
            {question.options?.filter(Boolean).map((option, optionIndex) => (
              <div
                key={optionIndex}
                className="flex gap-2 text-sm text-gray-700 leading-5"
              >
                <span className="font-semibold text-gray-500 min-w-6">
                  {letters[optionIndex]}.
                </span>

                <span>{option}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  const renderListeningMatching = (question, partId) => {
    const optionList = (question.options || []).filter(Boolean)

    return (
      <div>
        {question.instruction && (
          <p className="text-sm text-gray-700 mb-4 whitespace-pre-wrap">
            {question.instruction}
          </p>
        )}

        {question.matchingTitle && (
          <p className="font-semibold text-gray-900 mb-4">
            {question.matchingTitle}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-4 md:items-start">
          <div className="space-y-3">
            {(question.matchingItems || []).map(item => {
              const key = matchingAnswerKey(question.id, item.id)
              const questionNumber = getListeningMatchingQuestionNumber(
                listeningParts,
                partId,
                question.id,
                item.id
              )

              return (
                <div
                  key={item.id}
                  className="grid grid-cols-1 sm:grid-cols-[64px_minmax(0,1fr)_140px] gap-3 items-center bg-gray-50 border border-gray-100 rounded-xl p-4"
                >
                  <span className="text-sm font-bold text-purple-600">
                    Q{questionNumber}
                  </span>

                  <label className="text-sm font-medium text-gray-800">
                    {item.prompt}
                  </label>

                  <select
                    value={listeningAnswers[key] || ''}
                    onChange={e => handleListeningMatchingAnswer(question.id, item.id, e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                  >
                    <option value="">Select letter</option>

                    {(question.options || []).map((option, optionIndex) => {
                      if (!option?.trim()) return null

                      const letter = letters[optionIndex]

                      return (
                        <option key={letter} value={letter}>
                          {letter}
                        </option>
                      )
                    })}
                  </select>
                </div>
              )
            })}
          </div>

          <div className="bg-white border border-purple-100 rounded-xl p-4 md:sticky md:top-[210px] shadow-sm max-h-[calc(100vh-240px)] overflow-y-auto">
            <p className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-3">
              Options A-{letters[Math.max(optionList.length - 1, 0)] || ''}
            </p>

            <div className="grid grid-cols-1 gap-2">
              {optionList.map((option, optionIndex) => (
                <div
                  key={optionIndex}
                  className="flex gap-2 text-sm text-gray-700 leading-5 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2"
                >
                  <span className="font-bold text-purple-600 min-w-6">
                    {letters[optionIndex]}.
                  </span>

                  <span>{option}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderListening = part => (
    <div className="space-y-6">
      {renderSectionTimerCard()}

      {(() => {
        const progress = getListeningPartProgress(part)

        return (
          <div className="bg-white border border-purple-100 rounded-2xl p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">
                Listening progress
              </p>

              <p className="text-sm font-semibold text-gray-800 mt-1">
                {progress.answered} of {progress.total} answered
              </p>
            </div>

            <span className={`text-xs px-3 py-1.5 rounded-full ${
              progress.complete
                ? 'bg-green-50 text-green-600'
                : 'bg-amber-50 text-amber-600'
            }`}>
              {progress.complete
                ? 'Complete'
                : `${Math.max(progress.total - progress.answered, 0)} remaining`}
            </span>
          </div>
        )
      })()}

      {listeningLocked && (
        <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 text-sm font-medium">
          ⏰ Listening time is up. Your answers are saved. Move to the next section.
        </div>
      )}

      <div className="bg-white border border-gray-100 rounded-2xl p-6 sticky top-[120px] z-10">
        <h2 className="text-xl font-bold text-gray-900 mb-1">
          {part?.listeningTitle || 'Listening'}
        </h2>

        <p className="text-sm font-semibold text-purple-600 mb-2">
          {part?.title || 'Listening Part'} {part?.instructions ? `· ${part.instructions}` : ''}
        </p>

        {part?.listeningInstructions && (
          <p className="text-sm text-gray-500 mb-4 whitespace-pre-wrap">
            {part.listeningInstructions}
          </p>
        )}

        {audioWarning && (
          <div className="bg-amber-50 border border-amber-100 text-amber-700 rounded-xl p-3 mb-4 text-xs font-medium">
            {audioWarning}
          </div>
        )}

        <div className="border border-purple-100 bg-purple-50/60 rounded-2xl p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
            <div>
              <p className="text-sm font-semibold text-gray-800">
                Listening Audio
              </p>

              <p className="text-xs text-gray-500 mt-1">
                The recording plays once. Pausing, rewinding and fast-forwarding are disabled.
              </p>
            </div>

            <button
              type="button"
              onClick={handleStartAudio}
              disabled={
                audioStarted ||
                listeningLocked ||
                audioLocked ||
                !part?.listeningAudioUrl
              }
              className="bg-purple-600 text-white rounded-xl px-5 py-2.5 text-sm font-semibold hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {audioLocked
                ? 'Audio Finished'
                : audioStarted
                  ? 'Audio Playing'
                  : 'Start Audio'}
            </button>
          </div>

          <div className="h-2 bg-white rounded-full overflow-hidden border border-purple-100">
            <div
              className="h-full bg-purple-600 transition-[width] duration-300"
              style={{
                width: `${
                  audioDuration > 0
                    ? Math.min(
                        100,
                        Math.max(0, (audioCurrentTime / audioDuration) * 100)
                      )
                    : 0
                }%`
              }}
            />
          </div>

          <div className="flex justify-between mt-2 text-xs font-mono text-purple-700">
            <span>{formatTime(Math.floor(audioCurrentTime || 0))}</span>
            <span>
              {audioDuration > 0
                ? formatTime(Math.floor(audioDuration))
                : '--:--'}
            </span>
          </div>
        </div>

        <audio
          ref={audioRef}
          preload="metadata"
          src={part?.listeningAudioUrl}
          className="hidden"
          onLoadedMetadata={handleAudioLoadedMetadata}
          onPlay={handleAudioPlay}
          onPause={handleAudioPause}
          onSeeking={handleAudioSeeking}
          onTimeUpdate={handleAudioTimeUpdate}
          onEnded={handleAudioEnded}
        />
      </div>

      <fieldset disabled={listeningLocked} className={listeningLocked ? 'opacity-60' : ''}>
        {(part?.questions || []).map((question, index) => (
          <div
            key={question.id}
            className="bg-white border border-gray-100 rounded-2xl p-6 mb-6"
          >
            <p className="text-xs text-purple-600 font-semibold mb-2">
              Listening {getListeningQuestionRangeLabel(listeningParts, part?.id, index)}
            </p>

            {question.type === 'mcq' && (
              <div>
                <p className="text-sm text-gray-800 mb-3">
                  {question.question}
                </p>

                {question.mode === 'multi' && (
                  <p className="text-xs text-amber-600 bg-amber-50 rounded-xl p-3 mb-3">
                    Choose TWO answers.
                  </p>
                )}

                <div className="flex flex-col gap-2">
                  {question.options?.map((option, optionIndex) => {
                    const letter = letters[optionIndex]
                    const selectedMulti = Array.isArray(listeningAnswers[question.id])
                      ? listeningAnswers[question.id]
                      : []

                    const selected =
                      question.mode === 'multi'
                        ? selectedMulti.includes(letter)
                        : listeningAnswers[question.id] === letter

                    return (
                      <button
                        key={optionIndex}
                        type="button"
                        onClick={() =>
                          question.mode === 'multi'
                            ? handleListeningMultiAnswer(question.id, letter)
                            : handleListeningAnswer(question.id, letter)
                        }
                        className={`text-left px-4 py-3 rounded-xl text-sm border ${
                          selected
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'border-gray-200 text-gray-700'
                        }`}
                      >
                        <span className="font-semibold mr-2">{letter}.</span>
                        {option}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {question.type === 'tfng' && (
              <div>
                <p className="text-sm text-gray-800 mb-3">
                  {question.question}
                </p>

                <div className="flex gap-2">
                  {['True', 'False', 'Not Given'].map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => handleListeningAnswer(question.id, option)}
                      className={`flex-1 py-2 rounded-xl text-xs font-medium border ${
                        listeningAnswers[question.id] === option
                          ? 'bg-purple-600 text-white border-purple-600'
                          : 'border-gray-200 text-gray-500'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {question.type === 'fitb' && (
              <div>
                <p className="text-sm text-gray-800 mb-3">
                  {question.question}
                </p>

                <input
                  value={listeningAnswers[question.id] || ''}
                  onChange={e => handleListeningAnswer(question.id, e.target.value)}
                  placeholder="Type your answer..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"
                />
              </div>
            )}

            {question.type === 'listeningCompletion' &&
              renderListeningCompletion(question, part?.id)}

            {(question.type === 'table' || question.type === 'note') && (
              <div>
                <p className="text-sm text-gray-700 mb-4">
                  {question.instruction}
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                    <thead>
                      <tr className="bg-gray-100">
                        {question.columns?.map((column, columnIndex) => (
                          <th
                            key={columnIndex}
                            className="p-3 text-left font-semibold text-gray-700 border border-white"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody>
                      {question.rows?.map(row => (
                        <tr key={row.id}>
                          {row.cells?.map((cell, cellIndex) => {
                            if (cell.type !== 'blank') {
                              return (
                                <td
                                  key={cellIndex}
                                  className="p-3 bg-gray-50 border border-white text-gray-700 whitespace-pre-wrap"
                                >
                                  {cell.text}
                                </td>
                              )
                            }

                            const key = tableAnswerKey(question.id, row.id, cellIndex)

                            return (
                              <td
                                key={cellIndex}
                                className="p-3 bg-gray-50 border border-white align-top"
                              >
                                {(cell.beforeText || cell.afterText) ? (
                                  <div className="text-sm text-gray-700 leading-8">
                                    <span className="inline-block bg-purple-50 border border-purple-100 text-purple-600 font-semibold rounded-md px-2 py-0.5 mr-1">
                                      Q{getListeningBlankQuestionNumber(listeningParts, part?.id, question.id, row.id, cellIndex)}
                                    </span>

                                    {cell.beforeText && (
                                      <span className="whitespace-pre-wrap">
                                        {cell.beforeText}{' '}
                                      </span>
                                    )}

                                    <input
                                      value={listeningAnswers[key] || ''}
                                      onChange={e =>
                                        handleListeningTableAnswer(
                                          question.id,
                                          row.id,
                                          cellIndex,
                                          e.target.value
                                        )
                                      }
                                      placeholder="answer"
                                      className="inline-block min-w-[120px] max-w-[220px] border border-gray-200 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-purple-400 bg-white mx-1"
                                    />

                                    {cell.afterText && (
                                      <span className="whitespace-pre-wrap">
                                        {' '}{cell.afterText}
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <span className="bg-purple-50 border border-purple-100 text-purple-600 font-semibold rounded-md px-2 py-1 text-xs">
                                      Q{getListeningBlankQuestionNumber(listeningParts, part?.id, question.id, row.id, cellIndex)}
                                    </span>

                                    <input
                                      value={listeningAnswers[key] || ''}
                                    onChange={e =>
                                      handleListeningTableAnswer(
                                        question.id,
                                        row.id,
                                        cellIndex,
                                        e.target.value
                                      )
                                    }
                                    placeholder="Type answer..."
                                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                    />
                                  </div>
                                )}

                                {cell.maxWords && (
                                  <p className="text-[10px] text-gray-400 mt-1">
                                    Max {cell.maxWords} word{Number(cell.maxWords) > 1 ? 's' : ''}
                                  </p>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {question.type === 'matching' &&
              renderListeningMatching(question, part?.id)}

            {question.type === 'map' && (
              <div>
                <p className="text-sm text-gray-700 mb-4">
                  {question.instruction}
                </p>

                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] gap-5 lg:items-start">
                  <div className="space-y-4 lg:sticky lg:top-[210px]">
                    {question.mapImage && (
                      <div className="bg-white border border-gray-100 rounded-2xl p-4">
                        <img
                          src={question.mapImage}
                          alt="Map"
                          className="w-full max-h-[520px] object-contain rounded-xl bg-gray-50"
                        />
                      </div>
                    )}

                    <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                      <p className="text-xs font-semibold text-gray-400 mb-3">
                        Map letters
                      </p>

                      <div className="grid grid-cols-2 gap-2">
                        {question.mapLocations?.map(location => (
                          <p key={location.id} className="text-xs text-gray-600">
                            <span className="font-bold">{location.label}</span>{' '}
                            {location.text}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="bg-white border border-gray-100 rounded-2xl p-4">
                    <p className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-3">
                      Questions
                    </p>

                    <div className="flex flex-col gap-3">
                      {question.mapItems?.map(item => (
                        <div
                          key={item.id}
                          className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_140px] gap-3 items-center bg-gray-50 border border-gray-100 rounded-xl p-4"
                        >
                          <p className="text-sm text-gray-800">
                            <span className="font-bold text-purple-600 mr-2">
                              Q{getListeningMapQuestionNumber(listeningParts, part?.id, question.id, item.id)}
                            </span>
                            {item.prompt}
                          </p>

                          <select
                            value={listeningAnswers[mapAnswerKey(question.id, item.id)] || ''}
                            onChange={e =>
                              handleListeningMapAnswer(
                                question.id,
                                item.id,
                                e.target.value
                              )
                            }
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                          >
                            <option value="">Choose</option>

                            {question.mapLocations?.map(location => (
                              <option key={location.id} value={location.label}>
                                {location.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </fieldset>
    </div>
  )

  const renderReadingNoteCompletion = (reading, question) => (
    <div>
      {question.instruction && (
        <p className="text-sm text-gray-700 mb-4">
          {question.instruction}
        </p>
      )}

      <div className="bg-white border border-gray-100 rounded-xl p-5">
        {question.title && (
          <p className="font-semibold text-gray-900 text-center mb-5">
            {question.title}
          </p>
        )}

        <div className="space-y-4">
          {question.paragraphs?.map(paragraph => (
            <div key={paragraph.id}>
              {paragraph.heading && (
                <p className="text-sm font-bold text-gray-900 mb-1">
                  {paragraph.heading}
                </p>
              )}

              <div className="text-sm md:text-[15px] text-gray-800 leading-8">
                {paragraph.parts?.map((part, partIndex) => {
                  if (part.type === 'text') {
                    return (
                      <span key={partIndex} className="whitespace-pre-wrap">
                        {part.content}
                      </span>
                    )
                  }

                  const key = noteAnswerKey(question.id, paragraph.id, part.id)
                  const questionNumber = getReadingNoteBlankQuestionNumber(
                    reading,
                    question.id,
                    paragraph.id,
                    part.id
                  )

                  if (question.mode === 'choose') {
                    return (
                      <span key={part.id} className="inline-flex items-center gap-2 mx-1">
                        <span className="text-xs font-semibold text-gray-400">
                          ({questionNumber})
                        </span>

                        <select
                          value={readingAnswers[reading.id]?.[key] || ''}
                          onChange={e =>
                            handleReadingNoteCompletion(
                              reading.id,
                              question.id,
                              paragraph.id,
                              part.id,
                              e.target.value
                            )
                          }
                          className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-purple-400 bg-white"
                        >
                          <option value="">Choose</option>

                          {question.options?.map((option, optionIndex) => {
                            if (!option?.trim()) return null

                            const letter = letters[optionIndex]

                            return (
                              <option key={letter} value={letter}>
                                {letter}. {option}
                              </option>
                            )
                          })}
                        </select>
                      </span>
                    )
                  }

                  return (
                    <span key={part.id} className="inline-flex items-center gap-2 mx-1">
                      <span className="text-xs font-semibold text-gray-400">
                        ({questionNumber})
                      </span>

                      <input
                        value={readingAnswers[reading.id]?.[key] || ''}
                        onChange={e =>
                          handleReadingNoteCompletion(
                            reading.id,
                            question.id,
                            paragraph.id,
                            part.id,
                            e.target.value
                          )
                        }
                        placeholder="answer"
                        className="inline-block w-[150px] border border-gray-200 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-purple-400 bg-white"
                      />
                    </span>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {question.mode === 'choose' && (
        <div className="bg-white border border-gray-100 rounded-xl p-4 mt-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Options
          </p>

          <div className="space-y-2">
            {question.options?.filter(Boolean).map((option, optionIndex) => (
              <div
                key={optionIndex}
                className="flex gap-2 text-sm text-gray-700 leading-5"
              >
                <span className="font-semibold text-gray-500 min-w-6">
                  {letters[optionIndex]}.
                </span>

                <span>{option}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  const renderReading = reading => (
    <div className="space-y-6">
      {renderSectionTimerCard()}

      {(() => {
        const progress = getReadingProgress(reading)

        return (
          <div className="bg-white border border-blue-100 rounded-2xl p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">
                Reading passage progress
              </p>

              <p className="text-sm font-semibold text-gray-800 mt-1">
                {progress.answered} of {progress.total} answered
              </p>
            </div>

            <span className={`text-xs px-3 py-1.5 rounded-full ${
              progress.complete
                ? 'bg-green-50 text-green-600'
                : 'bg-amber-50 text-amber-600'
            }`}>
              {progress.complete
                ? 'Complete'
                : `${Math.max(progress.total - progress.answered, 0)} remaining`}
            </span>
          </div>
        )
      })()}

      {readingLocked && (
        <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 text-sm font-medium">
          ⏰ Reading time is up. Your answers are saved. Move to the next section.
        </div>
      )}

      <fieldset disabled={readingLocked} className={readingLocked ? 'opacity-60' : ''}>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6 min-w-0">
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-0 h-[72vh] lg:sticky lg:top-[150px] lg:h-[calc(100vh-11rem)]">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-100 bg-white shrink-0 z-10">
              <div className="min-w-0">
                <h2 className="font-semibold text-gray-900 truncate">
                  {reading.title}
                </h2>

                <p className="text-xs text-gray-400 mt-1">
                  Reading Passage
                </p>
              </div>

              <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1 rounded-full flex-shrink-0">
                Scroll passage
              </span>
            </div>

            <div
              ref={readingPassageScrollRef}
              className="p-5 md:p-7 pb-24 md:pb-28 flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-pb-24"
            >
              {reading.passageMode === 'sections' ? (
                <div className="space-y-8">
                  {reading.paragraphs?.map(paragraph => (
                    <div key={paragraph.id}>
                      <h3 className="font-semibold text-gray-900 mb-2">
                        Paragraph {paragraph.letter}
                      </h3>

                      <p className="text-sm md:text-[15px] text-gray-700 leading-8 whitespace-pre-wrap">
                        {paragraph.text}
                      </p>
                    </div>
                  ))}

                  <div className="pt-5 border-t border-gray-100 text-center text-xs font-medium text-gray-400">
                    End of passage
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-sm md:text-[15px] text-gray-700 leading-8 whitespace-pre-wrap">
                    {reading.passage}
                  </div>

                  <div className="mt-8 pt-5 border-t border-gray-100 text-center text-xs font-medium text-gray-400">
                    End of passage
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-0 h-[72vh] lg:h-[calc(100vh-11rem)]">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-100 bg-white shrink-0 z-10">
              <h2 className="font-semibold text-gray-800">
                Questions ({getTotalReadingQuestionCount(reading)})
              </h2>

              <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                Answer panel
              </span>
            </div>

            <div
              ref={readingQuestionsScrollRef}
              className="p-5 md:p-7 pb-24 md:pb-28 flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-pb-24"
            >
              <div className="space-y-5">
                {reading.questions?.map((question, index) => (
                  <div
                    key={question.id}
                    className="bg-gray-50 border border-gray-100 rounded-2xl p-6"
                  >
                    <p className="text-xs text-blue-600 font-semibold mb-2">
                      {getQuestionRangeLabel(reading.questions, question, index)}
                    </p>

                    {question.type === 'matching' && (
                      <div>
                        <p className="font-medium text-sm text-gray-800 mb-4">
                          Choose the correct heading for each paragraph.
                        </p>

                        <div className="bg-white border border-gray-100 rounded-xl p-4 mb-5">
                          {reading.headings?.filter(Boolean).map((heading, headingIndex) => (
                            <div
                              key={headingIndex}
                              className={`flex gap-2 text-sm leading-5 rounded-lg px-2 py-1 mb-1 ${
                                isReadingHeadingUsed(reading.id, question, String(headingIndex + 1))
                                  ? 'bg-green-50 text-gray-400'
                                  : 'text-gray-700'
                              }`}
                            >
                              <span
                                className={`font-semibold min-w-6 ${
                                  isReadingHeadingUsed(reading.id, question, String(headingIndex + 1))
                                    ? 'text-green-600'
                                    : 'text-gray-500'
                                }`}
                              >
                                {headingIndex + 1}.
                              </span>

                              <span
                                className={
                                  isReadingHeadingUsed(reading.id, question, String(headingIndex + 1))
                                    ? 'line-through'
                                    : ''
                                }
                              >
                                {heading}
                              </span>

                              {isReadingHeadingUsed(reading.id, question, String(headingIndex + 1)) && (
                                <span className="ml-auto text-[10px] font-semibold text-green-600 uppercase tracking-wider">
                                  Used
                                </span>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="flex flex-col gap-3">
                          {question.paragraphs?.map(paragraph => (
                            <div
                              key={paragraph.letter}
                              className="grid grid-cols-[110px_1fr] gap-3 items-center"
                            >
                              <label className="text-sm font-medium text-gray-700">
                                Paragraph {paragraph.letter}
                              </label>

                              <select
                                value={
                                  readingAnswers[reading.id]?.[question.id]?.[
                                    paragraph.letter
                                  ] || ''
                                }
                                onChange={e =>
                                  handleReadingMatching(
                                    reading.id,
                                    question.id,
                                    paragraph.letter,
                                    e.target.value
                                  )
                                }
                                className="w-full min-w-0 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                              >
                                <option value="">Select heading</option>

                                {reading.headings?.filter(Boolean).map((heading, headingIndex) => {
                                  const headingValue = String(headingIndex + 1)
                                  const usedByOther = isReadingHeadingUsedByOtherParagraph(
                                    reading.id,
                                    question,
                                    paragraph.letter,
                                    headingValue
                                  )

                                  return (
                                    <option
                                      key={headingIndex}
                                      value={headingValue}
                                      disabled={usedByOther}
                                    >
                                      {getReadingHeadingOptionLabel(
                                        reading.id,
                                        question,
                                        paragraph.letter,
                                        headingValue,
                                        heading
                                      )}
                                    </option>
                                  )
                                })}
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {question.type === 'matchingInformation' && (
                      <div>
                        {question.instruction && (
                          <p className="text-sm text-gray-700 mb-4">
                            {question.instruction}
                          </p>
                        )}

                        <div className="bg-white border border-violet-100 rounded-xl p-4 mb-5">
                          <p className="text-xs font-semibold text-violet-600 uppercase tracking-wider mb-2">
                            Sections
                          </p>

                          <p className="text-xs text-gray-500">
                            Choose the section letter for each statement. Letters may be used more than once.
                          </p>
                        </div>

                        <div className="flex flex-col gap-3">
                          {(question.items || []).map(item => (
                            <div
                              key={item.id}
                              className="grid grid-cols-1 md:grid-cols-[1fr_150px] gap-3 items-center bg-white border border-gray-100 rounded-xl p-3"
                            >
                              <p className="text-sm text-gray-800">
                                {item.statement || item.question}
                              </p>

                              <select
                                value={
                                  readingAnswers[reading.id]?.[question.id]?.[
                                    item.id
                                  ] || ''
                                }
                                onChange={e =>
                                  handleReadingMatchingInformation(
                                    reading.id,
                                    question.id,
                                    item.id,
                                    e.target.value
                                  )
                                }
                                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                              >
                                <option value="">Choose section</option>

                                {(question.sectionLetters?.length
                                  ? question.sectionLetters
                                  : reading.paragraphs?.map(paragraph => paragraph.letter) || []
                                ).map(letter => (
                                  <option key={letter} value={letter}>
                                    Section {letter}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {question.type === 'sentenceEndings' && (
                      <div>
                        {question.instruction && (
                          <p className="text-sm text-gray-700 mb-4">
                            {question.instruction}
                          </p>
                        )}

                        <div className="bg-white border border-gray-100 rounded-xl p-4 mb-5">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                            Endings
                          </p>

                          <div className="space-y-2">
                            {question.endings?.filter(Boolean).map((ending, endingIndex) => (
                              <div
                                key={endingIndex}
                                className="flex gap-2 text-sm text-gray-700 leading-5"
                              >
                                <span className="font-semibold text-gray-500 min-w-6">
                                  {letters[endingIndex]}.
                                </span>

                                <span>{ending}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="flex flex-col gap-3">
                          {question.items?.map(item => (
                            <div
                              key={item.id}
                              className="grid grid-cols-1 md:grid-cols-[1fr_160px] gap-3 items-center bg-white border border-gray-100 rounded-xl p-3"
                            >
                              <p className="text-sm text-gray-800">
                                {item.sentence}
                              </p>

                              <select
                                value={
                                  readingAnswers[reading.id]?.[question.id]?.[
                                    item.id
                                  ] || ''
                                }
                                onChange={e =>
                                  handleReadingSentenceEnding(
                                    reading.id,
                                    question.id,
                                    item.id,
                                    e.target.value
                                  )
                                }
                                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                              >
                                <option value="">Choose</option>

                                {question.endings?.map((ending, endingIndex) => {
                                  if (!ending?.trim()) return null

                                  const letter = letters[endingIndex]

                                  return (
                                    <option key={letter} value={letter}>
                                      {letter}. {ending}
                                    </option>
                                  )
                                })}
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {question.type === 'summaryOptions' && (
                      <div>
                        {question.instruction && (
                          <p className="text-sm text-gray-700 mb-4">
                            {question.instruction}
                          </p>
                        )}

                        <div className="bg-white border border-gray-100 rounded-xl p-5 mb-5">
                          <p className="font-semibold text-gray-900 text-center mb-4">
                            {question.title}
                          </p>

                          <div className="text-sm text-gray-700 leading-8">
                            {question.items?.map(item => (
                              <span key={item.id}>
                                {item.beforeText && (
                                  <span className="whitespace-pre-wrap">
                                    {item.beforeText}{' '}
                                  </span>
                                )}

                                <span className="inline-flex items-center gap-2 mx-1">
                                  <span className="text-xs font-semibold text-gray-400">
                                    ({item.number})
                                  </span>

                                  <select
                                    value={
                                      readingAnswers[reading.id]?.[question.id]?.[
                                        item.id
                                      ] || ''
                                    }
                                    onChange={e =>
                                      handleReadingSummaryOption(
                                        reading.id,
                                        question.id,
                                        item.id,
                                        e.target.value
                                      )
                                    }
                                    className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-purple-400 bg-white"
                                  >
                                    <option value="">Choose</option>

                                    {question.options?.map((option, optionIndex) => {
                                      if (!option?.trim()) return null

                                      const letter = letters[optionIndex]

                                      return (
                                        <option key={letter} value={letter}>
                                          {letter}. {option}
                                        </option>
                                      )
                                    })}
                                  </select>
                                </span>

                                {item.afterText && (
                                  <span className="whitespace-pre-wrap">
                                    {' '}{item.afterText}
                                  </span>
                                )}

                                {' '}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="bg-white border border-gray-100 rounded-xl p-4">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                            Options
                          </p>

                          <div className="space-y-2">
                            {question.options?.filter(Boolean).map((option, optionIndex) => (
                              <div
                                key={optionIndex}
                                className="flex gap-2 text-sm text-gray-700 leading-5"
                              >
                                <span className="font-semibold text-gray-500 min-w-6">
                                  {letters[optionIndex]}.
                                </span>

                                <span>{option}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {question.type === 'noteCompletion' &&
                      renderReadingNoteCompletion(reading, question)}

                    {(question.type === 'table' ||
                      question.type === 'summary' ||
                      question.type === 'note') && (
                      <div>
                        <p className="text-sm text-gray-700 mb-4">
                          {question.instruction}
                        </p>

                        <div className="overflow-x-auto">
                          <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                            <thead>
                              <tr className="bg-gray-100">
                                {question.columns?.map((column, columnIndex) => (
                                  <th
                                    key={columnIndex}
                                    className="p-3 text-left font-semibold text-gray-700 border border-white"
                                  >
                                    {column}
                                  </th>
                                ))}
                              </tr>
                            </thead>

                            <tbody>
                              {question.rows?.map(row => (
                                <tr key={row.id}>
                                  {row.cells?.map((cell, cellIndex) => {
                                    if (cell.type !== 'blank') {
                                      return (
                                        <td
                                          key={cellIndex}
                                          className="p-3 bg-white border border-gray-100 text-gray-700 whitespace-pre-wrap align-top"
                                        >
                                          {cell.text}
                                        </td>
                                      )
                                    }

                                    const key = tableAnswerKey(
                                      question.id,
                                      row.id,
                                      cellIndex
                                    )

                                    return (
                                      <td
                                        key={cellIndex}
                                        className="p-3 bg-white border border-gray-100 align-top"
                                      >
                                        <input
                                          value={readingAnswers[reading.id]?.[key] || ''}
                                          onChange={e =>
                                            handleReadingTableAnswer(
                                              reading.id,
                                              question.id,
                                              row.id,
                                              cellIndex,
                                              e.target.value
                                            )
                                          }
                                          placeholder="Type answer..."
                                          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                        />
                                      </td>
                                    )
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {question.type === 'tfng' && (
                      <div>
                        <p className="text-sm text-gray-800 mb-3">
                          {question.question}
                        </p>

                        <div className="flex gap-2">
                          {['True', 'False', 'Not Given'].map(option => (
                            <button
                              key={option}
                              type="button"
                              onClick={() =>
                                handleReadingAnswer(reading.id, question.id, option)
                              }
                              className={`flex-1 py-2 rounded-xl text-xs font-medium border ${
                                readingAnswers[reading.id]?.[question.id] === option
                                  ? 'bg-purple-600 text-white border-purple-600'
                                  : 'border-gray-200 text-gray-500'
                              }`}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {question.type === 'fitb' && (
                      <div>
                        <p className="text-sm text-gray-800 mb-3">
                          {question.question}
                        </p>

                        <input
                          value={readingAnswers[reading.id]?.[question.id] || ''}
                          onChange={e =>
                            handleReadingAnswer(reading.id, question.id, e.target.value)
                          }
                          placeholder="Type your answer..."
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                        />
                      </div>
                    )}

                    {question.type === 'mcq' && (
                      <div>
                        <p className="text-sm text-gray-800 mb-3">
                          {question.question}
                        </p>

                        {question.mode === 'multi' && (
                          <p className="text-xs text-amber-600 bg-amber-50 rounded-xl p-3 mb-3">
                            Choose TWO answers.
                          </p>
                        )}

                        <div className="flex flex-col gap-2">
                          {question.options?.map((option, optionIndex) => {
                            const letter = letters[optionIndex]
                            const selectedMulti = Array.isArray(
                              readingAnswers[reading.id]?.[question.id]
                            )
                              ? readingAnswers[reading.id][question.id]
                              : []

                            const selected =
                              question.mode === 'multi'
                                ? selectedMulti.includes(letter)
                                : readingAnswers[reading.id]?.[question.id] === letter

                            return (
                              <button
                                key={optionIndex}
                                type="button"
                                onClick={() =>
                                  question.mode === 'multi'
                                    ? handleReadingMultiAnswer(
                                        reading.id,
                                        question.id,
                                        letter
                                      )
                                    : handleReadingAnswer(
                                        reading.id,
                                        question.id,
                                        letter
                                      )
                                }
                                className={`text-left px-4 py-3 rounded-xl text-sm border ${
                                  selected
                                    ? 'bg-purple-600 text-white border-purple-600'
                                    : 'border-gray-200 text-gray-700 bg-white'
                                }`}
                              >
                                <span className="font-semibold mr-2">
                                  {letter}.
                                </span>
                                {option}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  )

  const renderWritingTask1 = () => {
    if (!writing) {
      return (
        <div className="bg-white border border-gray-100 rounded-2xl p-10 text-center">
          <p className="text-gray-400">Writing section is loading...</p>
        </div>
      )
    }

    const task1Image = getWritingTask1Image(writing)
    const wordCount = countWords(writingAnswers.task1)

    return (
      <div className="space-y-6">
        {renderSectionTimerCard()}

        {writingLocked && (
          <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 text-sm font-medium">
            ⏰ Writing time is up. Your answers are saved. Move to the next section.
          </div>
        )}

        <div className="bg-white border border-gray-100 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold text-gray-900">
              Writing Task 1
            </h2>

            <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
              ~20 min · Min 150 words
            </span>
          </div>

          <p className="text-sm text-gray-500">
            {hasWritingTask2
              ? `Task 1 and Task 2 share a ${getMockSectionMinutes(mock, 'writing')}-minute timer.`
              : `This Task 1 section has a ${getMockSectionMinutes(mock, 'writing')}-minute timer.`}
          </p>
        </div>

        <fieldset disabled={writingLocked} className={writingLocked ? 'opacity-60' : ''}>
          <div className="bg-white border border-gray-100 rounded-2xl p-6">
            <h3 className="font-semibold text-gray-800 mb-3">
              Task 1 Prompt
            </h3>

            <p className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-xl p-4 mb-4">
              {getWritingTask1Prompt(writing)}
            </p>

            {task1Image && (
              <img
                src={task1Image}
                alt="Task 1"
                className="w-full max-h-[420px] object-contain bg-gray-50 rounded-xl border border-gray-100 mb-4"
              />
            )}

            <textarea
              rows={14}
              value={writingAnswers.task1}
              onChange={e =>
                setWritingAnswers(prev => ({
                  ...prev,
                  task1: e.target.value
                }))
              }
              placeholder="Write your Task 1 answer here..."
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
            />

            <div className="flex justify-between mt-2">
              <p className="text-xs text-gray-400">{wordCount} words</p>

              <p
                className={`text-xs font-medium ${
                  wordCount >= 150 ? 'text-green-600' : 'text-amber-600'
                }`}
              >
                Minimum 150 words
              </p>
            </div>
          </div>
        </fieldset>
      </div>
    )
  }

  const renderWritingTask2 = () => {
    if (!writing) {
      return (
        <div className="bg-white border border-gray-100 rounded-2xl p-10 text-center">
          <p className="text-gray-400">Writing section is loading...</p>
        </div>
      )
    }

    const wordCount = countWords(writingAnswers.task2)

    return (
      <div className="space-y-6">
        {renderSectionTimerCard()}

        {writingLocked && (
          <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 text-sm font-medium">
            ⏰ Writing time is up. Your answers are saved. Move to the next section.
          </div>
        )}

        <div className="bg-white border border-gray-100 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold text-gray-900">
              Writing Task 2
            </h2>

            <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
              ~40 min · Min 250 words
            </span>
          </div>

          <p className="text-sm text-gray-500">
            {hasWritingTask1
              ? `Task 2 carries more weight than Task 1. Both tasks share a ${getMockSectionMinutes(mock, 'writing')}-minute timer.`
              : `This Task 2 section has a ${getMockSectionMinutes(mock, 'writing')}-minute timer.`}
          </p>
        </div>

        <fieldset disabled={writingLocked} className={writingLocked ? 'opacity-60' : ''}>
          <div className="bg-white border border-gray-100 rounded-2xl p-6">
            <h3 className="font-semibold text-gray-800 mb-3">
              Task 2 Prompt
            </h3>

            <p className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-xl p-4 mb-4">
              {getWritingTask2Prompt(writing)}
            </p>

            {getWritingTask2Image(writing) && (
              <img
                src={getWritingTask2Image(writing)}
                alt="Task 2"
                className="w-full max-h-[420px] object-contain bg-gray-50 rounded-xl border border-gray-100 mb-4"
              />
            )}

            <textarea
              rows={18}
              value={writingAnswers.task2}
              onChange={e =>
                setWritingAnswers(prev => ({
                  ...prev,
                  task2: e.target.value
                }))
              }
              placeholder="Write your Task 2 answer here..."
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
            />

            <div className="flex justify-between mt-2">
              <p className="text-xs text-gray-400">{wordCount} words</p>

              <p
                className={`text-xs font-medium ${
                  wordCount >= 250 ? 'text-green-600' : 'text-amber-600'
                }`}
              >
                Minimum 250 words
              </p>
            </div>
          </div>
        </fieldset>
      </div>
    )
  }

  const renderPrepareSection = ({ type }) => {
    const isReading = type === 'reading'
    const title = isReading
      ? 'Now prepare for the Reading Part'
      : 'Now prepare for the Writing Part'
    const previousSection = activeSection.transitionFrom === 'reading'
      ? 'Reading'
      : 'Listening'
    const targetMinutes = getMockSectionMinutes(mock, type)
    const description = `${previousSection} is complete. Your ${targetMinutes}-minute ${isReading ? 'Reading' : 'Writing'} timer has not started yet. When you continue, ${previousSection} will be locked.`
    const buttonLabel = isReading ? 'Start Reading →' : 'Start Writing →'

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-10 text-center max-w-3xl mx-auto">
        <p className="text-sm text-purple-600 font-semibold mb-3">
          Section Transition
        </p>

        <h1 className="text-3xl font-bold text-gray-900 mb-4">
          {title}
        </h1>

        <p className="text-gray-500 text-sm leading-7 mb-8">
          {description}
        </p>

        <button
          onClick={nextSection}
          className="bg-purple-600 text-white rounded-xl px-8 py-4 text-sm font-medium hover:bg-purple-700"
        >
          {buttonLabel}
        </button>
      </div>
    )
  }

  const renderReview = () => {
    const t1Words = countWords(writingAnswers.task1)
    const t2Words = countWords(writingAnswers.task2)
    const listeningProgress = getListeningOverallProgress()
    const readingProgress = getReadingOverallProgress()

    return (
      <div className="space-y-6">
        <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Review & Submit
          </h2>

          <p className="text-gray-500 text-sm mb-6">
            Your included sections are ready to submit. Scores and correct/incorrect counts will only be shown after final submission.
          </p>

          <div className={`grid grid-cols-1 ${
            Object.values(enabledSections).filter(Boolean).length >= 3
              ? 'md:grid-cols-3'
              : Object.values(enabledSections).filter(Boolean).length === 2
                ? 'md:grid-cols-2'
                : 'max-w-md mx-auto'
          } gap-4`}>
            {enabledSections.listening && (
              <div className="bg-purple-50 rounded-2xl p-5">
                <p className="text-xs text-gray-500 mb-1">Listening</p>
                <p className="text-xl font-bold text-purple-600">
                  {listeningProgress.answered}/{listeningProgress.total}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {listeningProgress.answered >= listeningProgress.total
                    ? 'All questions answered'
                    : `${Math.max(
                        listeningProgress.total - listeningProgress.answered,
                        0
                      )} unanswered`}
                </p>
              </div>
            )}

            {enabledSections.reading && (
              <div className="bg-blue-50 rounded-2xl p-5">
                <p className="text-xs text-gray-500 mb-1">Reading</p>
                <p className="text-xl font-bold text-blue-600">
                  {readingProgress.answered}/{readingProgress.total}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {readingProgress.answered >= readingProgress.total
                    ? 'All questions answered'
                    : `${Math.max(
                        readingProgress.total - readingProgress.answered,
                        0
                      )} unanswered`}
                </p>
              </div>
            )}

            {enabledSections.writing && (
              <div className="bg-amber-50 rounded-2xl p-5">
                <p className="text-xs text-gray-500 mb-1">Writing</p>
                <p className="text-xl font-bold text-amber-600">Pending</p>
                <p className="text-xs text-gray-500 mt-1">
                  Teacher review required
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-5">
          <h3 className="font-semibold text-amber-700 mb-2">
            Important
          </h3>

          <p className="text-sm text-amber-700 leading-6">
            Once you submit, you cannot edit this mock again. Included objective sections will be scored immediately. Included Writing tasks will wait for teacher review.
          </p>
        </div>

        {enabledSections.writing && (
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <h3 className="font-semibold text-gray-800 mb-3">
              Writing Word Count
            </h3>

            <div className={`grid grid-cols-1 ${
              hasWritingTask1 && hasWritingTask2
                ? 'md:grid-cols-2'
                : ''
            } gap-4`}>
              {hasWritingTask1 && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Task 1</p>
                  <p className="text-xl font-bold text-gray-800">
                    {t1Words} words
                  </p>
                  <p className={`text-xs mt-1 ${
                    t1Words >= 150 ? 'text-green-600' : 'text-amber-600'
                  }`}>
                    {t1Words >= 150 ? '✓ Above minimum' : 'Below 150 words'}
                  </p>
                </div>
              )}

              {hasWritingTask2 && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Task 2</p>
                  <p className="text-xl font-bold text-gray-800">
                    {t2Words} words
                  </p>
                  <p className={`text-xs mt-1 ${
                    t2Words >= 250 ? 'text-green-600' : 'text-amber-600'
                  }`}>
                    {t2Words >= 250 ? '✓ Above minimum' : 'Below 250 words'}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <button
          onClick={() => handleSubmitMock()}
          disabled={submitting}
          className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
        >
          {submitting ? 'Submitting...' : `Submit ${mockTypeLabel}`}
        </button>
      </div>
    )
  }


  const formatReviewAnswer = (value, options = []) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return 'No answer'

      return value
        .map(item => {
          const index = letters.indexOf(item)
          return index >= 0 && options[index]
            ? `${item}. ${options[index]}`
            : item
        })
        .join(', ')
    }

    if (value === undefined || value === null || value === '') {
      return 'No answer'
    }

    const cleanValue = value.toString()
    const optionIndex = letters.indexOf(cleanValue)

    if (optionIndex >= 0 && options[optionIndex]) {
      return `${cleanValue}. ${options[optionIndex]}`
    }

    return cleanValue
  }

  const getNearbyCompletionText = (parts, targetIndex) => {
    const previous = parts?.[targetIndex - 1]
    const next = parts?.[targetIndex + 1]

    return [
      previous?.content || previous?.text || '',
      '_____',
      next?.content || next?.text || ''
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
  }

  const buildListeningReviewItems = () => {
    const items = []

    listeningParts.forEach(part => {
      ;(part.questions || []).forEach(question => {
        const displayNumbers = getListeningQuestionDisplayNumbers(
          listeningParts,
          part.id,
          question
        )

        let subIndex = 0

        const pushItem = ({
          prompt,
          userAnswer,
          correctAnswer,
          correct,
          options = [],
          status = null
        }) => {
          const number =
            displayNumbers[subIndex] ||
            displayNumbers[0] ||
            items.length + 1

          items.push({
            id: `listening-${part.id}-${question.id}-${subIndex}`,
            section: part.displayTitle || part.title || 'Listening',
            number,
            prompt:
              prompt ||
              question.question ||
              question.instruction ||
              'Listening question',
            userAnswer: formatReviewAnswer(userAnswer, options),
            correctAnswer: formatReviewAnswer(correctAnswer, options),
            correct,
            status
          })

          subIndex++
        }

        if (question.type === 'table' || question.type === 'note') {
          ;(question.rows || []).forEach(row => {
            const rowText = (row.cells || [])
              .filter(cell => cell.type === 'text')
              .map(cell => cell.text)
              .filter(Boolean)
              .join(' · ')

            ;(row.cells || []).forEach((cell, cellIndex) => {
              if (cell.type !== 'blank') return

              const key = tableAnswerKey(
                question.id,
                row.id,
                cellIndex
              )
              const userAnswer = listeningAnswers[key]

              pushItem({
                prompt:
                  [
                    rowText,
                    cell.beforeText,
                    '_____',
                    cell.afterText
                  ]
                    .filter(Boolean)
                    .join(' ') ||
                  question.instruction,
                userAnswer,
                correctAnswer: cell.answer,
                correct: isBlankCorrect(
                  userAnswer,
                  cell.answer,
                  cell.acceptedAnswers,
                  cell.maxWords
                )
              })
            })
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          ;(question.sections || []).forEach(section => {
            ;(section.parts || []).forEach((item, itemIndex) => {
              if (item.type !== 'blank') return

              const key = listeningCompletionAnswerKey(
                question.id,
                section.id,
                item.id
              )
              const options =
                question.completionMode === 'choose'
                  ? question.options || []
                  : []

              pushItem({
                prompt:
                  [
                    section.heading,
                    getNearbyCompletionText(
                      section.parts,
                      itemIndex
                    )
                  ]
                    .filter(Boolean)
                    .join(' — ') ||
                  question.instruction,
                userAnswer: listeningAnswers[key],
                correctAnswer: item.answer,
                options,
                correct: isListeningCompletionPartCorrect(
                  question,
                  section,
                  item
                )
              })
            })
          })

          return
        }

        if (question.type === 'map') {
          ;(question.mapItems || []).forEach(item => {
            const key = mapAnswerKey(question.id, item.id)
            const userAnswer = listeningAnswers[key]

            pushItem({
              prompt: item.prompt || question.instruction,
              userAnswer,
              correctAnswer: item.answer,
              correct:
                normalize(userAnswer) ===
                normalize(item.answer)
            })
          })

          return
        }

        if (question.type === 'matching') {
          ;(question.matchingItems || []).forEach(item => {
            const key = matchingAnswerKey(question.id, item.id)
            const userAnswer = listeningAnswers[key]

            pushItem({
              prompt: item.prompt || question.matchingTitle,
              userAnswer,
              correctAnswer: item.answer,
              options: question.options || [],
              correct: isListeningMatchingItemCorrect(
                question,
                item
              )
            })
          })

          return
        }

        if (question.type === 'mcq' && question.mode === 'multi') {
          const score = getListeningMultiAnswerScore(question)

          pushItem({
            prompt: question.question,
            userAnswer: listeningAnswers[question.id] || [],
            correctAnswer: question.answers || [],
            options: question.options || [],
            correct: score.correct === score.total,
            status:
              score.correct > 0 && score.correct < score.total
                ? `Partly correct (${score.correct}/${score.total})`
                : null
          })

          return
        }

        pushItem({
          prompt: question.question,
          userAnswer: listeningAnswers[question.id],
          correctAnswer: question.answer,
          options:
            question.type === 'mcq'
              ? question.options || []
              : [],
          correct: isListeningNormalCorrect(question)
        })
      })
    })

    return items
  }

  const buildReadingReviewItems = () => {
    const items = []

    readings.forEach(reading => {
      ;(reading.questions || []).forEach(
        (question, questionIndex) => {
          const questionStart =
            (reading.questions || [])
              .slice(0, questionIndex)
              .reduce(
                (sum, item) =>
                  sum + getReadingQuestionCount(item),
                0
              ) + 1

          let subIndex = 0

          const pushItem = ({
            prompt,
            userAnswer,
            correctAnswer,
            correct,
            options = [],
            status = null
          }) => {
            const number = questionStart + subIndex

            items.push({
              id: `reading-${reading.id}-${question.id}-${subIndex}`,
              section: reading.title || 'Reading',
              number,
              prompt:
                prompt ||
                question.question ||
                question.instruction ||
                'Reading question',
              userAnswer: formatReviewAnswer(
                userAnswer,
                options
              ),
              correctAnswer: formatReviewAnswer(
                correctAnswer,
                options
              ),
              correct,
              status
            })

            subIndex++
          }

          if (question.type === 'matching') {
            ;(question.paragraphs || []).forEach(paragraph => {
              const userAnswer =
                readingAnswers[reading.id]?.[question.id]?.[
                  paragraph.letter
                ]

              pushItem({
                prompt: `Paragraph ${paragraph.letter}`,
                userAnswer,
                correctAnswer: paragraph.answer,
                options: reading.headings || [],
                correct:
                  userAnswer?.toString() ===
                  paragraph.answer?.toString()
              })
            })

            return
          }

          if (question.type === 'matchingInformation') {
            ;(question.items || []).forEach(item => {
              const userAnswer =
                readingAnswers[reading.id]?.[question.id]?.[
                  item.id
                ]

              pushItem({
                prompt:
                  item.statement ||
                  item.sentence ||
                  item.prompt ||
                  item.text,
                userAnswer,
                correctAnswer: item.answer,
                correct:
                  userAnswer?.toString() ===
                  item.answer?.toString()
              })
            })

            return
          }

          if (question.type === 'sentenceEndings') {
            ;(question.items || []).forEach(item => {
              const userAnswer =
                readingAnswers[reading.id]?.[question.id]?.[
                  item.id
                ]

              pushItem({
                prompt:
                  item.sentence ||
                  item.prompt ||
                  item.text,
                userAnswer,
                correctAnswer: item.answer,
                options: question.endings || [],
                correct:
                  userAnswer?.toString() ===
                  item.answer?.toString()
              })
            })

            return
          }

          if (question.type === 'summaryOptions') {
            ;(question.items || []).forEach(item => {
              const userAnswer =
                readingAnswers[reading.id]?.[question.id]?.[
                  item.id
                ]

              pushItem({
                prompt:
                  [
                    item.beforeText,
                    '_____',
                    item.afterText
                  ]
                    .filter(Boolean)
                    .join(' ') ||
                  item.prompt ||
                  item.text,
                userAnswer,
                correctAnswer: item.answer,
                options: question.options || [],
                correct:
                  userAnswer?.toString() ===
                  item.answer?.toString()
              })
            })

            return
          }

          if (question.type === 'noteCompletion') {
            ;(question.paragraphs || []).forEach(paragraph => {
              ;(paragraph.parts || []).forEach(
                (part, partIndex) => {
                  if (part.type !== 'blank') return

                  const key = noteAnswerKey(
                    question.id,
                    paragraph.id,
                    part.id
                  )
                  const userAnswer =
                    readingAnswers[reading.id]?.[key]
                  const options =
                    question.mode === 'choose'
                      ? question.options || []
                      : []

                  pushItem({
                    prompt:
                      [
                        paragraph.heading ||
                          paragraph.title,
                        getNearbyCompletionText(
                          paragraph.parts,
                          partIndex
                        )
                      ]
                        .filter(Boolean)
                        .join(' — ') ||
                      question.instruction,
                    userAnswer,
                    correctAnswer: part.answer,
                    options,
                    correct: isReadingNotePartCorrect(
                      reading.id,
                      question,
                      paragraph,
                      part
                    )
                  })
                }
              )
            })

            return
          }

          if (
            question.type === 'table' ||
            question.type === 'summary' ||
            question.type === 'note'
          ) {
            ;(question.rows || []).forEach(row => {
              const rowText = (row.cells || [])
                .filter(cell => cell.type === 'text')
                .map(cell => cell.text)
                .filter(Boolean)
                .join(' · ')

              ;(row.cells || []).forEach(
                (cell, cellIndex) => {
                  if (cell.type !== 'blank') return

                  const key = tableAnswerKey(
                    question.id,
                    row.id,
                    cellIndex
                  )
                  const userAnswer =
                    readingAnswers[reading.id]?.[key]

                  pushItem({
                    prompt:
                      [
                        rowText,
                        cell.beforeText,
                        '_____',
                        cell.afterText
                      ]
                        .filter(Boolean)
                        .join(' ') ||
                      question.instruction,
                    userAnswer,
                    correctAnswer: cell.answer,
                    correct: isBlankCorrect(
                      userAnswer,
                      cell.answer,
                      cell.acceptedAnswers,
                      cell.maxWords
                    )
                  })
                }
              )
            })

            return
          }

          if (
            question.type === 'mcq' &&
            question.mode === 'multi'
          ) {
            const score = getReadingMultiAnswerScore(
              reading.id,
              question
            )

            pushItem({
              prompt: question.question,
              userAnswer:
                readingAnswers[reading.id]?.[question.id] ||
                [],
              correctAnswer: question.answers || [],
              options: question.options || [],
              correct: score.correct === score.total,
              status:
                score.correct > 0 &&
                score.correct < score.total
                  ? `Partly correct (${score.correct}/${score.total})`
                  : null
            })

            return
          }

          pushItem({
            prompt: question.question,
            userAnswer:
              readingAnswers[reading.id]?.[question.id],
            correctAnswer: question.answer,
            options:
              question.type === 'mcq'
                ? question.options || []
                : [],
            correct: isReadingNormalCorrect(
              reading.id,
              question
            )
          })
        }
      )
    })

    return items
  }

  const renderIncorrectAnswerCard = item => (
    <div
      key={item.id}
      className="border border-red-100 bg-red-50 rounded-2xl p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-xs font-semibold text-red-500 uppercase tracking-wide">
            {item.section} · Q{item.number}
          </p>

          <p className="text-sm font-medium text-gray-900 mt-2 whitespace-pre-wrap">
            {item.prompt || 'Question text is not available.'}
          </p>
        </div>

        <span className="text-xs font-semibold text-red-600 bg-white px-3 py-1 rounded-full border border-red-100 flex-shrink-0">
          {item.status || 'Wrong'}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-white border border-red-100 rounded-xl p-4">
          <p className="text-xs text-gray-400 mb-1">
            Your answer
          </p>
          <p className="text-sm font-medium text-red-700 whitespace-pre-wrap">
            {item.userAnswer}
          </p>
        </div>

        <div className="bg-white border border-green-100 rounded-xl p-4">
          <p className="text-xs text-gray-400 mb-1">
            Correct answer
          </p>
          <p className="text-sm font-medium text-green-700 whitespace-pre-wrap">
            {item.correctAnswer}
          </p>
        </div>
      </div>
    </div>
  )

  if (loading) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading mock test...</p>
      </div>
    )
  }

  if (finalResult) {
    const listeningReviewItems = buildListeningReviewItems()
    const readingReviewItems = buildReadingReviewItems()
    const listeningMistakes = listeningReviewItems.filter(
      item => !item.correct
    )
    const readingMistakes = readingReviewItems.filter(
      item => !item.correct
    )

    const writingReview =
      finalResult?.writing?.review ||
      completedSubmission?.writingReview ||
      completedSubmission?.result?.writing?.review ||
      null

    const writingStatus =
      finalResult?.writing?.status ||
      completedSubmission?.writingReview?.status ||
      'pending_review'

    return (
      <div className="min-h-screen bg-[#faf9f6]">
        <nav className="flex justify-between items-center px-4 sm:px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-20">
          <img src="/1.png" alt="Maxima" className="h-12 sm:h-14 object-contain" />

          <button
            onClick={() => navigate('/student')}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Back to Dashboard
          </button>
        </nav>

        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
          <div className="bg-white border border-gray-100 rounded-2xl p-6 sm:p-8 text-center mb-6">
            <p className="text-sm text-gray-400 mb-2">
              Mock Test Submitted
            </p>

            <div className="flex items-center justify-center gap-2 mb-3">
              <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
                isMiniMock
                  ? 'bg-blue-50 text-blue-700'
                  : 'bg-purple-50 text-purple-700'
              }`}>
                {mockTypeLabel}
              </span>

              <span className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full">
                {getWritingModeLabel(writingMode)}
              </span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-4">
              {mock?.title}
            </h1>

            <p className="text-5xl font-bold text-purple-600 mb-2">
              {finalResult.overallEstimate || '-'}
            </p>

            <p className="text-sm text-gray-500">
              {enabledSections.listening || enabledSections.reading
                ? 'Overall estimate from included objective sections'
                : 'Writing will be reviewed by your teacher'}
            </p>
          </div>

          <div className={`grid grid-cols-1 ${
            Object.values(enabledSections).filter(Boolean).length >= 3
              ? 'md:grid-cols-3'
              : Object.values(enabledSections).filter(Boolean).length === 2
                ? 'md:grid-cols-2'
                : 'max-w-md mx-auto'
          } gap-4 mb-6`}>
            {enabledSections.listening && (
              <div className="bg-white border border-gray-100 rounded-2xl p-5">
                <p className="text-xs text-gray-400 mb-1">Listening</p>
                <p className="text-3xl font-bold text-purple-600">
                  {finalResult.listening.band ?? '-'}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {finalResult.listening.correct}/{finalResult.listening.total}
                </p>
              </div>
            )}

            {enabledSections.reading && (
              <div className="bg-white border border-gray-100 rounded-2xl p-5">
                <p className="text-xs text-gray-400 mb-1">Reading</p>
                <p className="text-3xl font-bold text-blue-600">
                  {finalResult.reading.band ?? '-'}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {finalResult.reading.correct}/{finalResult.reading.total}
                </p>
              </div>
            )}

            {enabledSections.writing && (
              <div className="bg-white border border-gray-100 rounded-2xl p-5">
                <p className="text-xs text-gray-400 mb-1">Writing</p>
                <p className={`text-xl font-bold ${
                  writingStatus === 'reviewed'
                    ? 'text-green-600'
                    : 'text-amber-600'
                }`}>
                  {writingStatus === 'reviewed'
                    ? writingReview?.overall || 'Reviewed'
                    : 'Pending'}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {writingStatus === 'reviewed'
                    ? 'Teacher feedback available'
                    : 'Teacher review required'}
                </p>
              </div>
            )}
          </div>

          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-5 mb-6">
            <p className="text-sm text-blue-700 leading-6">
              Your incorrect answers are listed below. Correct answers are shown only after the mock has been submitted.
            </p>
          </div>

          <div className="space-y-5">
            {enabledSections.listening && (
              <details open className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
              <summary className="cursor-pointer px-6 py-5 font-semibold text-gray-900 flex items-center justify-between gap-3">
                <span>Listening Mistakes</span>
                <span className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-full">
                  {listeningMistakes.length} wrong
                </span>
              </summary>

              <div className="border-t border-gray-100 p-5 space-y-4">
                {listeningMistakes.length > 0 ? (
                  listeningMistakes.map(renderIncorrectAnswerCard)
                ) : (
                  <div className="bg-green-50 border border-green-100 rounded-xl p-5 text-sm text-green-700">
                    Excellent — all Listening answers were correct.
                  </div>
                )}
              </div>
              </details>
            )}

            {enabledSections.reading && (
              <details open className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
              <summary className="cursor-pointer px-6 py-5 font-semibold text-gray-900 flex items-center justify-between gap-3">
                <span>Reading Mistakes</span>
                <span className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-full">
                  {readingMistakes.length} wrong
                </span>
              </summary>

              <div className="border-t border-gray-100 p-5 space-y-4">
                {readingMistakes.length > 0 ? (
                  readingMistakes.map(renderIncorrectAnswerCard)
                ) : (
                  <div className="bg-green-50 border border-green-100 rounded-xl p-5 text-sm text-green-700">
                    Excellent — all Reading answers were correct.
                  </div>
                )}
              </div>
              </details>
            )}

            {enabledSections.writing && (
              <details className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
              <summary className="cursor-pointer px-6 py-5 font-semibold text-gray-900">
                Writing Submission & Feedback
              </summary>

              <div className="border-t border-gray-100 p-5 space-y-5">
                {hasWritingTask1 && (
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <h3 className="font-semibold text-gray-900">
                        Writing Task 1
                      </h3>
                    <span className="text-xs text-gray-400">
                      {countWords(writingAnswers.task1 || '')} words
                    </span>
                  </div>

                  <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-sm text-gray-700 whitespace-pre-wrap min-h-[90px]">
                    {writingAnswers.task1 || 'No Task 1 answer submitted.'}
                  </div>

                  {writingReview?.task1Feedback && (
                    <div className="bg-purple-50 border border-purple-100 rounded-xl p-4 mt-3">
                      <p className="text-xs font-semibold text-purple-600 mb-1">
                        Teacher feedback
                      </p>
                      <p className="text-sm text-purple-800 whitespace-pre-wrap">
                        {writingReview.task1Feedback}
                      </p>
                    </div>
                    )}
                  </div>
                )}

                {hasWritingTask2 && (
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <h3 className="font-semibold text-gray-900">
                        Writing Task 2
                      </h3>
                    <span className="text-xs text-gray-400">
                      {countWords(writingAnswers.task2 || '')} words
                    </span>
                  </div>

                  <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-sm text-gray-700 whitespace-pre-wrap min-h-[90px]">
                    {writingAnswers.task2 || 'No Task 2 answer submitted.'}
                  </div>

                  {writingReview?.task2Feedback && (
                    <div className="bg-purple-50 border border-purple-100 rounded-xl p-4 mt-3">
                      <p className="text-xs font-semibold text-purple-600 mb-1">
                        Teacher feedback
                      </p>
                      <p className="text-sm text-purple-800 whitespace-pre-wrap">
                        {writingReview.task2Feedback}
                      </p>
                    </div>
                    )}
                  </div>
                )}

                {writingReview?.generalFeedback ? (
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                    <p className="text-xs font-semibold text-blue-600 mb-1">
                      General feedback
                    </p>
                    <p className="text-sm text-blue-800 whitespace-pre-wrap">
                      {writingReview.generalFeedback}
                    </p>
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 text-sm text-amber-700">
                    Writing feedback will appear here after your teacher completes the review.
                  </div>
                )}
              </div>
              </details>
            )}
          </div>
        </div>
      </div>
    )
  }


  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-30">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 hidden md:inline">
            {mock?.title}
          </span>

          {timerInfo && timerInfo.started && (
            <div
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold ${
                timerInfo.locked
                  ? 'bg-red-50 text-red-600'
                  : timerInfo.time < 300
                    ? 'bg-amber-50 text-amber-600'
                    : 'bg-purple-50 text-purple-600'
              }`}
            >
              <span className="text-xs font-medium">
                {timerInfo.label}
              </span>

              <span className="font-mono">
                {timerInfo.locked ? 'TIME UP' : formatTime(timerInfo.time)}
              </span>
            </div>
          )}

          <button
            onClick={handleExitMock}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            Exit
          </button>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-6 sticky top-[73px] z-20">
          <div className="flex gap-2 overflow-x-auto">
            {sections.map((section, index) => {
              const locked = !isSectionAccessible(index)

              return (
                <button
                  key={section.key}
                  type="button"
                  disabled={locked}
                  onClick={() => handleSectionTabClick(index)}
                  className={`text-xs px-4 py-2 rounded-full whitespace-nowrap ${
                    sectionIndex === index
                      ? 'bg-purple-600 text-white'
                      : locked
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed opacity-60'
                        : index < sectionIndex || index <= maxUnlockedSectionIndex
                          ? 'bg-green-50 text-green-600'
                          : 'bg-gray-100 text-gray-400 cursor-not-allowed opacity-60'
                  }`}
                  title={locked ? 'This section is locked.' : section.label}
                >
                  {section.label}
                </button>
              )
            })}
          </div>
        </div>

        {tabWarning && (
          <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 mb-6 text-sm font-medium">
            {tabWarning}
          </div>
        )}

        {activeSection.key === 'intro' && (
          <div className="bg-white border border-gray-100 rounded-2xl p-10 text-center max-w-3xl mx-auto">
            <h1 className="text-3xl font-bold text-gray-900 mb-3">
              {mock?.title}
            </h1>

            <div className="flex items-center justify-center gap-2 mb-4">
              <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
                isMiniMock
                  ? 'bg-blue-50 text-blue-700'
                  : 'bg-purple-50 text-purple-700'
              }`}>
                {mockTypeLabel}
              </span>

              <span className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full">
                {getWritingModeLabel(writingMode)}
              </span>
            </div>

            <p className="text-gray-500 mb-6">
              {isMiniMock
                ? `This Mini Mock runs in order: ${mockFlowLabel} → Review.`
                : `This Full Mock runs in order: selected Listening part(s) → three Reading passages → ${getWritingModeLabel(writingMode)} → Review.`}
            </p>

            <div className={`grid grid-cols-1 ${
              Object.values(enabledSections).filter(Boolean).length >= 3
                ? 'sm:grid-cols-3'
                : Object.values(enabledSections).filter(Boolean).length === 2
                  ? 'sm:grid-cols-2'
                  : 'max-w-md mx-auto'
            } gap-3 mb-8 text-left`}>
              {enabledSections.listening && (
                <div className="bg-purple-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Listening</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {getMockSectionMinutes(mock, 'listening')} min
                  </p>
                </div>
              )}

              {enabledSections.reading && (
                <div className="bg-blue-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Reading</p>
                  <p className="text-2xl font-bold text-blue-600">
                    {getMockSectionMinutes(mock, 'reading')} min
                  </p>
                </div>
              )}

              {enabledSections.writing && (
                <div className="bg-amber-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Writing</p>
                  <p className="text-2xl font-bold text-amber-600">
                    {getMockSectionMinutes(mock, 'writing')} min
                  </p>
                </div>
              )}
            </div>

            <p className="text-xs text-gray-400 mb-6">
              ⚠ When a section&apos;s timer runs out, that section is locked and cannot be edited.
            </p>

            <button
              onClick={nextSection}
              className="bg-purple-600 text-white rounded-xl px-8 py-4 text-sm font-medium hover:bg-purple-700"
            >
              Start {mockTypeLabel}
            </button>
          </div>
        )}

        {activeSection.key?.startsWith('listening-') &&
          renderListening(activeSection.listeningPart)}

        {activeSection.key === 'prepare-reading' &&
          renderPrepareSection({ type: 'reading' })}

        {activeSection.key?.startsWith('reading-') &&
          renderReading(activeSection.reading)}

        {activeSection.key === 'prepare-writing' &&
          renderPrepareSection({ type: 'writing' })}

        {activeSection.key === 'writing-task1' && renderWritingTask1()}

        {activeSection.key === 'writing-task2' && renderWritingTask2()}

        {activeSection.key === 'review' && renderReview()}

        {activeSection.key !== 'intro' && activeSection.key !== 'review' && activeSection.key !== 'prepare-reading' && activeSection.key !== 'prepare-writing' && (
          <div className="flex justify-between mt-8">
            <button
              onClick={prevSection}
              className="bg-white border border-gray-200 text-gray-600 rounded-xl px-6 py-3 text-sm font-medium hover:bg-gray-50"
            >
              ← Previous Section
            </button>

            <button
              onClick={nextSection}
              className="bg-purple-600 text-white rounded-xl px-6 py-3 text-sm font-medium hover:bg-purple-700"
            >
              Next Section →
            </button>
          </div>
        )}

        {activeSection.key === 'review' && (
          <div className="flex justify-start mt-8">
            <button
              onClick={prevSection}
              className="bg-white border border-gray-200 text-gray-600 rounded-xl px-6 py-3 text-sm font-medium hover:bg-gray-50"
            >
              ← Previous Section
            </button>
          </div>
        )}
      </div>
    </div>
  )
}