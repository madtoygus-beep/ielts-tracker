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

export default function DoListening() {
  const { id } = useParams()

  const [user, setUser] = useState(null)
  const [listening, setListening] = useState(null)
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

      const snap = await getDoc(doc(db, 'listenings', id))
      if (!snap.exists()) return

      const data = {
        id: snap.id,
        ...snap.data()
      }

      setListening(data)
      setTimeLeft((data.timeLimit || 30) * 60)

      const q = query(
        collection(db, 'listeningSubmissions'),
        where('uid', '==', currentUser.uid),
        where('listeningId', '==', id)
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
      handleSubmit()
      return
    }

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


  const mapAnswerKey = (questionId, itemId) => {
    return `${questionId}_${itemId}`
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


  const handleMapAnswer = (questionId, itemId, value) => {
    const key = mapAnswerKey(questionId, itemId)

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
      const userAnswer = sortAnswers(answers[question.id]).join('|')
      const correctAnswer = sortAnswers(question.answers || []).join('|')

      return userAnswer === correctAnswer
    }

    const userAnswer = normalize(answers[question.id])
    const correctAnswer = normalize(question.answer)

    return userAnswer === correctAnswer
  }

  const isTableCellCorrect = (question, row, cellIndex) => {
    const key = tableAnswerKey(question.id, row.id, cellIndex)
    const cell = row.cells[cellIndex]
    const userAnswer = normalize(answers[key])
    const acceptedAnswers = parseAcceptedAnswers(cell).map(normalize)

    if (!isWithinWordLimit(answers[key], cell.maxWords)) return false

    return acceptedAnswers.includes(userAnswer)
  }


  const isMapItemCorrect = (question, item) => {
    const key = mapAnswerKey(question.id, item.id)
    const userAnswer = normalize(answers[key])
    const correctAnswer = normalize(item.answer)

    return userAnswer === correctAnswer
  }

  const calculateScore = () => {
    let correct = 0
    let total = 0

    listening.questions.forEach(question => {
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

      if (question.type === 'map') {
        question.mapItems?.forEach(item => {
          total++

          if (isMapItemCorrect(question, item)) {
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

  const handleSubmit = async () => {
    if (submitted || alreadyDone || !listening || !user) return

    clearInterval(timerRef.current)

    const res = calculateScore()

    setResult(res)
    setSubmitted(true)

    await addDoc(collection(db, 'listeningSubmissions'), {
      uid: user.uid,
      listeningId: id,
      answers,
      result: res,
      submittedAt: new Date().toISOString(),
      finishedLate: timeLeft <= 0
    })
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
            className="h-10 object-contain"
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
              {listening.questions.map((question, index) => (
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
                        question.type === 'tfng'
                          ? 'bg-blue-50 text-blue-600'
                          : question.type === 'fitb'
                            ? 'bg-amber-50 text-amber-600'
                            : question.type === 'map'
                              ? 'bg-indigo-50 text-indigo-600'
                              : (question.type === 'table' || question.type === 'note')
                              ? 'bg-emerald-50 text-emerald-600'
                              : 'bg-purple-50 text-purple-600'
                      }`}
                    >
                      {question.type === 'tfng'
                        ? 'T/F/NG'
                        : question.type === 'fitb'
                          ? 'Fill blank'
                          : (question.type === 'table' || question.type === 'note')
                            ? question.type === 'note' ? 'Note Completion' : 'Table / Form Completion'
                            : question.type === 'map'
                              ? 'Map Labeling'
                              : question.mode === 'multi'
                              ? 'MCQ — Choose TWO'
                              : 'MCQ'}
                    </span>
                  </div>


                  {question.type === 'map' ? (
                    <div>
                      <p className="text-sm text-gray-700 mb-4">
                        {question.instruction}
                      </p>

                      {question.mapImage && (
                        <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4 mb-4">
                          <img
                            src={question.mapImage}
                            alt="Map"
                            className="w-full max-h-[420px] object-contain rounded-xl bg-white"
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                        {(question.mapLocations || []).map(location => (
                          <div key={location.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
                            <p className="text-sm font-bold text-gray-800">{location.label}</p>
                            {location.text && (
                              <p className="text-xs text-gray-500 mt-1">{location.text}</p>
                            )}
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-col gap-3">
                        {(question.mapItems || []).map((item, itemIndex) => {
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
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-sm font-semibold text-gray-800">
                                  {itemIndex + 1}. {item.prompt}
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
          <h2 className="font-semibold text-gray-800 mb-5">
            Questions ({listening.questions.length})
          </h2>

          <div className="flex flex-col gap-6">
            {listening.questions.map((question, index) => (
              <div
                key={question.id}
                className="border border-gray-100 rounded-2xl p-5"
              >
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-xs font-medium text-gray-400">
                    Q{index + 1}
                  </span>

                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      question.type === 'tfng'
                        ? 'bg-blue-50 text-blue-600'
                        : question.type === 'fitb'
                          ? 'bg-amber-50 text-amber-600'
                          : question.type === 'map'
                            ? 'bg-indigo-50 text-indigo-600'
                            : (question.type === 'table' || question.type === 'note')
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-purple-50 text-purple-600'
                    }`}
                  >
                    {question.type === 'tfng'
                      ? 'T/F/NG'
                      : question.type === 'fitb'
                        ? 'Fill blank'
                        : (question.type === 'table' || question.type === 'note')
                          ? question.type === 'note' ? 'Note Completion' : 'Table / Form Completion'
                          : question.type === 'map'
                            ? 'Map Labeling'
                            : question.mode === 'multi'
                            ? 'MCQ — Choose TWO'
                            : 'MCQ'}
                  </span>
                </div>

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
                {question.type === 'map' && (
                  <div>
                    <p className="text-sm text-gray-700 mb-4">
                      {question.instruction}
                    </p>

                    {question.mapImage && (
                      <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4 mb-4">
                        <img
                          src={question.mapImage}
                          alt="Map"
                          className="w-full max-h-[420px] object-contain rounded-xl bg-white"
                        />
                      </div>
                    )}

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                      {(question.mapLocations || []).map(location => (
                        <div key={location.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
                          <p className="text-sm font-bold text-gray-800">{location.label}</p>
                          {location.text && (
                            <p className="text-xs text-gray-500 mt-1">{location.text}</p>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-col gap-3">
                      {(question.mapItems || []).map((item, itemIndex) => {
                        const key = mapAnswerKey(question.id, item.id)

                        return (
                          <div key={item.id} className="grid grid-cols-[1fr_140px] gap-3 items-center bg-gray-50 border border-gray-100 rounded-xl p-4">
                            <label className="text-sm font-medium text-gray-800">
                              {itemIndex + 1}. {item.prompt}
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