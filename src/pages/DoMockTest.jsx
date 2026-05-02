import { useEffect, useMemo, useRef, useState } from 'react'
import { auth, db } from '../firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

// Section süreleri (saniye)
const LISTENING_DURATION = 30 * 60
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

function getReadingQuestionCount(question) {
  if (question.type === 'matching') return question.paragraphs?.length || 0

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

function getQuestionRangeLabel(questions, question, index) {
  const start = questions
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

function getWritingTask1Prompt(writing) {
  return extractPromptText(getWritingTask1Source(writing)) || 'Writing Task 1 prompt is missing.'
}

function getWritingTask2Prompt(writing) {
  return extractPromptText(getWritingTask2Source(writing)) || 'Writing Task 2 prompt is missing.'
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

export default function DoMockTest() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [mock, setMock] = useState(null)
  const [listening, setListening] = useState(null)
  const [readings, setReadings] = useState([])
  const [writing, setWriting] = useState(null)
  const [loading, setLoading] = useState(true)
  const [alreadySubmitted, setAlreadySubmitted] = useState(false)

  const [sectionIndex, setSectionIndex] = useState(0)
  const [listeningAnswers, setListeningAnswers] = useState({})
  const [readingAnswers, setReadingAnswers] = useState({})
  const [writingAnswers, setWritingAnswers] = useState({
    task1: '',
    task2: ''
  })

  // Timer states
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

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      setUser(currentUser)

      const mockSnap = await getDoc(doc(db, 'mockTests', id))

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

      setMock(mockData)

      const existingQuery = query(
        collection(db, 'mockSubmissions'),
        where('uid', '==', currentUser.uid),
        where('mockTestId', '==', id)
      )

      const existingSnap = await getDocs(existingQuery)

      if (!existingSnap.empty) {
        setAlreadySubmitted(true)
        const submission = existingSnap.docs[0].data()
        setFinalResult(submission.result || null)
      }

      const readingIds = mockData.readingIds || (mockData.readingId ? [mockData.readingId] : [])

      const [listeningSnap, writingSnapPrimary, writingSnapFallback] = await Promise.all([
        getDoc(doc(db, 'listenings', mockData.listeningId)),
        getDoc(doc(db, 'writings', mockData.writingId)),
        getDoc(doc(db, 'writingHomeworks', mockData.writingId))
      ])

      if (listeningSnap.exists()) {
        setListening({ id: listeningSnap.id, ...listeningSnap.data() })
      }

      if (writingSnapPrimary.exists()) {
        setWriting({ id: writingSnapPrimary.id, ...writingSnapPrimary.data() })
      } else if (writingSnapFallback.exists()) {
        setWriting({ id: writingSnapFallback.id, ...writingSnapFallback.data() })
      }

      const readingDocs = await Promise.all(
        readingIds.map(readingId => getDoc(doc(db, 'readings', readingId)))
      )

      setReadings(
        readingDocs
          .filter(snap => snap.exists())
          .map(snap => ({ id: snap.id, ...snap.data() }))
      )

      setLoading(false)
    })

    return unsub
  }, [id, navigate])

  const sections = useMemo(() => {
    return [
      { key: 'intro', label: 'Start' },
      { key: 'listening', label: 'Listening' },
      ...readings.map((reading, index) => ({
        key: `reading-${index}`,
        label: `Reading ${index + 1}`,
        reading,
        readingIndex: index
      })),
      { key: 'writing-task1', label: 'Writing T1' },
      { key: 'writing-task2', label: 'Writing T2' },
      { key: 'review', label: 'Review' }
    ]
  }, [readings])

  const activeSection = sections[sectionIndex] || sections[0]

  // Timer: Listening
  useEffect(() => {
    if (!listeningStarted || listeningLocked) return
    if (listeningTimeLeft <= 0) {
      setListeningLocked(true)
      return
    }

    const interval = setInterval(() => {
      setListeningTimeLeft(prev => {
        if (prev <= 1) {
          setListeningLocked(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [listeningStarted, listeningLocked, listeningTimeLeft])

  // Timer: Reading
  useEffect(() => {
    if (!readingStarted || readingLocked) return
    if (readingTimeLeft <= 0) {
      setReadingLocked(true)
      return
    }

    const interval = setInterval(() => {
      setReadingTimeLeft(prev => {
        if (prev <= 1) {
          setReadingLocked(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [readingStarted, readingLocked, readingTimeLeft])

  // Timer: Writing
  useEffect(() => {
    if (!writingStarted || writingLocked) return
    if (writingTimeLeft <= 0) {
      setWritingLocked(true)
      return
    }

    const interval = setInterval(() => {
      setWritingTimeLeft(prev => {
        if (prev <= 1) {
          setWritingLocked(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [writingStarted, writingLocked, writingTimeLeft])

  // Section değişince timer başlat
  useEffect(() => {
    if (activeSection.key === 'listening' && !listeningStarted && !listeningLocked) {
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
  }, [activeSection.key, listeningStarted, readingStarted, writingStarted, listeningLocked, readingLocked, writingLocked])

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

  const isReadingNormalCorrect = (readingId, question) => {
    const value = readingAnswers[readingId]?.[question.id]

    if (question.type === 'mcq' && question.mode === 'multi') {
      return sortAnswers(value).join('|') === sortAnswers(question.answers || []).join('|')
    }

    return normalize(value) === normalize(question.answer)
  }

  const isListeningNormalCorrect = question => {
    const value = listeningAnswers[question.id]

    if (question.type === 'mcq' && question.mode === 'multi') {
      return sortAnswers(value).join('|') === sortAnswers(question.answers || []).join('|')
    }

    return normalize(value) === normalize(question.answer)
  }

  const scoreListening = () => {
    if (!listening || !Array.isArray(listening.questions)) {
      return { correct: 0, total: 0, band: 0 }
    }

    let correct = 0
    let total = 0

    listening.questions.forEach(question => {
      if (question.type === 'table' || question.type === 'note') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type === 'blank') {
              total++
              const userAnswer = listeningAnswers[tableAnswerKey(question.id, row.id, cellIndex)]
              if (isBlankCorrect(userAnswer, cell.answer, cell.acceptedAnswers, cell.maxWords)) correct++
            }
          })
        })
        return
      }

      if (question.type === 'map') {
        question.mapItems?.forEach(item => {
          total++
          const userAnswer = listeningAnswers[mapAnswerKey(question.id, item.id)]
          if (normalize(userAnswer) === normalize(item.answer)) correct++
        })
        return
      }

      total++
      if (isListeningNormalCorrect(question)) correct++
    })

    return {
      correct,
      total,
      band: getBandFromPercentage(correct, total)
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
          if (userAnswer?.toString() === paragraph.answer?.toString()) correct++
        })
        return
      }

      if (question.type === 'table' || question.type === 'summary') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type === 'blank') {
              total++
              const userAnswer = readingAnswers[reading.id]?.[tableAnswerKey(question.id, row.id, cellIndex)]
              if (normalize(userAnswer) === normalize(cell.answer)) correct++
            }
          })
        })
        return
      }

      total++
      if (isReadingNormalCorrect(reading.id, question)) correct++
    })

    return {
      correct,
      total,
      band: getBandFromPercentage(correct, total)
    }
  }

  const getMockResult = () => {
    const listeningResult = scoreListening()
    const readingResults = readings.map(reading => ({
      readingId: reading.id,
      title: reading.title,
      ...scoreReading(reading)
    }))

    const totalReadingCorrect = readingResults.reduce((sum, item) => sum + item.correct, 0)
    const totalReadingQuestions = readingResults.reduce((sum, item) => sum + item.total, 0)

    const readingBand = getBandFromPercentage(totalReadingCorrect, totalReadingQuestions)

    const availableBands = [
      listeningResult.band,
      readingBand
    ].filter(Boolean)

    const overallEstimate = availableBands.length
      ? Math.round((availableBands.reduce((sum, band) => sum + band, 0) / availableBands.length) * 2) / 2
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

  const handleSubmitMock = async ({ auto = false } = {}) => {
    if (submittingRef.current) return
    if (alreadySubmitted) {
      if (!auto) alert('You already submitted this mock test.')
      return
    }

    if (!auto) {
      const ok = window.confirm('Submit the full mock test? You cannot edit it after submission.')
      if (!ok) return
    }

    submittingRef.current = true
    setSubmitting(true)

    try {
      const result = getMockResult()

      await addDoc(collection(db, 'mockSubmissions'), {
        uid: user.uid,
        mockTestId: mock.id,
        title: mock.title,
        listeningId: mock.listeningId,
        readingIds: mock.readingIds || [],
        writingId: mock.writingId,
        listeningAnswers,
        readingAnswers,
        writingAnswers,
        result,
        autoSubmitted: auto,
        submittedAt: new Date().toISOString(),
        status: 'submitted'
      })

      await addDoc(collection(db, 'scores'), {
        uid: user.uid,
        date: new Date().toISOString().slice(0, 10),
        source: 'mock_test',
        mockTestId: mock.id,
        listening: result.listening.band,
        reading: result.reading.band,
        writing: '',
        speaking: '',
        overall: result.overallEstimate,
        createdAt: new Date().toISOString()
      })

      setFinalResult(result)
      setAlreadySubmitted(true)
      setSectionIndex(sections.length - 1)
    } catch (error) {
      console.error(error)
      alert('Could not submit mock test.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const nextSection = () => {
    setSectionIndex(prev => Math.min(prev + 1, sections.length - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const prevSection = () => {
    setSectionIndex(prev => Math.max(prev - 1, 0))
    window.scrollTo({ top: 0, behavior: 'smooth' })
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
          <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

          <button
            onClick={() => navigate('/student')}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            ← Back to Dashboard
          </button>
        </nav>

        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center mb-6">
            <p className="text-sm text-gray-400 mb-2">Mock Test Submitted</p>
            <h1 className="text-3xl font-bold text-gray-900 mb-4">{mock.title}</h1>
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
              <p className="text-3xl font-bold text-purple-600">{finalResult.listening.band}</p>
              <p className="text-xs text-gray-400 mt-1">
                {finalResult.listening.correct}/{finalResult.listening.total}
              </p>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-5">
              <p className="text-xs text-gray-400 mb-1">Reading</p>
              <p className="text-3xl font-bold text-blue-600">{finalResult.reading.band}</p>
              <p className="text-xs text-gray-400 mt-1">
                {finalResult.reading.correct}/{finalResult.reading.total}
              </p>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-5">
              <p className="text-xs text-gray-400 mb-1">Writing</p>
              <p className="text-xl font-bold text-amber-600">Pending</p>
              <p className="text-xs text-gray-400 mt-1">Teacher review required</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Aktif timer ve etiket
  const getActiveTimerInfo = () => {
    if (activeSection.key === 'listening') {
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
      <div className={`border rounded-2xl p-5 mb-6 ${
        timerInfo.locked
          ? 'bg-red-50 border-red-100'
          : timerInfo.time < 300
            ? 'bg-amber-50 border-amber-100'
            : 'bg-purple-50 border-purple-100'
      }`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
              Active Section Timer
            </p>
            <p className={`text-lg font-bold ${
              timerInfo.locked
                ? 'text-red-600'
                : timerInfo.time < 300
                  ? 'text-amber-600'
                  : 'text-purple-700'
            }`}>
              {timerInfo.label}
            </p>
          </div>

          <div className={`font-mono text-4xl font-bold ${
            timerInfo.locked
              ? 'text-red-600'
              : timerInfo.time < 300
                ? 'text-amber-600'
                : 'text-purple-700'
          }`}>
            {timerInfo.locked ? 'TIME UP' : formatTime(timerInfo.time)}
          </div>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          When the timer reaches zero, this section is locked and answers are saved as they are.
        </p>
      </div>
    )
  }

  const renderListening = () => (
    <div className="space-y-6">
      {renderSectionTimerCard()}
      {listeningLocked && (
        <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 text-sm font-medium">
          ⏰ Listening time is up. Your answers are saved. Move to the next section.
        </div>
      )}

      <div className="bg-white border border-gray-100 rounded-2xl p-6 sticky top-[120px] z-10">
        <h2 className="text-xl font-bold text-gray-900 mb-2">{listening?.title}</h2>
        {listening?.instructions && (
          <p className="text-sm text-gray-500 mb-4 whitespace-pre-wrap">{listening.instructions}</p>
        )}
        <audio controls src={listening?.audioUrl} className="w-full" />
      </div>

      <fieldset disabled={listeningLocked} className={listeningLocked ? 'opacity-60' : ''}>
        {listening?.questions?.map((question, index) => (
          <div key={question.id} className="bg-white border border-gray-100 rounded-2xl p-6 mb-6">
            <p className="text-xs text-purple-600 font-semibold mb-2">Listening Q{index + 1}</p>

            {question.type === 'mcq' && (
              <div>
                <p className="text-sm text-gray-800 mb-3">{question.question}</p>
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
                    const selected = question.mode === 'multi'
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
                <p className="text-sm text-gray-800 mb-3">{question.question}</p>
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
                <p className="text-sm text-gray-800 mb-3">{question.question}</p>
                <input
                  value={listeningAnswers[question.id] || ''}
                  onChange={e => handleListeningAnswer(question.id, e.target.value)}
                  placeholder="Type your answer..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"
                />
              </div>
            )}

            {(question.type === 'table' || question.type === 'note') && (
              <div>
                <p className="text-sm text-gray-700 mb-4">{question.instruction}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                    <thead>
                      <tr className="bg-gray-100">
                        {question.columns?.map((column, columnIndex) => (
                          <th key={columnIndex} className="p-3 text-left font-semibold text-gray-700 border border-white">
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
                                <td key={cellIndex} className="p-3 bg-gray-50 border border-white text-gray-700 whitespace-pre-wrap">
                                  {cell.text}
                                </td>
                              )
                            }

                            const key = tableAnswerKey(question.id, row.id, cellIndex)

                            return (
                              <td key={cellIndex} className="p-3 bg-gray-50 border border-white">
                                <input
                                  value={listeningAnswers[key] || ''}
                                  onChange={e => handleListeningTableAnswer(question.id, row.id, cellIndex, e.target.value)}
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

            {question.type === 'map' && (
              <div>
                <p className="text-sm text-gray-700 mb-4">{question.instruction}</p>
                {question.mapImage && (
                  <img
                    src={question.mapImage}
                    alt="Map"
                    className="w-full max-h-[460px] object-contain rounded-xl bg-gray-50 border border-gray-100 mb-4"
                  />
                )}

                <div className="bg-gray-50 rounded-xl p-4 mb-4">
                  <p className="text-xs font-semibold text-gray-400 mb-2">Map letters</p>
                  <div className="grid grid-cols-2 gap-2">
                    {question.mapLocations?.map(location => (
                      <p key={location.id} className="text-xs text-gray-600">
                        <span className="font-bold">{location.label}</span> {location.text}
                      </p>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  {question.mapItems?.map(item => (
                    <div key={item.id} className="grid grid-cols-[1fr_130px] gap-3 items-center">
                      <p className="text-sm text-gray-800">{item.prompt}</p>
                      <select
                        value={listeningAnswers[mapAnswerKey(question.id, item.id)] || ''}
                        onChange={e => handleListeningMapAnswer(question.id, item.id, e.target.value)}
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

  const renderReading = reading => (
    <div className="space-y-6">
      {renderSectionTimerCard()}
      {readingLocked && (
        <div className="bg-red-50 border border-red-100 text-red-600 rounded-2xl p-4 text-sm font-medium">
          ⏰ Reading time is up. Your answers are saved. Move to the next section.
        </div>
      )}

      <fieldset disabled={readingLocked} className={readingLocked ? 'opacity-60' : ''}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-gray-100 rounded-2xl p-6 h-fit sticky top-[120px]">
            <h2 className="text-xl font-bold text-gray-900 mb-5">{reading.title}</h2>
            {reading.passageMode === 'sections' ? (
              <div className="space-y-6">
                {reading.paragraphs?.map(paragraph => (
                  <div key={paragraph.id}>
                    <h3 className="font-semibold text-gray-900 mb-2">Paragraph {paragraph.letter}</h3>
                    <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">{paragraph.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">{reading.passage}</div>
            )}
          </div>

          <div className="space-y-5">
            {reading.questions?.map((question, index) => (
              <div key={question.id} className="bg-white border border-gray-100 rounded-2xl p-6">
                <p className="text-xs text-blue-600 font-semibold mb-2">
                  {getQuestionRangeLabel(reading.questions, question, index)}
                </p>

                {question.type === 'matching' && (
                  <div>
                    <p className="font-medium text-sm text-gray-800 mb-4">Choose the correct heading for each paragraph.</p>
                    <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-5">
                      {reading.headings?.filter(Boolean).map((heading, headingIndex) => (
                        <p key={headingIndex} className="text-sm text-gray-700 mb-1">
                          <span className="font-semibold">{headingIndex + 1}.</span> {heading}
                        </p>
                      ))}
                    </div>
                    <div className="flex flex-col gap-3">
                      {question.paragraphs?.map(paragraph => (
                        <div key={paragraph.letter} className="grid grid-cols-[110px_1fr] gap-3 items-center">
                          <label className="text-sm font-medium text-gray-700">Paragraph {paragraph.letter}</label>
                          <select
                            value={readingAnswers[reading.id]?.[question.id]?.[paragraph.letter] || ''}
                            onChange={e => handleReadingMatching(reading.id, question.id, paragraph.letter, e.target.value)}
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                          >
                            <option value="">Select heading</option>
                            {reading.headings?.filter(Boolean).map((heading, headingIndex) => (
                              <option key={headingIndex} value={String(headingIndex + 1)}>
                                {headingIndex + 1}. {heading}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(question.type === 'table' || question.type === 'summary') && (
                  <div>
                    <p className="text-sm text-gray-700 mb-4">{question.instruction}</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                        <thead>
                          <tr className="bg-gray-100">
                            {question.columns?.map((column, columnIndex) => (
                              <th key={columnIndex} className="p-3 text-left font-semibold text-gray-700 border border-white">
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
                                    <td key={cellIndex} className="p-3 bg-gray-50 border border-white text-gray-700 whitespace-pre-wrap">
                                      {cell.text}
                                    </td>
                                  )
                                }

                                const key = tableAnswerKey(question.id, row.id, cellIndex)

                                return (
                                  <td key={cellIndex} className="p-3 bg-gray-50 border border-white">
                                    <input
                                      value={readingAnswers[reading.id]?.[key] || ''}
                                      onChange={e => handleReadingTableAnswer(reading.id, question.id, row.id, cellIndex, e.target.value)}
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
                    <p className="text-sm text-gray-800 mb-3">{question.question}</p>
                    <div className="flex gap-2">
                      {['True', 'False', 'Not Given'].map(option => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => handleReadingAnswer(reading.id, question.id, option)}
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
                    <p className="text-sm text-gray-800 mb-3">{question.question}</p>
                    <input
                      value={readingAnswers[reading.id]?.[question.id] || ''}
                      onChange={e => handleReadingAnswer(reading.id, question.id, e.target.value)}
                      placeholder="Type your answer..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"
                    />
                  </div>
                )}

                {question.type === 'mcq' && (
                  <div>
                    <p className="text-sm text-gray-800 mb-3">{question.question}</p>
                    {question.mode === 'multi' && (
                      <p className="text-xs text-amber-600 bg-amber-50 rounded-xl p-3 mb-3">
                        Choose TWO answers.
                      </p>
                    )}
                    <div className="flex flex-col gap-2">
                      {question.options?.map((option, optionIndex) => {
                        const letter = letters[optionIndex]
                        const selectedMulti = Array.isArray(readingAnswers[reading.id]?.[question.id])
                          ? readingAnswers[reading.id][question.id]
                          : []
                        const selected = question.mode === 'multi'
                          ? selectedMulti.includes(letter)
                          : readingAnswers[reading.id]?.[question.id] === letter

                        return (
                          <button
                            key={optionIndex}
                            type="button"
                            onClick={() =>
                              question.mode === 'multi'
                                ? handleReadingMultiAnswer(reading.id, question.id, letter)
                                : handleReadingAnswer(reading.id, question.id, letter)
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
              </div>
            ))}
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
            <h2 className="text-xl font-bold text-gray-900">Writing Task 1</h2>
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
            <h3 className="font-semibold text-gray-800 mb-3">Task 1 Prompt</h3>
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
              onChange={e => setWritingAnswers(prev => ({ ...prev, task1: e.target.value }))}
              placeholder="Write your Task 1 answer here..."
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
            />
            <div className="flex justify-between mt-2">
              <p className="text-xs text-gray-400">
                {wordCount} words
              </p>
              <p className={`text-xs font-medium ${
                wordCount >= 150 ? 'text-green-600' : 'text-amber-600'
              }`}>
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
            <h2 className="text-xl font-bold text-gray-900">Writing Task 2</h2>
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
            <h3 className="font-semibold text-gray-800 mb-3">Task 2 Prompt</h3>
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
              onChange={e => setWritingAnswers(prev => ({ ...prev, task2: e.target.value }))}
              placeholder="Write your Task 2 answer here..."
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
            />
            <div className="flex justify-between mt-2">
              <p className="text-xs text-gray-400">
                {wordCount} words
              </p>
              <p className={`text-xs font-medium ${
                wordCount >= 250 ? 'text-green-600' : 'text-amber-600'
              }`}>
                Minimum 250 words
              </p>
            </div>
          </div>
        </fieldset>
      </div>
    )
  }

  const renderReview = () => {
    const previewResult = getMockResult()
    const t1Words = countWords(writingAnswers.task1)
    const t2Words = countWords(writingAnswers.task2)

    return (
      <div className="space-y-6">
        <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Review & Submit</h2>
          <p className="text-gray-500 text-sm mb-6">
            Check your estimated auto-scored sections before final submission.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-purple-50 rounded-2xl p-5">
              <p className="text-xs text-gray-500 mb-1">Listening</p>
              <p className="text-3xl font-bold text-purple-600">{previewResult.listening.band}</p>
              <p className="text-xs text-gray-500 mt-1">
                {previewResult.listening.correct}/{previewResult.listening.total}
              </p>
            </div>

            <div className="bg-blue-50 rounded-2xl p-5">
              <p className="text-xs text-gray-500 mb-1">Reading</p>
              <p className="text-3xl font-bold text-blue-600">{previewResult.reading.band}</p>
              <p className="text-xs text-gray-500 mt-1">
                {previewResult.reading.correct}/{previewResult.reading.total}
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

        <div className="bg-white border border-gray-100 rounded-2xl p-5">
          <h3 className="font-semibold text-gray-800 mb-3">Writing Word Count</h3>
          <div className="grid grid-cols-2 gap-4">
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

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-30">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 hidden md:inline">
            {mock?.title}
          </span>

          {timerInfo && timerInfo.started && (
            <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold ${
              timerInfo.locked
                ? 'bg-red-50 text-red-600'
                : timerInfo.time < 300
                  ? 'bg-amber-50 text-amber-600'
                  : 'bg-purple-50 text-purple-600'
            }`}>
              <span className="text-xs font-medium">{timerInfo.label}</span>
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
            {sections.map((section, index) => (
              <button
                key={section.key}
                onClick={() => setSectionIndex(index)}
                className={`text-xs px-4 py-2 rounded-full whitespace-nowrap ${
                  sectionIndex === index
                    ? 'bg-purple-600 text-white'
                    : index < sectionIndex
                      ? 'bg-green-50 text-green-600'
                      : 'bg-gray-100 text-gray-500'
                }`}
              >
                {section.label}
              </button>
            ))}
          </div>
        </div>

        {activeSection.key === 'intro' && (
          <div className="bg-white border border-gray-100 rounded-2xl p-10 text-center max-w-3xl mx-auto">
            <h1 className="text-3xl font-bold text-gray-900 mb-3">
              {mock?.title}
            </h1>

            <p className="text-gray-500 mb-6">
              This mock test runs in one page: Listening → Reading 1 → Reading 2 → Reading 3 → Writing Task 1 → Writing Task 2 → Review.
            </p>

            <div className="grid grid-cols-3 gap-3 mb-8 text-left">
              <div className="bg-purple-50 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Listening</p>
                <p className="text-2xl font-bold text-purple-600">30 min</p>
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
              ⚠ When a section's timer runs out, that section is locked and cannot be edited.
            </p>

            <button
              onClick={nextSection}
              className="bg-purple-600 text-white rounded-xl px-8 py-4 text-sm font-medium hover:bg-purple-700"
            >
              Start Mock Test
            </button>
          </div>
        )}

        {activeSection.key === 'listening' && renderListening()}

        {activeSection.key?.startsWith('reading-') && renderReading(activeSection.reading)}

        {activeSection.key === 'writing-task1' && renderWritingTask1()}

        {activeSection.key === 'writing-task2' && renderWritingTask2()}

        {activeSection.key === 'review' && renderReview()}

        {activeSection.key !== 'intro' && activeSection.key !== 'review' && (
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