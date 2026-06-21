import { useState, useEffect, useRef } from 'react'
import { auth, db } from '../firebase'
import {
  doc,
  getDoc,
  addDoc,
  collection,
  query,
  where,
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

function getHighlightStorageKey(userId, readingId) {
  return `reading-highlights:${userId}:${readingId}`
}

function getElementFromNode(node) {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
}

function getTextOffsetWithin(container, node, offset) {
  const range = document.createRange()
  range.selectNodeContents(container)
  range.setEnd(node, offset)
  return range.toString().length
}

export default function DoReading() {
  const { id } = useParams()

  const [user, setUser] = useState(null)
  const [reading, setReading] = useState(null)
  const [answers, setAnswers] = useState({})
  const [timeLeft, setTimeLeft] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [alreadyDone, setAlreadyDone] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [flaggedQuestions, setFlaggedQuestions] = useState([])
  const [studentNote, setStudentNote] = useState('')
  const [showQuestionMap, setShowQuestionMap] = useState(true)
  const [highlights, setHighlights] = useState([])
  const [pendingHighlight, setPendingHighlight] = useState(null)
  const [highlightMessage, setHighlightMessage] = useState('')

  const timerRef = useRef(null)
  const submittingRef = useRef(false)
  const questionRefs = useRef({})
  const highlightMessageTimerRef = useRef(null)
  const navigate = useNavigate()

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
      setLoadError(null)

      const snap = await getDoc(doc(db, 'readings', id))
      if (!snap.exists()) {
        setLoadError({
          title: 'Reading homework not found.',
          message: 'This reading document does not exist in Firestore. The dashboard may be pointing to an old or deleted reading ID.',
          readingId: id
        })
        return
      }

      const data = {
        id: snap.id,
        ...snap.data()
      }

      // StudentDashboard already lists only assigned reading homework.
      // Do not hard-redirect here, because old reading documents may use different assignment fields.
      if (!isAssignedToCurrentUser(data, currentUser, profile)) {
        console.warn('Reading assignment check did not match, but access is allowed from dashboard.', {
          readingId: data.id,
          assignTo: data.assignTo,
          assignedTo: data.assignedTo,
          studentIds: data.studentIds,
          assignedStudentIds: data.assignedStudentIds,
          assignedEmails: data.assignedEmails,
          currentUserUid: currentUser.uid,
          currentUserEmail: currentUser.email,
          profile
        })
      }

      if (isHiddenForCurrentUser(data, currentUser, profile) || data.archived === true) {
        setLoadError({
          title: 'This reading homework is hidden or archived.',
          message: 'DoReading is working, but this item is marked as hidden/archived for this student. Check hiddenFor and archived fields in Firestore.',
          readingId: data.id,
          archived: data.archived === true,
          hiddenFor: data.hiddenFor || []
        })
        return
      }

      setReading(data)
      setTimeLeft((data.timeLimit || 60) * 60)

      let locallySavedHighlights = []

      try {
        const storedHighlights = localStorage.getItem(
          getHighlightStorageKey(currentUser.uid, id)
        )

        if (storedHighlights) {
          const parsedHighlights = JSON.parse(storedHighlights)

          if (Array.isArray(parsedHighlights)) {
            locallySavedHighlights = parsedHighlights
          }
        }
      } catch (error) {
        console.warn('Could not restore reading highlights:', error)
      }

      setHighlights(locallySavedHighlights)

      const q = query(
        collection(db, 'readingSubmissions'),
        where('uid', '==', currentUser.uid),
        where('readingId', '==', id)
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
        setHighlights(
          Array.isArray(sub.highlights)
            ? sub.highlights
            : locallySavedHighlights
        )
        setSubmitted(true)
      }
    })

    return unsub
  }, [id, navigate])

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

  useEffect(() => {
    if (!user || !reading || submitted) return

    try {
      localStorage.setItem(
        getHighlightStorageKey(user.uid, id),
        JSON.stringify(highlights)
      )
    } catch (error) {
      console.warn('Could not save reading highlights:', error)
    }
  }, [highlights, id, reading, submitted, user])

  useEffect(() => {
    return () => {
      if (highlightMessageTimerRef.current) {
        clearTimeout(highlightMessageTimerRef.current)
      }
    }
  }, [])

  const formatTime = secs => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0')

    const s = (secs % 60).toString().padStart(2, '0')

    return `${m}:${s}`
  }

  const normalize = value => {
    return value?.toString().trim().toLowerCase()
  }

  const sortAnswers = value => {
    if (!Array.isArray(value)) return []
    return [...value].map(v => v?.toString().trim()).sort()
  }

  const countWords = value => {
    return value
      ?.toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean).length || 0
  }

  const isWithinWordLimit = (value, maxWords) => {
    if (!maxWords) return true
    return countWords(value) <= Number(maxWords)
  }

  const tableAnswerKey = (questionId, rowId, cellIndex) => {
    return `${questionId}_${rowId}_${cellIndex}`
  }

  const noteAnswerKey = (questionId, paragraphId, partId) => {
    return `${questionId}_${paragraphId}_${partId}`
  }

  const getAcceptedAnswers = (mainAnswer, acceptedAnswers) => {
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

  const isBlankAnswerCorrect = (userAnswer, mainAnswer, acceptedAnswers = '', maxWords = '') => {
    if (!isWithinWordLimit(userAnswer, maxWords)) return false

    const cleanUser = normalize(userAnswer)
    const accepted = getAcceptedAnswers(mainAnswer, acceptedAnswers)

    if (!cleanUser || accepted.length === 0) return false

    return accepted.includes(cleanUser)
  }

  const getQuestionItemCount = question => {
    if (question.type === 'matching') {
      return question.paragraphs?.length || 0
    }

    if (question.type === 'matchingInformation') {
      return question.items?.length || 0
    }

    if (question.type === 'sentenceEndings') {
      return question.items?.length || 0
    }

    if (question.type === 'summaryOptions') {
      return question.items?.length || 0
    }

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

  const getTotalQuestionCount = () => {
    if (!reading?.questions?.length) return 0

    return reading.questions.reduce(
      (sum, question) => sum + getQuestionItemCount(question),
      0
    )
  }

  const getQuestionStartNumber = index => {
    return reading.questions
      .slice(0, index)
      .reduce((sum, question) => sum + getQuestionItemCount(question), 0) + 1
  }

  const getQuestionRangeLabel = (question, index) => {
    const start = getQuestionStartNumber(index)
    const count = getQuestionItemCount(question)
    const end = start + count - 1

    return count > 1 ? `Q${start}-${end}` : `Q${start}`
  }

  const getReadingBlankNumber = (questionId, rowId, cellIndex) => {
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

      number += getQuestionItemCount(question)
    }

    return number
  }

  const getNoteBlankNumber = (questionId, paragraphId, partId) => {
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

      number += getQuestionItemCount(question)
    }

    return number
  }

  const getQuestionTypeLabel = question => {
    if (question.type === 'matching') return 'Matching Headings'
    if (question.type === 'matchingInformation') return 'Matching Information'
    if (question.type === 'sentenceEndings') return 'Sentence Endings'
    if (question.type === 'summaryOptions') return 'Summary Completion with Options'
    if (question.type === 'noteCompletion') {
      return question.mode === 'choose'
        ? 'Note Completion — Choose A-H'
        : 'Note Completion'
    }
    if (question.type === 'tfng') return 'T/F/NG'
    if (question.type === 'fitb') return 'Fill blank'
    if (question.type === 'table') return 'Table Completion'
    if (question.type === 'summary') return 'Summary Completion'
    if (question.mode === 'multi') return 'MCQ — Choose TWO'
    return 'MCQ'
  }

  const hasAnswerValue = value => {
    if (Array.isArray(value)) return value.filter(Boolean).length > 0
    if (value && typeof value === 'object') {
      return Object.values(value).some(item => hasAnswerValue(item))
    }

    return value !== undefined && value !== null && value.toString().trim() !== ''
  }

  const getQuestionStatus = (question, index) => {
    let answered = 0
    let total = getQuestionItemCount(question)

    if (question.type === 'matching') {
      answered = (question.paragraphs || []).filter(paragraph =>
        hasAnswerValue(answers[question.id]?.[paragraph.letter])
      ).length
    } else if (question.type === 'matchingInformation') {
      answered = (question.items || []).filter(item =>
        hasAnswerValue(answers[question.id]?.[item.id])
      ).length
    } else if (question.type === 'sentenceEndings') {
      answered = (question.items || []).filter(item =>
        hasAnswerValue(answers[question.id]?.[item.id])
      ).length
    } else if (question.type === 'summaryOptions') {
      answered = (question.items || []).filter(item =>
        hasAnswerValue(answers[question.id]?.[item.id])
      ).length
    } else if (question.type === 'noteCompletion') {
      answered = 0
      total = 0

      question.paragraphs?.forEach(paragraph => {
        paragraph.parts?.forEach(part => {
          if (part.type !== 'blank') return

          total++

          if (hasAnswerValue(answers[noteAnswerKey(question.id, paragraph.id, part.id)])) {
            answered++
          }
        })
      })
    } else if (question.type === 'mcq' && question.mode === 'multi') {
      const selected = Array.isArray(answers[question.id]) ? answers[question.id] : []
      total = question.answers?.length || 2
      answered = Math.min(selected.filter(Boolean).length, total)
    } else if (question.type === 'table' || question.type === 'summary') {
      answered = 0
      total = 0

      question.rows?.forEach(row => {
        row.cells?.forEach((cell, cellIndex) => {
          if (cell.type !== 'blank') return

          total++

          if (hasAnswerValue(answers[tableAnswerKey(question.id, row.id, cellIndex)])) {
            answered++
          }
        })
      })
    } else {
      answered = hasAnswerValue(answers[question.id]) ? 1 : 0
      total = 1
    }

    const label = getQuestionRangeLabel(question, index)

    return {
      id: question.id,
      label,
      answered,
      total,
      complete: total > 0 && answered >= total,
      flagged: flaggedQuestions.includes(question.id)
    }
  }

  const getQuestionStatuses = () =>
    (reading?.questions || []).map((question, index) =>
      getQuestionStatus(question, index)
    )

  const getAnsweredQuestionCount = () =>
    getQuestionStatuses().reduce((sum, item) => sum + item.answered, 0)

  const getUnansweredQuestionLabels = () =>
    getQuestionStatuses()
      .filter(item => !item.complete)
      .map(item => item.label)

  const toggleFlagQuestion = questionId => {
    setFlaggedQuestions(prev =>
      prev.includes(questionId)
        ? prev.filter(id => id !== questionId)
        : [...prev, questionId]
    )
  }

  const scrollToQuestion = questionId => {
    questionRefs.current[questionId]?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }

  const showHighlightMessage = message => {
    setHighlightMessage(message)

    if (highlightMessageTimerRef.current) {
      clearTimeout(highlightMessageTimerRef.current)
    }

    highlightMessageTimerRef.current = setTimeout(() => {
      setHighlightMessage('')
    }, 2600)
  }

  const getPassageBlockText = blockId => {
    if (!reading) return ''

    if (blockId === 'standard-passage') {
      return reading.passage || ''
    }

    const paragraph = reading.paragraphs?.find(
      item => `paragraph-${item.id || item.letter}` === blockId
    )

    return paragraph?.text || ''
  }

  const captureHighlightSelection = () => {
    if (submitted) return

    const selection = window.getSelection()

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setPendingHighlight(null)
      return
    }

    const range = selection.getRangeAt(0)
    const startElement = getElementFromNode(range.startContainer)
    const endElement = getElementFromNode(range.endContainer)

    const startBlock = startElement?.closest?.('[data-highlight-block]')
    const endBlock = endElement?.closest?.('[data-highlight-block]')

    if (!startBlock || !endBlock) {
      setPendingHighlight(null)
      return
    }

    if (startBlock !== endBlock) {
      setPendingHighlight(null)
      showHighlightMessage('Select text inside one paragraph at a time.')
      return
    }

    const blockId = startBlock.dataset.highlightBlock
    const sourceText = getPassageBlockText(blockId)

    if (!sourceText) {
      setPendingHighlight(null)
      return
    }

    let start = getTextOffsetWithin(
      startBlock,
      range.startContainer,
      range.startOffset
    )

    let end = getTextOffsetWithin(
      startBlock,
      range.endContainer,
      range.endOffset
    )

    if (end < start) {
      const previousStart = start
      start = end
      end = previousStart
    }

    while (start < end && /\s/.test(sourceText[start])) start++
    while (end > start && /\s/.test(sourceText[end - 1])) end--

    if (end <= start) {
      setPendingHighlight(null)
      return
    }

    setPendingHighlight({
      blockId,
      start,
      end,
      text: sourceText.slice(start, end)
    })
  }

  const addPendingHighlight = () => {
    if (!pendingHighlight) {
      showHighlightMessage('First select a word or sentence in the passage.')
      return
    }

    const { blockId, start, end } = pendingHighlight
    const sourceText = getPassageBlockText(blockId)

    let mergedStart = start
    let mergedEnd = end

    const remaining = highlights.filter(highlight => {
      if (highlight.blockId !== blockId) return true

      const overlaps =
        highlight.start <= mergedEnd &&
        highlight.end >= mergedStart

      if (overlaps) {
        mergedStart = Math.min(mergedStart, highlight.start)
        mergedEnd = Math.max(mergedEnd, highlight.end)
        return false
      }

      return true
    })

    const nextHighlight = {
      id: crypto.randomUUID(),
      blockId,
      start: mergedStart,
      end: mergedEnd,
      text: sourceText.slice(mergedStart, mergedEnd)
    }

    setHighlights([...remaining, nextHighlight])
    setPendingHighlight(null)

    const selection = window.getSelection()
    selection?.removeAllRanges()

    showHighlightMessage('Highlighted.')
  }

  const removeHighlight = highlightId => {
    setHighlights(prev =>
      prev.filter(highlight => highlight.id !== highlightId)
    )
    showHighlightMessage('Highlight removed.')
  }

  const clearHighlights = () => {
    if (highlights.length === 0) return

    const ok = window.confirm('Clear all passage highlights?')
    if (!ok) return

    setHighlights([])
    setPendingHighlight(null)
    showHighlightMessage('All highlights cleared.')
  }

  const renderHighlightedText = (text, blockId, reviewMode = false) => {
    if (!text) return null

    const validHighlights = highlights
      .filter(highlight =>
        highlight.blockId === blockId &&
        Number.isInteger(highlight.start) &&
        Number.isInteger(highlight.end) &&
        highlight.start >= 0 &&
        highlight.end > highlight.start &&
        highlight.end <= text.length
      )
      .sort((a, b) => a.start - b.start)

    if (validHighlights.length === 0) return text

    const parts = []
    let cursor = 0

    validHighlights.forEach(highlight => {
      if (highlight.start > cursor) {
        parts.push(
          <span key={`text-${blockId}-${cursor}`}>
            {text.slice(cursor, highlight.start)}
          </span>
        )
      }

      const visibleStart = Math.max(cursor, highlight.start)

      if (highlight.end > visibleStart) {
        parts.push(
          <mark
            key={highlight.id}
            title={reviewMode ? 'Student highlight' : 'Click to remove highlight'}
            onClick={
              reviewMode
                ? undefined
                : event => {
                    event.stopPropagation()
                    removeHighlight(highlight.id)
                  }
            }
            className={`rounded px-0.5 ${
              reviewMode
                ? 'bg-yellow-200 text-inherit'
                : 'bg-yellow-200 text-inherit cursor-pointer hover:bg-yellow-300'
            }`}
          >
            {text.slice(visibleStart, highlight.end)}
          </mark>
        )
      }

      cursor = Math.max(cursor, highlight.end)
    })

    if (cursor < text.length) {
      parts.push(
        <span key={`text-${blockId}-${cursor}`}>
          {text.slice(cursor)}
        </span>
      )
    }

    return parts
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

  const handleMatching = (questionId, letter, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: {
        ...(prev[questionId] || {}),
        [letter]: value
      }
    }))
  }

  const handleMatchingInformation = (questionId, itemId, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: {
        ...(prev[questionId] || {}),
        [itemId]: value
      }
    }))
  }

  const handleSentenceEnding = (questionId, itemId, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: {
        ...(prev[questionId] || {}),
        [itemId]: value
      }
    }))
  }

  const handleSummaryOption = (questionId, itemId, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: {
        ...(prev[questionId] || {}),
        [itemId]: value
      }
    }))
  }

  const handleNoteCompletion = (questionId, paragraphId, partId, value) => {
    const key = noteAnswerKey(questionId, paragraphId, partId)

    setAnswers(prev => ({
      ...prev,
      [key]: value
    }))
  }

  const getNoteOptionText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.options?.[index] || `Option ${letter}`
  }

  const getSummaryOptionText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.options?.[index] || `Option ${letter}`
  }

  const getSentenceEndingText = (question, letter) => {
    if (!letter) return 'No answer'
    const index = letters.indexOf(letter)
    return question.endings?.[index] || `Ending ${letter}`
  }

  const getHeadingText = number => {
    if (!number) return 'No answer'
    const index = Number(number) - 1
    return reading.headings?.[index] || `Heading ${number}`
  }

  const isHeadingUsed = (question, headingValue) => {
    if (!headingValue) return false

    return Object.values(answers[question.id] || {}).some(
      selected => selected?.toString() === headingValue?.toString()
    )
  }

  const isHeadingUsedByOtherParagraph = (question, currentParagraphLetter, headingValue) => {
    if (!headingValue) return false

    return Object.entries(answers[question.id] || {}).some(
      ([paragraphLetter, selected]) =>
        paragraphLetter !== currentParagraphLetter &&
        selected?.toString() === headingValue?.toString()
    )
  }

  const getHeadingOptionLabel = (question, currentParagraphLetter, headingValue, heading) => {
    const usedByOther = isHeadingUsedByOtherParagraph(
      question,
      currentParagraphLetter,
      headingValue
    )

    return usedByOther
      ? `${headingValue}. ${heading} — Used`
      : `${headingValue}. ${heading}`
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

    if (question.type === 'fitb') {
      return isBlankAnswerCorrect(
        answers[question.id],
        question.answer,
        question.acceptedAnswers,
        question.maxWords
      )
    }

    const userAnswer = normalize(answers[question.id])
    const correctAnswer = normalize(question.answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isTableCellCorrect = (question, row, cellIndex) => {
    const key = tableAnswerKey(question.id, row.id, cellIndex)
    const cell = row.cells[cellIndex]

    return isBlankAnswerCorrect(
      answers[key],
      cell.answer,
      cell.acceptedAnswers,
      cell.maxWords
    )
  }

  const isMatchingCorrect = (question, paragraph) => {
    const userAnswer = answers[question.id]?.[paragraph.letter]?.toString()
    const correctAnswer = paragraph.answer?.toString()

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isMatchingInformationCorrect = (question, item) => {
    const userAnswer = answers[question.id]?.[item.id]?.toString()
    const correctAnswer = item.answer?.toString()

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isSentenceEndingCorrect = (question, item) => {
    const userAnswer = answers[question.id]?.[item.id]?.toString()
    const correctAnswer = item.answer?.toString()

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isSummaryOptionCorrect = (question, item) => {
    const userAnswer = answers[question.id]?.[item.id]?.toString()
    const correctAnswer = item.answer?.toString()

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isNotePartCorrect = (question, paragraph, part) => {
    const key = noteAnswerKey(question.id, paragraph.id, part.id)
    const userAnswer = answers[key]

    if (question.mode === 'choose') {
      return userAnswer?.toString() === part.answer?.toString()
    }

    return isBlankAnswerCorrect(
      userAnswer,
      part.answer,
      part.acceptedAnswers,
      part.maxWords
    )
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

  const getMultiAnswerStatus = question => {
    const score = getMultiAnswerScore(question)

    if (score.correct === score.total) return 'Correct'
    if (score.correct > 0) return `Partly correct (${score.correct}/${score.total})`
    return 'Wrong'
  }

  const calculateScore = () => {
    let correct = 0
    let total = 0

    reading.questions.forEach(question => {
      if (question.type === 'matching') {
        question.paragraphs?.forEach(paragraph => {
          total++

          if (isMatchingCorrect(question, paragraph)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'matchingInformation') {
        question.items?.forEach(item => {
          total++

          if (isMatchingInformationCorrect(question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'sentenceEndings') {
        question.items?.forEach(item => {
          total++

          if (isSentenceEndingCorrect(question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'summaryOptions') {
        question.items?.forEach(item => {
          total++

          if (isSummaryOptionCorrect(question, item)) {
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

            if (isNotePartCorrect(question, paragraph, part)) {
              correct++
            }
          })
        })

        return
      }

      if (question.type === 'mcq' && question.mode === 'multi') {
        const score = getMultiAnswerScore(question)

        correct += score.correct
        total += score.total

        return
      }

      if (question.type === 'table' || question.type === 'summary') {
        question.rows.forEach(row => {
          row.cells.forEach((cell, cellIndex) => {
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

      total++

      if (isNormalCorrect(question)) {
        correct++
      }
    })

    return {
      correct,
      total,
      band: getReadingBand(correct, total)
    }
  }

  const handleSubmit = async (autoSubmit = false) => {
    if (submittingRef.current || submitted || alreadyDone || !reading || !user) return

    if (!autoSubmit) {
      const unansweredLabels = getUnansweredQuestionLabels()
      const flaggedLabels = getQuestionStatuses()
        .filter(item => item.flagged)
        .map(item => item.label)

      const warningLines = []

      if (unansweredLabels.length > 0) {
        warningLines.push(
          `You still have ${unansweredLabels.length} unanswered question group(s): ${unansweredLabels.join(', ')}`
        )
      }

      if (flaggedLabels.length > 0) {
        warningLines.push(
          `You flagged these for review: ${flaggedLabels.join(', ')}`
        )
      }

      warningLines.push('Submit your answers? You cannot retake this homework after submitting.')

      const ok = window.confirm(warningLines.join('\n\n'))
      if (!ok) return
    }

    submittingRef.current = true
    setSubmitting(true)

    clearInterval(timerRef.current)

    const res = calculateScore()

    try {
      await addDoc(collection(db, 'readingSubmissions'), {
        uid: user.uid,
        readingId: id,
        answers,
        result: res,
        flaggedQuestions,
        studentNote: studentNote.trim(),
        highlights,
        submittedAt: new Date().toISOString(),
        finishedLate: timeLeft <= 0,
        autoSubmitted: autoSubmit
      })

      setResult(res)
      setSubmitted(true)
    } catch (error) {
      console.error(error)
      alert('Could not submit your answers. Please try again.')
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const renderNoteCompletion = (question, reviewMode = false) => (
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
                  const questionNumber = getNoteBlankNumber(
                    question.id,
                    paragraph.id,
                    part.id
                  )
                  const correct = isNotePartCorrect(question, paragraph, part)

                  if (reviewMode) {
                    return (
                      <span
                        key={part.id}
                        className={`inline-flex items-center gap-2 mx-1 px-2 py-1 rounded-xl border ${
                          correct
                            ? 'bg-green-50 border-green-100'
                            : 'bg-red-50 border-red-100'
                        }`}
                      >
                        <span className="text-xs font-semibold text-purple-600">
                          ({questionNumber})
                        </span>

                        <span className="font-medium text-gray-800">
                          {answers[key] || 'No answer'}
                        </span>

                        {!correct && (
                          <span className="text-xs font-semibold text-green-700">
                            Correct:{' '}
                            {question.mode === 'choose'
                              ? `${part.answer}. ${getNoteOptionText(question, part.answer)}`
                              : part.answer}
                          </span>
                        )}
                      </span>
                    )
                  }

                  if (question.mode === 'choose') {
                    return (
                      <span key={part.id} className="inline-flex items-center gap-2 mx-1">
                        <span className="text-xs font-semibold text-gray-400">
                          ({questionNumber})
                        </span>

                        <select
                          value={answers[key] || ''}
                          onChange={e =>
                            handleNoteCompletion(
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
                        value={answers[key] || ''}
                        onChange={e =>
                          handleNoteCompletion(
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

  if (!reading) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
        <div className="bg-white border border-gray-100 rounded-2xl p-8 max-w-xl w-full text-center shadow-sm">
          {loadError ? (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-3">
                {loadError.title}
              </h1>

              <p className="text-sm text-gray-500 leading-6 mb-5">
                {loadError.message}
              </p>

              <pre className="text-left text-xs bg-gray-50 border border-gray-100 rounded-xl p-4 overflow-x-auto mb-5">
                {JSON.stringify(loadError, null, 2)}
              </pre>

              <button
                onClick={() => navigate('/student')}
                className="bg-purple-600 text-white px-5 py-3 rounded-xl text-sm font-medium hover:bg-purple-700"
              >
                Back to dashboard
              </button>
            </>
          ) : (
            <>
              <p className="text-gray-400 mb-4">Loading reading homework...</p>
              <p className="text-xs text-gray-400">
                Please wait while your homework is loading.
              </p>
            </>
          )}
        </div>
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

        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center shadow-sm mb-8">
            <div className="text-5xl font-bold text-purple-600 mb-2">
              {result.band}
            </div>

            <p className="text-gray-400 text-sm mb-1">
              IELTS Reading Band
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
              <h2 className="font-semibold text-gray-800 mb-5">
                Reading Passage
              </h2>

              {reading.passageMode === 'sections' ? (
                <div className="space-y-8">
                  {reading.paragraphs.map(paragraph => (
                    <div key={paragraph.id}>
                      <h3 className="font-semibold text-gray-900 mb-2">
                        Paragraph {paragraph.letter}
                      </h3>

                      <p
                        data-highlight-block={`paragraph-${paragraph.id || paragraph.letter}`}
                        className="text-sm text-gray-700 leading-7 whitespace-pre-wrap"
                      >
                        {renderHighlightedText(
                          paragraph.text,
                          `paragraph-${paragraph.id || paragraph.letter}`,
                          true
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  data-highlight-block="standard-passage"
                  className="text-sm text-gray-700 leading-7 whitespace-pre-wrap"
                >
                  {renderHighlightedText(
                    reading.passage,
                    'standard-passage',
                    true
                  )}
                </div>
              )}
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
              <h2 className="font-semibold text-gray-800 mb-5">
                Answer Review
              </h2>

              <div className="flex flex-col gap-5">
                {reading.questions.map((question, index) => (
                  <div
                    key={question.id}
                    className="border border-gray-100 rounded-xl p-5"
                  >
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xs font-medium text-gray-400">
                        {getQuestionRangeLabel(question, index)}
                      </span>

                      <span
                        className={`text-xs px-2 py-1 rounded-full ${
                          question.type === 'matching'
                            ? 'bg-indigo-50 text-indigo-600'
                            : question.type === 'sentenceEndings'
                              ? 'bg-cyan-50 text-cyan-600'
                              : question.type === 'summaryOptions'
                                ? 'bg-fuchsia-50 text-fuchsia-600'
                                : question.type === 'tfng'
                              ? 'bg-blue-50 text-blue-600'
                              : question.type === 'fitb'
                                ? 'bg-amber-50 text-amber-600'
                                : (question.type === 'table' || question.type === 'summary' || question.type === 'noteCompletion')
                                  ? 'bg-emerald-50 text-emerald-600'
                                  : 'bg-purple-50 text-purple-600'
                        }`}
                      >
{getQuestionTypeLabel(question)}
                      </span>
                    </div>

                    {question.type === 'matching' && (
                      <div>
                        <p className="font-medium text-sm text-gray-800 mb-4">
                          Matching Headings
                        </p>

                        <div className="flex flex-col gap-3">
                          {question.paragraphs.map(paragraph => {
                            const userAnswer =
                              answers[question.id]?.[paragraph.letter]

                            const correctAnswer = paragraph.answer
                            const correct = isMatchingCorrect(question, paragraph)

                            return (
                              <div
                                key={paragraph.letter}
                                className={`rounded-xl p-4 border ${
                                  correct
                                    ? 'bg-green-50 border-green-100'
                                    : 'bg-red-50 border-red-100'
                                }`}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-sm font-semibold text-gray-800">
                                    Paragraph {paragraph.letter}
                                  </p>

                                  <span
                                    className={`text-xs font-semibold ${
                                      correct
                                        ? 'text-green-600'
                                        : 'text-red-600'
                                    }`}
                                  >
                                    {correct ? 'Correct' : 'Wrong'}
                                  </span>
                                </div>

                                <p className="text-xs text-gray-500 mb-1">
                                  Your answer:
                                </p>

                                <p className="text-sm text-gray-800 mb-2">
                                  {userAnswer
                                    ? `${userAnswer}. ${getHeadingText(userAnswer)}`
                                    : 'No answer'}
                                </p>

                                {!correct && (
                                  <>
                                    <p className="text-xs text-gray-500 mb-1">
                                      Correct answer:
                                    </p>

                                    <p className="text-sm font-medium text-green-700">
                                      {correctAnswer}. {getHeadingText(correctAnswer)}
                                    </p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {question.type === 'matchingInformation' && (
                      <div>
                        <p className="font-medium text-sm text-gray-800 mb-2">
                          Matching Information
                        </p>

                        {question.instruction && (
                          <p className="text-sm text-gray-600 mb-4">
                            {question.instruction}
                          </p>
                        )}

                        <div className="flex flex-col gap-3">
                          {question.items?.map(item => {
                            const userAnswer = answers[question.id]?.[item.id]
                            const correctAnswer = item.answer
                            const correct = isMatchingInformationCorrect(question, item)

                            return (
                              <div
                                key={item.id}
                                className={`rounded-xl p-4 border ${
                                  correct
                                    ? 'bg-green-50 border-green-100'
                                    : 'bg-red-50 border-red-100'
                                }`}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-sm font-semibold text-gray-800">
                                    {item.statement || item.question}
                                  </p>

                                  <span
                                    className={`text-xs font-semibold ${
                                      correct
                                        ? 'text-green-600'
                                        : 'text-red-600'
                                    }`}
                                  >
                                    {correct ? 'Correct' : 'Wrong'}
                                  </span>
                                </div>

                                <p className="text-xs text-gray-500 mb-1">
                                  Your answer:
                                </p>

                                <p className="text-sm text-gray-800 mb-2">
                                  {userAnswer ? `Section ${userAnswer}` : 'No answer'}
                                </p>

                                {!correct && (
                                  <>
                                    <p className="text-xs text-gray-500 mb-1">
                                      Correct answer:
                                    </p>

                                    <p className="text-sm font-medium text-green-700">
                                      Section {correctAnswer}
                                    </p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {question.type === 'sentenceEndings' && (
                      <div>
                        <p className="font-medium text-sm text-gray-800 mb-2">
                          Matching Sentence Endings
                        </p>

                        {question.instruction && (
                          <p className="text-sm text-gray-600 mb-4">
                            {question.instruction}
                          </p>
                        )}

                        <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-5">
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
                          {question.items?.map(item => {
                            const userAnswer = answers[question.id]?.[item.id]
                            const correctAnswer = item.answer
                            const correct = isSentenceEndingCorrect(question, item)

                            return (
                              <div
                                key={item.id}
                                className={`rounded-xl p-4 border ${
                                  correct
                                    ? 'bg-green-50 border-green-100'
                                    : 'bg-red-50 border-red-100'
                                }`}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-sm font-semibold text-gray-800">
                                    {item.sentence}
                                  </p>

                                  <span
                                    className={`text-xs font-semibold ${
                                      correct
                                        ? 'text-green-600'
                                        : 'text-red-600'
                                    }`}
                                  >
                                    {correct ? 'Correct' : 'Wrong'}
                                  </span>
                                </div>

                                <p className="text-xs text-gray-500 mb-1">
                                  Your answer:
                                </p>

                                <p className="text-sm text-gray-800 mb-2">
                                  {userAnswer
                                    ? `${userAnswer}. ${getSentenceEndingText(question, userAnswer)}`
                                    : 'No answer'}
                                </p>

                                {!correct && (
                                  <>
                                    <p className="text-xs text-gray-500 mb-1">
                                      Correct answer:
                                    </p>

                                    <p className="text-sm font-medium text-green-700">
                                      {correctAnswer}. {getSentenceEndingText(question, correctAnswer)}
                                    </p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {question.type === 'summaryOptions' && (
                      <div>
                        <p className="font-medium text-sm text-gray-800 mb-2">
                          {question.title}
                        </p>

                        {question.instruction && (
                          <p className="text-sm text-gray-600 mb-4">
                            {question.instruction}
                          </p>
                        )}

                        <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-5">
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

                        <div className="flex flex-col gap-3">
                          {question.items?.map(item => {
                            const userAnswer = answers[question.id]?.[item.id]
                            const correctAnswer = item.answer
                            const correct = isSummaryOptionCorrect(question, item)

                            return (
                              <div
                                key={item.id}
                                className={`rounded-xl p-4 border ${
                                  correct
                                    ? 'bg-green-50 border-green-100'
                                    : 'bg-red-50 border-red-100'
                                }`}
                              >
                                <div className="flex items-center justify-between mb-3">
                                  <p className="text-sm font-semibold text-gray-800">
                                    Question {item.number}
                                  </p>

                                  <span
                                    className={`text-xs font-semibold ${
                                      correct
                                        ? 'text-green-600'
                                        : 'text-red-600'
                                    }`}
                                  >
                                    {correct ? 'Correct' : 'Wrong'}
                                  </span>
                                </div>

                                <div className="text-sm text-gray-700 leading-7 mb-3">
                                  {item.beforeText && (
                                    <span className="whitespace-pre-wrap">
                                      {item.beforeText}{' '}
                                    </span>
                                  )}

                                  <span className="inline-block min-w-[90px] px-2 py-0.5 rounded-md bg-white border border-gray-200 text-center">
                                    {userAnswer
                                      ? `${userAnswer}. ${getSummaryOptionText(question, userAnswer)}`
                                      : 'No answer'}
                                  </span>

                                  {item.afterText && (
                                    <span className="whitespace-pre-wrap">
                                      {' '}{item.afterText}
                                    </span>
                                  )}
                                </div>

                                {!correct && (
                                  <>
                                    <p className="text-xs text-gray-500 mb-1">
                                      Correct answer:
                                    </p>

                                    <p className="text-sm font-medium text-green-700">
                                      {correctAnswer}. {getSummaryOptionText(question, correctAnswer)}
                                    </p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}


                    {question.type === 'noteCompletion' && renderNoteCompletion(question, true)}

                    {(question.type === 'table' || question.type === 'summary') && (
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
                                        <div className="flex items-center gap-2 mb-2">
                                          <span className="bg-white border border-gray-200 text-purple-600 font-semibold rounded-md px-2 py-1 text-xs">
                                            Q{getReadingBlankNumber(question.id, row.id, cellIndex)}
                                          </span>

                                          <div>
                                            <p className="text-xs text-gray-500 mb-1">
                                              Your answer:
                                            </p>

                                            <p className="text-sm text-gray-800">
                                              {answers[key] || 'No answer'}
                                            </p>
                                          </div>
                                        </div>

                                        {!correct && (
                                          <>
                                            <p className="text-xs text-gray-500 mb-1">
                                              Correct:
                                            </p>

                                            <p className="text-sm font-medium text-green-700">
                                              {cell.answer}
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
                    )}

                    {question.type !== 'matching' && question.type !== 'matchingInformation' && question.type !== 'sentenceEndings' && question.type !== 'summaryOptions' && question.type !== 'noteCompletion' && question.type !== 'table' && question.type !== 'summary' && (
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

              <button
                onClick={() => navigate('/student')}
                className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-8"
              >
                Back to dashboard
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex flex-col md:flex-row md:justify-between md:items-center gap-3 px-5 md:px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-20">
        <img
          src="/1.png"
          alt="Maxima"
          className="h-10 object-contain"
        />

        <div className="flex items-center justify-between md:justify-end gap-4">
          <span className="text-sm font-medium text-gray-700 uppercase tracking-wide truncate max-w-[220px] md:max-w-[520px]">
            {reading.title}
          </span>

          <div
            className={`font-mono text-lg font-bold px-4 py-1.5 rounded-xl flex-shrink-0 ${
              timeLeft <= 60
                ? 'bg-red-50 text-red-600'
                : timeLeft <= 300
                  ? 'bg-amber-50 text-amber-600'
                  : 'bg-green-50 text-green-600'
            }`}
          >
            ⏱ {formatTime(timeLeft)}
          </div>

          <span className="hidden md:inline-flex text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-xl font-semibold">
            {getAnsweredQuestionCount()} / {getTotalQuestionCount()} answered
          </span>
        </div>
      </nav>

      <div className="max-w-[1500px] mx-auto px-4 md:px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6">
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden lg:sticky lg:top-24 lg:h-[calc(100vh-8rem)]">
            <div className="px-5 py-4 border-b border-gray-100 bg-white sticky top-0 z-10">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Reading Passage
                  </h2>

                  <p className="text-xs text-gray-400 mt-0.5">
                    Select text, then press Highlight. Click a yellow highlight to remove it.
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={addPendingHighlight}
                    disabled={!pendingHighlight}
                    className="text-xs bg-yellow-100 text-yellow-800 px-3 py-2 rounded-xl hover:bg-yellow-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    🖍 Highlight
                  </button>

                  <button
                    type="button"
                    onClick={clearHighlights}
                    disabled={highlights.length === 0}
                    className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Clear ({highlights.length})
                  </button>
                </div>
              </div>

              {(pendingHighlight || highlightMessage) && (
                <div className="mt-3 text-xs rounded-xl px-3 py-2 bg-yellow-50 text-yellow-800 border border-yellow-100">
                  {highlightMessage ||
                    `Selected: “${pendingHighlight.text.slice(0, 90)}${pendingHighlight.text.length > 90 ? '…' : ''}”`}
                </div>
              )}
            </div>

            <div
              onMouseUp={captureHighlightSelection}
              onTouchEnd={() => setTimeout(captureHighlightSelection, 0)}
              className="p-5 md:p-7 overflow-y-auto h-[65vh] lg:h-[calc(100vh-12rem)] select-text"
            >
              {reading.passageMode === 'sections' ? (
                <div className="space-y-8">
                  {reading.paragraphs.map(paragraph => (
                    <div key={paragraph.id}>
                      <h3 className="font-semibold text-gray-900 mb-2">
                        Paragraph {paragraph.letter}
                      </h3>

                      <p
                        data-highlight-block={`paragraph-${paragraph.id || paragraph.letter}`}
                        className="text-sm md:text-[15px] text-gray-700 leading-8 whitespace-pre-wrap"
                      >
                        {renderHighlightedText(
                          paragraph.text,
                          `paragraph-${paragraph.id || paragraph.letter}`
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  data-highlight-block="standard-passage"
                  className="text-sm md:text-[15px] text-gray-700 leading-8 whitespace-pre-wrap"
                >
                  {renderHighlightedText(
                    reading.passage,
                    'standard-passage'
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden lg:h-[calc(100vh-8rem)]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-white sticky top-0 z-10">
              <div>
                <h2 className="font-semibold text-gray-800">
                  Questions ({getTotalQuestionCount()})
                </h2>

                <p className="text-xs text-gray-400 mt-0.5">
                  {getAnsweredQuestionCount()} answered · {getTotalQuestionCount() - getAnsweredQuestionCount()} remaining
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowQuestionMap(prev => !prev)}
                className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full hover:bg-purple-100"
              >
                {showQuestionMap ? 'Hide map' : 'Show map'}
              </button>
            </div>

            <div className="p-5 md:p-7 overflow-y-auto h-[65vh] lg:h-[calc(100vh-12rem)]">
              {showQuestionMap && (
                <div className="bg-white border border-purple-100 rounded-2xl p-4 mb-6 shadow-sm">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">
                        Question map
                      </p>

                      <p className="text-xs text-gray-400 mt-0.5">
                        Green: answered · White: unanswered · Amber: flagged
                      </p>
                    </div>

                    <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1 rounded-full">
                      {getAnsweredQuestionCount()} / {getTotalQuestionCount()}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {getQuestionStatuses().map(status => (
                      <button
                        key={status.id}
                        type="button"
                        onClick={() => scrollToQuestion(status.id)}
                        className={`text-xs font-semibold px-3 py-2 rounded-xl border transition-all ${
                          status.flagged
                            ? 'bg-amber-50 border-amber-200 text-amber-700'
                            : status.complete
                              ? 'bg-green-50 border-green-200 text-green-700'
                              : 'bg-white border-gray-200 text-gray-500 hover:border-purple-200'
                        }`}
                        title={`${status.answered}/${status.total} answered`}
                      >
                        {status.label}
                        {status.flagged ? ' ★' : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-6 shadow-sm">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="text-sm font-semibold text-gray-800">
                    Scratch note
                  </p>

                  <span className="text-xs text-gray-400">
                    Saved with your submission
                  </span>
                </div>

                <textarea
                  rows={3}
                  value={studentNote}
                  onChange={e => setStudentNote(e.target.value)}
                  placeholder="Write short notes, keywords or paragraph clues here..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none"
                />
              </div>

          <div className="flex flex-col gap-6">
            {reading.questions.map((question, index) => (
              <div
                key={question.id}
                ref={element => {
                  if (element) questionRefs.current[question.id] = element
                }}
                className={`bg-gray-50 border rounded-2xl p-5 overflow-hidden scroll-mt-28 ${
                  flaggedQuestions.includes(question.id)
                    ? 'border-amber-300 ring-2 ring-amber-100'
                    : 'border-gray-100'
                }`}
              >
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-gray-400">
                      {getQuestionRangeLabel(question, index)}
                    </span>

                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        question.type === 'matching'
                          ? 'bg-indigo-50 text-indigo-600'
                          : question.type === 'sentenceEndings'
                            ? 'bg-cyan-50 text-cyan-600'
                            : question.type === 'summaryOptions'
                              ? 'bg-fuchsia-50 text-fuchsia-600'
                              : question.type === 'tfng'
                            ? 'bg-blue-50 text-blue-600'
                            : question.type === 'fitb'
                              ? 'bg-amber-50 text-amber-600'
                              : (question.type === 'table' || question.type === 'summary' || question.type === 'noteCompletion')
                                ? 'bg-emerald-50 text-emerald-600'
                                : 'bg-purple-50 text-purple-600'
                      }`}
                    >
                      {getQuestionTypeLabel(question)}
                    </span>

                    <span className="text-xs bg-white border border-gray-100 text-gray-500 px-2 py-1 rounded-full">
                      {getQuestionStatus(question, index).answered}/{getQuestionStatus(question, index).total} answered
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => toggleFlagQuestion(question.id)}
                    className={`text-xs px-3 py-1.5 rounded-xl border flex-shrink-0 ${
                      flaggedQuestions.includes(question.id)
                        ? 'bg-amber-50 border-amber-200 text-amber-700'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-amber-200'
                    }`}
                  >
                    {flaggedQuestions.includes(question.id) ? '★ Flagged' : '☆ Review later'}
                  </button>
                </div>

                {question.type === 'matching' && (
                  <div>
                    <p className="font-medium text-sm text-gray-800 mb-4">
                      Choose the correct heading for each paragraph.
                    </p>

                    <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-5">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                        Headings
                      </p>

                      <div className="space-y-2">
                        {reading.headings
                          .filter(Boolean)
                          .map((heading, headingIndex) => (
                            <div
                              key={headingIndex}
                              className={`flex gap-2 text-sm leading-5 rounded-lg px-2 py-1 ${
                                isHeadingUsed(question, String(headingIndex + 1))
                                  ? 'bg-green-50 text-gray-400'
                                  : 'text-gray-700'
                              }`}
                            >
                              <span
                                className={`font-semibold min-w-6 ${
                                  isHeadingUsed(question, String(headingIndex + 1))
                                    ? 'text-green-600'
                                    : 'text-gray-500'
                                }`}
                              >
                                {headingIndex + 1}.
                              </span>

                              <span
                                className={
                                  isHeadingUsed(question, String(headingIndex + 1))
                                    ? 'line-through'
                                    : ''
                                }
                              >
                                {heading}
                              </span>

                              {isHeadingUsed(question, String(headingIndex + 1)) && (
                                <span className="ml-auto text-[10px] font-semibold text-green-600 uppercase tracking-wider">
                                  Used
                                </span>
                              )}
                            </div>
                          ))}
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      {question.paragraphs.map(paragraph => (
                        <div
                          key={paragraph.letter}
                          className="grid grid-cols-[110px_1fr] gap-3 items-center"
                        >
                          <label className="text-sm font-medium text-gray-700">
                            Paragraph {paragraph.letter}
                          </label>

                          <select
                            value={
                              answers[question.id]?.[paragraph.letter] || ''
                            }
                            onChange={e =>
                              handleMatching(
                                question.id,
                                paragraph.letter,
                                e.target.value
                              )
                            }
                            className="w-full min-w-0 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                          >
                            <option value="">Select heading</option>

                            {reading.headings
                              .filter(Boolean)
                              .map((heading, headingIndex) => {
                                const headingValue = String(headingIndex + 1)
                                const usedByOther = isHeadingUsedByOtherParagraph(
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
                                    {getHeadingOptionLabel(
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
                            value={answers[question.id]?.[item.id] || ''}
                            onChange={e =>
                              handleMatchingInformation(
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
                            value={answers[question.id]?.[item.id] || ''}
                            onChange={e =>
                              handleSentenceEnding(
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
                                value={answers[question.id]?.[item.id] || ''}
                                onChange={e =>
                                  handleSummaryOption(
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

                {question.type === 'noteCompletion' && renderNoteCompletion(question)}

                {(question.type === 'table' || question.type === 'summary') && (
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
                                    <div className="flex items-center gap-2">
                                      <span className="bg-purple-50 border border-purple-100 text-purple-600 font-semibold rounded-md px-2 py-1 text-xs">
                                        Q{getReadingBlankNumber(question.id, row.id, cellIndex)}
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

              <div className="bg-white border border-gray-100 rounded-2xl p-4 mt-8">
                <div className="flex items-center justify-between gap-3 mb-3 text-xs text-gray-500">
                  <span>
                    Answered: {getAnsweredQuestionCount()} / {getTotalQuestionCount()}
                  </span>

                  <span>
                    Flagged: {flaggedQuestions.length}
                  </span>
                </div>

                <button
                  onClick={() => handleSubmit(false)}
                  disabled={submitting}
                  className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
                >
                  {submitting ? 'Submitting...' : 'Submit answers'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}