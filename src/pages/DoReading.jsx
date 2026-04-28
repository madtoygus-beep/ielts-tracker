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

export default function DoReading() {
  const { id } = useParams()

  const [user, setUser] = useState(null)
  const [reading, setReading] = useState(null)
  const [answers, setAnswers] = useState({})
  const [timeLeft, setTimeLeft] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState(null)
  const [alreadyDone, setAlreadyDone] = useState(false)

  const timerRef = useRef(null)
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
    if (timeLeft <= 0) return

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => prev - 1)
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

  const handleAnswer = (questionId, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: value
    }))
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

  const normalize = value => {
    return value?.toString().trim().toLowerCase()
  }

  const getHeadingText = number => {
    if (!number) return 'No answer'
    const index = Number(number) - 1
    return reading.headings?.[index] || `Heading ${number}`
  }

  const isNormalCorrect = question => {
    const userAnswer = normalize(answers[question.id])
    const correctAnswer = normalize(question.answer)

    return userAnswer === correctAnswer
  }

  const isMatchingCorrect = (question, paragraph) => {
    const userAnswer = answers[question.id]?.[paragraph.letter]?.toString()
    const correctAnswer = paragraph.answer?.toString()

    return userAnswer === correctAnswer
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

      total++

      if (isNormalCorrect(question)) {
        correct++
      }
    })

    const percentage = correct / total

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

  const handleSubmit = async () => {
    clearInterval(timerRef.current)

    const res = calculateScore()

    setResult(res)
    setSubmitted(true)

    await addDoc(collection(db, 'readingSubmissions'), {
      uid: user.uid,
      readingId: id,
      answers,
      result: res,
      submittedAt: new Date().toISOString(),
      finishedLate: timeLeft <= 0
    })
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
                        Q{index + 1}
                      </span>

                      <span
                        className={`text-xs px-2 py-1 rounded-full ${
                          question.type === 'matching'
                            ? 'bg-indigo-50 text-indigo-600'
                            : question.type === 'tfng'
                              ? 'bg-blue-50 text-blue-600'
                              : question.type === 'fitb'
                                ? 'bg-amber-50 text-amber-600'
                                : 'bg-purple-50 text-purple-600'
                        }`}
                      >
                        {question.type === 'matching'
                          ? 'Matching Headings'
                          : question.type === 'tfng'
                            ? 'T/F/NG'
                            : question.type === 'fitb'
                              ? 'Fill blank'
                              : 'MCQ'}
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

                    {question.type !== 'matching' && (
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
                            {answers[question.id] || 'No answer'}
                          </p>

                          {!isNormalCorrect(question) && (
                            <>
                              <p className="text-xs text-gray-500 mb-1">
                                Correct answer:
                              </p>

                              <p className="text-sm font-medium text-green-700">
                                {question.answer}
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
    <div className="min-h-screen bg-[#faf9f6] flex flex-col">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <img
          src="/1.png"
          alt="Maxima"
          className="h-10 object-contain"
        />

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 uppercase tracking-wide">
            {reading.title}
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

      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 overflow-y-auto p-8 border-r border-gray-100">
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

        <div className="w-1/2 overflow-y-auto p-8">
          <h2 className="font-semibold text-gray-800 mb-5">
            Questions ({reading.questions.length})
          </h2>

          <div className="flex flex-col gap-6">
            {reading.questions.map((question, index) => (
              <div
                key={question.id}
                className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm overflow-hidden"
              >
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-xs font-medium text-gray-400">
                    Q{index + 1}
                  </span>

                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      question.type === 'matching'
                        ? 'bg-indigo-50 text-indigo-600'
                        : question.type === 'tfng'
                          ? 'bg-blue-50 text-blue-600'
                          : question.type === 'fitb'
                            ? 'bg-amber-50 text-amber-600'
                            : 'bg-purple-50 text-purple-600'
                    }`}
                  >
                    {question.type === 'matching'
                      ? 'Matching Headings'
                      : question.type === 'tfng'
                        ? 'T/F/NG'
                        : question.type === 'fitb'
                          ? 'Fill blank'
                          : 'MCQ'}
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

                    <div className="flex flex-col gap-2">
                      {question.options.map((option, optionIndex) => (
                        <button
                          key={optionIndex}
                          onClick={() =>
                            handleAnswer(question.id, option)
                          }
                          className={`text-left px-4 py-3 rounded-xl text-sm border transition-all ${
                            answers[question.id] === option
                              ? 'bg-purple-600 text-white border-purple-600'
                              : 'border-gray-200 text-gray-700 hover:border-purple-300'
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <button
            onClick={handleSubmit}
            className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-8"
          >
            Submit answers
          </button>
        </div>
      </div>
    </div>
  )
}