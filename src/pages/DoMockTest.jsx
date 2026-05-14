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

function getListeningQuestionRangeLabel(parts, partId, questionIndex) {
  let start = 1

  for (const part of parts || []) {
    if (part.id === partId) {
      const previousQuestionsTotal = (part.questions || [])
        .slice(0, questionIndex)
        .reduce(
          (sum, item) => sum + getListeningQuestionCount(item),
          0
        )

      start += previousQuestionsTotal

      const question = part.questions?.[questionIndex]
      const count = getListeningQuestionCount(question)
      const end = start + count - 1

      return count > 1 ? `Q${start}-${end}` : `Q${start}`
    }

    start += getListeningPartQuestionTotal(part)
  }

  return `Q${questionIndex + 1}`
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
              return number
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
              return number
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
  const [submitting, setSubmitting] = useState(false)

  const submittingRef = useRef(false)
  const handleSubmitMockRef = useRef(null)
  const restoredRef = useRef(false)
  const loadingRef = useRef(true)
  const audioRef = useRef(null)
  const audioLastTimeRef = useRef(0)
  const listeningTickRef = useRef(null)
  const readingTickRef = useRef(null)
  const writingTickRef = useRef(null)
  const tabSwitchCountRef = useRef(0)
  const pendingListeningAutoPlayRef = useRef(false)

  const [audioStarted, setAudioStarted] = useState(false)
  const [audioLocked, setAudioLocked] = useState(false)
  const [audioWarning, setAudioWarning] = useState('')
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

        if (!mockData.assignTo?.includes(currentUser.uid)) {
          alert('This mock test is not assigned to you.')
          navigate('/student')
          return
        }

        if (mockData.hiddenFor?.includes(currentUser.uid) || mockData.archived === true) {
          alert('This mock test is no longer available.')
          navigate('/student')
          return
        }

        setMock(mockData)

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
          const submission = existingSnap.docs[0].data()
          setFinalResult(submission.result || null)

          const key = `mock_progress_${id}_${currentUser.uid}`
          localStorage.removeItem(key)
        }

        const readingIds = Array.isArray(mockData.readingIds)
          ? mockData.readingIds.filter(Boolean)
          : mockData.readingId
            ? [mockData.readingId]
            : []

        const listeningIds = Array.isArray(mockData.listeningIds)
          ? mockData.listeningIds.filter(Boolean)
          : mockData.listeningId
            ? [mockData.listeningId]
            : []

        if (listeningIds.length === 0) {
          throw new Error('Mock test is missing listeningIds.')
        }

        if (readingIds.length === 0) {
          throw new Error('Mock test is missing readingIds.')
        }

        if (!mockData.writingId) {
          throw new Error('Mock test is missing writingId.')
        }

        const [listeningDocs, writingSnap] = await Promise.all([
          Promise.all(
            listeningIds.map(listeningId =>
              getDoc(doc(db, 'listenings', listeningId))
            )
          ),
          getDoc(doc(db, 'writingHomeworks', mockData.writingId))
        ])

        if (!isActive) return

        const loadedListenings = listeningDocs
          .filter(snap => snap.exists())
          .map(snap => ({ id: snap.id, ...snap.data() }))

        if (loadedListenings.length === 0) {
          throw new Error('Listening test was not found.')
        }

        if (!writingSnap.exists()) {
          throw new Error('Writing test was not found.')
        }

        setListenings(loadedListenings)
        setWriting({ id: writingSnap.id, ...writingSnap.data() })

        const readingDocs = await Promise.all(
          readingIds.map(readingId => getDoc(doc(db, 'readings', readingId)))
        )

        if (!isActive) return

        const loadedReadings = readingDocs
          .filter(snap => snap.exists())
          .map(snap => ({ id: snap.id, ...snap.data() }))

        if (loadedReadings.length === 0) {
          throw new Error('No reading tests were found for this mock.')
        }

        setReadings(loadedReadings)

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

    setListeningTimeLeft(saved.listeningTimeLeft ?? LISTENING_DURATION)
    setReadingTimeLeft(saved.readingTimeLeft ?? READING_DURATION)
    setWritingTimeLeft(saved.writingTimeLeft ?? WRITING_DURATION)

    setListeningStarted(Boolean(saved.listeningStarted))
    setReadingStarted(Boolean(saved.readingStarted))
    setWritingStarted(Boolean(saved.writingStarted))

    setListeningLocked(Boolean(saved.listeningLocked))
    setReadingLocked(Boolean(saved.readingLocked))
    setWritingLocked(Boolean(saved.writingLocked))

    setAudioStarted(Boolean(saved.audioStarted))
    setAudioLocked(Boolean(saved.audioLocked))

    restoredRef.current = true
  }, [storageKey, loading, alreadySubmitted, finalResult])

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

      return normalizedParts.map((part, partIndex) => ({
        ...part,
        id: `${listeningItem.id}_${part.id || partIndex}`,
        originalPartId: part.id,
        listeningId: listeningItem.id,
        listeningTitle: listeningItem.title || `Listening ${listeningIndex + 1}`,
        listeningAudioUrl: listeningItem.audioUrl || '',
        listeningInstructions: listeningItem.instructions || '',
        displayTitle:
          listenings.length > 1
            ? `L${listeningIndex + 1}`
            : part.title || `Part ${partIndex + 1}`
      }))
    })
  }, [listenings])

  const sections = useMemo(() => {
    return [
      { key: 'intro', label: 'Start' },
      ...listeningParts.map((part, index) => ({
        key: `listening-${index}`,
        label: `L${index + 1}`,
        listeningPart: part,
        listeningPartIndex: index
      })),
      { key: 'prepare-reading', label: 'Prepare Reading' },
      ...readings.map((reading, index) => ({
        key: `reading-${index}`,
        label: `Reading ${index + 1}`,
        reading,
        readingIndex: index
      })),
      { key: 'prepare-writing', label: 'Prepare Writing' },
      { key: 'writing-task1', label: 'Writing T1' },
      { key: 'writing-task2', label: 'Writing T2' },
      { key: 'review', label: 'Review' }
    ]
  }, [readings, listeningParts])

  const activeSection = sections[sectionIndex] || sections[0]

  useEffect(() => {
    if (!activeSection.key?.startsWith('listening-')) return

    setAudioStarted(false)
    setAudioLocked(false)
    setAudioWarning('')
    audioLastTimeRef.current = 0

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
    writingLocked
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
    const listeningResult = scoreListening()

    const readingResults = readings.map(reading => ({
      readingId: reading.id,
      title: reading.title,
      ...scoreReading(reading)
    }))

    const totalReadingCorrect = readingResults.reduce(
      (sum, item) => sum + item.correct,
      0
    )

    const totalReadingQuestions = readingResults.reduce(
      (sum, item) => sum + item.total,
      0
    )

    const readingBand = getReadingBand(
      totalReadingCorrect,
      totalReadingQuestions
    )

    const availableBands = [listeningResult.band, readingBand].filter(Boolean)

    const overallEstimate = availableBands.length
      ? Math.round(
          (availableBands.reduce((sum, band) => sum + band, 0) /
            availableBands.length) *
            2
        ) / 2
      : null

    return {
      listening: listeningResult,
      reading: {
        correct: totalReadingCorrect,
        total: totalReadingQuestions,
        band: readingBand,
        passages: readingResults
      },
      writing: {
        status: 'pending_review',
        task1WordCount: countWords(writingAnswers.task1),
        task2WordCount: countWords(writingAnswers.task2)
      },
      overallEstimate
    }
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
    if (!audioRef.current) return

    const currentTime = audioRef.current.currentTime

    if (currentTime > audioLastTimeRef.current + 1.5) {
      audioRef.current.currentTime = audioLastTimeRef.current
      setAudioWarning('Audio seeking is not allowed during the listening section.')
      return
    }

    if (audioStarted && currentTime < audioLastTimeRef.current - 1.5) {
      audioRef.current.currentTime = audioLastTimeRef.current
      setAudioWarning('Audio replay is not allowed during the listening section.')
    }
  }

  const handleAudioTimeUpdate = () => {
    if (!audioRef.current) return

    if (audioRef.current.currentTime > audioLastTimeRef.current) {
      audioLastTimeRef.current = audioRef.current.currentTime
    }
  }

  const handleAudioEnded = () => {
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
      const task1Words = countWords(writingAnswers.task1)
      const task2Words = countWords(writingAnswers.task2)

      if (task1Words < 50 || task2Words < 100) {
        const continueAnyway = window.confirm(
          `Your writing answers look very short.\n\nTask 1: ${task1Words} words\nTask 2: ${task2Words} words\n\nSubmit anyway?`
        )

        if (!continueAnyway) return
      }

      const ok = window.confirm(
        'Submit the full mock test? You cannot edit it after submission.'
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

        const existingSubmission = existingSnap.docs[0].data()
        setFinalResult(existingSubmission.result || null)

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

      await addDoc(collection(db, 'mockSubmissions'), {
        uid: user.uid,
        mockTestId: mock.id,
        title: mock.title || 'Untitled Mock Test',
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
        submittedAt,
        status: 'submitted'
      })

      try {
        await addDoc(collection(db, 'scores'), {
          uid: user.uid,
          date: submittedAt.slice(0, 10),
          source: 'mock_test',
          mockTestId: mock.id,
          listening: result.listening?.band || '',
          reading: result.reading?.band || '',
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
    sections.length
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

    if (listeningLocked && readingLocked && writingLocked) {
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
    writingLocked
  ])

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
    goToSection(sectionIndex + 1)
  }

  const prevSection = () => {
    setSectionIndex(prev => {
      let target = Math.max(prev - 1, 0)

      while (
        target > 0 &&
        (
          sections[target]?.key === 'prepare-reading' ||
          sections[target]?.key === 'prepare-writing'
        )
      ) {
        target = Math.max(target - 1, 0)
      }

      return target
    })

    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleSectionTabClick = index => {
    if (index > maxUnlockedSectionIndex) return

    const targetSection = sections[index]

    if (
      index < sectionIndex &&
      (
        targetSection?.key === 'prepare-reading' ||
        targetSection?.key === 'prepare-writing'
      )
    ) {
      return
    }

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

  const renderListening = part => (
    <div className="space-y-6">
      {renderSectionTimerCard()}

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

        <audio
          ref={audioRef}
          controls
          controlsList="nodownload noplaybackrate"
          disablePictureInPicture
          src={part?.listeningAudioUrl}
          className="w-full"
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

            {question.type === 'map' && (
              <div>
                <p className="text-sm text-gray-700 mb-4">
                  {question.instruction}
                </p>

                {question.mapImage && (
                  <img
                    src={question.mapImage}
                    alt="Map"
                    className="w-full max-h-[460px] object-contain rounded-xl bg-gray-50 border border-gray-100 mb-4"
                  />
                )}

                <div className="bg-gray-50 rounded-xl p-4 mb-4">
                  <p className="text-xs font-semibold text-gray-400 mb-2">
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

                <div className="flex flex-col gap-3">
                  {question.mapItems?.map(item => (
                    <div
                      key={item.id}
                      className="grid grid-cols-[1fr_130px] gap-3 items-center"
                    >
                      <p className="text-sm text-gray-800">{item.prompt}</p>

                      <select
                        value={listeningAnswers[mapAnswerKey(question.id, item.id)] || ''}
                        onChange={e =>
                          handleListeningMapAnswer(
                            question.id,
                            item.id,
                            e.target.value
                          )
                        }
                        className="border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
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

      {readingLocked && (
        <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 text-sm font-medium">
          ⏰ Reading time is up. Your answers are saved. Move to the next section.
        </div>
      )}

      <fieldset disabled={readingLocked} className={readingLocked ? 'opacity-60' : ''}>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6">
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden lg:sticky lg:top-[150px] lg:h-[calc(100vh-12rem)]">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-100 bg-white sticky top-0 z-10">
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

            <div className="p-5 md:p-7 overflow-y-auto h-[65vh] lg:h-[calc(100vh-16rem)]">
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
                </div>
              ) : (
                <div className="text-sm md:text-[15px] text-gray-700 leading-8 whitespace-pre-wrap">
                  {reading.passage}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden lg:h-[calc(100vh-12rem)]">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-100 bg-white sticky top-0 z-10">
              <h2 className="font-semibold text-gray-800">
                Questions ({getTotalReadingQuestionCount(reading)})
              </h2>

              <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                Answer panel
              </span>
            </div>

            <div className="p-5 md:p-7 overflow-y-auto h-[65vh] lg:h-[calc(100vh-16rem)]">
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
                            <p
                              key={headingIndex}
                              className="text-sm text-gray-700 mb-1"
                            >
                              <span className="font-semibold">
                                {headingIndex + 1}.
                              </span>{' '}
                              {heading}
                            </p>
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

                                {reading.headings?.filter(Boolean).map((heading, headingIndex) => (
                                  <option
                                    key={headingIndex}
                                    value={String(headingIndex + 1)}
                                  >
                                    {headingIndex + 1}. {heading}
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
            Task 1 and Task 2 share a 60-minute timer. You can move between them freely.
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
            Task 2 carries more weight than Task 1 in the final writing band.
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

    const description = isReading
      ? 'The Listening section is complete. Your Reading timer has not started yet. When you are ready, click Start Reading.'
      : 'The Reading section is complete. Your Writing timer has not started yet. When you are ready, click Start Writing.'

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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8 text-left">
          <div className={`rounded-xl p-4 ${isReading ? 'bg-green-50' : 'bg-gray-50'}`}>
            <p className="text-xs text-gray-500 mb-1">Listening</p>
            <p className={`text-xl font-bold ${isReading ? 'text-green-600' : 'text-gray-500'}`}>
              Completed
            </p>
          </div>

          <div className={`rounded-xl p-4 ${isReading ? 'bg-blue-50' : 'bg-green-50'}`}>
            <p className="text-xs text-gray-500 mb-1">Reading</p>
            <p className={`text-xl font-bold ${isReading ? 'text-blue-600' : 'text-green-600'}`}>
              {isReading ? 'Ready' : 'Completed'}
            </p>
          </div>

          <div className={`rounded-xl p-4 ${isReading ? 'bg-gray-50' : 'bg-amber-50'}`}>
            <p className="text-xs text-gray-500 mb-1">Writing</p>
            <p className={`text-xl font-bold ${isReading ? 'text-gray-500' : 'text-amber-600'}`}>
              {isReading ? 'Locked' : 'Ready'}
            </p>
          </div>
        </div>

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

    return (
      <div className="space-y-6">
        <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Review & Submit
          </h2>

          <p className="text-gray-500 text-sm mb-6">
            Your answers are ready to submit. Scores and correct/incorrect counts will only be shown after final submission.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-purple-50 rounded-2xl p-5">
              <p className="text-xs text-gray-500 mb-1">Listening</p>
              <p className="text-xl font-bold text-purple-600">
                Completed
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Result hidden until submission
              </p>
            </div>

            <div className="bg-blue-50 rounded-2xl p-5">
              <p className="text-xs text-gray-500 mb-1">Reading</p>
              <p className="text-xl font-bold text-blue-600">
                Completed
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Result hidden until submission
              </p>
            </div>

            <div className="bg-amber-50 rounded-2xl p-5">
              <p className="text-xs text-gray-500 mb-1">Writing</p>
              <p className="text-xl font-bold text-amber-600">Pending</p>
              <p className="text-xs text-gray-500 mt-1">
                Teacher review required
              </p>
            </div>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-5">
          <h3 className="font-semibold text-amber-700 mb-2">
            Important
          </h3>

          <p className="text-sm text-amber-700 leading-6">
            Once you submit, you cannot edit this mock test again. Listening and Reading scores will be calculated after submission. Writing will wait for teacher review.
          </p>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-5">
          <h3 className="font-semibold text-gray-800 mb-3">
            Writing Word Count
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Task 1</p>
              <p className="text-xl font-bold text-gray-800">
                {t1Words} words
              </p>
              <p
                className={`text-xs mt-1 ${
                  t1Words >= 150 ? 'text-green-600' : 'text-amber-600'
                }`}
              >
                {t1Words >= 150 ? '✓ Above minimum' : 'Below 150 words'}
              </p>
            </div>

            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Task 2</p>
              <p className="text-xl font-bold text-gray-800">
                {t2Words} words
              </p>
              <p
                className={`text-xs mt-1 ${
                  t2Words >= 250 ? 'text-green-600' : 'text-amber-600'
                }`}
              >
                {t2Words >= 250 ? '✓ Above minimum' : 'Below 250 words'}
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={() => handleSubmitMock()}
          disabled={submitting}
          className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
        >
          {submitting ? 'Submitting...' : 'Submit Full Mock Test'}
        </button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading mock test...</p>
      </div>
    )
  }

  if (finalResult) {
    return (
      <div className="min-h-screen bg-[#faf9f6]">
        <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
          <img src="/1.png" alt="Maxima" className="h-14 object-contain" />

          <button
            onClick={() => navigate('/student')}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            ← Back to Dashboard
          </button>
        </nav>

        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center mb-6">
            <p className="text-sm text-gray-400 mb-2">
              Mock Test Submitted
            </p>

            <h1 className="text-3xl font-bold text-gray-900 mb-4">
              {mock?.title}
            </h1>

            <p className="text-5xl font-bold text-purple-600 mb-2">
              {finalResult.overallEstimate || '-'}
            </p>

            <p className="text-sm text-gray-500">
              Overall estimate without Writing review
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-100 rounded-2xl p-5">
              <p className="text-xs text-gray-400 mb-1">Listening</p>
              <p className="text-3xl font-bold text-purple-600">
                {finalResult.listening.band}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {finalResult.listening.correct}/{finalResult.listening.total}
              </p>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-5">
              <p className="text-xs text-gray-400 mb-1">Reading</p>
              <p className="text-3xl font-bold text-blue-600">
                {finalResult.reading.band}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {finalResult.reading.correct}/{finalResult.reading.total}
              </p>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-5">
              <p className="text-xs text-gray-400 mb-1">Writing</p>
              <p className="text-xl font-bold text-amber-600">Pending</p>
              <p className="text-xs text-gray-400 mt-1">
                Teacher review required
              </p>
            </div>
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
            onClick={() => navigate('/student')}
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
              const locked = index > maxUnlockedSectionIndex

              return (
                <button
                  key={section.key}
                  type="button"
                  disabled={locked}
                  onClick={() => handleSectionTabClick(index)}
                  className={`text-xs px-4 py-2 rounded-full whitespace-nowrap ${
                    sectionIndex === index
                      ? 'bg-purple-600 text-white'
                      : index < sectionIndex || index <= maxUnlockedSectionIndex
                        ? 'bg-green-50 text-green-600'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed opacity-60'
                  }`}
                  title={locked ? 'Complete the current section first.' : section.label}
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

            <p className="text-gray-500 mb-6">
              This mock test runs in order: selected Listening part(s) → Prepare for Reading → Reading section(s) → Prepare for Writing → Writing Task 1 → Writing Task 2 → Review.
            </p>

            <div className="grid grid-cols-3 gap-3 mb-8 text-left">
              <div className="bg-purple-50 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Listening</p>
                <p className="text-2xl font-bold text-purple-600">35 min</p>
              </div>

              <div className="bg-blue-50 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Reading</p>
                <p className="text-2xl font-bold text-blue-600">60 min</p>
              </div>

              <div className="bg-amber-50 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Writing</p>
                <p className="text-2xl font-bold text-amber-600">60 min</p>
              </div>
            </div>

            <p className="text-xs text-gray-400 mb-6">
              ⚠ When a section&apos;s timer runs out, that section is locked and cannot be edited.
            </p>

            <button
              onClick={nextSection}
              className="bg-purple-600 text-white rounded-xl px-8 py-4 text-sm font-medium hover:bg-purple-700"
            >
              Start Mock Test
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