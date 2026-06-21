import { useState, useEffect, useRef } from 'react'
import { auth, db } from '../firebase'
import {
  doc,
  getDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs
} from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

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


function normalizeListeningParts(listening) {
  const sourceQuestions = []

  if (Array.isArray(listening?.parts) && listening.parts.length) {
    listening.parts.forEach(part => {
      ;(part.questions || []).forEach(question => {
        sourceQuestions.push({
          ...question,
          partId: question.partId || part.id || '',
          partTitle: question.partTitle || part.title || ''
        })
      })
    })
  }

  if (sourceQuestions.length === 0 && Array.isArray(listening?.questions)) {
    listening.questions.forEach(question => {
      sourceQuestions.push(question)
    })
  }

  return [
    {
      id: listening?.parts?.[0]?.id || 'listening-main',
      title: 'Listening Questions',
      instructions: '',
      questions: sourceQuestions
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

function getPartQuestionTotal(part) {
  return (part.questions || []).reduce(
    (sum, question) => sum + getListeningQuestionCount(question),
    0
  )
}

function getTotalListeningQuestionCount(parts) {
  return (parts || []).reduce(
    (sum, part) => sum + getPartQuestionTotal(part),
    0
  )
}

function getQuestionDisplayNumbers(parts, partId, targetQuestion) {
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

function getQuestionRangeLabel(parts, partId, questionIndex) {
  const part = (parts || []).find(item => item.id === partId)
  const question = part?.questions?.[questionIndex]
  const numbers = getQuestionDisplayNumbers(parts, partId, question)

  if (numbers.length > 1) {
    return `Q${numbers[0]}-${numbers[numbers.length - 1]}`
  }

  if (numbers.length === 1) {
    return `Q${numbers[0]}`
  }

  return `Q${questionIndex + 1}`
}

function getSingleQuestionNumber(parts, partId, questionId) {
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

function getMapQuestionNumber(parts, partId, questionId, itemId) {
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

function getSavedListeningState(storageKey) {
  try {
    const saved = localStorage.getItem(storageKey)
    return saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
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

function getBlankQuestionNumber(parts, partId, questionId, rowId, cellIndex) {
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

function getCompletionBlankQuestionNumber(parts, partId, questionId, sectionId, itemId) {
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

function getMatchingQuestionNumber(parts, partId, questionId, itemId) {
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

function getPercentageBand(correct, total) {
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

  return getPercentageBand(correct, total)
}

export default function DoListening() {
  const { id } = useParams()

  const [user, setUser] = useState(null)
  const [listening, setListening] = useState(null)
  const [activePartId, setActivePartId] = useState(null)
  const [answers, setAnswers] = useState({})
  const [timeLeft, setTimeLeft] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [alreadyDone, setAlreadyDone] = useState(false)
  const [flaggedQuestions, setFlaggedQuestions] = useState([])
  const [studentNote, setStudentNote] = useState('')
  const [showQuestionMap, setShowQuestionMap] = useState(true)

  const timerRef = useRef(null)
  const submittingRef = useRef(false)
  const restoredRef = useRef(false)
  const questionRefs = useRef({})
  const navigate = useNavigate()

  const storageKey = user?.uid && id ? `listening_progress_${id}_${user.uid}` : null

  const parts = listening ? normalizeListeningParts(listening) : []
  const activePart = parts.find(part => part.id === activePartId) || parts[0]
  const activeQuestions = activePart?.questions || []
  const totalQuestionCount = getTotalListeningQuestionCount(parts)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      const profileSnap = await getDoc(doc(db, 'users', currentUser.uid))

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

      const snap = await getDoc(doc(db, 'listenings', id))
      if (!snap.exists()) {
        alert('Listening homework not found.')
        navigate('/student')
        return
      }

      const data = {
        id: snap.id,
        ...snap.data()
      }

      if (!isAssignedToCurrentUser(data, currentUser, profile)) {
        alert('This listening homework is not assigned to you.')
        navigate('/student')
        return
      }

      if (isHiddenForCurrentUser(data, currentUser, profile) || data.archived === true) {
        alert('This listening homework is no longer available.')
        navigate('/student')
        return
      }

      const loadedParts = normalizeListeningParts(data)

      setListening(data)
      setActivePartId(loadedParts[0]?.id || null)
      setTimeLeft((data.timeLimit || 30) * 60)

      const q = query(
        collection(db, 'listeningSubmissions'),
        where('uid', '==', currentUser.uid),
        where('listeningId', '==', id),
        orderBy('submittedAt', 'desc'),
        limit(1)
      )

      const existing = await getDocs(q)

      if (!existing.empty) {
        const sub = existing.docs[0].data()

        setAlreadyDone(true)
        setAnswers(sub.answers || {})
        setResult(sub.result)
        setFlaggedQuestions(
          Array.isArray(sub.flaggedQuestions) ? sub.flaggedQuestions : []
        )
        setStudentNote(sub.studentNote || '')
        setSubmitted(true)

        const key = `listening_progress_${id}_${currentUser.uid}`
        localStorage.removeItem(key)
      }
    })

    return unsub
  }, [id, navigate])

  useEffect(() => {
    if (!storageKey || restoredRef.current || !listening) return
    if (submitted || alreadyDone) return

    const saved = getSavedListeningState(storageKey)

    if (!saved) {
      restoredRef.current = true
      return
    }

    setAnswers(saved.answers || {})
    setFlaggedQuestions(
      Array.isArray(saved.flaggedQuestions) ? saved.flaggedQuestions : []
    )
    setStudentNote(saved.studentNote || '')

    if (saved.activePartId) {
      setActivePartId(saved.activePartId)
    }

    if (typeof saved.timeLeft === 'number') {
      setTimeLeft(saved.timeLeft)
    }

    restoredRef.current = true
  }, [storageKey, listening, submitted, alreadyDone])

  useEffect(() => {
    if (!storageKey || !listening || submitted || alreadyDone) return

    const timeout = setTimeout(() => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          answers,
          activePartId,
          timeLeft,
          flaggedQuestions,
          studentNote,
          updatedAt: new Date().toISOString()
        })
      )
    }, 300)

    return () => clearTimeout(timeout)
  }, [
    storageKey,
    listening,
    submitted,
    alreadyDone,
    answers,
    activePartId,
    timeLeft,
    flaggedQuestions,
    studentNote
  ])

  useEffect(() => {
    if (submitted || alreadyDone) return

    const handleBeforeUnload = event => {
      if (!listening || Object.keys(answers || {}).length === 0) return

      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [submitted, alreadyDone, listening, answers])

  useEffect(() => {
    if (timeLeft === null || submitted) return

    if (timeLeft <= 0) {
      handleSubmit(true)
      return
    }

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => Math.max(prev - 1, 0))
    }, 1000)

    return () => clearInterval(timerRef.current)
  }, [timeLeft, submitted])

  const formatTime = secs => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0')

    const s = (secs % 60).toString().padStart(2, '0')

    return `${m}:${s}`
  }

  const numberWords = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
    twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
    seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
  }

  const normalize = value => {
    if (value === undefined || value === null) return ''

    const clean = value
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:()]/g, '')
      .replace(/\s+/g, ' ')

    return numberWords[clean] || clean
  }

  const getWordCount = value => {
    const clean = normalize(value)
    if (!clean) return 0
    return clean.split(' ').filter(Boolean).length
  }

  const parseAcceptedAnswers = cell => {
    const main = cell.answer ? [cell.answer] : []
    const alternatives = cell.acceptedAnswers
      ? cell.acceptedAnswers.split(',').map(item => item.trim()).filter(Boolean)
      : []

    return [...main, ...alternatives]
  }

  const isWithinWordLimit = (value, maxWords) => {
    if (!maxWords) return true
    return getWordCount(value) <= Number(maxWords)
  }

  const sortAnswers = value => {
    if (!Array.isArray(value)) return []
    return [...value].map(v => v?.toString().trim()).sort()
  }

  const tableAnswerKey = (questionId, rowId, cellIndex) => {
    return `${questionId}_${rowId}_${cellIndex}`
  }

  const completionAnswerKey = (questionId, sectionId, itemId) => {
    return `${questionId}_${sectionId}_${itemId}`
  }

  const mapAnswerKey = (questionId, itemId) => {
    return `${questionId}_${itemId}`
  }

  const matchingAnswerKey = (questionId, itemId) => {
    return `${questionId}_${itemId}`
  }

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

  const getQuestionStatus = (question, index) => {
    let answered = 0
    let total = getListeningQuestionCount(question)

    if (question.type === 'table' || question.type === 'note') {
      answered = 0
      total = 0

      question.rows?.forEach(row => {
        row.cells?.forEach((cell, cellIndex) => {
          if (cell.type !== 'blank') return

          total++

          if (
            hasAnswerValue(
              answers[tableAnswerKey(question.id, row.id, cellIndex)]
            )
          ) {
            answered++
          }
        })
      })
    } else if (question.type === 'listeningCompletion') {
      answered = 0
      total = 0

      question.sections?.forEach(section => {
        section.parts?.forEach(item => {
          if (item.type !== 'blank') return

          total++

          if (
            hasAnswerValue(
              answers[
                completionAnswerKey(
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
    } else if (question.type === 'map') {
      const items = question.mapItems || []
      total = items.length
      answered = items.filter(item =>
        hasAnswerValue(answers[mapAnswerKey(question.id, item.id)])
      ).length
    } else if (question.type === 'matching') {
      const items = question.matchingItems || []
      total = items.length
      answered = items.filter(item =>
        hasAnswerValue(
          answers[matchingAnswerKey(question.id, item.id)]
        )
      ).length
    } else if (question.type === 'mcq' && question.mode === 'multi') {
      const selected = Array.isArray(answers[question.id])
        ? answers[question.id]
        : []

      total = question.answers?.length || 2
      answered = Math.min(selected.filter(Boolean).length, total)
    } else {
      total = 1
      answered = hasAnswerValue(answers[question.id]) ? 1 : 0
    }

    return {
      id: question.id,
      label: getQuestionRangeLabel(parts, activePart?.id, index),
      answered,
      total,
      complete: total > 0 && answered >= total,
      partial: answered > 0 && answered < total,
      flagged: flaggedQuestions.includes(question.id)
    }
  }

  const getQuestionStatuses = () =>
    activeQuestions.map((question, index) =>
      getQuestionStatus(question, index)
    )

  const getAnsweredQuestionCount = () =>
    getQuestionStatuses().reduce(
      (sum, status) => sum + status.answered,
      0
    )

  const getUnansweredQuestionLabels = () =>
    getQuestionStatuses()
      .filter(status => !status.complete)
      .map(status => status.label)

  const toggleFlagQuestion = questionId => {
    setFlaggedQuestions(previous =>
      previous.includes(questionId)
        ? previous.filter(id => id !== questionId)
        : [...previous, questionId]
    )
  }

  const scrollToQuestion = questionId => {
    questionRefs.current[questionId]?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }

  const handleAnswer = (questionId, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: value
    }))
  }

  const handleTableAnswer = (questionId, rowId, cellIndex, value) => {
    const key = tableAnswerKey(questionId, rowId, cellIndex)

    setAnswers(prev => ({
      ...prev,
      [key]: value
    }))
  }


  const handleCompletionAnswer = (questionId, sectionId, itemId, value) => {
    const key = completionAnswerKey(questionId, sectionId, itemId)

    setAnswers(prev => ({
      ...prev,
      [key]: value
    }))
  }

  const handleMapAnswer = (questionId, itemId, value) => {
    const key = mapAnswerKey(questionId, itemId)

    setAnswers(prev => ({
      ...prev,
      [key]: value
    }))
  }

  const handleMatchingAnswer = (questionId, itemId, value) => {
    const key = matchingAnswerKey(questionId, itemId)

    setAnswers(prev => ({
      ...prev,
      [key]: value
    }))
  }

  const handleMultiAnswer = (questionId, letter) => {
    setAnswers(prev => {
      const current = Array.isArray(prev[questionId])
        ? prev[questionId]
        : []

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

  const getOptionText = (question, letter) => {
    if (!letter) return ''
    const index = letters.indexOf(letter)
    return question.options?.[index] || ''
  }

  const getAnswerText = (question, value) => {
    if (question.type === 'mcq') {
      if (Array.isArray(value)) {
        if (value.length === 0) return 'No answer'

        return value
          .map(letter => `${letter}. ${getOptionText(question, letter)}`)
          .join(', ')
      }

      if (!value) return 'No answer'
      return `${value}. ${getOptionText(question, value)}`
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return 'No answer'
      return value.join(', ')
    }

    return value || 'No answer'
  }

  const isNormalCorrect = question => {
    if (question.type === 'mcq' && question.mode === 'multi') {
      const userAnswer = sortAnswers(answers[question.id])
      const correctAnswer = sortAnswers(question.answers || [])

      if (userAnswer.length === 0 || correctAnswer.length === 0) return false

      return userAnswer.join('|') === correctAnswer.join('|')
    }

    const userAnswer = normalize(answers[question.id])
    const correctAnswer = normalize(question.answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const getMultiAnswerScore = question => {
    const selected = Array.isArray(answers[question.id])
      ? answers[question.id].map(item => item?.toString())
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

  const isTableCellCorrect = (question, row, cellIndex) => {
    const key = tableAnswerKey(question.id, row.id, cellIndex)
    const cell = row.cells[cellIndex]
    const userAnswer = normalize(answers[key])
    const acceptedAnswers = parseAcceptedAnswers(cell).map(normalize)

    if (!userAnswer) return false
    if (acceptedAnswers.length === 0) return false
    if (!isWithinWordLimit(answers[key], cell.maxWords)) return false

    return acceptedAnswers.includes(userAnswer)
  }


  const isCompletionPartCorrect = (question, section, item) => {
    const key = completionAnswerKey(question.id, section.id, item.id)
    const userAnswer = answers[key]

    if (question.completionMode === 'choose') {
      return userAnswer?.toString().trim() === item.answer?.toString().trim()
    }

    const acceptedAnswers = [
      item.answer,
      ...(item.acceptedAnswers
        ? item.acceptedAnswers.split(',').map(answer => answer.trim()).filter(Boolean)
        : [])
    ].map(normalize)

    if (!normalize(userAnswer)) return false
    if (acceptedAnswers.length === 0) return false
    if (!isWithinWordLimit(userAnswer, item.maxWords)) return false

    return acceptedAnswers.includes(normalize(userAnswer))
  }

  const getCompletionOptionText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.options?.[index] || `Option ${letter}`
  }

  const isMapItemCorrect = (question, item) => {
    const key = mapAnswerKey(question.id, item.id)
    const userAnswer = normalize(answers[key])
    const correctAnswer = normalize(item.answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isMatchingItemCorrect = (question, item) => {
    const key = matchingAnswerKey(question.id, item.id)
    const userAnswer = normalize(answers[key])
    const correctAnswer = normalize(item.answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const getMatchingOptionText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.options?.[index] || `Option ${letter}`
  }

  const calculateScore = () => {
    let correct = 0
    let total = 0

    parts.forEach(part => {
      part.questions?.forEach(question => {
      if (question.type === 'table' || question.type === 'note') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type === 'blank') {
              total++

              if (isTableCellCorrect(question, row, cellIndex)) {
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

            if (isCompletionPartCorrect(question, section, item)) {
              correct++
            }
          })
        })

        return
      }

      if (question.type === 'map') {
        question.mapItems?.forEach(item => {
          total++

          if (isMapItemCorrect(question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'matching') {
        question.matchingItems?.forEach(item => {
          total++

          if (isMatchingItemCorrect(question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'mcq' && question.mode === 'multi') {
        const score = getMultiAnswerScore(question)

        correct += score.correct
        total += score.total

        return
      }

      total++

      if (isNormalCorrect(question)) {
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

  const handleSubmit = async (autoSubmit = false) => {
    if (submittingRef.current || submitted || alreadyDone || !listening || !user) return

    if (!autoSubmit) {
      const unansweredLabels = getUnansweredQuestionLabels()
      const flaggedLabels = getQuestionStatuses()
        .filter(status => status.flagged)
        .map(status => status.label)

      const warningLines = [
        'Submit your answers? You cannot retake this homework after submitting.'
      ]

      if (unansweredLabels.length > 0) {
        warningLines.push(
          `Unanswered or incomplete: ${unansweredLabels.join(', ')}`
        )
      }

      if (flaggedLabels.length > 0) {
        warningLines.push(
          `Marked for review: ${flaggedLabels.join(', ')}`
        )
      }

      const ok = window.confirm(warningLines.join('\n\n'))
      if (!ok) return
    }

    submittingRef.current = true
    setSubmitting(true)

    clearInterval(timerRef.current)

    const res = calculateScore()
    const submissionTeacherIds = getSourceTeacherIds(listening)

    try {
      await addDoc(collection(db, 'listeningSubmissions'), {
        uid: user.uid,
        studentId: user.uid,
        studentEmail: user.email || '',
        listeningId: id,
        schoolId: listening.schoolId || 'maxima',
        teacherId: submissionTeacherIds[0] || '',
        teacherIds: submissionTeacherIds,
        answers,
        flaggedQuestions,
        studentNote: studentNote.trim(),
        result: res,
        submittedAt: new Date().toISOString(),
        finishedLate: timeLeft <= 0,
        autoSubmitted: autoSubmit
      })

      if (storageKey) {
        localStorage.removeItem(storageKey)
      }

      setResult(res)
      setSubmitted(true)
    } catch (error) {
      console.error(error)
      alert('Could not submit your answers. Please try again.')
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const renderListeningCompletion = (question, partId, reviewMode = false) => (
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

                  const key = completionAnswerKey(question.id, section.id, item.id)
                  const questionNumber = getCompletionBlankQuestionNumber(
                    parts,
                    partId,
                    question.id,
                    section.id,
                    item.id
                  )
                  const correct = isCompletionPartCorrect(question, section, item)

                  if (reviewMode) {
                    return (
                      <span
                        key={item.id}
                        className={`inline-flex items-center gap-2 mx-1 px-2 py-1 rounded-xl border ${
                          correct
                            ? 'bg-green-50 border-green-100'
                            : 'bg-red-50 border-red-100'
                        }`}
                      >
                        <span className="text-xs font-semibold text-purple-600">
                          Q{questionNumber}
                        </span>

                        <span className="font-medium text-gray-800">
                          {answers[key] || 'No answer'}
                        </span>

                        {!correct && (
                          <span className="text-xs font-semibold text-green-700">
                            Correct:{' '}
                            {question.completionMode === 'choose'
                              ? `${item.answer}. ${getCompletionOptionText(question, item.answer)}`
                              : [item.answer, item.acceptedAnswers].filter(Boolean).join(', ')}
                          </span>
                        )}
                      </span>
                    )
                  }

                  if (question.completionMode === 'choose') {
                    return (
                      <span key={item.id} className="inline-flex items-center gap-2 mx-1">
                        <span className="text-xs font-semibold text-gray-400">
                          Q{questionNumber}
                        </span>

                        <select
                          value={answers[key] || ''}
                          onChange={e =>
                            handleCompletionAnswer(
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
                        value={answers[key] || ''}
                        onChange={e =>
                          handleCompletionAnswer(
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

  const renderMatchingQuestion = (question, partId, reviewMode = false) => {
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

        {reviewMode ? (
          <div className="bg-white border border-gray-100 rounded-xl p-4 mb-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Options
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2">
              {optionList.map((option, optionIndex) => (
                <div key={optionIndex} className="flex gap-2 text-sm text-gray-700 leading-5">
                  <span className="font-semibold text-gray-500 min-w-6">
                    {letters[optionIndex]}.
                  </span>

                  <span>{option}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className={reviewMode ? 'space-y-3' : 'grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-4 md:items-start'}>
          <div className="space-y-3">
            {(question.matchingItems || []).map(item => {
              const key = matchingAnswerKey(question.id, item.id)
              const questionNumber = getMatchingQuestionNumber(parts, partId, question.id, item.id)
              const correct = isMatchingItemCorrect(question, item)

              if (reviewMode) {
                return (
                  <div
                    key={item.id}
                    className={`rounded-xl p-4 border ${
                      correct
                        ? 'bg-green-50 border-green-100'
                        : 'bg-red-50 border-red-100'
                    }`}
                  >
                    <div className="grid grid-cols-1 md:grid-cols-[70px_1fr] gap-3 mb-3">
                      <span className="text-sm font-bold text-purple-600">
                        Q{questionNumber}
                      </span>

                      <p className="text-sm font-medium text-gray-800">
                        {item.prompt}
                      </p>
                    </div>

                    <p className="text-xs text-gray-500 mb-1">Your answer:</p>
                    <p className="text-sm text-gray-800 mb-2">
                      {answers[key] ? `${answers[key]}. ${getMatchingOptionText(question, answers[key])}` : 'No answer'}
                    </p>

                    {!correct && (
                      <>
                        <p className="text-xs text-gray-500 mb-1">Correct:</p>
                        <p className="text-sm font-medium text-green-700">
                          {item.answer}. {getMatchingOptionText(question, item.answer)}
                        </p>
                      </>
                    )}
                  </div>
                )
              }

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
                    value={answers[key] || ''}
                    onChange={e => handleMatchingAnswer(question.id, item.id, e.target.value)}
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

          {!reviewMode && (
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
          )}
        </div>
      </div>
    )
  }

  if (!listening) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  if (submitted && result) {
    return (
      <div className="min-h-screen bg-[#faf9f6]">
        <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
          <img
            src="/1.png"
            alt="Maxima"
            className="h-14 object-contain"
          />

          <button
            onClick={() => navigate('/student')}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Back to dashboard
          </button>
        </nav>

        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center shadow-sm mb-8">
            <div className="text-5xl font-bold text-purple-600 mb-2">
              {result.band}
            </div>

            <p className="text-gray-400 text-sm mb-1">
              IELTS Listening Band
            </p>

            <p className="text-gray-600 text-sm mb-4">
              {result.correct} / {result.total} correct answers
            </p>

            {alreadyDone ? (
              <p className="text-amber-600 text-sm bg-amber-50 rounded-xl py-2 px-4 inline-block">
                You already completed this homework. You can review your answers, but you cannot retake it.
              </p>
            ) : (
              <p className="text-green-600 text-sm bg-green-50 rounded-xl py-2 px-4 inline-block">
                Submitted successfully. Review your answers below.
              </p>
            )}
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
            <h2 className="font-semibold text-gray-800 mb-5">
              Answer Review
            </h2>

            <div className="flex flex-col gap-5">
              {parts.map(part => (
                <div key={part.id} className="mb-8">
                  <div className="mb-4">
                    <h3 className="font-semibold text-gray-800">
                      {part.title}
                    </h3>

                    {part.instructions && (
                      <p className="text-xs text-gray-400 mt-1">
                        {part.instructions}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-5">
                    {part.questions.map((question, index) => (
                <div
                  key={question.id}
                  className="border border-gray-100 rounded-xl p-5"
                >
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-xs font-medium text-gray-400">
                      {getQuestionRangeLabel(parts, part.id, index)}
                    </span>

                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        question.type === 'tfng'
                          ? 'bg-blue-50 text-blue-600'
                          : question.type === 'fitb'
                            ? 'bg-amber-50 text-amber-600'
                            : question.type === 'map'
                              ? 'bg-indigo-50 text-indigo-600'
                              : question.type === 'matching'
                                ? 'bg-cyan-50 text-cyan-600'
                              : (question.type === 'table' || question.type === 'note' || question.type === 'listeningCompletion')
                              ? 'bg-emerald-50 text-emerald-600'
                              : 'bg-purple-50 text-purple-600'
                      }`}
                    >
                      {question.type === 'tfng'
                        ? 'T/F/NG'
                        : question.type === 'fitb'
                          ? 'Fill blank'
                          : (question.type === 'table' || question.type === 'note' || question.type === 'listeningCompletion')
                            ? question.type === 'listeningCompletion' ? 'Note/Summary Completion' : question.type === 'note' ? 'Note Completion' : 'Table / Form Completion'
                            : question.type === 'map'
                              ? 'Map Labeling'
                              : question.type === 'matching'
                                ? 'Listening Matching'
                              : question.mode === 'multi'
                              ? 'MCQ — Choose TWO'
                              : 'MCQ'}
                    </span>
                  </div>


                  {question.type === 'listeningCompletion' ? (
                    renderListeningCompletion(question, part.id, true)
                  ) : question.type === 'matching' ? (
                    renderMatchingQuestion(question, part.id, true)
                  ) : question.type === 'map' ? (
                    <div>
                      <p className="text-sm text-gray-700 mb-4">
                        {question.instruction}
                      </p>

                      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] gap-5 lg:items-start">
                        <div className="space-y-4">
                          {question.mapImage && (
                            <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                              <img
                                src={question.mapImage}
                                alt="Map"
                                className="w-full max-h-[520px] object-contain rounded-xl bg-white"
                              />
                            </div>
                          )}

                          <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                              Map letters
                            </p>

                            <div className="grid grid-cols-2 gap-2">
                              {(question.mapLocations || []).map(location => (
                                <div key={location.id} className="bg-white border border-gray-100 rounded-xl p-3">
                                  <p className="text-sm font-bold text-gray-800">{location.label}</p>
                                  {location.text && (
                                    <p className="text-xs text-gray-500 mt-1">{location.text}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          {(question.mapItems || []).map(item => {
                            const key = mapAnswerKey(question.id, item.id)
                            const correct = isMapItemCorrect(question, item)

                            return (
                              <div
                                key={item.id}
                                className={`rounded-xl p-4 border ${
                                  correct
                                    ? 'bg-green-50 border-green-100'
                                    : 'bg-red-50 border-red-100'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-3 mb-2">
                                  <p className="text-sm font-semibold text-gray-800">
                                    <span className="font-bold text-purple-600 mr-2">
                                      Q{getMapQuestionNumber(parts, part.id, question.id, item.id)}
                                    </span>
                                    {item.prompt}
                                  </p>

                                  <span className={`text-xs font-semibold ${correct ? 'text-green-600' : 'text-red-600'}`}>
                                    {correct ? 'Correct' : 'Wrong'}
                                  </span>
                                </div>

                                <p className="text-xs text-gray-500 mb-1">Your answer:</p>
                                <p className="text-sm text-gray-800 mb-2">{answers[key] || 'No answer'}</p>

                                {!correct && (
                                  <>
                                    <p className="text-xs text-gray-500 mb-1">Correct:</p>
                                    <p className="text-sm font-medium text-green-700">{item.answer}</p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  ) : (question.type === 'table' || question.type === 'note') ? (
                    <div>
                      <p className="text-sm text-gray-700 mb-4">
                        {question.instruction}
                      </p>

                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                          <thead>
                            <tr className="bg-gray-100">
                              {question.columns.map((column, columnIndex) => (
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
                            {question.rows.map(row => (
                              <tr key={row.id}>
                                {row.cells.map((cell, cellIndex) => {
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

                                  const key = tableAnswerKey(
                                    question.id,
                                    row.id,
                                    cellIndex
                                  )

                                  const correct = isTableCellCorrect(
                                    question,
                                    row,
                                    cellIndex
                                  )

                                  return (
                                    <td
                                      key={cellIndex}
                                      className={`p-3 border border-white ${
                                        correct
                                          ? 'bg-green-50'
                                          : 'bg-red-50'
                                      }`}
                                    >
                                      {(cell.beforeText || cell.afterText) && (
                                        <div className="text-sm text-gray-700 leading-7 mb-3">
                                          <span className="inline-block bg-white border border-gray-200 text-purple-600 font-semibold rounded-md px-2 py-0.5 mr-1">
                                            Q{getBlankQuestionNumber(parts, part.id, question.id, row.id, cellIndex)}
                                          </span>

                                          {cell.beforeText && (
                                            <span className="whitespace-pre-wrap">
                                              {cell.beforeText}{' '}
                                            </span>
                                          )}

                                          <span className="inline-block min-w-[90px] px-2 py-0.5 rounded-md bg-white border border-gray-200 text-center">
                                            {answers[key] || 'No answer'}
                                          </span>

                                          {cell.afterText && (
                                            <span className="whitespace-pre-wrap">
                                              {' '}{cell.afterText}
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      <p className="text-xs text-gray-500 mb-1">
                                        Your answer:
                                      </p>

                                      <p className="text-sm text-gray-800 mb-2">
                                        {answers[key] || 'No answer'}
                                      </p>

                                      {!correct && (
                                        <>
                                          <p className="text-xs text-gray-500 mb-1">
                                            Correct:
                                          </p>

                                          <p className="text-sm font-medium text-green-700">
                                            {[cell.answer, cell.acceptedAnswers].filter(Boolean).join(', ')}
                                          </p>
                                        </>
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
                  ) : (
                    <div>
                      <p className="text-sm text-gray-800 mb-4">
                        {question.question}
                      </p>

                      <div
                        className={`rounded-xl p-4 border ${
                          isNormalCorrect(question)
                            ? 'bg-green-50 border-green-100'
                            : 'bg-red-50 border-red-100'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-sm font-semibold text-gray-800">
                            Result
                          </p>

                          <span
                            className={`text-xs font-semibold ${
                              isNormalCorrect(question)
                                ? 'text-green-600'
                                : 'text-red-600'
                            }`}
                          >
                            {isNormalCorrect(question) ? 'Correct' : 'Wrong'}
                          </span>
                        </div>

                        <p className="text-xs text-gray-500 mb-1">
                          Your answer:
                        </p>

                        <p className="text-sm text-gray-800 mb-3">
                          {getAnswerText(question, answers[question.id])}
                        </p>

                        {!isNormalCorrect(question) && (
                          <>
                            <p className="text-xs text-gray-500 mb-1">
                              Correct answer:
                            </p>

                            <p className="text-sm font-medium text-green-700">
                              {question.type === 'mcq' && question.mode === 'multi'
                                ? (question.answers || [])
                                    .map(letter => `${letter}. ${getOptionText(question, letter)}`)
                                    .join(', ')
                                : question.type === 'mcq'
                                  ? `${question.answer}. ${getOptionText(question, question.answer)}`
                                  : question.answer}
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => navigate('/student')}
              className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-8"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <img
          src="/1.png"
          alt="Maxima"
          className="h-10 object-contain"
        />

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 uppercase tracking-wide">
            {listening.title}
          </span>

          <span className="text-xs font-semibold bg-purple-50 text-purple-600 px-3 py-2 rounded-xl whitespace-nowrap">
            {getAnsweredQuestionCount()} / {totalQuestionCount} answered
          </span>

          <div
            className={`font-mono text-lg font-bold px-4 py-1.5 rounded-xl ${
              timeLeft <= 60
                ? 'bg-red-50 text-red-600'
                : timeLeft <= 300
                  ? 'bg-amber-50 text-amber-600'
                  : 'bg-green-50 text-green-600'
            }`}
          >
            ⏱ {formatTime(timeLeft)}
          </div>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-6 sticky top-[76px] z-10 shadow-sm">
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            {listening.title}
          </h1>

          {listening.instructions && (
            <p className="text-sm text-gray-500 mb-4 whitespace-pre-wrap">
              {listening.instructions}
            </p>
          )}

          <audio controls src={listening.audioUrl} className="w-full" />
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="font-semibold text-gray-800">
                Questions ({totalQuestionCount})
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                {getAnsweredQuestionCount()} answered ·{' '}
                {Math.max(
                  totalQuestionCount - getAnsweredQuestionCount(),
                  0
                )} remaining
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowQuestionMap(previous => !previous)}
              className="text-xs bg-purple-50 text-purple-600 px-3 py-2 rounded-xl hover:bg-purple-100"
            >
              {showQuestionMap ? 'Hide map' : 'Show map'}
            </button>
          </div>

          {showQuestionMap && (
            <div className="bg-white border border-purple-100 rounded-2xl p-5 mb-6 shadow-sm">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h3 className="font-semibold text-gray-800">
                    Question map
                  </h3>

                  <p className="text-xs text-gray-400 mt-1">
                    Green: answered · Blue: partial · White: unanswered · Amber: flagged
                  </p>
                </div>

                <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">
                  {getAnsweredQuestionCount()} / {totalQuestionCount}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {getQuestionStatuses().map(status => (
                  <button
                    key={status.id}
                    type="button"
                    onClick={() => scrollToQuestion(status.id)}
                    className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                      status.flagged
                        ? 'bg-amber-100 text-amber-700 border-amber-200'
                        : status.complete
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : status.partial
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : 'bg-white text-gray-500 border-gray-200 hover:border-purple-300'
                    }`}
                  >
                    {status.label}
                    {status.total > 1 && (
                      <span className="ml-1 opacity-70">
                        {status.answered}/{status.total}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white border border-gray-100 rounded-2xl p-5 mb-6 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h3 className="font-semibold text-gray-800">
                Scratch note
              </h3>

              <span className="text-xs text-gray-400">
                Saved with your submission
              </span>
            </div>

            <textarea
              value={studentNote}
              onChange={event => setStudentNote(event.target.value)}
              placeholder="Write short notes, keywords or answer clues here..."
              rows={3}
              className="w-full resize-y border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            />
          </div>

          <div className="flex flex-col gap-6">
            {activeQuestions.map((question, index) => (
              <div
                key={question.id}
                ref={element => {
                  questionRefs.current[question.id] = element
                }}
                className={`border rounded-2xl p-5 scroll-mt-52 ${
                  flaggedQuestions.includes(question.id)
                    ? 'border-amber-200 bg-amber-50/30'
                    : 'border-gray-100'
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-gray-400">
                      {getQuestionRangeLabel(parts, activePart?.id, index)}
                    </span>

                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                      question.type === 'tfng'
                        ? 'bg-blue-50 text-blue-600'
                        : question.type === 'fitb'
                          ? 'bg-amber-50 text-amber-600'
                          : question.type === 'map'
                            ? 'bg-indigo-50 text-indigo-600'
                            : question.type === 'matching'
                              ? 'bg-cyan-50 text-cyan-600'
                            : (question.type === 'table' || question.type === 'note' || question.type === 'listeningCompletion')
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-purple-50 text-purple-600'
                    }`}
                  >
                    {question.type === 'tfng'
                      ? 'T/F/NG'
                      : question.type === 'fitb'
                        ? 'Fill blank'
                        : (question.type === 'table' || question.type === 'note' || question.type === 'listeningCompletion')
                          ? question.type === 'listeningCompletion' ? 'Note/Summary Completion' : question.type === 'note' ? 'Note Completion' : 'Table / Form Completion'
                          : question.type === 'map'
                            ? 'Map Labeling'
                            : question.type === 'matching'
                              ? 'Listening Matching'
                            : question.mode === 'multi'
                            ? 'MCQ — Choose TWO'
                            : 'MCQ'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <span className="text-xs bg-white border border-gray-200 text-gray-500 px-2.5 py-1.5 rounded-full whitespace-nowrap">
                      {getQuestionStatus(question, index).answered}/
                      {getQuestionStatus(question, index).total} answered
                    </span>

                    <button
                      type="button"
                      onClick={() => toggleFlagQuestion(question.id)}
                      className={`text-xs px-3 py-1.5 rounded-xl border whitespace-nowrap ${
                        flaggedQuestions.includes(question.id)
                          ? 'bg-amber-100 text-amber-700 border-amber-200'
                          : 'bg-white text-gray-500 border-gray-200 hover:border-amber-300'
                      }`}
                    >
                      {flaggedQuestions.includes(question.id)
                        ? '★ Review later'
                        : '☆ Review later'}
                    </button>
                  </div>
                </div>

                {question.type === 'listeningCompletion' &&
                  renderListeningCompletion(question, activePart?.id)}

                {question.type === 'tfng' && (
                  <div>
                    <p className="text-sm text-gray-800 mb-3">
                      {question.question}
                    </p>

                    <div className="flex gap-2">
                      {['True', 'False', 'Not Given'].map(option => (
                        <button
                          key={option}
                          onClick={() =>
                            handleAnswer(question.id, option)
                          }
                          className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                            answers[question.id] === option
                              ? 'bg-purple-600 text-white border-purple-600'
                              : 'border-gray-200 text-gray-500 hover:border-purple-300'
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
                      value={answers[question.id] || ''}
                      onChange={e =>
                        handleAnswer(question.id, e.target.value)
                      }
                      placeholder="Type your answer..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"
                    />
                  </div>
                )}
                {question.type === 'matching' &&
                  renderMatchingQuestion(question, activePart?.id)}

                {question.type === 'map' && (
                  <div>
                    <p className="text-sm text-gray-700 mb-4">
                      {question.instruction}
                    </p>

                    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] gap-5 lg:items-start">
                      <div className="lg:sticky lg:top-[220px] space-y-4">
                        {question.mapImage && (
                          <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                            <img
                              src={question.mapImage}
                              alt="Map"
                              className="w-full max-h-[520px] object-contain rounded-xl bg-white"
                            />
                          </div>
                        )}

                        <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                            Map letters
                          </p>

                          <div className="grid grid-cols-2 gap-2">
                            {(question.mapLocations || []).map(location => (
                              <div key={location.id} className="bg-white border border-gray-100 rounded-xl p-3">
                                <p className="text-sm font-bold text-gray-800">{location.label}</p>
                                {location.text && (
                                  <p className="text-xs text-gray-500 mt-1">{location.text}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-3">
                        {(question.mapItems || []).map(item => {
                          const key = mapAnswerKey(question.id, item.id)

                          return (
                            <div key={item.id} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_150px] gap-3 items-center bg-gray-50 border border-gray-100 rounded-xl p-4">
                              <label className="text-sm font-medium text-gray-800">
                                <span className="font-bold text-purple-600 mr-2">
                                  Q{getMapQuestionNumber(parts, activePart?.id, question.id, item.id)}
                                </span>
                                {item.prompt}
                              </label>

                              <select
                                value={answers[key] || ''}
                                onChange={e => handleMapAnswer(question.id, item.id, e.target.value)}
                                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                              >
                                <option value="">Select letter</option>
                                {(question.mapLocations || []).map(location => (
                                  <option key={location.id} value={location.label}>
                                    {location.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}


                {(question.type === 'table' || question.type === 'note') && (
                  <div>
                    <p className="text-sm text-gray-700 mb-4">
                      {question.instruction}
                    </p>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                        <thead>
                          <tr className="bg-gray-100">
                            {question.columns.map((column, columnIndex) => (
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
                          {question.rows.map(row => (
                            <tr key={row.id}>
                              {row.cells.map((cell, cellIndex) => {
                                if (cell.type !== 'blank') {
                                  return (
                                    <td
                                      key={cellIndex}
                                      className="p-3 bg-gray-50 border border-white text-gray-700 whitespace-pre-wrap align-top"
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
                                    className="p-3 bg-gray-50 border border-white align-top"
                                  >
                                    {(cell.beforeText || cell.afterText) ? (
                                      <div className="text-sm text-gray-700 leading-8">
                                        <span className="inline-block bg-purple-50 border border-purple-100 text-purple-600 font-semibold rounded-md px-2 py-0.5 mr-1">
                                          Q{getBlankQuestionNumber(parts, activePart?.id, question.id, row.id, cellIndex)}
                                        </span>

                                        {cell.beforeText && (
                                          <span className="whitespace-pre-wrap">
                                            {cell.beforeText}{' '}
                                          </span>
                                        )}

                                        <input
                                          value={answers[key] || ''}
                                          onChange={e =>
                                            handleTableAnswer(
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
                                          Q{getBlankQuestionNumber(parts, activePart?.id, question.id, row.id, cellIndex)}
                                        </span>

                                        <input
                                          value={answers[key] || ''}
                                        onChange={e =>
                                          handleTableAnswer(
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

                {question.type === 'mcq' && (
                  <div>
                    <p className="text-sm text-gray-800 mb-3">
                      {question.question}
                    </p>

                    {question.mode === 'multi' && (
                      <p className="text-xs text-amber-600 bg-amber-50 rounded-xl p-3 mb-3">
                        Choose TWO answers. You can select up to 2 options.
                      </p>
                    )}

                    <div className="flex flex-col gap-2">
                      {question.options.map((option, optionIndex) => {
                        const letter = letters[optionIndex]

                        const selectedMulti = Array.isArray(answers[question.id])
                          ? answers[question.id]
                          : []

                        const isSelected =
                          question.mode === 'multi'
                            ? selectedMulti.includes(letter)
                            : answers[question.id] === letter

                        return (
                          <button
                            key={optionIndex}
                            onClick={() =>
                              question.mode === 'multi'
                                ? handleMultiAnswer(question.id, letter)
                                : handleAnswer(question.id, letter)
                            }
                            className={`text-left px-4 py-3 rounded-xl text-sm border transition-all ${
                              isSelected
                                ? 'bg-purple-600 text-white border-purple-600'
                                : 'border-gray-200 text-gray-700 hover:border-purple-300'
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

          <button
            onClick={() => handleSubmit(false)}
            disabled={submitting}
            className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-8 disabled:opacity-60"
          >
            {submitting ? 'Submitting...' : 'Submit answers'}
          </button>
        </div>
      </div>
    </div>
  )
}