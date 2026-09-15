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
  const defaults =
    type === 'match_definition'
      ? {
          taskTitle: 'Task A - Match the words with their definitions',
          instruction: 'Match the words with their definitions.'
        }
      : type === 'word_bank'
        ? {
            taskTitle: 'Task B - Complete the sentences',
            instruction: 'Use the words in the box.'
          }
        : type === 'grammar_form'
          ? {
              taskTitle: 'Task C - Grammar Focus',
              instruction: 'Complete the sentences using the correct form.'
            }
          : {
              taskTitle: 'Vocabulary Multiple Choice',
              instruction: 'Choose the best answer.'
            }

  return {
    id: makeId(),
    type,
    taskTitle: defaults.taskTitle,
    instruction: defaults.instruction,
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
    grammarNote: '',
    sectionTitle: '',
    groupId: type === 'word_bank' ? makeId() : ''
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
    grammarNote: normalizeMultilineText(question?.grammarNote || ''),
    sectionTitle: question?.sectionTitle || '',
    groupId: question?.groupId || ''
  }
}

function getQuestionTypeLabel(type) {
  return questionTypes.find(item => item[0] === type)?.[1] || 'Question'
}

function normalizeMultilineText(value) {
  return (value || '').replace(/\\n/g, '\n')
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
  const [bulkPaste, setBulkPaste] = useState({
    type: '',
    groupId: '',
    text: ''
  })

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
          const legacyWordBankGroupId = makeId()

          setQuestions(
            data.questions?.length
              ? data.questions.map(rawQuestion =>
                  normalizeQuestion({
                    ...rawQuestion,
                    groupId:
                      rawQuestion.groupId ||
                      (rawQuestion.type === 'word_bank'
                        ? legacyWordBankGroupId
                        : '')
                  })
                )
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

  const groupedQuestions = useMemo(() => ({
    matching: questions.filter(question => question.type === 'match_definition'),
    wordBank: questions.filter(question => question.type === 'word_bank'),
    grammar: questions.filter(question => question.type === 'grammar_form'),
    mcq: questions.filter(question => question.type === 'mcq' || !question.type)
  }), [questions])

  const wordBankGroups = useMemo(() => {
    const groups = []
    const byId = new Map()

    groupedQuestions.wordBank.forEach(question => {
      const groupId = question.groupId || 'legacy-word-bank'

      if (!byId.has(groupId)) {
        const group = {
          groupId,
          questions: []
        }

        byId.set(groupId, group)
        groups.push(group)
      }

      byId.get(groupId).questions.push(question)
    })

    return groups
  }, [groupedQuestions.wordBank])

  const orderedSections = useMemo(() => {
    const sections = []
    const seen = new Set()

    questions.forEach(question => {
      const type =
        question.type === 'match_definition'
          ? 'matching'
          : question.type === 'word_bank'
            ? 'wordBank'
            : question.type === 'grammar_form'
              ? 'grammar'
              : 'mcq'

      const key =
        type === 'wordBank'
          ? `wordBank:${question.groupId || 'legacy-word-bank'}`
          : type

      if (seen.has(key)) return

      seen.add(key)

      if (type === 'wordBank') {
        const groupId = question.groupId || 'legacy-word-bank'
        const group = wordBankGroups.find(item => item.groupId === groupId)

        if (group) {
          sections.push({
            key,
            type,
            group
          })
        }

        return
      }

      sections.push({
        key,
        type
      })
    })

    return sections
  }, [questions, wordBankGroups])

  const orderedQuestions = useMemo(
    () =>
      orderedSections.flatMap(section => {
        if (section.type === 'matching') {
          return groupedQuestions.matching
        }

        if (section.type === 'wordBank') {
          return section.group?.questions || []
        }

        if (section.type === 'grammar') {
          return groupedQuestions.grammar
        }

        return groupedQuestions.mcq
      }),
    [orderedSections, groupedQuestions]
  )

  const getQuestionNumber = questionId => {
    const index = orderedQuestions.findIndex(
      question => question.id === questionId
    )

    return index >= 0 ? index + 1 : 0
  }

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

  const scrollToCreatedItem = elementId => {
    window.setTimeout(() => {
      const element = document.getElementById(elementId)

      if (element) {
        element.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        })
      }
    }, 80)
  }

  const addQuestion = type => {
    if (type === 'word_bank') {
      const nextQuestion = emptyQuestion('word_bank')
      const newGroupId = nextQuestion.groupId

      setQuestions(prev => [
        ...prev,
        nextQuestion
      ])

      scrollToCreatedItem(`word-bank-section-${newGroupId}`)
      return
    }

    setQuestions(prev => {
      const firstOfType = prev.find(question => question.type === type)
      const nextQuestion = emptyQuestion(type)

      if (firstOfType) {
        nextQuestion.taskTitle =
          firstOfType.taskTitle || nextQuestion.taskTitle
        nextQuestion.instruction =
          firstOfType.instruction || nextQuestion.instruction

        if (type === 'grammar_form') {
          nextQuestion.grammarNote = firstOfType.grammarNote || ''
        }
      }

      return [...prev, nextQuestion]
    })
  }

  const addWordBankSentence = groupId => {
    const nextQuestion = emptyQuestion('word_bank')
    nextQuestion.groupId = groupId

    setQuestions(prev => {
      const firstInGroup = prev.find(
        question =>
          question.type === 'word_bank' &&
          (question.groupId || 'legacy-word-bank') === groupId
      )

      if (firstInGroup) {
        nextQuestion.taskTitle =
          firstInGroup.taskTitle || nextQuestion.taskTitle
        nextQuestion.instruction =
          firstInGroup.instruction || nextQuestion.instruction
        nextQuestion.wordBank = firstInGroup.wordBank || ''
      }

      const lastIndexInGroup = prev.reduce(
        (lastIndex, question, index) =>
          question.type === 'word_bank' &&
          (question.groupId || 'legacy-word-bank') === groupId
            ? index
            : lastIndex,
        -1
      )

      if (lastIndexInGroup === -1) {
        return [...prev, nextQuestion]
      }

      return [
        ...prev.slice(0, lastIndexInGroup + 1),
        nextQuestion,
        ...prev.slice(lastIndexInGroup + 1)
      ]
    })

    scrollToCreatedItem(`word-bank-question-${nextQuestion.id}`)
  }

  const removeWordBankGroup = groupId => {
    setQuestions(prev =>
      prev.filter(
        question =>
          !(
            question.type === 'word_bank' &&
            (question.groupId || 'legacy-word-bank') === groupId
          )
      )
    )

    setBulkPaste(current =>
      current.type === 'word_bank' && current.groupId === groupId
        ? { type: '', groupId: '', text: '' }
        : current
    )
  }

  const duplicateQuestion = question => {
    const duplicated = {
      ...JSON.parse(JSON.stringify(question)),
      id: makeId()
    }

    setQuestions(prev => {
      const originalIndex = prev.findIndex(
        item => item.id === question.id
      )

      if (originalIndex === -1) {
        return [...prev, duplicated]
      }

      return [
        ...prev.slice(0, originalIndex + 1),
        duplicated,
        ...prev.slice(originalIndex + 1)
      ]
    })

    if (question.type === 'word_bank') {
      scrollToCreatedItem(`word-bank-question-${duplicated.id}`)
    }
  }

  const removeQuestion = questionId => {
    setQuestions(prev =>
      prev.length <= 1
        ? prev
        : prev.filter(question => question.id !== questionId)
    )
  }


  const updateGroupFields = (type, patch) => {
    setQuestions(prev =>
      prev.map(question =>
        question.type === type
          ? { ...question, ...patch }
          : question
      )
    )
  }

  const getGroupSharedValue = (type, key, fallback = '') => {
    const item = questions.find(question => question.type === type)
    return item?.[key] || fallback
  }

  const updateWordBankGroupFields = (groupId, patch) => {
    setQuestions(prev =>
      prev.map(question =>
        question.type === 'word_bank' &&
        (question.groupId || 'legacy-word-bank') === groupId
          ? { ...question, ...patch }
          : question
      )
    )
  }

  const getWordBankGroupSharedValue = (
    groupId,
    key,
    fallback = ''
  ) => {
    const item = questions.find(
      question =>
        question.type === 'word_bank' &&
        (question.groupId || 'legacy-word-bank') === groupId
    )

    return item?.[key] || fallback
  }

  const isEmptyWorkbookQuestion = question => {
    if (question.type === 'match_definition') {
      return !question.word?.trim() && !question.definition?.trim()
    }

    if (question.type === 'word_bank') {
      return !question.sentence?.trim() && !question.answerText?.trim()
    }

    if (question.type === 'grammar_form') {
      return (
        !question.sentence?.trim() &&
        !question.baseWord?.trim() &&
        !question.answerText?.trim()
      )
    }

    return false
  }

  const splitBulkColumns = line => {
    if (line.includes('\t')) {
      return line.split('\t').map(value => value.trim())
    }

    if (line.includes('|')) {
      return line.split('|').map(value => value.trim())
    }

    if (line.includes('=>')) {
      return line.split('=>').map(value => value.trim())
    }

    return [line.trim()]
  }

  const openBulkPaste = (type, groupId = '') => {
    setBulkPaste(current =>
      current.type === type && current.groupId === groupId
        ? { type: '', groupId: '', text: '' }
        : { type, groupId, text: '' }
    )
  }

  const importBulkItems = (type, groupId = '') => {
    const lines = bulkPaste.text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      alert('Paste at least one line first.')
      return
    }

    const firstOfType =
      type === 'word_bank'
        ? questions.find(
            question =>
              question.type === 'word_bank' &&
              (question.groupId || 'legacy-word-bank') === groupId
          )
        : questions.find(question => question.type === type)

    const sharedTitle =
      firstOfType?.taskTitle || emptyQuestion(type).taskTitle
    const sharedInstruction =
      firstOfType?.instruction || emptyQuestion(type).instruction
    const sharedWordBank = firstOfType?.wordBank || ''
    const sharedGrammarNote = firstOfType?.grammarNote || ''
    const imported = []
    const skipped = []

    lines.forEach((line, lineIndex) => {
      const columns = splitBulkColumns(line)

      if (type === 'match_definition') {
        if (columns.length < 2 || !columns[0] || !columns[1]) {
          skipped.push(lineIndex + 1)
          return
        }

        imported.push({
          ...emptyQuestion(type),
          taskTitle: sharedTitle,
          instruction: sharedInstruction,
          word: columns[0],
          definition: columns.slice(1).join(' | ')
        })
        return
      }

      if (type === 'word_bank') {
        if (columns.length < 2 || !columns[0] || !columns[1]) {
          skipped.push(lineIndex + 1)
          return
        }

        const question = emptyQuestion(type)
        question.groupId = groupId

        imported.push({
          ...question,
          taskTitle: sharedTitle,
          instruction: sharedInstruction,
          wordBank: sharedWordBank,
          sentence: columns[0],
          answerText: columns[1],
          acceptedAnswers: columns.slice(2).join(', ')
        })
        return
      }

      if (type === 'grammar_form') {
        if (
          columns.length < 3 ||
          !columns[0] ||
          !columns[1] ||
          !columns[2]
        ) {
          skipped.push(lineIndex + 1)
          return
        }

        imported.push({
          ...emptyQuestion(type),
          taskTitle: sharedTitle,
          instruction: sharedInstruction,
          grammarNote: sharedGrammarNote,
          sentence: columns[0],
          baseWord: columns[1],
          answerText: columns[2],
          acceptedAnswers: columns.slice(3).join(', ')
        })
      }
    })

    if (imported.length === 0) {
      alert(
        'No valid rows were found. Check the example format and try again.'
      )
      return
    }

    let generatedWordBank = sharedWordBank

    if (type === 'word_bank' && !generatedWordBank.trim()) {
      const existingGroupAnswers = questions
        .filter(
          question =>
            question.type === 'word_bank' &&
            (question.groupId || 'legacy-word-bank') === groupId
        )
        .map(question => question.answerText?.trim())
        .filter(Boolean)

      generatedWordBank = Array.from(
        new Set([
          ...existingGroupAnswers,
          ...imported.map(item => item.answerText).filter(Boolean)
        ])
      ).join(' - ')

      imported.forEach(item => {
        item.wordBank = generatedWordBank
      })
    }

    setQuestions(prev => {
      const cleaned = prev.filter(question => {
        if (!isEmptyWorkbookQuestion(question)) return true

        if (type !== 'word_bank') {
          return question.type !== type
        }

        return !(
          question.type === 'word_bank' &&
          (question.groupId || 'legacy-word-bank') === groupId
        )
      })

      const withSharedWordBank =
        type === 'word_bank' && generatedWordBank.trim()
          ? cleaned.map(question =>
              question.type === 'word_bank' &&
              (question.groupId || 'legacy-word-bank') === groupId
                ? { ...question, wordBank: generatedWordBank }
                : question
            )
          : cleaned

      if (type !== 'word_bank') {
        return [...withSharedWordBank, ...imported]
      }

      const lastIndexInGroup = withSharedWordBank.reduce(
        (lastIndex, question, index) =>
          question.type === 'word_bank' &&
          (question.groupId || 'legacy-word-bank') === groupId
            ? index
            : lastIndex,
        -1
      )

      if (lastIndexInGroup === -1) {
        return [...withSharedWordBank, ...imported]
      }

      return [
        ...withSharedWordBank.slice(0, lastIndexInGroup + 1),
        ...imported,
        ...withSharedWordBank.slice(lastIndexInGroup + 1)
      ]
    })

    setBulkPaste({ type: '', groupId: '', text: '' })

    if (type === 'word_bank' && imported.length > 0) {
      scrollToCreatedItem(
        `word-bank-question-${imported[imported.length - 1].id}`
      )
    }

    if (skipped.length > 0) {
      alert(
        `Imported ${imported.length} row(s). Skipped line(s): ${skipped.join(', ')}`
      )
    }
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
        const questionGroupId =
          question.groupId || 'legacy-word-bank'

        const sharedWordBank = questions.find(
          item =>
            item.type === 'word_bank' &&
            (item.groupId || 'legacy-word-bank') === questionGroupId &&
            item.wordBank?.trim()
        )?.wordBank || ''

        if (!sharedWordBank.trim()) {
          alert('Each Complete the Sentences section needs its own word box.')
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

  const cleanQuestions = () => {
    const sharedByType = {
      match_definition: questions.find(
        item => item.type === 'match_definition'
      ),
      grammar_form: questions.find(
        item => item.type === 'grammar_form'
      ),
      mcq: questions.find(
        item => item.type === 'mcq' || !item.type
      )
    }

    const wordBankSharedByGroup = new Map()

    questions
      .filter(item => item.type === 'word_bank')
      .forEach(item => {
        const groupId = item.groupId || 'legacy-word-bank'

        if (!wordBankSharedByGroup.has(groupId)) {
          wordBankSharedByGroup.set(groupId, item)
        }
      })

    return questions.map(question => {
      const wordBankGroupId =
        question.groupId || 'legacy-word-bank'

      const shared =
        question.type === 'word_bank'
          ? wordBankSharedByGroup.get(wordBankGroupId) || question
          : sharedByType[question.type] || question

      return {
        id: question.id,
        type: question.type,
        groupId:
          question.type === 'word_bank'
            ? wordBankGroupId
            : '',
        taskTitle:
          (shared?.taskTitle || question.taskTitle || '').trim(),
        instruction:
          (shared?.instruction || question.instruction || '').trim(),
        question: question.question.trim(),
        options: question.options.map(option => option.trim()),
        answer: question.answer,
        word: question.word.trim(),
        definition: question.definition.trim(),
        wordBank:
          question.type === 'word_bank'
            ? (shared?.wordBank || question.wordBank || '').trim()
            : question.wordBank.trim(),
        sentence: question.sentence.trim(),
        baseWord: question.baseWord.trim(),
        answerText: question.answerText.trim(),
        acceptedAnswers: question.acceptedAnswers.trim(),
        grammarNote:
          question.type === 'grammar_form'
            ? (
                sharedByType.grammar_form?.grammarNote ||
                question.grammarNote ||
                ''
              ).trim()
            : question.grammarNote.trim(),
        sectionTitle:
          question.type === 'mcq'
            ? (question.sectionTitle || '').trim()
            : ''
      }
    })
  }

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
      matchingShuffle: true,
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

  const renderBulkPasteBox = (type, groupId = '') => {
    if (
      bulkPaste.type !== type ||
      bulkPaste.groupId !== groupId
    ) return null

    const help =
      type === 'match_definition'
        ? 'One line per pair: word | definition. You can also paste two Excel columns.'
        : type === 'word_bank'
          ? 'One line per sentence: sentence | correct answer | optional alternatives.'
          : 'One line per item: sentence | base word | correct form | optional alternatives.'

    const example =
      type === 'match_definition'
        ? 'extended family | a family that includes relatives such as grandparents, aunts and uncles\nclose-knit | having strong and friendly relationships with each other'
        : type === 'word_bank'
          ? 'Grandparents can have a strong ________ on family life. | influence\nMarta tries to ________ with her cousins. | keep in touch'
          : 'Old glass bottles ________ at recycling centres. | collect | are collected\nThe bottles ________ according to colour. | sort | are sorted'

    return (
      <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 mb-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-semibold text-amber-800">
              Paste Multiple
            </p>
            <p className="text-xs text-amber-600 mt-1">
              {help}
            </p>
          </div>

          <button
            type="button"
            onClick={() =>
              setBulkPaste({ type: '', groupId: '', text: '' })
            }
            className="text-xs text-amber-700 bg-white border border-amber-200 px-3 py-1.5 rounded-lg"
          >
            Close
          </button>
        </div>

        <textarea
          rows={7}
          value={bulkPaste.text}
          onChange={event =>
            setBulkPaste({
              type,
              groupId,
              text: event.target.value
            })
          }
          placeholder={example}
          className="w-full border border-amber-200 rounded-xl px-3 py-3 text-sm outline-none focus:border-amber-400 resize-y bg-white font-mono"
        />

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-3">
          <p className="text-[11px] text-amber-600">
            Accepted separators: Excel tab, | or =&gt;
          </p>

          <button
            type="button"
            onClick={() => importBulkItems(type, groupId)}
            className="text-xs bg-amber-600 text-white px-4 py-2 rounded-xl hover:bg-amber-700"
          >
            Import lines
          </button>
        </div>
      </div>
    )
  }

  const renderMatchingGroup = () => {
    if (groupedQuestions.matching.length === 0) return null

    return (
      <div className="border border-purple-100 bg-purple-50/40 rounded-2xl p-5">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-gray-800">
              Task A - Match words with definitions
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              {groupedQuestions.matching.length} pair{groupedQuestions.matching.length === 1 ? '' : 's'}. Task settings are entered once.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openBulkPaste('match_definition')}
              className="text-xs bg-white border border-purple-200 text-purple-600 px-3 py-2 rounded-xl hover:bg-purple-50"
            >
              Paste Multiple
            </button>

            <button
              type="button"
              onClick={() => addQuestion('match_definition')}
              className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
            >
              + Add Pair
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Task heading
            </label>
            <input
              value={getGroupSharedValue('match_definition', 'taskTitle', 'Task A - Match the words with their definitions')}
              onChange={event =>
                updateGroupFields('match_definition', {
                  taskTitle: event.target.value
                })
              }
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Instruction
            </label>
            <input
              value={getGroupSharedValue('match_definition', 'instruction', 'Match the words with their definitions.')}
              onChange={event =>
                updateGroupFields('match_definition', {
                  instruction: event.target.value
                })
              }
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
            />
          </div>
        </div>

        {renderBulkPasteBox('match_definition')}

        <div className="space-y-3">
          {groupedQuestions.matching.map((question, index) => (
            <div
              key={question.id}
              className="bg-white border border-gray-100 rounded-2xl p-4"
            >
              <div className="grid grid-cols-1 lg:grid-cols-[44px_0.9fr_1.6fr_auto] gap-3 items-start">
                <div className="h-10 flex items-center justify-center rounded-xl bg-purple-50 text-purple-600 text-sm font-semibold">
                  {index + 1}
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Word / phrase
                  </label>
                  <input
                    value={question.word}
                    onChange={event =>
                      updateQuestion(question.id, {
                        word: event.target.value
                      })
                    }
                    placeholder="extended family"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Definition
                  </label>
                  <textarea
                    rows={3}
                    value={question.definition}
                    onChange={event =>
                      updateQuestion(question.id, {
                        definition: event.target.value
                      })
                    }
                    placeholder="a family that includes relatives such as grandparents, aunts and uncles"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 resize-y bg-white"
                  />
                </div>

                <div className="flex lg:flex-col gap-2 lg:pt-6">
                  <button
                    type="button"
                    onClick={() => duplicateQuestion(question)}
                    className="text-xs bg-gray-50 border border-gray-200 text-gray-500 px-3 py-2 rounded-xl hover:bg-gray-100"
                  >
                    Duplicate
                  </button>

                  <button
                    type="button"
                    onClick={() => removeQuestion(question.id)}
                    disabled={questions.length <= 1}
                    className="text-xs bg-red-50 text-red-500 px-3 py-2 rounded-xl hover:bg-red-100 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderWordBankGroup = group => {
    if (!group) return null

    const groupIndex = wordBankGroups.findIndex(
      item => item.groupId === group.groupId
    )

    const groupId = group.groupId
    const groupQuestions = group.questions

    const sharedWordBank = getWordBankGroupSharedValue(
      groupId,
      'wordBank',
      ''
    )

    return (
      <div
        id={`word-bank-section-${groupId}`}
        key={groupId}
        className="border border-blue-100 bg-blue-50/40 rounded-2xl p-5 scroll-mt-24"
      >
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded-full font-semibold">
                      Section {groupIndex + 1}
                    </span>

                    <h3 className="font-semibold text-gray-800">
                      Complete the sentences
                    </h3>
                  </div>

                  <p className="text-xs text-gray-400 mt-1">
                    {groupQuestions.length} question{groupQuestions.length === 1 ? '' : 's'} in this section. This section has its own heading, instruction and word box.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const words = Array.from(
                        new Set(
                          groupQuestions
                            .map(question =>
                              question.answerText?.trim()
                            )
                            .filter(Boolean)
                        )
                      ).join(' - ')

                      updateWordBankGroupFields(groupId, {
                        wordBank: words
                      })
                    }}
                    className="text-xs bg-white border border-blue-200 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-50"
                  >
                    Build word box
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      openBulkPaste('word_bank', groupId)
                    }
                    className="text-xs bg-white border border-blue-200 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-50"
                  >
                    Paste Multiple
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      addWordBankSentence(groupId)
                    }
                    className="text-xs bg-blue-600 text-white px-3 py-2 rounded-xl hover:bg-blue-700"
                  >
                    + Add Sentence
                  </button>

                  <button
                    type="button"
                    onClick={() => removeWordBankGroup(groupId)}
                    className="text-xs bg-red-50 text-red-500 px-3 py-2 rounded-xl hover:bg-red-100"
                  >
                    Delete Section
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Section heading
                  </label>

                  <input
                    value={getWordBankGroupSharedValue(
                      groupId,
                      'taskTitle',
                      'Task B - Complete the sentences'
                    )}
                    onChange={event =>
                      updateWordBankGroupFields(groupId, {
                        taskTitle: event.target.value
                      })
                    }
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 bg-white"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Instruction
                  </label>

                  <input
                    value={getWordBankGroupSharedValue(
                      groupId,
                      'instruction',
                      'Use the words in the box.'
                    )}
                    onChange={event =>
                      updateWordBankGroupFields(groupId, {
                        instruction: event.target.value
                      })
                    }
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 bg-white"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="text-xs text-gray-400 mb-1 block">
                    Words in the box
                  </label>

                  <textarea
                    rows={3}
                    value={sharedWordBank}
                    onChange={event =>
                      updateWordBankGroupFields(groupId, {
                        wordBank: event.target.value
                      })
                    }
                    placeholder="independent - influence - patient - support - keep in touch - share"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 resize-y bg-white"
                  />
                </div>
              </div>

              {renderBulkPasteBox('word_bank', groupId)}

              <div className="space-y-3">
                {groupQuestions.map(question => (
                    <div
                      id={`word-bank-question-${question.id}`}
                      key={question.id}
                      className="bg-white border border-gray-100 rounded-2xl p-4 scroll-mt-24"
                    >
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1.5 rounded-full font-semibold">
                          Question {getQuestionNumber(question.id)}
                        </span>

                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              duplicateQuestion(question)
                            }
                            className="text-xs bg-gray-50 border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg"
                          >
                            Duplicate
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              removeQuestion(question.id)
                            }
                            disabled={questions.length <= 1}
                            className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 xl:grid-cols-[1fr_230px] gap-3">
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">
                            Sentence with blank
                          </label>

                          <textarea
                            rows={3}
                            value={question.sentence}
                            onChange={event =>
                              updateQuestion(question.id, {
                                sentence: event.target.value
                              })
                            }
                            placeholder="Grandparents can have a strong ________ on the way children think about family life."
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 resize-y bg-white"
                          />
                        </div>

                        <div className="space-y-2">
                          <div>
                            <label className="text-xs text-gray-400 mb-1 block">
                              Correct answer
                            </label>

                            <input
                              value={question.answerText}
                              onChange={event =>
                                updateQuestion(question.id, {
                                  answerText: event.target.value
                                })
                              }
                              placeholder="influence"
                              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 bg-white"
                            />
                          </div>

                          <input
                            value={question.acceptedAnswers}
                            onChange={event =>
                              updateQuestion(question.id, {
                                acceptedAnswers:
                                  event.target.value
                              })
                            }
                            placeholder="Alternative answers, comma separated"
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400 bg-white"
                          />
                        </div>
                      </div>
                    </div>
                ))}
              </div>
      </div>
    )
  }

  const renderGrammarGroup = () => {
    if (groupedQuestions.grammar.length === 0) return null

    return (
      <div className="border border-green-100 bg-green-50/40 rounded-2xl p-5">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-gray-800">
              Task C - Grammar form completion
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              {groupedQuestions.grammar.length} grammar item{groupedQuestions.grammar.length === 1 ? '' : 's'}. Grammar note is entered once.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openBulkPaste('grammar_form')}
              className="text-xs bg-white border border-green-200 text-green-600 px-3 py-2 rounded-xl hover:bg-green-50"
            >
              Paste Multiple
            </button>

            <button
              type="button"
              onClick={() => addQuestion('grammar_form')}
              className="text-xs bg-green-600 text-white px-3 py-2 rounded-xl hover:bg-green-700"
            >
              + Add Grammar Item
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Task heading
            </label>
            <input
              value={getGroupSharedValue('grammar_form', 'taskTitle', 'Task C - Grammar Focus')}
              onChange={event =>
                updateGroupFields('grammar_form', {
                  taskTitle: event.target.value
                })
              }
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-green-400 bg-white"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Instruction
            </label>
            <input
              value={getGroupSharedValue('grammar_form', 'instruction', 'Complete the sentences using the correct form.')}
              onChange={event =>
                updateGroupFields('grammar_form', {
                  instruction: event.target.value
                })
              }
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-green-400 bg-white"
            />
          </div>

          <div className="md:col-span-2">
            <label className="text-xs text-gray-400 mb-1 block">
              Grammar explanation / optional
            </label>
            <textarea
              rows={5}
              value={normalizeMultilineText(
                getGroupSharedValue('grammar_form', 'grammarNote', '')
              )}
              onChange={event =>
                updateGroupFields('grammar_form', {
                  grammarNote: event.target.value
                })
              }
              placeholder="We often use the Present Simple Passive when describing a process.\n\nActive: Workers wash the bottles.\nPassive: The bottles are washed."
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-green-400 resize-y bg-white"
            />
          </div>
        </div>

        {renderBulkPasteBox('grammar_form')}

        <div className="space-y-3">
          {groupedQuestions.grammar.map((question, index) => (
            <div key={question.id} className="bg-white border border-gray-100 rounded-2xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full font-semibold">
                  Question {getQuestionNumber(question.id)}
                </span>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => duplicateQuestion(question)}
                    className="text-xs bg-gray-50 border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg"
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQuestion(question.id)}
                    disabled={questions.length <= 1}
                    className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-[1fr_170px_230px] gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Sentence with blank
                  </label>
                  <textarea
                    rows={3}
                    value={question.sentence}
                    onChange={event =>
                      updateQuestion(question.id, {
                        sentence: event.target.value
                      })
                    }
                    placeholder="Old glass bottles ________ at recycling centres."
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-green-400 resize-y bg-white"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Base word
                  </label>
                  <input
                    value={question.baseWord}
                    onChange={event =>
                      updateQuestion(question.id, {
                        baseWord: event.target.value
                      })
                    }
                    placeholder="collect"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-green-400 bg-white"
                  />
                </div>

                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">
                      Correct form
                    </label>
                    <input
                      value={question.answerText}
                      onChange={event =>
                        updateQuestion(question.id, {
                          answerText: event.target.value
                        })
                      }
                      placeholder="are collected"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-green-400 bg-white"
                    />
                  </div>

                  <input
                    value={question.acceptedAnswers}
                    onChange={event =>
                      updateQuestion(question.id, {
                        acceptedAnswers: event.target.value
                      })
                    }
                    placeholder="Alternative answers, comma separated"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-green-400 bg-white"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderMcqGroup = () => {
    if (groupedQuestions.mcq.length === 0) return null

    return (
      <div className="border border-gray-200 bg-gray-50 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-gray-800">
              Vocabulary Multiple Choice
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              {groupedQuestions.mcq.length} question{groupedQuestions.mcq.length === 1 ? '' : 's'}. You can optionally start a new sub-section before any question.
            </p>
          </div>

          <button
            type="button"
            onClick={() => addQuestion('mcq')}
            className="text-xs bg-gray-900 text-white px-3 py-2 rounded-xl hover:bg-gray-800"
          >
            + Add MCQ
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Section heading
            </label>
            <input
              value={getGroupSharedValue('mcq', 'taskTitle', 'Vocabulary Multiple Choice')}
              onChange={event =>
                updateGroupFields('mcq', {
                  taskTitle: event.target.value
                })
              }
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Instruction
            </label>
            <input
              value={getGroupSharedValue('mcq', 'instruction', 'Choose the best answer.')}
              onChange={event =>
                updateGroupFields('mcq', {
                  instruction: event.target.value
                })
              }
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
            />
          </div>
        </div>

        <div className="space-y-4">
          {groupedQuestions.mcq.map((question, index) => (
            <div key={question.id} className="bg-white border border-gray-100 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-3 mb-4">
                <p className="text-sm font-semibold text-gray-800">
                  Question {getQuestionNumber(question.id)}
                </p>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => duplicateQuestion(question)}
                    className="text-xs bg-gray-50 border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg"
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQuestion(question.id)}
                    disabled={questions.length <= 1}
                    className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  New section heading / optional
                </label>

                <input
                  value={question.sectionTitle || ''}
                  onChange={event =>
                    updateQuestion(question.id, {
                      sectionTitle: event.target.value
                    })
                  }
                  placeholder="e.g. Synonyms, Collocations, Academic Vocabulary..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                />

                <p className="text-[11px] text-gray-400 mt-1">
                  Leave blank to continue the current section. Add a title only to the first question of a new section.
                </p>
              </div>

              {renderMcqEditor(question)}
            </div>
          ))}
        </div>
      </div>
    )
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
                  <h2 className="font-semibold text-gray-800">
                    Vocabulary Tasks
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    Add separate sections, then add questions inside each section. New sentence sections are placed after the existing sentence sections.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => addQuestion('match_definition')}
                    className="text-xs bg-purple-50 text-purple-600 px-3 py-2 rounded-xl hover:bg-purple-100"
                  >
                    + Matching
                  </button>
                  <button
                    type="button"
                    onClick={() => addQuestion('word_bank')}
                    className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-100"
                  >
                    + New sentence section
                  </button>
                  <button
                    type="button"
                    onClick={() => addQuestion('grammar_form')}
                    className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
                  >
                    + Grammar
                  </button>
                  <button
                    type="button"
                    onClick={() => addQuestion('mcq')}
                    className="text-xs bg-gray-100 text-gray-700 px-3 py-2 rounded-xl hover:bg-gray-200"
                  >
                    + MCQ
                  </button>
                </div>
              </div>

              <div className="space-y-6">
                {orderedSections.map(section => {
                  if (section.type === 'matching') {
                    return (
                      <div key={section.key}>
                        {renderMatchingGroup()}
                      </div>
                    )
                  }

                  if (section.type === 'wordBank') {
                    return (
                      <div key={section.key}>
                        {renderWordBankGroup(section.group)}
                      </div>
                    )
                  }

                  if (section.type === 'grammar') {
                    return (
                      <div key={section.key}>
                        {renderGrammarGroup()}
                      </div>
                    )
                  }

                  return (
                    <div key={section.key}>
                      {renderMcqGroup()}
                    </div>
                  )
                })}
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
                <p>{questions.length} total question{questions.length === 1 ? '' : 's'}</p>
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
