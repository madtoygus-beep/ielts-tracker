import { useState, useEffect, useRef } from 'react'
import { auth, db } from '../firebase'
import { doc, getDoc, addDoc, collection, query, where, getDocs } from 'firebase/firestore'
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
    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) { navigate('/login'); return }
      setUser(currentUser)

      const snap = await getDoc(doc(db, 'readings', id))
      if (!snap.exists()) return
      const data = { id: snap.id, ...snap.data() }
      setReading(data)
      setTimeLeft(data.timeLimit * 60)

      const q = query(collection(db, 'readingSubmissions'), where('uid', '==', currentUser.uid), where('readingId', '==', id))
      const existing = await getDocs(q)
      if (!existing.empty) {
        setAlreadyDone(true)
        const sub = existing.docs[0].data()
        setResult(sub.result)
        setSubmitted(true)
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    if (timeLeft === null || submitted) return
    if (timeLeft <= 0) return
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => prev - 1)
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [timeLeft, submitted])

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const handleAnswer = (qId, value) => {
    setAnswers(prev => ({ ...prev, [qId]: value }))
  }

  const calculateScore = () => {
    let correct = 0
    reading.questions.forEach(q => {
      const userAnswer = answers[q.id]?.toString().trim().toLowerCase()
      const correctAnswer = q.answer?.toString().trim().toLowerCase()
      if (userAnswer === correctAnswer) correct++
    })
    const total = reading.questions.length
    const percentage = correct / total
    let band = 0
    if (percentage >= 0.97) band = 9.0
    else if (percentage >= 0.93) band = 8.5
    else if (percentage >= 0.87) band = 8.0
    else if (percentage >= 0.80) band = 7.5
    else if (percentage >= 0.72) band = 7.0
    else if (percentage >= 0.63) band = 6.5
    else if (percentage >= 0.53) band = 6.0
    else if (percentage >= 0.43) band = 5.5
    else if (percentage >= 0.33) band = 5.0
    else if (percentage >= 0.23) band = 4.5
    else band = 4.0
    return { correct, total, band }
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

  if (!reading) return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
      <p className="text-gray-400">Loading...</p>
    </div>
  )

  if (submitted && result) return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 w-full max-w-md text-center">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain mx-auto mb-6" />
        <div className="text-5xl font-bold text-purple-600 mb-2">{result.band}</div>
        <p className="text-gray-400 text-sm mb-1">IELTS Band Score</p>
        <p className="text-gray-600 text-sm mb-6">{result.correct} / {result.total} correct answers</p>
        {alreadyDone && <p className="text-amber-500 text-xs mb-4">You already completed this homework.</p>}
        <button onClick={() => navigate('/student')} className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700">
          Back to dashboard
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#faf9f6] flex flex-col">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">{reading.title}</span>
          <div className={`font-mono text-lg font-bold px-4 py-1.5 rounded-xl ${timeLeft <= 60 ? 'bg-red-50 text-red-600' : timeLeft <= 300 ? 'bg-amber-50 text-amber-600' : 'bg-green-50 text-green-600'}`}>
            ⏱ {formatTime(timeLeft)}
          </div>
        </div>
      </nav>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 overflow-y-auto p-8 border-r border-gray-100">
          <h2 className="font-semibold text-gray-800 mb-4">Reading Passage</h2>
          <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{reading.passage}</div>
        </div>

        <div className="w-1/2 overflow-y-auto p-8">
          <h2 className="font-semibold text-gray-800 mb-4">Questions ({reading.questions.length})</h2>
          <div className="flex flex-col gap-6">
            {reading.questions.map((q, i) => (
              <div key={q.id} className="bg-white border border-gray-100 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-medium text-gray-400">Q{i + 1}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${q.type === 'tfng' ? 'bg-blue-50 text-blue-600' : q.type === 'fitb' ? 'bg-amber-50 text-amber-600' : 'bg-purple-50 text-purple-600'}`}>
                    {q.type === 'tfng' ? 'T/F/NG' : q.type === 'fitb' ? 'Fill blank' : 'MCQ'}
                  </span>
                </div>
                <p className="text-sm text-gray-800 mb-3">{q.question}</p>

                {q.type === 'tfng' && (
                  <div className="flex gap-2">
                    {['True', 'False', 'Not Given'].map(opt => (
                      <button
                        key={opt}
                        onClick={() => handleAnswer(q.id, opt)}
                        className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${answers[q.id] === opt ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-500 hover:border-purple-300'}`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}

                {q.type === 'fitb' && (
                  <input
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                    placeholder="Type your answer..."
                    value={answers[q.id] || ''}
                    onChange={e => handleAnswer(q.id, e.target.value)}
                  />
                )}

                {q.type === 'mcq' && (
                  <div className="flex flex-col gap-2">
                    {q.options.map((opt, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleAnswer(q.id, opt)}
                        className={`text-left px-3 py-2 rounded-xl text-sm border transition-all ${answers[q.id] === opt ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-700 hover:border-purple-300'}`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <button
            onClick={handleSubmit}
            className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-6"
          >
            Submit answers
          </button>
        </div>
      </div>
    </div>
  )
}