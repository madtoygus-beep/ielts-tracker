import { useEffect, useMemo, useState } from 'react'
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
const DEFAULT_SCHOOL_ID = 'maxima'

const questionTypes = [
  ['mcq', 'Multiple Choice'],
  ['match_definition', 'Task A - Match words with definitions'],
  ['word_bank', 'Task B - Complete sentences'],
  ['grammar_form', 'Task C - Grammar form completion']
]

function getProfileSchoolId(profile) {
  return profile?.schoolId || DEFAULT_SCHOOL_ID
}

function getEntitySchoolId(entity) {
  return entity?.schoolId || DEFAULT_SCHOOL_ID
}

function isAdminProfile(profile) {
  return profile?.role === 'admin'
}

function isSameSchool(entity, profile) {
  return getEntitySchoolId(entity) === getProfileSchoolId(profile)
}

function isAssignedToTeacher(entity, teacherId) {
  if (!entity || !teacherId) return false

  return (
    entity.teacherId === teacherId ||
    entity.createdBy === teacherId ||
    (Array.isArray(entity.teacherIds) && entity.teacherIds.includes(teacherId))
  )
}

function filterStudentsByProfile(students, profile, teacherId) {
  if (isAdminProfile(profile)) return students

  return students.filter(student =>
    isSameSchool(student, profile) &&
    isAssignedToTeacher(student, teacherId)
  )
}

function filterClassesByProfile(classes, profile, teacherId) {
  if (isAdminProfile(profile)) return classes

  return classes.filter(classItem =>
    isSameSchool(classItem, profile) &&
    isAssignedToTeacher(classItem, teacherId)
  )
}

function filterClassStudentIds(classItem, visibleStudents) {
  const visibleStudentIds = new Set(visibleStudents.map(student => student.id))

  return (classItem.studentIds || []).filter(studentId =>
    visibleStudentIds.has(studentId)
  )
}

function makeId() {
  return crypto.randomUUID()
}

function emptyQuestion(type = 'mcq') {
  return {
    id: makeId(),
    type,
    taskTitle: '',
    instruction: '',
    question: '',
    options: ['', '', '', ''],
    answer: '',
    word: '',
    definition: '',
    wordBank: '',
    sentence: '',
    baseWord: '',
    answerText: '',
    acceptedAnswers: '',
    grammarNote: ''
  }
}

function normalizeOptions(options) {
  const clean = Array.isArray(options) && options.length > 0
    ? options.map(option => option || '')
    : ['', '', '', '']

  return clean.length >= 2 ? clean : [...clean, '', ''].slice(0, 2)
}

function normalizeQuestion(question) {
  const type = question?.type || 'mcq'

  return {
    id: question?.id || makeId(),
    type,
    taskTitle: question?.taskTitle || '',
    instruction: question?.instruction || '',
    question: question?.question || '',
    options: normalizeOptions(question?.options),
    answer: question?.answer || '',
    word: question?.word || '',
    definition: question?.definition || '',
    wordBank: question?.wordBank || '',
    sentence: question?.sentence || '',
    baseWord: question?.baseWord || '',
    answerText: question?.answerText || question?.correctAnswer || '',
    acceptedAnswers: question?.acceptedAnswers || '',
    grammarNote: question?.grammarNote || ''
  }
}

function getQuestionTypeLabel(type) {
  return questionTypes.find(item => item[0] === type)?.[1] || 'Question'
}

export default function CreateVocabulary() {
  const { id } = useParams()
  const isEditMode = Boolean(id)
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [title, setTitle] = useState('')
  const [contentType, setContentType] = useState('mixed_practice')
  const [visibility, setVisibility] = useState('private')
  const [instructions, setInstructions] = useState('')
  const [timeLimit, setTimeLimit] = useState(20)
  const [dueDate, setDueDate] = useState('')
  const [questions, setQuestions] = useState([
    emptyQuestion('match_definition'),
    emptyQuestion('word_bank'),
    emptyQuestion('grammar_form')
  ])
  const [assignTo, setAssignTo] = useState([])
  const [studentSearch, setStudentSearch] = useState('')

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

        const loadedProfile = profileSnap.data()

        if (
          loadedProfile.deleted === true ||
          loadedProfile.status !== 'approved' ||
          (loadedProfile.role !== 'teacher' && loadedProfile.role !== 'admin')
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        setUser(currentUser)
        setProfile({ id: currentUser.uid, ...loadedProfile })

        const studentsQuery = query(
          collection(db, 'users'),
          where('role', '==', 'student')
        )

        liveUnsubscribers.push(
          onSnapshot(studentsQuery, snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => !item.deleted && item.status === 'approved')

            const visibleStudents = filterStudentsByProfile(
              list,
              loadedProfile,
              currentUser.uid
            )

            visibleStudents.sort((a, b) =>
              (a.name || a.email || '').localeCompare(b.name || b.email || '')
            )

            setStudents(visibleStudents)
          })
        )

        liveUnsubscribers.push(
          onSnapshot(collection(db, 'classes'), snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(classItem => classItem.archived !== true)

            const visibleClasses = filterClassesByProfile(
              list,
              loadedProfile,
              currentUser.uid
            ).sort((a, b) => (a.name || '').localeCompare(b.name || ''))

            setClasses(visibleClasses)
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
          setContentType(data.contentType || 'mixed_practice')
          setVisibility(data.visibility || data.libraryVisibility || 'private')
          setInstructions(data.instructions || '')
          setTimeLimit(data.timeLimit || 20)
          setDueDate(data.dueDate || '')
          setQuestions(
            data.questions?.length
              ? data.questions.map(normalizeQuestion)
              : [emptyQuestion('mcq')]
          )
          setAssignTo(
            Array.from(
              new Set([
                ...(Array.isArray(data.assignTo) ? data.assignTo : []),
                ...(Array.isArray(data.assignedTo) ? data.assignedTo : []),
                ...(Array.isArray(data.studentIds) ? data.studentIds : []),
                ...(Array.isArray(data.assignedStudentIds)
                  ? data.assignedStudentIds
                  : [])
              ])
            )
          )
        }

        setLoading(false)
      } catch (error) {
        console.error(error)

        if (isActive) {
          alert('Could not load vocabulary creator.')
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

  useEffect(() => {
    if (!user || !profile || isAdminProfile(profile) || students.length === 0) return

    const visibleStudentIds = new Set(students.map(student => student.id))

    setAssignTo(prev =>
      prev.filter(studentId => visibleStudentIds.has(studentId))
    )
  }, [user, profile, students])

  const filteredStudents = useMemo(() => {
    const term = studentSearch.trim().toLowerCase()

    if (!term) return students

    return students.filter(student => {
      const name = student.name?.toLowerCase() || ''
      const email = student.email?.toLowerCase() || ''

      return name.includes(term) || email.includes(term)
    })
  }, [students, studentSearch])

  const selectedStudents = useMemo(
    () => students.filter(student => assignTo.includes(student.id)),
    [students, assignTo]
  )

  const updateQuestion = (questionId, patch) => {
    setQuestions(prev =>
      prev.map(question =>
        question.id === questionId
          ? { ...question, ...patch }
          : question
      )
    )
  }

  const changeQuestionType = (questionId, type) => {
    setQuestions(prev =>
      prev.map(question =>
        question.id === questionId
          ? {
              ...emptyQuestion(type),
              id: question.id,
              taskTitle: question.taskTitle,
              instruction: question.instruction
            }
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

  const addQuestion = type => {
    setQuestions(prev => [...prev, emptyQuestion(type)])
  }

  const duplicateQuestion = question => {
    setQuestions(prev => [
      ...prev,
      {
        ...JSON.parse(JSON.stringify(question)),
        id: makeId()
      }
    ])
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
    const classStudentIds = filterClassStudentIds(classItem, students)

    if (classStudentIds.length === 0) {
      alert('This class has no students yet.')
      return
    }

    setAssignTo(prev => Array.from(new Set([...prev, ...classStudentIds])))
  }

  const removeClass = classItem => {
    const classStudentIds = filterClassStudentIds(classItem, students)
    setAssignTo(prev => prev.filter(studentId => !classStudentIds.includes(studentId)))
  }

  const isClassFullyAssigned = classItem => {
    const classStudentIds = filterClassStudentIds(classItem, students)
    if (classStudentIds.length === 0) return false
    return classStudentIds.every(studentId => assignTo.includes(studentId))
  }

  const isClassPartlyAssigned = classItem => {
    const classStudentIds = filterClassStudentIds(classItem, students)
    if (classStudentIds.length === 0) return false
    return classStudentIds.some(studentId => assignTo.includes(studentId))
  }

  const validate = () => {
    if (!title.trim()) {
      alert('Please enter a title.')
      return false
    }

    if (questions.length === 0) {
      alert('Please add at least one task item.')
      return false
    }

    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]
      const label = `${getQuestionTypeLabel(question.type)} ${index + 1}`

      if (question.type === 'mcq') {
        const validOptions = question.options.filter(option => option.trim())

        if (!question.question.trim()) {
          alert(`Please fill in ${label}.`)
          return false
        }

        if (validOptions.length < 2) {
          alert(`${label} must have at least 2 options.`)
          return false
        }

        if (question.options.some(option => !option.trim())) {
          alert(`Please fill in every option for ${label}.`)
          return false
        }

        if (!question.answer) {
          alert(`Please choose the correct answer for ${label}.`)
          return false
        }
      }

      if (question.type === 'match_definition') {
        if (!question.word.trim() || !question.definition.trim()) {
          alert(`${label} needs a word and definition.`)
          return false
        }
      }

      if (question.type === 'word_bank') {
        if (!question.wordBank.trim()) {
          alert(`${label} needs words in the box.`)
          return false
        }

        if (!question.sentence.trim() || !question.answerText.trim()) {
          alert(`${label} needs a sentence and correct answer.`)
          return false
        }
      }

      if (question.type === 'grammar_form') {
        if (!question.sentence.trim() || !question.baseWord.trim() || !question.answerText.trim()) {
          alert(`${label} needs a sentence, base word and correct form.`)
          return false
        }
      }
    }

    if (assignTo.length === 0) {
      alert('Please assign this vocabulary practice to at least one student or class.')
      return false
    }

    return true
  }

  const cleanQuestions = () =>
    questions.map(question => ({
      id: question.id,
      type: question.type,
      taskTitle: question.taskTitle.trim(),
      instruction: question.instruction.trim(),
      question: question.question.trim(),
      options: question.options.map(option => option.trim()),
      answer: question.answer,
      word: question.word.trim(),
      definition: question.definition.trim(),
      wordBank: question.wordBank.trim(),
      sentence: question.sentence.trim(),
      baseWord: question.baseWord.trim(),
      answerText: question.answerText.trim(),
      acceptedAnswers: question.acceptedAnswers.trim(),
      grammarNote: question.grammarNote.trim()
    }))

  const handleSave = async () => {
    if (!user || saving) return
    if (!validate()) return

    setSaving(true)

    const now = new Date().toISOString()
    const preparedQuestions = cleanQuestions()

    const payload = {
      title: title.trim(),
      module: 'vocabulary',
      contentType,
      visibility,
      instructions: instructions.trim(),
      timeLimit: Number(timeLimit) || 20,
      dueDate,
      questions: preparedQuestions,
      questionCount: preparedQuestions.length,
      hasWorkbookTasks: preparedQuestions.some(question => question.type !== 'mcq'),
      assignTo,
      assignedStudentIds: selectedStudents.map(student => student.id),
      assignedEmails: selectedStudents
        .map(student => student.email?.toLowerCase())
        .filter(Boolean),
      schoolId: getProfileSchoolId(profile),
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
          teacherId: profile?.role === 'teacher' ? user.uid : '',
          teacherIds: profile?.role === 'teacher' ? [user.uid] : [],
          createdAt: now
        })
      }

      navigate('/teacher')
    } catch (error) {
      console.error(error)
      alert('Could not save vocabulary practice.')
    } finally {
      setSaving(false)
    }
  }

  const renderMcqEditor = question => (
    <>
      <label className="text-xs text-gray-400 mb-1 block">
        Question text
      </label>

      <textarea
        rows={2}
        value={question.question}
        onChange={event => updateQuestion(question.id, { question: event.target.value })}
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
                onChange={event => updateOption(question.id, optionIndex, event.target.value)}
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
                X
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
    </>
  )

  const renderMatchingEditor = question => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Word / phrase</label>
        <input
          value={question.word}
          onChange={event => updateQuestion(question.id, { word: event.target.value })}
          placeholder="extended family"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
        />
      </div>

      <div>
        <label className="text-xs text-gray-400 mb-1 block">Definition</label>
        <input
          value={question.definition}
          onChange={event => updateQuestion(question.id, { definition: event.target.value })}
          placeholder="a family that includes relatives such as grandparents, aunts and uncles"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
        />
      </div>
    </div>
  )

  const renderWordBankEditor = question => (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Words in the box</label>
        <textarea
          rows={2}
          value={question.wordBank}
          onChange={event => updateQuestion(question.id, { wordBank: event.target.value })}
          placeholder="independent - influence - patient - support - keep in touch - share"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none bg-white"
        />
      </div>

      <div>
        <label className="text-xs text-gray-400 mb-1 block">Sentence with blank</label>
        <textarea
          rows={2}
          value={question.sentence}
          onChange={event => updateQuestion(question.id, { sentence: event.target.value })}
          placeholder="Grandparents can have a strong ________ on the way children think about family life."
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none bg-white"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <input
          value={question.answerText}
          onChange={event => updateQuestion(question.id, { answerText: event.target.value })}
          placeholder="Correct answer"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
        />

        <input
          value={question.acceptedAnswers}
          onChange={event => updateQuestion(question.id, { acceptedAnswers: event.target.value })}
          placeholder="Alternative answers, comma separated"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
        />
      </div>
    </div>
  )

  const renderGrammarEditor = question => (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Grammar note / optional</label>
        <textarea
          rows={4}
          value={question.grammarNote}
          onChange={event => updateQuestion(question.id, { grammarNote: event.target.value })}
          placeholder="We often use the Present Simple Passive when describing a process."
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none bg-white"
        />
      </div>

      <div>
        <label className="text-xs text-gray-400 mb-1 block">Sentence with blank</label>
        <textarea
          rows={2}
          value={question.sentence}
          onChange={event => updateQuestion(question.id, { sentence: event.target.value })}
          placeholder="Old glass bottles ________ at recycling centres."
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none bg-white"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input
          value={question.baseWord}
          onChange={event => updateQuestion(question.id, { baseWord: event.target.value })}
          placeholder="Base word, e.g. collect"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
        />

        <input
          value={question.answerText}
          onChange={event => updateQuestion(question.id, { answerText: event.target.value })}
          placeholder="Correct form, e.g. are collected"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
        />

        <input
          value={question.acceptedAnswers}
          onChange={event => updateQuestion(question.id, { acceptedAnswers: event.target.value })}
          placeholder="Alternatives, comma separated"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
        />
      </div>
    </div>
  )

  const renderQuestionEditor = question => {
    if (question.type === 'match_definition') return renderMatchingEditor(question)
    if (question.type === 'word_bank') return renderWordBankEditor(question)
    if (question.type === 'grammar_form') return renderGrammarEditor(question)
    return renderMcqEditor(question)
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
          Back to dashboard
        </button>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">
              {isEditMode ? 'Edit Vocabulary Practice' : 'Create Vocabulary Practice'}
            </h1>

            <p className="text-gray-400 text-sm">
              Add matching, word box completion, grammar completion and MCQ tasks.
            </p>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-purple-600 text-white px-5 py-3 rounded-xl text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
          >
            {saving ? 'Saving...' : isEditMode ? 'Update Practice' : 'Save & Assign'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
          <div className="space-y-6">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">Practice Details</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="text-xs text-gray-400 mb-1 block">Title</label>
                  <input
                    value={title}
                    onChange={event => setTitle(event.target.value)}
                    placeholder="e.g. Family Vocabulary and Passive Practice"
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Time limit / minutes</label>
                  <input
                    type="number"
                    min="1"
                    value={timeLimit}
                    onChange={event => setTimeLimit(event.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Due date</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={event => setDueDate(event.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Library visibility</label>
                  <select
                    value={visibility}
                    onChange={event => setVisibility(event.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                  >
                    <option value="private">My Library</option>
                    <option value="school">School Library</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Content type</label>
                  <select
                    value={contentType}
                    onChange={event => setContentType(event.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                  >
                    <option value="mixed_practice">Mixed Practice</option>
                    <option value="vocabulary_quiz">Vocabulary Quiz</option>
                    <option value="word_set">Word Set</option>
                    <option value="topic_vocabulary">Topic Vocabulary</option>
                    <option value="academic_vocabulary">Academic Vocabulary</option>
                    <option value="grammar_vocabulary">Grammar + Vocabulary</option>
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label className="text-xs text-gray-400 mb-1 block">General instructions / optional</label>
                  <textarea
                    rows={3}
                    value={instructions}
                    onChange={event => setInstructions(event.target.value)}
                    placeholder="Complete all tasks."
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 resize-none"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-semibold text-gray-800">Task Items</h2>
                  <p className="text-xs text-gray-400 mt-1">
                    Each item is scored automatically. Add as many as you need.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {questionTypes.map(([type, label]) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => addQuestion(type)}
                      className="text-xs bg-purple-50 text-purple-600 px-3 py-2 rounded-xl hover:bg-purple-100"
                    >
                      + {label.replace('Task A - ', '').replace('Task B - ', '').replace('Task C - ', '')}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-5">
                {questions.map((question, questionIndex) => (
                  <div key={question.id} className="border border-gray-100 bg-gray-50 rounded-2xl p-5">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div>
                        <p className="text-sm font-semibold text-gray-800">
                          Item {questionIndex + 1}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {getQuestionTypeLabel(question.type)}
                        </p>
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => duplicateQuestion(question)}
                          className="text-xs bg-white border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                        >
                          Duplicate
                        </button>

                        <button
                          type="button"
                          onClick={() => removeQuestion(question.id)}
                          disabled={questions.length <= 1}
                          className="text-xs bg-red-50 text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-100 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Question type</label>
                        <select
                          value={question.type}
                          onChange={event => changeQuestionType(question.id, event.target.value)}
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                        >
                          {questionTypes.map(([type, label]) => (
                            <option key={type} value={type}>{label}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Task heading / optional</label>
                        <input
                          value={question.taskTitle}
                          onChange={event => updateQuestion(question.id, { taskTitle: event.target.value })}
                          placeholder="Task A - Match the words with their definitions"
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                        />
                      </div>

                      <div className="md:col-span-2">
                        <label className="text-xs text-gray-400 mb-1 block">Instruction / optional</label>
                        <input
                          value={question.instruction}
                          onChange={event => updateQuestion(question.id, { instruction: event.target.value })}
                          placeholder="Use the words in the box."
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                        />
                      </div>
                    </div>

                    {renderQuestionEditor(question)}
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
                    <h2 className="font-semibold text-purple-800">Assign by Class</h2>
                    <p className="text-xs text-purple-500 mt-1">Add or remove all students from a class.</p>
                  </div>

                  <span className="text-xs bg-white text-purple-600 px-3 py-1 rounded-full">
                    {assignTo.length} selected
                  </span>
                </div>

                <div className="space-y-2">
                  {classes.map(classItem => {
                    const classStudentIds = filterClassStudentIds(classItem, students)
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
                            <p className="text-sm font-medium text-gray-800 truncate">{classItem.name}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {classStudentIds.length} student{classStudentIds.length === 1 ? '' : 's'}
                              {fullyAssigned ? ' - selected' : partlyAssigned ? ' - partly selected' : ''}
                            </p>

                            {classStudentIds.length > 0 && (
                              <p className="text-[11px] text-gray-400 mt-1 truncate">
                                {classStudentIds.slice(0, 2).map(getStudentName).join(', ')}
                                {classStudentIds.length > 2 ? ` +${classStudentIds.length - 2} more` : ''}
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
                  <h2 className="font-semibold text-gray-800">Assign Students</h2>
                  <p className="text-xs text-gray-400 mt-1">Select individual students.</p>
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

              <input
                value={studentSearch}
                onChange={event => setStudentSearch(event.target.value)}
                placeholder="Search students..."
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 mb-3"
              />

              <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                {filteredStudents.map(student => (
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
                        <p className="text-xs text-gray-400 truncate">{student.email}</p>
                      </div>
                    </div>

                    {assignTo.includes(student.id) && (
                      <span className="text-xs bg-purple-50 text-purple-600 px-2.5 py-1 rounded-full">
                        Assigned
                      </span>
                    )}
                  </label>
                ))}

                {filteredStudents.length === 0 && (
                  <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                    No approved students found.
                  </p>
                )}
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-5 sticky top-6">
              <h2 className="font-semibold text-gray-800 mb-2">Summary</h2>
              <div className="space-y-2 text-sm text-gray-500 mb-5">
                <p>{questions.length} scored item{questions.length === 1 ? '' : 's'}</p>
                <p>{selectedStudents.length} student{selectedStudents.length === 1 ? '' : 's'} selected</p>
              </div>

              <button
                onClick={handleSave}
                disabled={saving}
                className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
              >
                {saving ? 'Saving...' : isEditMode ? 'Update Practice' : 'Save & Assign'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
