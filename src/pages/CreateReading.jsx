import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import { collection, addDoc, query, where, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export default function CreateReading() {
  const [user, setUser] = useState(null)
  const [students, setStudents] = useState([])

  const [title, setTitle] = useState('')
  const [timeLimit, setTimeLimit] = useState(60)
  const [assignTo, setAssignTo] = useState([])

  const [passageMode, setPassageMode] = useState('standard')
  const [fullPassage, setFullPassage] = useState('')
  const [paragraphs, setParagraphs] = useState([
    { id: Date.now(), letter: 'A', text: '' }
  ])

  const [headings, setHeadings] = useState(['', '', '', '', '', '', ''])
  const [questions, setQuestions] = useState([])
  const [saved, setSaved] = useState(false)

  const navigate = useNavigate()

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      setUser(currentUser)
    })

    return unsub
  }, [navigate])

  useEffect(() => {
    const q = query(collection(db, 'users'), where('role', '==', 'student'))

    return onSnapshot(q, snap => {
      setStudents(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
  }, [])

  const toggleStudent = id => {
    setAssignTo(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    )
  }

  const addParagraph = () => {
    setPassageMode('sections')

    setParagraphs(prev => [
      ...prev,
      {
        id: Date.now(),
        letter: letters[prev.length],
        text: ''
      }
    ])
  }

  const removeParagraph = id => {
    setParagraphs(prev => {
      const filtered = prev.filter(p => p.id !== id)

      return filtered.map((p, index) => ({
        ...p,
        letter: letters[index]
      }))
    })
  }

  const updateParagraph = (id, value) => {
    setParagraphs(prev =>
      prev.map(p => (p.id === id ? { ...p, text: value } : p))
    )
  }

  const addHeading = () => {
    setHeadings(prev => [...prev, ''])
  }

  const updateHeading = (index, value) => {
    setHeadings(prev => {
      const copy = [...prev]
      copy[index] = value
      return copy
    })
  }

  const removeHeading = index => {
    setHeadings(prev => prev.filter((_, i) => i !== index))
  }

  const addQuestion = type => {
    if (type === 'matching') {
      setPassageMode('sections')

      setQuestions(prev => [
        ...prev,
        {
          id: Date.now(),
          type: 'matching',
          paragraphs: paragraphs.map(p => ({
            letter: p.letter,
            answer: ''
          }))
        }
      ])

      return
    }

    setQuestions(prev => [
      ...prev,
      {
        id: Date.now(),
        type,
        question: '',
        options: type === 'mcq' ? ['', '', '', ''] : [],
        answer: ''
      }
    ])
  }

  const removeQuestion = id => {
    setQuestions(prev => prev.filter(q => q.id !== id))
  }

  const updateQuestion = (id, field, value) => {
    setQuestions(prev =>
      prev.map(q => (q.id === id ? { ...q, [field]: value } : q))
    )
  }

  const updateOption = (id, index, value) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== id) return q

        const options = [...q.options]
        options[index] = value

        return { ...q, options }
      })
    )
  }

  const updateMatching = (questionId, letter, value) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        return {
          ...q,
          paragraphs: q.paragraphs.map(p =>
            p.letter === letter ? { ...p, answer: value } : p
          )
        }
      })
    )
  }

  const syncMatchingQuestions = () => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.type !== 'matching') return q

        return {
          ...q,
          paragraphs: paragraphs.map(p => {
            const existing = q.paragraphs.find(x => x.letter === p.letter)

            return {
              letter: p.letter,
              answer: existing?.answer || ''
            }
          })
        }
      })
    )
  }

  useEffect(() => {
    syncMatchingQuestions()
  }, [paragraphs])

  const handleSave = async () => {
    if (!title || assignTo.length === 0 || questions.length === 0) {
      alert('Please add title, students and questions.')
      return
    }

    if (passageMode === 'standard' && !fullPassage.trim()) {
      alert('Please add the reading passage.')
      return
    }

    if (
      passageMode === 'sections' &&
      paragraphs.some(p => !p.text.trim())
    ) {
      alert('Please fill all paragraph sections.')
      return
    }

    await addDoc(collection(db, 'readings'), {
      title,
      timeLimit,
      assignTo,
      passageMode,
      passage: fullPassage,
      paragraphs,
      headings,
      questions,
      createdBy: user.uid,
      createdAt: new Date().toISOString()
    })

    setSaved(true)

    setTimeout(() => {
      navigate('/teacher')
    }, 1500)
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

        <button
          onClick={() => navigate('/teacher')}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Back
        </button>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Create IELTS Reading
        </h1>

        <p className="text-gray-400 text-sm mb-8">
          Build IELTS-style reading homework with different question types
        </p>

        {saved && (
          <div className="bg-green-50 text-green-600 rounded-xl p-4 mb-6 text-sm font-medium">
            ✓ Reading homework saved. Redirecting...
          </div>
        )}

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <h2 className="font-semibold text-gray-800 mb-4">
            Reading Details
          </h2>

          <div className="mb-4">
            <label className="text-xs text-gray-400 mb-1 block">
              Title
            </label>

            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Climate Change Reading"
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Time limit / minutes
            </label>

            <input
              type="number"
              min="5"
              max="120"
              value={timeLimit}
              onChange={e => setTimeLimit(Number(e.target.value))}
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            />
          </div>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <h2 className="font-semibold text-gray-800 mb-4">
            Assign Students
          </h2>

          {students.length === 0 ? (
            <p className="text-sm text-gray-400">
              No students found.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {students.map(student => (
                <label
                  key={student.id}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={assignTo.includes(student.id)}
                    onChange={() => toggleStudent(student.id)}
                    className="accent-purple-600"
                  />

                  <span className="text-sm text-gray-700">
                    {student.name} — {student.email}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">
              Passage
            </h2>

            <div className="flex gap-2">
              <button
                onClick={() => setPassageMode('standard')}
                className={`text-xs px-3 py-2 rounded-lg border ${
                  passageMode === 'standard'
                    ? 'bg-purple-600 text-white border-purple-600'
                    : 'border-gray-200 text-gray-500'
                }`}
              >
                Standard Passage
              </button>

              <button
                onClick={() => setPassageMode('sections')}
                className={`text-xs px-3 py-2 rounded-lg border ${
                  passageMode === 'sections'
                    ? 'bg-purple-600 text-white border-purple-600'
                    : 'border-gray-200 text-gray-500'
                }`}
              >
                Paragraph Sections
              </button>
            </div>
          </div>

          {passageMode === 'standard' ? (
            <div>
              <p className="text-xs text-gray-400 mb-2">
                Use this for a normal single-block reading passage.
              </p>

              <textarea
                rows={14}
                value={fullPassage}
                onChange={e => setFullPassage(e.target.value)}
                placeholder="Paste the full reading passage here..."
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
              />
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-400 mb-4">
                Use this for Matching Headings or paragraph-based IELTS tasks.
              </p>

              <div className="flex flex-col gap-4">
                {paragraphs.map((paragraph, index) => (
                  <div
                    key={paragraph.id}
                    className="border border-gray-100 rounded-xl p-4"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-gray-700">
                        Paragraph {paragraph.letter}
                      </label>

                      {paragraphs.length > 1 && (
                        <button
                          onClick={() => removeParagraph(paragraph.id)}
                          className="text-xs text-red-400 hover:text-red-600"
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    <textarea
                      rows={5}
                      value={paragraph.text}
                      onChange={e =>
                        updateParagraph(paragraph.id, e.target.value)
                      }
                      placeholder={`Write paragraph ${paragraph.letter} here...`}
                      className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
                    />
                  </div>
                ))}
              </div>

              <button
                onClick={addParagraph}
                className="mt-4 text-sm bg-purple-50 text-purple-600 px-4 py-2 rounded-xl hover:bg-purple-100"
              >
                + Add Paragraph
              </button>
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <h2 className="font-semibold text-gray-800 mb-4">
            Matching Headings Pool
          </h2>

          <p className="text-xs text-gray-400 mb-4">
            Add headings here. These will be used only when you create Matching
            Headings questions.
          </p>

          <div className="flex flex-col gap-2">
            {headings.map((heading, index) => (
              <div key={index} className="flex gap-2">
                <input
                  value={heading}
                  onChange={e => updateHeading(index, e.target.value)}
                  placeholder={`Heading ${index + 1}`}
                  className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                />

                {headings.length > 1 && (
                  <button
                    onClick={() => removeHeading(index)}
                    className="text-xs text-red-400 hover:text-red-600 px-2"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>

          <button
            onClick={addHeading}
            className="mt-4 text-sm bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl hover:bg-indigo-100"
          >
            + Add Heading
          </button>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">
              Questions ({questions.length})
            </h2>

            <div className="flex gap-2 flex-wrap justify-end">
              <button
                onClick={() => addQuestion('matching')}
                className="text-xs bg-indigo-50 text-indigo-600 px-3 py-2 rounded-lg hover:bg-indigo-100"
              >
                + Matching Headings
              </button>

              <button
                onClick={() => addQuestion('tfng')}
                className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-lg hover:bg-blue-100"
              >
                + T/F/NG
              </button>

              <button
                onClick={() => addQuestion('fitb')}
                className="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-lg hover:bg-amber-100"
              >
                + Fill Blank
              </button>

              <button
                onClick={() => addQuestion('mcq')}
                className="text-xs bg-purple-50 text-purple-600 px-3 py-2 rounded-lg hover:bg-purple-100"
              >
                + MCQ
              </button>
            </div>
          </div>

          {questions.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-8">
              No questions yet. Add a question type above.
            </p>
          )}

          <div className="flex flex-col gap-4">
            {questions.map((question, index) => (
              <div
                key={question.id}
                className="border border-gray-100 rounded-xl p-5"
              >
                <div className="flex items-center justify-between mb-4">
                  <span
                    className={`text-xs font-medium px-3 py-1.5 rounded-full ${
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
                        ? 'True / False / Not Given'
                        : question.type === 'fitb'
                          ? 'Fill in the Blank'
                          : 'Multiple Choice'}
                  </span>

                  <button
                    onClick={() => removeQuestion(question.id)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>

                {question.type === 'matching' && (
                  <div>
                    <p className="text-sm font-medium text-gray-800 mb-2">
                      Matching Headings Answer Key
                    </p>

                    <p className="text-xs text-gray-400 mb-4">
                      Choose the correct heading for each paragraph.
                    </p>

                    <div className="flex flex-col gap-3">
                      {paragraphs.map(paragraph => (
                        <div
                          key={paragraph.id}
                          className="flex items-center gap-3"
                        >
                          <label className="w-28 text-sm text-gray-700">
                            Paragraph {paragraph.letter}
                          </label>

                          <select
                            value={
                              question.paragraphs.find(
                                p => p.letter === paragraph.letter
                              )?.answer || ''
                            }
                            onChange={e =>
                              updateMatching(
                                question.id,
                                paragraph.letter,
                                e.target.value
                              )
                            }
                            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                          >
                            <option value="">Select correct heading</option>

                            {headings
                              .map((h, i) => ({ text: h, number: i + 1 }))
                              .filter(h => h.text.trim())
                              .map(h => (
                                <option key={h.number} value={String(h.number)}>
                                  {h.number}. {h.text}
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
                    <label className="text-xs text-gray-400 mb-1 block">
                      Statement {index + 1}
                    </label>

                    <input
                      value={question.question}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'question',
                          e.target.value
                        )
                      }
                      placeholder="Type the statement..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 mb-3"
                    />

                    <label className="text-xs text-gray-400 mb-2 block">
                      Correct answer
                    </label>

                    <div className="flex gap-2">
                      {['True', 'False', 'Not Given'].map(option => (
                        <button
                          key={option}
                          onClick={() =>
                            updateQuestion(question.id, 'answer', option)
                          }
                          className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                            question.answer === option
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
                    <label className="text-xs text-gray-400 mb-1 block">
                      Question {index + 1}
                    </label>

                    <input
                      value={question.question}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'question',
                          e.target.value
                        )
                      }
                      placeholder="e.g. The experiment was conducted in ______."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 mb-3"
                    />

                    <label className="text-xs text-gray-400 mb-1 block">
                      Correct answer
                    </label>

                    <input
                      value={question.answer}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'answer',
                          e.target.value
                        )
                      }
                      placeholder="Type the correct answer..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                    />
                  </div>
                )}

                {question.type === 'mcq' && (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">
                      Question {index + 1}
                    </label>

                    <input
                      value={question.question}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'question',
                          e.target.value
                        )
                      }
                      placeholder="Type the question..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 mb-3"
                    />

                    <label className="text-xs text-gray-400 mb-2 block">
                      Options / select correct one
                    </label>

                    <div className="flex flex-col gap-2">
                      {question.options.map((option, optionIndex) => (
                        <div key={optionIndex} className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              updateQuestion(question.id, 'answer', option)
                            }
                            className={`w-6 h-6 rounded-full border-2 flex-shrink-0 transition-all ${
                              question.answer === option
                                ? 'bg-purple-600 border-purple-600'
                                : 'border-gray-300'
                            }`}
                          />

                          <input
                            value={option}
                            onChange={e =>
                              updateOption(
                                question.id,
                                optionIndex,
                                e.target.value
                              )
                            }
                            placeholder={`Option ${optionIndex + 1}`}
                            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
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
          className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700"
        >
          Save & Assign Reading
        </button>
      </div>
    </div>
  )
}