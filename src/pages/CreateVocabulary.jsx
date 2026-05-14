import { useEffect, useState } from 'react'
import { auth, db } from '../firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  updateDoc,
  where
} from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const emptyQuestion = () => ({
  id: crypto.randomUUID(),
  question: '',
  options: ['', '', '', ''],
  answer: ''
})

export default function CreateVocabulary() {
  const { id } = useParams()
  const isEditMode = Boolean(id)
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [timeLimit, setTimeLimit] = useState(20)
  const [dueDate, setDueDate] = useState('')
  const [questions, setQuestions] = useState([emptyQuestion()])
  const [assignTo, setAssignTo] = useState([])

  useEffect(() => {
    let isActive = true
    const liveUnsubscribers = []

    const clearLiveUnsubscribers = () => {
      while (liveUnsubscribers.length > 0) {
        const unsubscribe = liveUnsubscribers.pop()

        if (typeof unsubscribe === 'function') {
          unsubscribe()
        }
      }
    }

    const unsubAuth = onAuthStateChanged(auth, async currentUser => {
      clearLiveUnsubscribers()

      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
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
          (profile.role !== 'teacher' && profile.role !== 'admin')
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        setUser(currentUser)

        const studentsQuery = query(
          collection(db, 'users'),
          where('role', '==', 'student')
        )

        liveUnsubscribers.push(
          onSnapshot(studentsQuery, snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => !item.deleted && item.status === 'approved')
              .sort((a, b) =>
                (a.name || a.email || '').localeCompare(b.name || b.email || '')
              )

            setStudents(list)
          })
        )

        liveUnsubscribers.push(
          onSnapshot(collection(db, 'classes'), snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(classItem => classItem.archived !== true)
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

            setClasses(list)
          })
        )

        if (isEditMode) {
          const vocabSnap = await getDoc(doc(db, 'vocabularyTests', id))

          if (!isActive) return

          if (!vocabSnap.exists()) {
            alert('Vocabulary test not found.')
            navigate('/teacher')
            return
          }

          const data = vocabSnap.data()

          setTitle(data.title || '')
          setInstructions(data.instructions || '')
          setTimeLimit(data.timeLimit || 20)
          setDueDate(data.dueDate || '')
          setQuestions(
            data.questions?.length
              ? data.questions.map(question => ({
                  id: question.id || crypto.randomUUID(),
                  question: question.question || '',
                  options: question.options?.length ? question.options : ['', '', '', ''],
                  answer: question.answer || ''
                }))
              : [emptyQuestion()]
          )
          setAssignTo(data.assignTo || [])
        }

        setLoading(false)
      } catch (error) {
        console.error(error)

        if (isActive) {
          alert('Could not load vocabulary test creator.')
          navigate('/teacher')
        }
      }
    })

    return () => {
      isActive = false
      unsubAuth()
      clearLiveUnsubscribers()
    }
  }, [id, isEditMode, navigate])

  const updateQuestion = (questionId, patch) => {
    setQuestions(prev =>
      prev.map(question =>
        question.id === questionId
          ? { ...question, ...patch }
          : question
      )
    )
  }

  const updateOption = (questionId, optionIndex, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const options = [...question.options]
        options[optionIndex] = value

        return {
          ...question,
          options
        }
      })
    )
  }

  const addOption = questionId => {
    setQuestions(prev =>
      prev.map(question =>
        question.id === questionId
          ? {
              ...question,
              options: [...question.options, '']
            }
          : question
      )
    )
  }

  const removeOption = (questionId, optionIndex) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question
        if (question.options.length <= 2) return question

        const removedLetter = letters[optionIndex]
        const options = question.options.filter((_, index) => index !== optionIndex)

        let answer = question.answer

        if (answer === removedLetter) {
          answer = ''
        } else {
          const answerIndex = letters.indexOf(answer)

          if (answerIndex > optionIndex) {
            answer = letters[answerIndex - 1]
          }
        }

        return {
          ...question,
          options,
          answer
        }
      })
    )
  }

  const addQuestion = () => {
    setQuestions(prev => [...prev, emptyQuestion()])
  }

  const removeQuestion = questionId => {
    setQuestions(prev =>
      prev.length <= 1
        ? prev
        : prev.filter(question => question.id !== questionId)
    )
  }

  const toggleStudent = studentId => {
    setAssignTo(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    )
  }

  const getStudentName = studentId => {
    const student = students.find(item => item.id === studentId)
    return student?.name || student?.email || 'Unknown student'
  }

  const assignClass = classItem => {
    const classStudentIds = classItem.studentIds || []

    if (classStudentIds.length === 0) {
      alert('This class has no students yet.')
      return
    }

    setAssignTo(prev => Array.from(new Set([...prev, ...classStudentIds])))
  }

  const removeClass = classItem => {
    const classStudentIds = classItem.studentIds || []
    setAssignTo(prev => prev.filter(studentId => !classStudentIds.includes(studentId)))
  }

  const isClassFullyAssigned = classItem => {
    const classStudentIds = classItem.studentIds || []
    if (classStudentIds.length === 0) return false
    return classStudentIds.every(studentId => assignTo.includes(studentId))
  }

  const isClassPartlyAssigned = classItem => {
    const classStudentIds = classItem.studentIds || []
    if (classStudentIds.length === 0) return false
    return classStudentIds.some(studentId => assignTo.includes(studentId))
  }

  const validate = () => {
    if (!title.trim()) {
      alert('Please enter a title.')
      return false
    }

    if (questions.length === 0) {
      alert('Please add at least one question.')
      return false
    }

    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]
      const validOptions = question.options.filter(option => option.trim())

      if (!question.question.trim()) {
        alert(`Please fill in Question ${index + 1}.`)
        return false
      }

      if (validOptions.length < 2) {
        alert(`Question ${index + 1} must have at least 2 options.`)
        return false
      }

      if (question.options.some(option => !option.trim())) {
        alert(`Please fill in every option for Question ${index + 1}.`)
        return false
      }

      if (!question.answer) {
        alert(`Please choose the correct answer for Question ${index + 1}.`)
        return false
      }

      const answerIndex = letters.indexOf(question.answer)

      if (!question.options[answerIndex]?.trim()) {
        alert(`Correct answer for Question ${index + 1} points to an empty option.`)
        return false
      }
    }

    if (assignTo.length === 0) {
      alert('Please assign this vocabulary test to at least one student or class.')
      return false
    }

    return true
  }

  const handleSave = async () => {
    if (!user || saving) return
    if (!validate()) return

    setSaving(true)

    const now = new Date().toISOString()

    const payload = {
      title: title.trim(),
      instructions: instructions.trim(),
      timeLimit: Number(timeLimit) || 20,
      dueDate,
      questions: questions.map(question => ({
        id: question.id,
        type: 'mcq',
        mode: 'single',
        question: question.question.trim(),
        options: question.options.map(option => option.trim()),
        answer: question.answer
      })),
      assignTo,
      archived: false,
      updatedAt: now
    }

    try {
      if (isEditMode) {
        await updateDoc(doc(db, 'vocabularyTests', id), payload)
      } else {
        await addDoc(collection(db, 'vocabularyTests'), {
          ...payload,
          createdBy: user.uid,
          createdAt: now
        })
      }

      navigate('/teacher')
    } catch (error) {
      console.error(error)
      alert('Could not save vocabulary test.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-14 object-contain" />

        <button
          onClick={() => navigate('/teacher')}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Back to dashboard
        </button>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">
              {isEditMode ? 'Edit Vocabulary Test' : 'Create Vocabulary Test'}
            </h1>

            <p className="text-gray-400 text-sm">
              Multiple choice vocabulary homework for IELTS students.
            </p>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-purple-600 text-white px-5 py-3 rounded-xl text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
          >
            {saving ? 'Saving...' : isEditMode ? 'Update Test' : 'Save & Assign'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
          <div className="space-y-6">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                Test Details
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="text-xs text-gray-400 mb-1 block">
                    Title
                  </label>

                  <input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Academic Vocabulary Set 1"
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Time limit (minutes)
                  </label>

                  <input
                    type="number"
                    min="1"
                    value={timeLimit}
                    onChange={e => setTimeLimit(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Due date
                  </label>

                  <input
                    type="date"
                    value={dueDate}
                    onChange={e => setDueDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="text-xs text-gray-400 mb-1 block">
                    Instructions
                  </label>

                  <textarea
                    rows={3}
                    value={instructions}
                    onChange={e => setInstructions(e.target.value)}
                    placeholder="Choose the best answer."
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 resize-none"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Questions
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Only multiple choice questions are used in this vocabulary test.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={addQuestion}
                  className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                >
                  + Add Question
                </button>
              </div>

              <div className="space-y-5">
                {questions.map((question, questionIndex) => (
                  <div
                    key={question.id}
                    className="border border-gray-100 bg-gray-50 rounded-2xl p-5"
                  >
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <p className="text-sm font-semibold text-gray-800">
                        Question {questionIndex + 1}
                      </p>

                      <button
                        type="button"
                        onClick={() => removeQuestion(question.id)}
                        disabled={questions.length <= 1}
                        className="text-xs bg-red-50 text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-100 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>

                    <label className="text-xs text-gray-400 mb-1 block">
                      Question text
                    </label>

                    <textarea
                      rows={2}
                      value={question.question}
                      onChange={e => updateQuestion(question.id, { question: e.target.value })}
                      placeholder="Which word means 'to improve gradually'?"
                      className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 resize-none bg-white mb-4"
                    />

                    <div className="space-y-2">
                      {question.options.map((option, optionIndex) => {
                        const letter = letters[optionIndex]

                        return (
                          <div
                            key={optionIndex}
                            className="grid grid-cols-[42px_1fr_auto_auto] gap-2 items-center"
                          >
                            <span className="text-sm font-semibold text-gray-500">
                              {letter}.
                            </span>

                            <input
                              value={option}
                              onChange={e => updateOption(question.id, optionIndex, e.target.value)}
                              placeholder={`Option ${letter}`}
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                            />

                            <label className="flex items-center gap-1 text-xs text-gray-500">
                              <input
                                type="radio"
                                name={`answer-${question.id}`}
                                checked={question.answer === letter}
                                onChange={() => updateQuestion(question.id, { answer: letter })}
                                className="accent-purple-600"
                              />
                              Correct
                            </label>

                            <button
                              type="button"
                              onClick={() => removeOption(question.id, optionIndex)}
                              disabled={question.options.length <= 2}
                              className="text-xs bg-red-50 text-red-500 px-2.5 py-2 rounded-lg hover:bg-red-100 disabled:opacity-40"
                            >
                              ✕
                            </button>
                          </div>
                        )
                      })}
                    </div>

                    <button
                      type="button"
                      onClick={() => addOption(question.id)}
                      className="mt-3 text-xs bg-white border border-gray-200 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-50"
                    >
                      + Add Option
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {classes.length > 0 && (
              <div className="bg-purple-50 border border-purple-100 rounded-2xl p-5">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div>
                    <h2 className="font-semibold text-purple-800">
                      Assign by Class
                    </h2>

                    <p className="text-xs text-purple-500 mt-1">
                      Add or remove all students from a class.
                    </p>
                  </div>

                  <span className="text-xs bg-white text-purple-600 px-3 py-1 rounded-full">
                    {assignTo.length} selected
                  </span>
                </div>

                <div className="space-y-2">
                  {classes.map(classItem => {
                    const classStudentIds = classItem.studentIds || []
                    const fullyAssigned = isClassFullyAssigned(classItem)
                    const partlyAssigned = isClassPartlyAssigned(classItem)

                    return (
                      <div
                        key={classItem.id}
                        className={`bg-white border rounded-xl p-3 ${
                          fullyAssigned
                            ? 'border-purple-300'
                            : partlyAssigned
                              ? 'border-amber-200'
                              : 'border-gray-100'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {classItem.name}
                            </p>

                            <p className="text-xs text-gray-400 mt-0.5">
                              {classStudentIds.length} student{classStudentIds.length === 1 ? '' : 's'}
                              {fullyAssigned ? ' · selected' : partlyAssigned ? ' · partly selected' : ''}
                            </p>

                            {classStudentIds.length > 0 && (
                              <p className="text-[11px] text-gray-400 mt-1 truncate">
                                {classStudentIds.slice(0, 2).map(getStudentName).join(', ')}
                                {classStudentIds.length > 2
                                  ? ` +${classStudentIds.length - 2} more`
                                  : ''}
                              </p>
                            )}
                          </div>

                          {fullyAssigned ? (
                            <button
                              type="button"
                              onClick={() => removeClass(classItem)}
                              className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-100 flex-shrink-0"
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => assignClass(classItem)}
                              className="text-xs bg-purple-600 text-white px-3 py-1.5 rounded-lg hover:bg-purple-700 flex-shrink-0"
                            >
                              Add
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="bg-white border border-gray-100 rounded-2xl p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Assign Students
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Select individual students.
                  </p>
                </div>

                {assignTo.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAssignTo([])}
                    className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-lg hover:bg-gray-200"
                  >
                    Clear
                  </button>
                )}
              </div>

              <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                {students.map(student => (
                  <label
                    key={student.id}
                    className="flex items-center justify-between gap-3 border border-gray-100 rounded-xl p-3 cursor-pointer hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={assignTo.includes(student.id)}
                        onChange={() => toggleStudent(student.id)}
                        className="accent-purple-600"
                      />

                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {student.name || student.email}
                        </p>

                        <p className="text-xs text-gray-400 truncate">
                          {student.email}
                        </p>
                      </div>
                    </div>

                    {assignTo.includes(student.id) && (
                      <span className="text-xs bg-purple-50 text-purple-600 px-2.5 py-1 rounded-full">
                        Assigned
                      </span>
                    )}
                  </label>
                ))}

                {students.length === 0 && (
                  <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                    No approved students yet.
                  </p>
                )}
              </div>
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
            >
              {saving ? 'Saving...' : isEditMode ? 'Update Test' : 'Save & Assign'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
