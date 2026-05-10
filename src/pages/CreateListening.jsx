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

const emptyQuestion = () => ({
  id: crypto.randomUUID(),
  type: 'mcq',
  mode: 'single',
  question: '',
  options: ['', '', '', ''],
  answer: '',
  answers: [],
  instruction: '',
  columns: ['Question', 'Answer'],
  rows: [
    {
      id: crypto.randomUUID(),
      cells: [
        { type: 'text', text: '' },
        { type: 'blank', beforeText: '', afterText: '', answer: '', acceptedAnswers: '', maxWords: '' }
      ]
    }
  ],
  mapImage: '',
  mapLocations: [
    { id: crypto.randomUUID(), label: 'A', text: '' },
    { id: crypto.randomUUID(), label: 'B', text: '' },
    { id: crypto.randomUUID(), label: 'C', text: '' },
    { id: crypto.randomUUID(), label: 'D', text: '' }
  ],
  mapItems: [
    { id: crypto.randomUUID(), prompt: '', answer: '' }
  ]
})

const emptyTableRow = columns => ({
  id: crypto.randomUUID(),
  cells: columns.map((_, index) => ({
    type: index === columns.length - 1 ? 'blank' : 'text',
    text: '',
    beforeText: '',
    afterText: '',
    answer: '',
    acceptedAnswers: '',
    maxWords: ''
  }))
})

const emptyCompletionText = () => ({
  id: crypto.randomUUID(),
  type: 'text',
  content: ''
})

const emptyCompletionBlank = () => ({
  id: crypto.randomUUID(),
  type: 'blank',
  answer: '',
  acceptedAnswers: '',
  maxWords: ''
})

const emptyCompletionSection = () => ({
  id: crypto.randomUUID(),
  heading: '',
  parts: [emptyCompletionText(), emptyCompletionBlank(), emptyCompletionText()]
})

const ensureCompletionQuestion = question => ({
  ...question,
  type: 'listeningCompletion',
  completionTitle: question.completionTitle || '',
  instruction:
    question.instruction ||
    'Complete the notes below. Write ONE WORD AND/OR A NUMBER for each answer.',
  completionMode: question.completionMode || 'type',
  options: question.options?.length ? question.options : ['', '', '', '', '', '', '', ''],
  sections: question.sections?.length ? question.sections : [emptyCompletionSection()],
  question: question.question || ''
})

const emptyPart = number => ({
  id: crypto.randomUUID(),
  title: `Part ${number}`,
  instructions:
    number === 1
      ? 'Questions 1-10'
      : number === 2
        ? 'Questions 11-20'
        : number === 3
          ? 'Questions 21-30'
          : number === 4
            ? 'Questions 31-40'
            : '',
  questions: [emptyQuestion()]
})

const normalizeParts = data => {
  if (data.parts?.length) {
    return data.parts.map((part, index) => ({
      id: part.id || crypto.randomUUID(),
      title: part.title || `Part ${index + 1}`,
      instructions: part.instructions || '',
      questions: part.questions?.length ? part.questions : [emptyQuestion()]
    }))
  }

  return [
    {
      id: crypto.randomUUID(),
      title: 'Part 1',
      instructions: 'Questions 1-10',
      questions: data.questions?.length ? data.questions : [emptyQuestion()]
    }
  ]
}

export default function CreateListening() {
  const { id } = useParams()
  const isEditMode = Boolean(id)
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])
  const [search, setSearch] = useState('')

  const [title, setTitle] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  const [instructions, setInstructions] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [timeLimit, setTimeLimit] = useState(30)
  const [assignTo, setAssignTo] = useState([])
  const [parts, setParts] = useState([
    emptyPart(1),
    emptyPart(2),
    emptyPart(3),
    emptyPart(4)
  ])
  const [activePartId, setActivePartId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let isActive = true

    const unsub = onAuthStateChanged(auth, async currentUser => {
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
      } catch (error) {
        console.error(error)

        if (isActive) {
          await signOut(auth)
          navigate('/login')
        }
      }
    })

    return () => {
      isActive = false
      unsub()
    }
  }, [navigate])

  useEffect(() => {
    const q = query(collection(db, 'users'), where('role', '==', 'student'))

    return onSnapshot(q, snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(student => student.status === 'approved' && student.deleted !== true)

      list.sort((a, b) =>
        (a.name || a.email || '').localeCompare(b.name || b.email || '')
      )
      setStudents(list)
    })
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'classes'))

    return onSnapshot(q, snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(classItem => classItem.archived !== true)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

      setClasses(list)
    })
  }, [])

  useEffect(() => {
    if (!activePartId && parts.length > 0) {
      setActivePartId(parts[0].id)
    }
  }, [activePartId, parts])

  useEffect(() => {
    const loadListening = async () => {
      if (!isEditMode) return

      const snap = await getDoc(doc(db, 'listenings', id))

      if (!snap.exists()) {
        alert('Listening homework not found.')
        navigate('/teacher')
        return
      }

      const data = snap.data()

      setTitle(data.title || '')
      setAudioUrl(data.audioUrl || '')
      setInstructions(data.instructions || '')
      setDueDate(data.dueDate || '')
      setTimeLimit(data.timeLimit || 30)
      setAssignTo(data.assignTo || [])

      const loadedParts = normalizeParts(data)
      setParts(loadedParts)
      setActivePartId(loadedParts[0]?.id || null)
    }

    loadListening()
  }, [id, isEditMode, navigate])

  const filteredStudents = useMemo(() => {
    const term = search.trim().toLowerCase()

    if (!term) return students

    return students.filter(student => {
      const name = student.name?.toLowerCase() || ''
      const email = student.email?.toLowerCase() || ''

      return name.includes(term) || email.includes(term)
    })
  }, [students, search])

  const selectedStudents = students.filter(student =>
    assignTo.includes(student.id)
  )

  const activePart = parts.find(part => part.id === activePartId) || parts[0]
  const questions = activePart?.questions || []

  const setQuestions = updater => {
    if (!activePart) return

    setParts(prev =>
      prev.map(part => {
        if (part.id !== activePart.id) return part

        const nextQuestions =
          typeof updater === 'function'
            ? updater(part.questions || [])
            : updater

        return {
          ...part,
          questions: nextQuestions
        }
      })
    )
  }

  const updatePart = (partId, key, value) => {
    setParts(prev =>
      prev.map(part =>
        part.id === partId
          ? {
              ...part,
              [key]: value
            }
          : part
      )
    )
  }

  const addPart = () => {
    const nextPart = emptyPart(parts.length + 1)

    setParts(prev => [...prev, nextPart])
    setActivePartId(nextPart.id)
  }

  const duplicatePart = part => {
    const clone = JSON.parse(JSON.stringify(part))
    clone.id = crypto.randomUUID()
    clone.title = `${part.title || 'Part'} Copy`
    clone.questions = (clone.questions || []).map(question => ({
      ...question,
      id: crypto.randomUUID(),
      rows: question.rows?.map(row => ({ ...row, id: crypto.randomUUID() })) || [],
      mapLocations:
        question.mapLocations?.map(location => ({
          ...location,
          id: crypto.randomUUID()
        })) || [],
      mapItems:
        question.mapItems?.map(item => ({
          ...item,
          id: crypto.randomUUID()
        })) || []
    }))

    setParts(prev => [...prev, clone])
    setActivePartId(clone.id)
  }

  const removePart = partId => {
    if (parts.length === 1) {
      alert('Listening needs at least one part.')
      return
    }

    const ok = window.confirm('Delete this listening part and all questions inside it?')
    if (!ok) return

    setParts(prev => {
      const next = prev.filter(part => part.id !== partId)

      if (activePartId === partId) {
        setActivePartId(next[0]?.id || null)
      }

      return next
    })
  }

  const getListeningQuestionPointCount = question => {
    if (question.type === 'table' || question.type === 'note') {
      let count = 0

      question.rows?.forEach(row => {
        row.cells?.forEach(cell => {
          if (cell.type === 'blank') count++
        })
      })

      return count || 1
    }

    if (question.type === 'listeningCompletion') {
      let count = 0

      question.sections?.forEach(section => {
        section.parts?.forEach(part => {
          if (part.type === 'blank') count++
        })
      })

      return count || 1
    }

    if (question.type === 'map') {
      return question.mapItems?.length || 0
    }

    return 1
  }

  const getListeningBlankNumber = (partId, questionId, rowId, cellIndex) => {
    let number = 1

    for (const part of parts || []) {
      for (const question of part.questions || []) {
        if (question.id === questionId) {
          for (const row of question.rows || []) {
            for (let index = 0; index < (row.cells || []).length; index++) {
              const cell = row.cells[index]

              if (cell.type !== 'blank') continue

              if (part.id === partId && row.id === rowId && index === cellIndex) {
                return number
              }

              number++
            }
          }

          return number
        }

        number += getListeningQuestionPointCount(question)
      }
    }

    return number
  }

  const getListeningCompletionBlankNumber = (partId, questionId, sectionId, partItemId) => {
    let number = 1

    for (const part of parts || []) {
      for (const question of part.questions || []) {
        if (question.id === questionId) {
          for (const section of question.sections || []) {
            for (const item of section.parts || []) {
              if (item.type !== 'blank') continue

              if (part.id === partId && section.id === sectionId && item.id === partItemId) {
                return number
              }

              number++
            }
          }

          return number
        }

        number += getListeningQuestionPointCount(question)
      }
    }

    return number
  }

  const getPartQuestionCount = part => part.questions?.length || 0

  const toggleStudent = studentId => {
    setAssignTo(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    )
  }

  const selectAllFiltered = () => {
    const ids = filteredStudents.map(student => student.id)
    setAssignTo(prev => Array.from(new Set([...prev, ...ids])))
  }

  const clearAssignments = () => {
    setAssignTo([])
  }

  const assignClassToListening = classItem => {
    const classStudentIds = classItem.studentIds || []

    if (classStudentIds.length === 0) {
      alert('This class has no students yet.')
      return
    }

    setAssignTo(prev => Array.from(new Set([...prev, ...classStudentIds])))
  }

  const removeClassFromListening = classItem => {
    const classStudentIds = classItem.studentIds || []

    setAssignTo(prev =>
      prev.filter(studentId => !classStudentIds.includes(studentId))
    )
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

  const getStudentName = studentId => {
    const student = students.find(item => item.id === studentId)
    return student?.name || student?.email || 'Unknown student'
  }

  const updateQuestion = (questionId, key, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        if (key === 'type') {
          if (value === 'mcq') {
            return {
              ...question,
              type: 'mcq',
              mode: question.mode || 'single',
              options: question.options?.length ? question.options : ['', '', '', ''],
              answer: '',
              answers: []
            }
          }

          if (value === 'table' || value === 'note') {
            return {
              ...question,
              type: value,
              instruction: question.instruction || '',
              columns: question.columns?.length ? question.columns : ['Question', 'Answer'],
              rows: question.rows?.length ? question.rows : [emptyTableRow(['Question', 'Answer'])]
            }
          }

          if (value === 'map') {
            return {
              ...question,
              type: 'map',
              instruction: question.instruction || 'Label the map. Choose the correct letter A–F.',
              mapImage: question.mapImage || '',
              mapLocations: question.mapLocations?.length
                ? question.mapLocations
                : [
                    { id: crypto.randomUUID(), label: 'A', text: '' },
                    { id: crypto.randomUUID(), label: 'B', text: '' },
                    { id: crypto.randomUUID(), label: 'C', text: '' },
                    { id: crypto.randomUUID(), label: 'D', text: '' }
                  ],
              mapItems: question.mapItems?.length
                ? question.mapItems
                : [{ id: crypto.randomUUID(), prompt: '', answer: '' }]
            }
          }

          if (value === 'listeningCompletion') {
            return ensureCompletionQuestion(question)
          }

          return {
            ...question,
            type: value,
            mode: 'single',
            answer: '',
            answers: []
          }
        }

        return {
          ...question,
          [key]: value
        }
      })
    )
  }

  const updateOption = (questionId, optionIndex, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const options = [...(question.options || [])]
        options[optionIndex] = value

        return {
          ...question,
          options
        }
      })
    )
  }

  const toggleCorrectMulti = (questionId, letter) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const current = Array.isArray(question.answers) ? question.answers : []
        const answers = current.includes(letter)
          ? current.filter(item => item !== letter)
          : current.length < 2
            ? [...current, letter]
            : current

        return {
          ...question,
          answers
        }
      })
    )
  }

  const updateTableColumn = (questionId, columnIndex, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const columns = [...(question.columns || [])]
        columns[columnIndex] = value

        return {
          ...question,
          columns
        }
      })
    )
  }

  const addTableColumn = questionId => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const columns = [...(question.columns || []), `Column ${(question.columns || []).length + 1}`]
        const rows = (question.rows || []).map(row => ({
          ...row,
          cells: [
            ...(row.cells || []),
            { type: 'blank', text: '', beforeText: '', afterText: '', answer: '', acceptedAnswers: '', maxWords: '' }
          ]
        }))

        return {
          ...question,
          columns,
          rows
        }
      })
    )
  }

  const removeTableColumn = (questionId, columnIndex) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question
        if ((question.columns || []).length <= 2) {
          alert('Table needs at least 2 columns.')
          return question
        }

        const columns = question.columns.filter((_, index) => index !== columnIndex)
        const rows = (question.rows || []).map(row => ({
          ...row,
          cells: row.cells.filter((_, index) => index !== columnIndex)
        }))

        return {
          ...question,
          columns,
          rows
        }
      })
    )
  }

  const addTableRow = questionId => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          rows: [
            ...(question.rows || []),
            emptyTableRow(question.columns || ['Question', 'Answer'])
          ]
        }
      })
    )
  }

  const removeTableRow = (questionId, rowId) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question
        if ((question.rows || []).length <= 1) {
          alert('Table needs at least 1 row.')
          return question
        }

        return {
          ...question,
          rows: question.rows.filter(row => row.id !== rowId)
        }
      })
    )
  }

  const updateTableCell = (questionId, rowId, cellIndex, key, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const rows = (question.rows || []).map(row => {
          if (row.id !== rowId) return row

          const cells = [...(row.cells || [])]
          cells[cellIndex] = {
            ...cells[cellIndex],
            [key]: value
          }

          return {
            ...row,
            cells
          }
        })

        return {
          ...question,
          rows
        }
      })
    )
  }


  const updateCompletionOption = (questionId, optionIndex, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const options = [...(question.options || ['', '', '', '', '', '', '', ''])]
        options[optionIndex] = value

        return {
          ...question,
          options
        }
      })
    )
  }

  const updateCompletionSection = (questionId, sectionId, key, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          sections: (question.sections || []).map(section =>
            section.id === sectionId
              ? {
                  ...section,
                  [key]: value
                }
              : section
          )
        }
      })
    )
  }

  const addCompletionSection = questionId => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          sections: [
            ...(question.sections || []),
            emptyCompletionSection()
          ]
        }
      })
    )
  }

  const removeCompletionSection = (questionId, sectionId) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        if ((question.sections || []).length <= 1) {
          alert('Completion question needs at least one section.')
          return question
        }

        return {
          ...question,
          sections: question.sections.filter(section => section.id !== sectionId)
        }
      })
    )
  }

  const updateCompletionPart = (questionId, sectionId, partId, key, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          sections: (question.sections || []).map(section => {
            if (section.id !== sectionId) return section

            return {
              ...section,
              parts: (section.parts || []).map(part =>
                part.id === partId
                  ? {
                      ...part,
                      [key]: value
                    }
                  : part
              )
            }
          })
        }
      })
    )
  }

  const addCompletionPart = (questionId, sectionId, type) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          sections: (question.sections || []).map(section => {
            if (section.id !== sectionId) return section

            return {
              ...section,
              parts: [
                ...(section.parts || []),
                type === 'blank' ? emptyCompletionBlank() : emptyCompletionText()
              ]
            }
          })
        }
      })
    )
  }

  const removeCompletionPart = (questionId, sectionId, partId) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          sections: (question.sections || []).map(section => {
            if (section.id !== sectionId) return section

            if ((section.parts || []).length <= 1) {
              alert('Section needs at least one item.')
              return section
            }

            return {
              ...section,
              parts: section.parts.filter(part => part.id !== partId)
            }
          })
        }
      })
    )
  }

  const updateMapLocation = (questionId, locationId, key, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          mapLocations: (question.mapLocations || []).map(location =>
            location.id === locationId
              ? { ...location, [key]: value }
              : location
          )
        }
      })
    )
  }

  const addMapLocation = questionId => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        const usedLabels = (question.mapLocations || []).map(location => location.label)
        const nextLabel = letters.find(letter => !usedLabels.includes(letter)) || letters[(question.mapLocations || []).length] || 'Z'

        return {
          ...question,
          mapLocations: [
            ...(question.mapLocations || []),
            { id: crypto.randomUUID(), label: nextLabel, text: '' }
          ]
        }
      })
    )
  }

  const removeMapLocation = (questionId, locationId) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question
        if ((question.mapLocations || []).length <= 2) {
          alert('Map labeling needs at least 2 locations.')
          return question
        }

        return {
          ...question,
          mapLocations: question.mapLocations.filter(location => location.id !== locationId)
        }
      })
    )
  }

  const updateMapItem = (questionId, itemId, key, value) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          mapItems: (question.mapItems || []).map(item =>
            item.id === itemId
              ? { ...item, [key]: value }
              : item
          )
        }
      })
    )
  }

  const addMapItem = questionId => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question

        return {
          ...question,
          mapItems: [
            ...(question.mapItems || []),
            { id: crypto.randomUUID(), prompt: '', answer: '' }
          ]
        }
      })
    )
  }

  const removeMapItem = (questionId, itemId) => {
    setQuestions(prev =>
      prev.map(question => {
        if (question.id !== questionId) return question
        if ((question.mapItems || []).length <= 1) {
          alert('Map labeling needs at least 1 question item.')
          return question
        }

        return {
          ...question,
          mapItems: question.mapItems.filter(item => item.id !== itemId)
        }
      })
    )
  }

  const addQuestion = () => {
    setQuestions(prev => [...prev, emptyQuestion()])
  }

  const duplicateQuestion = question => {
    const clone = JSON.parse(JSON.stringify(question))
    clone.id = crypto.randomUUID()
    clone.question = `${question.question} Copy`
    clone.rows = clone.rows?.map(row => ({ ...row, id: crypto.randomUUID() })) || []
    clone.mapLocations = clone.mapLocations?.map(location => ({ ...location, id: crypto.randomUUID() })) || []
    clone.mapItems = clone.mapItems?.map(item => ({ ...item, id: crypto.randomUUID() })) || []
    clone.sections =
      clone.sections?.map(section => ({
        ...section,
        id: crypto.randomUUID(),
        parts:
          section.parts?.map(part => ({
            ...part,
            id: crypto.randomUUID()
          })) || []
      })) || []

    setQuestions(prev => [...prev, clone])
  }

  const removeQuestion = questionId => {
    if (questions.length === 1) {
      alert('You need at least one question.')
      return
    }

    setQuestions(prev => prev.filter(question => question.id !== questionId))
  }

  const validateQuestions = () => {
    for (const part of parts) {
      if (!part.title?.trim()) {
        alert('Every listening part needs a title.')
        return false
      }

      if (!part.questions?.length) {
        alert(`${part.title || 'Part'} needs at least one question.`)
        return false
      }

      for (const question of part.questions) {
      if (question.type !== 'table' && question.type !== 'note' && question.type !== 'map' && question.type !== 'listeningCompletion' && !question.question.trim()) {
        alert('Please fill in every question text.')
        return false
      }

      if (question.type === 'mcq') {
        const cleanOptions = question.options?.filter(option => option.trim()) || []

        if (cleanOptions.length < 2) {
          alert('Each multiple choice question needs at least 2 options.')
          return false
        }

        if (question.mode === 'multi') {
          if (!question.answers || question.answers.length !== 2) {
            alert('Choose TWO correct answers for every multi-select question.')
            return false
          }
        } else if (!question.answer) {
          alert('Choose the correct answer for every multiple choice question.')
          return false
        }
      }

      if (question.type === 'fitb' && !question.answer.trim()) {
        alert('Every fill in the blank question needs a correct answer.')
        return false
      }

      if (question.type === 'tfng' && !question.answer) {
        alert('Every True / False / Not Given question needs a correct answer.')
        return false
      }

      if (question.type === 'table' || question.type === 'note') {
        let blankCount = 0

        for (const row of question.rows || []) {
          for (const cell of row.cells || []) {
            if (cell.type === 'blank') {
              blankCount++

              if (!cell.answer?.trim()) {
                alert('Every table blank needs a correct answer.')
                return false
              }
            }
          }
        }

        if (blankCount === 0) {
          alert('Table / form completion needs at least one blank answer cell.')
          return false
        }
      }

      if (question.type === 'listeningCompletion') {
        let blankCount = 0

        for (const section of question.sections || []) {
          for (const item of section.parts || []) {
            if (item.type !== 'blank') continue

            blankCount++

            if (question.completionMode === 'choose') {
              if (!item.answer) {
                alert('Every listening completion blank needs a correct option.')
                return false
              }
            } else if (!item.answer?.trim()) {
              alert('Every listening completion blank needs a correct answer.')
              return false
            }
          }
        }

        if (blankCount === 0) {
          alert('Listening completion needs at least one blank.')
          return false
        }

        if (question.completionMode === 'choose') {
          const cleanOptions = question.options?.filter(option => option.trim()) || []

          if (cleanOptions.length < 2) {
            alert('Choose A-H mode needs at least 2 options.')
            return false
          }
        }
      }

      if (question.type === 'map') {
        if (!question.mapImage?.trim()) {
          alert('Map labeling needs a map image URL.')
          return false
        }

        const locations = question.mapLocations || []
        const items = question.mapItems || []

        if (locations.length < 2) {
          alert('Map labeling needs at least 2 map locations.')
          return false
        }

        if (items.length === 0) {
          alert('Map labeling needs at least 1 question item.')
          return false
        }

        for (const item of items) {
          if (!item.prompt?.trim() || !item.answer) {
            alert('Every map labeling item needs a label prompt and correct letter.')
            return false
          }
        }
      }
      }
    }

    return true
  }

  const handleSave = async () => {
    if (!title.trim()) {
      alert('Please add a title.')
      return
    }

    if (!audioUrl.trim()) {
      alert('Please add an audio URL.')
      return
    }

    if (assignTo.length === 0) {
      alert('Please assign at least one student.')
      return
    }

    if (!validateQuestions()) return

    setSaving(true)

    const cleanParts = parts.map(part => ({
      ...part,
      title: part.title?.trim() || 'Part',
      instructions: part.instructions || '',
      questions: part.questions || []
    }))

    const payload = {
      title: title.trim(),
      audioUrl: audioUrl.trim(),
      instructions,
      dueDate,
      timeLimit: Number(timeLimit) || 30,
      assignTo,
      parts: cleanParts,
      questions: cleanParts.flatMap(part =>
        (part.questions || []).map(question => ({
          ...question,
          partId: part.id,
          partTitle: part.title
        }))
      ),
      updatedAt: new Date().toISOString()
    }

    try {
      if (isEditMode) {
        await updateDoc(doc(db, 'listenings', id), payload)
      } else {
        await addDoc(collection(db, 'listenings'), {
          ...payload,
          createdBy: user.uid,
          createdAt: new Date().toISOString(),
          archived: false
        })
      }

      setSaved(true)

      setTimeout(() => {
        navigate('/teacher')
      }, 1000)
    } catch (error) {
      console.error(error)
      alert('Could not save listening homework.')
    } finally {
      setSaving(false)
    }
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

      <div className="max-w-6xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          {isEditMode ? 'Edit Listening Homework' : 'Create Listening Homework'}
        </h1>

        <p className="text-gray-500 mb-8">
          Add an audio link, organize questions by IELTS Listening parts and assign it to students.
        </p>

        {saved && (
          <div className="bg-green-50 text-green-600 rounded-xl p-4 mb-6 text-sm font-medium">
            ✓ Listening homework saved and assigned. Redirecting...
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
          <div className="space-y-6">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                Listening Details
              </h2>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Title
                </label>

                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. IELTS Listening Test 01"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                />
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Audio URL
                </label>

                <input
                  value={audioUrl}
                  onChange={e => setAudioUrl(e.target.value)}
                  placeholder="https://...mp3"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                />

                <p className="text-xs text-gray-400 mt-2">
                  Use a direct MP3 link or any browser-playable audio URL.
                </p>
              </div>

              {audioUrl && (
                <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-4">
                  <p className="text-xs text-gray-400 mb-2">Audio preview</p>
                  <audio controls src={audioUrl} className="w-full" />
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Time limit / minutes
                  </label>

                  <input
                    type="number"
                    min="5"
                    max="90"
                    value={timeLimit}
                    onChange={e => setTimeLimit(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Due date / optional
                  </label>

                  <input
                    type="date"
                    value={dueDate}
                    onChange={e => setDueDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 mb-1 block">
                  Instructions / optional
                </label>

                <textarea
                  rows={4}
                  value={instructions}
                  onChange={e => setInstructions(e.target.value)}
                  placeholder="You will hear the recording once. Answer the questions below."
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
                />
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Listening Parts
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Build IELTS Listening as Part 1, Part 2, Part 3 and Part 4. Each part can have its own question set.
                  </p>
                </div>

                <button
                  onClick={addPart}
                  className="text-xs bg-gray-900 text-white px-4 py-2 rounded-xl hover:bg-gray-800"
                >
                  + Add Part
                </button>
              </div>

              <div className="flex gap-2 overflow-x-auto mb-5 pb-1">
                {parts.map((part, partIndex) => (
                  <button
                    key={part.id}
                    type="button"
                    onClick={() => setActivePartId(part.id)}
                    className={`whitespace-nowrap px-4 py-2 rounded-xl text-xs font-medium border ${
                      activePart?.id === part.id
                        ? 'bg-purple-600 text-white border-purple-600'
                        : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {part.title || `Part ${partIndex + 1}`}
                    <span className="opacity-70 ml-1">
                      ({getPartQuestionCount(part)})
                    </span>
                  </button>
                ))}
              </div>

              {activePart && (
                <div className="bg-gray-50 border border-gray-100 rounded-2xl p-5 mb-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">
                        Part title
                      </label>

                      <input
                        value={activePart.title || ''}
                        onChange={e =>
                          updatePart(activePart.id, 'title', e.target.value)
                        }
                        placeholder="Part 1"
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">
                        Part instructions / optional
                      </label>

                      <input
                        value={activePart.instructions || ''}
                        onChange={e =>
                          updatePart(activePart.id, 'instructions', e.target.value)
                        }
                        placeholder="Questions 1-10"
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={addQuestion}
                      className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                    >
                      + Add Question to {activePart.title || 'Part'}
                    </button>

                    <button
                      onClick={() => duplicatePart(activePart)}
                      className="text-xs bg-white border border-gray-200 text-gray-500 px-4 py-2 rounded-xl hover:bg-gray-50"
                    >
                      Duplicate Part
                    </button>

                    <button
                      onClick={() => removePart(activePart.id)}
                      className="text-xs bg-red-50 text-red-500 px-4 py-2 rounded-xl hover:bg-red-100"
                    >
                      Delete Part
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-4">
                {questions.map((question, index) => (
                  <div
                    key={question.id}
                    className="border border-gray-100 rounded-2xl p-5 bg-gray-50"
                  >
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <p className="text-sm font-semibold text-gray-800">
                        {activePart?.title || 'Part'} · Question {index + 1}
                      </p>

                      <div className="flex gap-2">
                        <button
                          onClick={() => duplicateQuestion(question)}
                          className="text-xs bg-white border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg"
                        >
                          Duplicate
                        </button>

                        <button
                          onClick={() => removeQuestion(question.id)}
                          className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">
                          Question type
                        </label>

                        <select
                          value={question.type}
                          onChange={e => updateQuestion(question.id, 'type', e.target.value)}
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                        >
                          <option value="mcq">Multiple Choice</option>
                          <option value="fitb">Fill in the Blank</option>
                          <option value="tfng">True / False / Not Given</option>
                          <option value="table">Table / Form Completion</option>
                          <option value="note">Note Completion Legacy</option>
                          <option value="listeningCompletion">Note/Summary Completion New</option>
                          <option value="map">Map Labeling</option>
                        </select>
                      </div>

                      {question.type === 'mcq' && (
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">
                            MCQ mode
                          </label>

                          <select
                            value={question.mode || 'single'}
                            onChange={e => updateQuestion(question.id, 'mode', e.target.value)}
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                          >
                            <option value="single">Single answer</option>
                            <option value="multi">Choose TWO</option>
                          </select>
                        </div>
                      )}

                      {question.type === 'listeningCompletion' && (
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">
                            Completion mode
                          </label>

                          <select
                            value={question.completionMode || 'type'}
                            onChange={e => updateQuestion(question.id, 'completionMode', e.target.value)}
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                          >
                            <option value="type">Type Answer</option>
                            <option value="choose">Choose A-H</option>
                          </select>
                        </div>
                      )}
                    </div>

                    {question.type !== 'table' && question.type !== 'note' && question.type !== 'map' && question.type !== 'listeningCompletion' && (
                      <div className="mb-4">
                        <label className="text-xs text-gray-400 mb-1 block">
                          Question text
                        </label>

                        <textarea
                          rows={3}
                          value={question.question}
                          onChange={e => updateQuestion(question.id, 'question', e.target.value)}
                          placeholder="Type the question..."
                          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none bg-white"
                        />
                      </div>
                    )}

                    {question.type === 'mcq' && (
                      <div>
                        <label className="text-xs text-gray-400 mb-2 block">
                          Options and correct answer
                        </label>

                        <div className="flex flex-col gap-2">
                          {(question.options || []).map((option, optionIndex) => {
                            const letter = letters[optionIndex]
                            const isCorrect =
                              question.mode === 'multi'
                                ? question.answers?.includes(letter)
                                : question.answer === letter

                            return (
                              <div
                                key={optionIndex}
                                className={`grid grid-cols-[46px_1fr_110px] gap-2 items-center rounded-xl ${
                                  isCorrect ? 'bg-green-50' : ''
                                }`}
                              >
                                <div className="text-sm font-semibold text-gray-500 text-center">
                                  {letter}
                                </div>

                                <input
                                  value={option}
                                  onChange={e => updateOption(question.id, optionIndex, e.target.value)}
                                  placeholder={`Option ${letter}`}
                                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                />

                                {question.mode === 'multi' ? (
                                  <button
                                    onClick={() => toggleCorrectMulti(question.id, letter)}
                                    className={`text-xs rounded-xl py-2 ${
                                      isCorrect
                                        ? 'bg-green-600 text-white'
                                        : 'bg-white border border-gray-200 text-gray-500'
                                    }`}
                                  >
                                    Correct
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => updateQuestion(question.id, 'answer', letter)}
                                    className={`text-xs rounded-xl py-2 ${
                                      isCorrect
                                        ? 'bg-green-600 text-white'
                                        : 'bg-white border border-gray-200 text-gray-500'
                                    }`}
                                  >
                                    Correct
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {question.type === 'fitb' && (
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">
                          Correct answer
                        </label>

                        <input
                          value={question.answer}
                          onChange={e => updateQuestion(question.id, 'answer', e.target.value)}
                          placeholder="Type correct answer..."
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                        />
                      </div>
                    )}

                    {question.type === 'tfng' && (
                      <div>
                        <label className="text-xs text-gray-400 mb-2 block">
                          Correct answer
                        </label>

                        <div className="flex gap-2">
                          {['True', 'False', 'Not Given'].map(option => (
                            <button
                              key={option}
                              onClick={() => updateQuestion(question.id, 'answer', option)}
                              className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                                question.answer === option
                                  ? 'bg-green-600 text-white border-green-600'
                                  : 'border-gray-200 text-gray-500 bg-white'
                              }`}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {question.type === 'listeningCompletion' && (
                      <div>
                        <div className="mb-4">
                          <label className="text-xs text-gray-400 mb-1 block">
                            Instruction
                          </label>

                          <textarea
                            rows={3}
                            value={question.instruction || ''}
                            onChange={e => updateQuestion(question.id, 'instruction', e.target.value)}
                            placeholder="Complete the notes below. Write ONE WORD AND/OR A NUMBER for each answer."
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none bg-white"
                          />
                        </div>

                        <div className="mb-4">
                          <label className="text-xs text-gray-400 mb-1 block">
                            Title / optional
                          </label>

                          <input
                            value={question.completionTitle || ''}
                            onChange={e => updateQuestion(question.id, 'completionTitle', e.target.value)}
                            placeholder="e.g. Notes on library registration"
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white"
                          />
                        </div>

                        {question.completionMode === 'choose' && (
                          <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-4">
                            <p className="text-sm font-semibold text-gray-800 mb-3">
                              Options A-H
                            </p>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              {(question.options || ['', '', '', '', '', '', '', '']).map((option, optionIndex) => (
                                <div key={optionIndex} className="grid grid-cols-[36px_1fr] gap-2 items-center">
                                  <span className="text-sm font-semibold text-gray-500">
                                    {letters[optionIndex]}.
                                  </span>

                                  <input
                                    value={option}
                                    onChange={e => updateCompletionOption(question.id, optionIndex, e.target.value)}
                                    placeholder={`Option ${letters[optionIndex]}`}
                                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-800">
                              Sections
                            </p>

                            <p className="text-xs text-gray-400">
                              Build the note/summary as text and blanks.
                            </p>
                          </div>

                          <button
                            onClick={() => addCompletionSection(question.id)}
                            className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
                          >
                            + Add Section
                          </button>
                        </div>

                        <div className="flex flex-col gap-4">
                          {(question.sections || []).map(section => (
                            <div key={section.id} className="bg-white border border-gray-100 rounded-2xl p-4">
                              <div className="grid grid-cols-[1fr_80px] gap-2 mb-3">
                                <input
                                  value={section.heading || ''}
                                  onChange={e => updateCompletionSection(question.id, section.id, 'heading', e.target.value)}
                                  placeholder="Section heading, e.g. Questions 1-4 / Transport"
                                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                />

                                <button
                                  onClick={() => removeCompletionSection(question.id, section.id)}
                                  className="text-xs bg-red-50 text-red-500 rounded-xl hover:bg-red-100"
                                >
                                  Delete
                                </button>
                              </div>

                              <div className="flex flex-col gap-2 mb-3">
                                {(section.parts || []).map(item => (
                                  <div key={item.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className={`text-xs px-2 py-1 rounded-full ${
                                        item.type === 'blank'
                                          ? 'bg-purple-50 text-purple-600'
                                          : 'bg-gray-100 text-gray-500'
                                      }`}>
                                        {item.type === 'blank'
                                          ? `Blank Q${getListeningCompletionBlankNumber(activePart.id, question.id, section.id, item.id)}`
                                          : 'Text'}
                                      </span>

                                      <button
                                        onClick={() => removeCompletionPart(question.id, section.id, item.id)}
                                        className="text-xs text-red-500"
                                      >
                                        Remove
                                      </button>
                                    </div>

                                    {item.type === 'text' ? (
                                      <textarea
                                        rows={2}
                                        value={item.content || ''}
                                        onChange={e => updateCompletionPart(question.id, section.id, item.id, 'content', e.target.value)}
                                        placeholder="Visible text..."
                                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-purple-400 bg-white resize-none"
                                      />
                                    ) : (
                                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                        {question.completionMode === 'choose' ? (
                                          <select
                                            value={item.answer || ''}
                                            onChange={e => updateCompletionPart(question.id, section.id, item.id, 'answer', e.target.value)}
                                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-purple-400 bg-white"
                                          >
                                            <option value="">Correct option</option>

                                            {(question.options || []).map((option, optionIndex) => {
                                              if (!option?.trim()) return null

                                              const letter = letters[optionIndex]

                                              return (
                                                <option key={letter} value={letter}>
                                                  {letter}. {option}
                                                </option>
                                              )
                                            })}
                                          </select>
                                        ) : (
                                          <input
                                            value={item.answer || ''}
                                            onChange={e => updateCompletionPart(question.id, section.id, item.id, 'answer', e.target.value)}
                                            placeholder="Correct answer"
                                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-purple-400 bg-white"
                                          />
                                        )}

                                        <input
                                          value={item.acceptedAnswers || ''}
                                          onChange={e => updateCompletionPart(question.id, section.id, item.id, 'acceptedAnswers', e.target.value)}
                                          placeholder="Alternatives, comma separated"
                                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-purple-400 bg-white"
                                        />

                                        <select
                                          value={item.maxWords || ''}
                                          onChange={e => updateCompletionPart(question.id, section.id, item.id, 'maxWords', e.target.value)}
                                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-purple-400 bg-white"
                                        >
                                          <option value="">No word limit</option>
                                          <option value="1">ONE WORD / NUMBER</option>
                                          <option value="2">NO MORE THAN TWO WORDS</option>
                                          <option value="3">NO MORE THAN THREE WORDS</option>
                                        </select>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>

                              <div className="flex gap-2">
                                <button
                                  onClick={() => addCompletionPart(question.id, section.id, 'text')}
                                  className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
                                >
                                  + Text
                                </button>

                                <button
                                  onClick={() => addCompletionPart(question.id, section.id, 'blank')}
                                  className="text-xs bg-purple-50 text-purple-600 px-3 py-2 rounded-xl hover:bg-purple-100"
                                >
                                  + Blank
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="bg-green-50 border border-green-100 rounded-2xl p-4 mt-4">
                          <p className="text-xs font-semibold text-green-700 mb-3">
                            Preview
                          </p>

                          <div className="bg-white rounded-xl p-5 text-sm text-gray-800 leading-8">
                            {question.completionTitle && (
                              <p className="text-center font-semibold text-gray-900 mb-4">
                                {question.completionTitle}
                              </p>
                            )}

                            {(question.sections || []).map(section => (
                              <div key={section.id} className="mb-3">
                                {section.heading && (
                                  <p className="font-bold text-gray-900 mb-1">
                                    {section.heading}
                                  </p>
                                )}

                                <p>
                                  {(section.parts || []).map(item => {
                                    if (item.type === 'text') {
                                      return (
                                        <span key={item.id} className="whitespace-pre-wrap">
                                          {item.content}
                                        </span>
                                      )
                                    }

                                    return (
                                      <span
                                        key={item.id}
                                        className="inline-block bg-green-50 border border-green-200 text-green-700 font-semibold rounded-md px-2 py-1 mx-1"
                                      >
                                        ({getListeningCompletionBlankNumber(activePart.id, question.id, section.id, item.id)}) ..........
                                      </span>
                                    )
                                  })}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {question.type === 'map' && (
                      <div>
                        <div className="mb-4">
                          <label className="text-xs text-gray-400 mb-1 block">
                            Instruction
                          </label>

                          <textarea
                            rows={3}
                            value={question.instruction || ''}
                            onChange={e => updateQuestion(question.id, 'instruction', e.target.value)}
                            placeholder="Label the map. Choose the correct letter A–F."
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none bg-white"
                          />
                        </div>

                        <div className="mb-4">
                          <label className="text-xs text-gray-400 mb-1 block">
                            Map image URL
                          </label>

                          <input
                            value={question.mapImage || ''}
                            onChange={e => updateQuestion(question.id, 'mapImage', e.target.value)}
                            placeholder="https://.../map-image.png"
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white"
                          />

                          <p className="text-xs text-gray-400 mt-2">
                            Upload the map image somewhere public and paste the image URL here for now.
                          </p>
                        </div>

                        {question.mapImage && (
                          <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-4">
                            <p className="text-xs text-gray-400 mb-2">Map preview</p>
                            <img
                              src={question.mapImage}
                              alt="Map preview"
                              className="w-full max-h-[420px] object-contain rounded-xl bg-gray-50"
                            />
                          </div>
                        )}

                        <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-4">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <p className="text-sm font-semibold text-gray-800">Map locations</p>
                              <p className="text-xs text-gray-400">Define letters shown on the map, such as A, B, C, D.</p>
                            </div>

                            <button
                              onClick={() => addMapLocation(question.id)}
                              className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
                            >
                              + Location
                            </button>
                          </div>

                          <div className="flex flex-col gap-2">
                            {(question.mapLocations || []).map(location => (
                              <div key={location.id} className="grid grid-cols-[70px_1fr_70px] gap-2 items-center">
                                <input
                                  value={location.label || ''}
                                  onChange={e => updateMapLocation(question.id, location.id, 'label', e.target.value.toUpperCase())}
                                  placeholder="A"
                                  maxLength={2}
                                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white text-center font-semibold"
                                />

                                <input
                                  value={location.text || ''}
                                  onChange={e => updateMapLocation(question.id, location.id, 'text', e.target.value)}
                                  placeholder="Optional note, e.g. near entrance / library"
                                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                />

                                <button
                                  onClick={() => removeMapLocation(question.id, location.id)}
                                  className="text-xs bg-red-50 text-red-500 px-3 py-2 rounded-xl hover:bg-red-100"
                                >
                                  Delete
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="bg-white border border-gray-100 rounded-2xl p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <p className="text-sm font-semibold text-gray-800">Questions</p>
                              <p className="text-xs text-gray-400">Students will choose a letter for each item.</p>
                            </div>

                            <button
                              onClick={() => addMapItem(question.id)}
                              className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                            >
                              + Map Item
                            </button>
                          </div>

                          <div className="flex flex-col gap-2">
                            {(question.mapItems || []).map((item, itemIndex) => (
                              <div key={item.id} className="grid grid-cols-[1fr_130px_70px] gap-2 items-center">
                                <input
                                  value={item.prompt || ''}
                                  onChange={e => updateMapItem(question.id, item.id, 'prompt', e.target.value)}
                                  placeholder={`Item ${itemIndex + 1}, e.g. library / reception`}
                                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                />

                                <select
                                  value={item.answer || ''}
                                  onChange={e => updateMapItem(question.id, item.id, 'answer', e.target.value)}
                                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
                                >
                                  <option value="">Correct letter</option>
                                  {(question.mapLocations || []).map(location => (
                                    <option key={location.id} value={location.label}>
                                      {location.label}
                                    </option>
                                  ))}
                                </select>

                                <button
                                  onClick={() => removeMapItem(question.id, item.id)}
                                  className="text-xs bg-red-50 text-red-500 px-3 py-2 rounded-xl hover:bg-red-100"
                                >
                                  Delete
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}


                    {(question.type === 'table' || question.type === 'note') && (
                      <div>
                        <div className="mb-4">
                          <label className="text-xs text-gray-400 mb-1 block">
                            Instruction
                          </label>

                          <textarea
                            rows={3}
                            value={question.instruction || ''}
                            onChange={e => updateQuestion(question.id, 'instruction', e.target.value)}
                            placeholder={question.type === 'note' ? 'Complete the notes below. Write ONE WORD AND/OR A NUMBER for each answer.' : 'Complete the form below. Write ONE WORD AND/OR A NUMBER for each answer.'}
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none bg-white"
                          />
                        </div>

                        <div className="flex items-center justify-between mb-3">
                          <label className="text-xs text-gray-400 block">
                            {question.type === 'note' ? 'Note Completion Layout' : 'Table / Form'}
                          </label>

                          <div className="flex gap-2">
                            <button
                              onClick={() => addTableColumn(question.id)}
                              className="text-xs bg-white border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg"
                            >
                              + Column
                            </button>

                            <button
                              onClick={() => addTableRow(question.id)}
                              className="text-xs bg-white border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg"
                            >
                              + Row
                            </button>
                          </div>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                            <thead>
                              <tr className="bg-gray-100">
                                {(question.columns || []).map((column, columnIndex) => (
                                  <th key={columnIndex} className="p-2 border border-white min-w-[160px]">
                                    <div className="flex gap-2">
                                      <input
                                        value={column}
                                        onChange={e => updateTableColumn(question.id, columnIndex, e.target.value)}
                                        className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white"
                                      />

                                      <button
                                        onClick={() => removeTableColumn(question.id, columnIndex)}
                                        className="text-xs text-red-500"
                                      >
                                        ×
                                      </button>
                                    </div>
                                  </th>
                                ))}
                                <th className="p-2 border border-white w-[70px]">Row</th>
                              </tr>
                            </thead>

                            <tbody>
                              {(question.rows || []).map(row => (
                                <tr key={row.id}>
                                  {(row.cells || []).map((cell, cellIndex) => (
                                    <td key={cellIndex} className="p-2 bg-gray-50 border border-white align-top">
                                      <select
                                        value={cell.type}
                                        onChange={e => updateTableCell(question.id, row.id, cellIndex, 'type', e.target.value)}
                                        className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white mb-2"
                                      >
                                        <option value="text">Text</option>
                                        <option value="blank">Blank Answer</option>
                                      </select>

                                      {cell.type === 'text' ? (
                                        <textarea
                                          rows={2}
                                          value={cell.text || ''}
                                          onChange={e => updateTableCell(question.id, row.id, cellIndex, 'text', e.target.value)}
                                          placeholder="Visible text..."
                                          className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white resize-none"
                                        />
                                      ) : (
                                        <div className="space-y-2">
                                          <div className="bg-purple-50 border border-purple-100 rounded-lg p-2">
                                            <p className="text-[10px] text-purple-500 font-medium mb-2">
                                              Inline blank preview
                                            </p>

                                            <div className="text-xs text-gray-700 leading-6">
                                              <span className="inline-block bg-white border border-purple-200 text-purple-600 font-semibold rounded-md px-2 py-0.5 mr-1">
                                                Q{getListeningBlankNumber(activePart.id, question.id, row.id, cellIndex)}
                                              </span>
                                              <span>{cell.beforeText || ''}</span>
                                              <span className="inline-block min-w-[72px] mx-1 px-2 py-0.5 rounded-md bg-white border border-purple-200 text-purple-500 text-center">
                                                answer
                                              </span>
                                              <span>{cell.afterText || ''}</span>
                                            </div>
                                          </div>

                                          <input
                                            value={cell.beforeText || ''}
                                            onChange={e => updateTableCell(question.id, row.id, cellIndex, 'beforeText', e.target.value)}
                                            placeholder="Text before blank, e.g. The"
                                            className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white"
                                          />

                                          <input
                                            value={cell.answer || ''}
                                            onChange={e => updateTableCell(question.id, row.id, cellIndex, 'answer', e.target.value)}
                                            placeholder="Main correct answer..."
                                            className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white"
                                          />

                                          <input
                                            value={cell.afterText || ''}
                                            onChange={e => updateTableCell(question.id, row.id, cellIndex, 'afterText', e.target.value)}
                                            placeholder="Text after blank, e.g. is a good place for a drink"
                                            className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white"
                                          />

                                          <input
                                            value={cell.acceptedAnswers || ''}
                                            onChange={e => updateTableCell(question.id, row.id, cellIndex, 'acceptedAnswers', e.target.value)}
                                            placeholder="Alternative answers, separated by comma"
                                            className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white"
                                          />

                                          <select
                                            value={cell.maxWords || ''}
                                            onChange={e => updateTableCell(question.id, row.id, cellIndex, 'maxWords', e.target.value)}
                                            className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-purple-400 bg-white"
                                          >
                                            <option value="">No word limit</option>
                                            <option value="1">ONE WORD / NUMBER</option>
                                            <option value="2">NO MORE THAN TWO WORDS</option>
                                            <option value="3">NO MORE THAN THREE WORDS</option>
                                          </select>
                                        </div>
                                      )}
                                    </td>
                                  ))}

                                  <td className="p-2 bg-gray-50 border border-white text-center">
                                    <button
                                      onClick={() => removeTableRow(question.id, row.id)}
                                      className="text-xs text-red-500"
                                    >
                                      Delete
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 h-fit sticky top-6">
            <h2 className="font-semibold text-gray-800 mb-2">
              Assign Students
            </h2>

            <p className="text-xs text-gray-400 mb-4">
              Selected students will receive this listening homework.
            </p>

            {classes.length > 0 && (
              <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-4">
                <p className="text-sm font-semibold text-purple-800 mb-1">
                  Assign by Class
                </p>
                <p className="text-xs text-purple-500 mb-3">
                  Add all students from a class in one click.
                </p>

                <div className="flex flex-col gap-2">
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
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {classItem.name}
                            </p>

                            <p className="text-xs text-gray-400 mt-0.5">
                              {classStudentIds.length} student{classStudentIds.length === 1 ? '' : 's'}
                              {partlyAssigned && !fullyAssigned ? ' · partly selected' : ''}
                              {fullyAssigned ? ' · selected' : ''}
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
                              onClick={() => removeClassFromListening(classItem)}
                              className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-100 flex-shrink-0"
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              onClick={() => assignClassToListening(classItem)}
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

            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search students..."
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 mb-3"
            />

            <div className="flex gap-2 mb-4">
              <button
                onClick={selectAllFiltered}
                className="flex-1 bg-purple-50 text-purple-600 rounded-xl py-2 text-xs font-medium"
              >
                Select filtered
              </button>

              <button
                onClick={clearAssignments}
                className="flex-1 bg-gray-100 text-gray-600 rounded-xl py-2 text-xs font-medium"
              >
                Clear
              </button>
            </div>

            <div className="max-h-[360px] overflow-y-auto flex flex-col gap-2 pr-1">
              {filteredStudents.length === 0 ? (
                <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                  No students found.
                </p>
              ) : (
                filteredStudents.map(student => (
                  <label
                    key={student.id}
                    className={`border rounded-xl p-3 cursor-pointer flex items-center gap-3 ${
                      assignTo.includes(student.id)
                        ? 'border-purple-300 bg-purple-50'
                        : 'border-gray-100 bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={assignTo.includes(student.id)}
                      onChange={() => toggleStudent(student.id)}
                      className="accent-purple-600"
                    />

                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {student.name}
                      </p>

                      <p className="text-xs text-gray-400">
                        {student.email}
                      </p>
                    </div>
                  </label>
                ))
              )}
            </div>

            <div className="border-t border-gray-100 mt-5 pt-5">
              <p className="text-xs text-gray-400 mb-2">
                Selected students
              </p>

              {selectedStudents.length === 0 ? (
                <p className="text-sm text-gray-400">
                  None selected.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {selectedStudents.map(student => (
                    <span
                      key={student.id}
                      className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full"
                    >
                      {student.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-6 disabled:opacity-60"
            >
              {saving
                ? 'Saving...'
                : isEditMode
                  ? 'Save Changes'
                  : 'Save & Assign Listening'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}