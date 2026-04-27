import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import { collection, addDoc, query, where, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

export default function CreateReading() {
  const [user, setUser] = useState(null)
  const [students, setStudents] = useState([])
  const [title, setTitle] = useState('')
  const [passage, setPassage] = useState('')
  const [timeLimit, setTimeLimit] = useState(60)
  const [assignTo, setAssignTo] = useState([])
  const [questions, setQuestions] = useState([])
  const [saved, setSaved] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) { navigate('/login'); return }
      setUser(currentUser)
    })
    return unsub
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'users'), where('role', '==', 'student'))
    return onSnapshot(q, snap => setStudents(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [])

  const addQuestion = (type) => {
    setQuestions(prev => [...prev, {
      id: Date.now(),
      type,
      question: '',
      options: type === 'mcq' ? ['', '', '', ''] : [],
      answer: ''
    }])
  }

  const updateQuestion = (id, field, value) => {
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, [field]: value } : q))
  }

  const updateOption = (id, index, value) => {
    setQuestions(prev => prev.map(q => {
      if (q.id !== id) return q
      const options = [...q.options]
      options[index] = value
      return { ...q, options }
    }))
  }

  const removeQuestion = (id) => {
    setQuestions(prev => prev.filter(q => q.id !== id))
  }

  const toggleStudent = (id) => {
    setAssignTo(prev => prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id])
  }

  const handleSave = async () => {
    if (!title || !passage || questions.length === 0 || assignTo.length === 0) return
    await addDoc(collection(db, 'readings'), {
      title, passage, timeLimit,
      questions, assignTo,
      createdBy: user.uid,
      createdAt: new Date().toISOString()
    })
    setSaved(true)
    setTimeout(() => navigate('/teacher'), 1500)
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />
        <button onClick={() => navigate('/teacher')} className="text-sm text-gray-400 hover:text-gray-600">← Back</button>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Create Reading Homework</h1>
        <p className="text-gray-400 text-sm mb-8">Add a passage, questions and assign to students</p>

        {saved && (
          <div className="bg-green-50 text-green-600 rounded-xl p-4 mb-6 text-sm font-medium">
            ✓ Homework saved! Redirecting...
          </div>
        )}

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-4">
          <h2 className="font-semibold text-gray-800 mb-4">Homework details</h2>
          <div className="mb-3">
            <label className="text-xs text-gray-400 mb-1 block">Title</label>
            <input
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
              placeholder="e.g. Climate Change Reading"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div className="mb-3">
            <label className="text-xs text-gray-400 mb-1 block">Time limit (minutes)</label>
            <input
              type="number" min="5" max="120"
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
              value={timeLimit}
              onChange={e => setTimeLimit(+e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-2 block">Assign to students</label>
            <div className="flex flex-col gap-2">
              {students.map(s => (
                <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assignTo.includes(s.id)}
                    onChange={() => toggleStudent(s.id)}
                    className="accent-purple-600"
                  />
                  <span className="text-sm text-gray-700">{s.name} — {s.email}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-4">
          <h2 className="font-semibold text-gray-800 mb-4">Reading passage</h2>
          <textarea
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
            rows={12}
            placeholder="Paste or type the reading passage here..."
            value={passage}
            onChange={e => setPassage(e.target.value)}
          />
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">Questions ({questions.length})</h2>
            <div className="flex gap-2">
              <button onClick={() => addQuestion('tfng')} className="text-xs bg-blue-50 text-blue-600 px-3 py-1.5 rounded-lg hover:bg-blue-100">+ T/F/NG</button>
              <button onClick={() => addQuestion('fitb')} className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-lg hover:bg-amber-100">+ Fill blank</button>
              <button onClick={() => addQuestion('mcq')} className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-lg hover:bg-purple-100">+ MCQ</button>
            </div>
          </div>

          {questions.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-6">No questions yet. Add some using the buttons above.</p>
          )}

          <div className="flex flex-col gap-4">
            {questions.map((q, i) => (
              <div key={q.id} className="border border-gray-100 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${q.type === 'tfng' ? 'bg-blue-50 text-blue-600' : q.type === 'fitb' ? 'bg-amber-50 text-amber-600' : 'bg-purple-50 text-purple-600'}`}>
                    {q.type === 'tfng' ? 'True / False / Not Given' : q.type === 'fitb' ? 'Fill in the blank' : 'Multiple Choice'}
                  </span>
                  <button onClick={() => removeQuestion(q.id)} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                </div>

                <div className="mb-3">
                  <label className="text-xs text-gray-400 mb-1 block">Question {i + 1}</label>
                  <input
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                    placeholder="Type the question..."
                    value={q.question}
                    onChange={e => updateQuestion(q.id, 'question', e.target.value)}
                  />
                </div>

                {q.type === 'tfng' && (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Correct answer</label>
                    <div className="flex gap-2">
                      {['True', 'False', 'Not Given'].map(opt => (
                        <button
                          key={opt}
                          onClick={() => updateQuestion(q.id, 'answer', opt)}
                          className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${q.answer === opt ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-500'}`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {q.type === 'fitb' && (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Correct answer</label>
                    <input
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                      placeholder="Type the correct answer..."
                      value={q.answer}
                      onChange={e => updateQuestion(q.id, 'answer', e.target.value)}
                    />
                  </div>
                )}

                {q.type === 'mcq' && (
                  <div>
                    <label className="text-xs text-gray-400 mb-2 block">Options (click the correct one)</label>
                    <div className="flex flex-col gap-2">
                      {q.options.map((opt, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <button
                            onClick={() => updateQuestion(q.id, 'answer', opt)}
                            className={`w-6 h-6 rounded-full border-2 flex-shrink-0 transition-all ${q.answer === opt ? 'bg-purple-600 border-purple-600' : 'border-gray-300'}`}
                          />
                          <input
                            className="flex-1 border border-gray-200 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-purple-400"
                            placeholder={`Option ${idx + 1}`}
                            value={opt}
                            onChange={e => updateOption(q.id, idx, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={handleSave}
          className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700"
        >
          Save & assign homework
        </button>
      </div>
    </div>
  )
}