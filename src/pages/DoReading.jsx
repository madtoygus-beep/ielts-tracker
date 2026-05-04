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
import { onAuthStateChanged } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

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

  const timerRef = useRef(null)
  const submittingRef = useRef(false)
  const navigate = useNavigate()

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      setUser(currentUser)

      const snap = await getDoc(doc(db, 'readings', id))
      if (!snap.exists()) return

      const data = {
        id: snap.id,
        ...snap.data()
      }

      setReading(data)
      setTimeLeft(data.timeLimit * 60)

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

  const tableAnswerKey = (questionId, rowId, cellIndex) => {
    return `${questionId}_${rowId}_${cellIndex}`
  }

  const getQuestionItemCount = question => {
    if (question.type === 'matching') {
      return question.paragraphs?.length || 0
    }

    if (question.type === 'sentenceEndings') {
      return question.items?.length || 0
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

  const getQuestionTypeLabel = question => {
    if (question.type === 'matching') return 'Matching Headings'
    if (question.type === 'sentenceEndings') return 'Sentence Endings'
    if (question.type === 'tfng') return 'T/F/NG'
    if (question.type === 'fitb') return 'Fill blank'
    if (question.type === 'table') return 'Table Completion'
    if (question.type === 'summary') return 'Summary Completion'
    if (question.mode === 'multi') return 'MCQ — Choose TWO'
    return 'MCQ'
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

  const handleSentenceEnding = (questionId, itemId, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: {
        ...(prev[questionId] || {}),
        [itemId]: value
      }
    }))
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

  const isTableCellCorrect = (question, row, cellIndex) => {
    const key = tableAnswerKey(question.id, row.id, cellIndex)
    const userAnswer = normalize(answers[key])
    const correctAnswer = normalize(row.cells[cellIndex].answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isMatchingCorrect = (question, paragraph) => {
    const userAnswer = answers[question.id]?.[paragraph.letter]?.toString()
    const correctAnswer = paragraph.answer?.toString()

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const isSentenceEndingCorrect = (question, item) => {
    const userAnswer = answers[question.id]?.[item.id]?.toString()
    const correctAnswer = item.answer?.toString()

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
        question.paragraphs.forEach(paragraph => {
          total++

          if (isMatchingCorrect(question, paragraph)) {
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

      if (question.type === 'mcq' && question.mode === 'multi') {
      return question.answers?.length || 2
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

    const percentage = total ? correct / total : 0

    let band = 4

    if (percentage >= 0.97) band = 9
    else if (percentage >= 0.93) band = 8.5
    else if (percentage >= 0.87) band = 8
    else if (percentage >= 0.8) band = 7.5
    else if (percentage >= 0.72) band = 7
    else if (percentage >= 0.63) band = 6.5
    else if (percentage >= 0.53) band = 6
    else if (percentage >= 0.43) band = 5.5
    else if (percentage >= 0.33) band = 5
    else if (percentage >= 0.23) band = 4.5

    return {
      correct,
      total,
      band
    }
  }

  const handleSubmit = async (autoSubmit = false) => {
    if (submittingRef.current || submitted || alreadyDone || !reading || !user) return

    if (!autoSubmit) {
      const ok = window.confirm('Submit your answers? You cannot retake this homework after submitting.')
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

  if (!reading) {
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
            className="h-10 object-contain"
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

                      <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                        {paragraph.text}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                  {reading.passage}
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
                              : question.type === 'tfng'
                              ? 'bg-blue-50 text-blue-600'
                              : question.type === 'fitb'
                                ? 'bg-amber-50 text-amber-600'
                                : (question.type === 'table' || question.type === 'summary')
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

                    {question.type !== 'matching' && question.type !== 'sentenceEndings' && question.type !== 'table' && question.type !== 'summary' && (
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
        </div>
      </nav>

      <div className="max-w-[1500px] mx-auto px-4 md:px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6">
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden lg:sticky lg:top-24 lg:h-[calc(100vh-8rem)]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-white sticky top-0 z-10">
              <h2 className="font-semibold text-gray-800">
                Reading Passage
              </h2>

              <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1 rounded-full">
                Scroll passage
              </span>
            </div>

            <div className="p-5 md:p-7 overflow-y-auto h-[65vh] lg:h-[calc(100vh-12rem)]">
              {reading.passageMode === 'sections' ? (
                <div className="space-y-8">
                  {reading.paragraphs.map(paragraph => (
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

          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden lg:h-[calc(100vh-8rem)]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-white sticky top-0 z-10">
              <h2 className="font-semibold text-gray-800">
                Questions ({getTotalQuestionCount()})
              </h2>

              <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                Answer panel
              </span>
            </div>

            <div className="p-5 md:p-7 overflow-y-auto h-[65vh] lg:h-[calc(100vh-12rem)]">

          <div className="flex flex-col gap-6">
            {reading.questions.map((question, index) => (
              <div
                key={question.id}
                className="bg-gray-50 border border-gray-100 rounded-2xl p-5 overflow-hidden"
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
                          : question.type === 'tfng'
                          ? 'bg-blue-50 text-blue-600'
                          : question.type === 'fitb'
                            ? 'bg-amber-50 text-amber-600'
                            : (question.type === 'table' || question.type === 'summary')
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
                              className="flex gap-2 text-sm text-gray-700 leading-5"
                            >
                              <span className="font-semibold text-gray-500 min-w-6">
                                {headingIndex + 1}.
                              </span>

                              <span>{heading}</span>
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
                              .map((heading, headingIndex) => (
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
      </div>
    </div>
  )
}