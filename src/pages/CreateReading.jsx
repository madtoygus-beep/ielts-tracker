import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  doc,
  getDoc,
  updateDoc
} from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export default function CreateReading() {
  const { id } = useParams()
  const isEditMode = Boolean(id)

  const [user, setUser] = useState(null)
  const [students, setStudents] = useState([])

  const [title, setTitle] = useState('')
  const [timeLimit, setTimeLimit] = useState(60)
  const [dueDate, setDueDate] = useState('')
  const [assignTo, setAssignTo] = useState([])

  const [passageMode, setPassageMode] = useState('standard')
  const [fullPassage, setFullPassage] = useState('')
  const [paragraphs, setParagraphs] = useState([
    { id: Date.now(), letter: 'A', text: '' }
  ])

  const [headings, setHeadings] = useState(['', '', '', '', '', '', ''])
  const [questions, setQuestions] = useState([])
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hasSubmissions, setHasSubmissions] = useState(false)

  const navigate = useNavigate()

  const getQuestionItemCount = question => {
    if (question.type === 'matching') {
      return question.paragraphs?.length || 0
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

  const getQuestionStartNumber = index => {
    return questions
      .slice(0, index)
      .reduce((sum, question) => sum + getQuestionItemCount(question), 0) + 1
  }

  const getQuestionRangeLabel = (question, index) => {
    const start = getQuestionStartNumber(index)
    const count = getQuestionItemCount(question)
    const end = start + count - 1

    return count > 1 ? `Questions ${start}-${end}` : `Question ${start}`
  }

  const getQuestionTypeLabel = question => {
    if (question.type === 'matching') return 'Matching Headings'
    if (question.type === 'tfng') return 'True / False / Not Given'
    if (question.type === 'fitb') return 'Fill in the Blank'
    if (question.type === 'table') return 'Table Completion'
    if (question.type === 'summary') return 'Summary Completion'
    if (question.mode === 'multi') return 'Multiple Choice — Choose TWO'
    return 'Multiple Choice'
  }


  const removeUndefined = value => {
    if (Array.isArray(value)) {
      return value.map(removeUndefined)
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, removeUndefined(v)])
      )
    }

    return value
  }

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

  useEffect(() => {
    let unsubSubmissions = null

    const loadReading = async () => {
      if (!isEditMode) return

      const snap = await getDoc(doc(db, 'readings', id))

      if (!snap.exists()) {
        alert('Reading homework not found.')
        navigate('/teacher')
        return
      }

      const data = snap.data()

      setTitle(data.title || '')
      setTimeLimit(data.timeLimit || 60)
      setDueDate(data.dueDate || '')
      setAssignTo(data.assignTo || [])
      setPassageMode(
        data.passageMode || (data.paragraphs ? 'sections' : 'standard')
      )
      setFullPassage(data.passage || '')

      if (data.paragraphs?.length) {
        setParagraphs(
          data.paragraphs.map((p, index) => ({
            id: p.id || Date.now() + index,
            letter: p.letter || letters[index],
            text: p.text || ''
          }))
        )
      } else {
        setParagraphs([{ id: Date.now(), letter: 'A', text: '' }])
      }

      setHeadings(
        data.headings?.length ? data.headings : ['', '', '', '', '', '', '']
      )

      const loadedQuestions = (data.questions || []).map(question => {
        if (question.type === 'mcq') {
          return {
            id: question.id || Date.now(),
            type: 'mcq',
            mode: question.mode || 'single',
            question: question.question || '',
            options: question.options?.length
              ? question.options
              : ['', '', '', ''],
            answer: question.answer || '',
            answers: question.answers || []
          }
        }

        if (question.type === 'table' || question.type === 'summary') {
          return {
            id: question.id || Date.now(),
            type: question.type,
            instruction:
              question.instruction ||
              (question.type === 'summary'
                ? 'Complete the summary below. Choose NO MORE THAN THREE WORDS from the passage for each answer.'
                : 'Complete the table below. Choose NO MORE THAN THREE WORDS from the passage for each answer.'),
            columns: question.columns?.length
              ? question.columns
              : question.type === 'summary'
                ? ['Summary', 'Answer']
                : ['Column 1', 'Column 2', 'Column 3'],
            rows: question.rows?.length
              ? question.rows
              : [
                  {
                    id: Date.now(),
                    cells:
                      question.type === 'summary'
                        ? [
                            { type: 'text', text: '' },
                            { type: 'blank', answer: '' }
                          ]
                        : [
                            { type: 'text', text: '' },
                            { type: 'text', text: '' },
                            { type: 'blank', answer: '' }
                          ]
                  }
                ]
          }
        }

        if (question.type === 'matching') {
          return {
            id: question.id || Date.now(),
            type: 'matching',
            paragraphs: question.paragraphs || []
          }
        }

        return {
          id: question.id || Date.now(),
          type: question.type,
          question: question.question || '',
          answer: question.answer || '',
          options: question.options || []
        }
      })

      setQuestions(loadedQuestions)

      const subQuery = query(
        collection(db, 'readingSubmissions'),
        where('readingId', '==', id)
      )

      unsubSubmissions = onSnapshot(subQuery, subSnap => {
        setHasSubmissions(!subSnap.empty)
      })
    }

    loadReading()

    return () => {
      if (unsubSubmissions) unsubSubmissions()
    }
  }, [id, isEditMode, navigate])

  const toggleStudent = studentId => {
    setAssignTo(prev =>
      prev.includes(studentId)
        ? prev.filter(s => s !== studentId)
        : [...prev, studentId]
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

  const removeParagraph = paragraphId => {
    setParagraphs(prev => {
      const filtered = prev.filter(p => p.id !== paragraphId)

      return filtered.map((p, index) => ({
        ...p,
        letter: letters[index]
      }))
    })
  }

  const updateParagraph = (paragraphId, value) => {
    setParagraphs(prev =>
      prev.map(p => (p.id === paragraphId ? { ...p, text: value } : p))
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

    if (type === 'table') {
      setQuestions(prev => [
        ...prev,
        {
          id: Date.now(),
          type: 'table',
          instruction:
            'Complete the table below. Choose NO MORE THAN THREE WORDS from the passage for each answer.',
          columns: ['Original Theorist', 'Theory', 'Principle'],
          rows: [
            {
              id: Date.now(),
              cells: [
                { type: 'text', text: '' },
                { type: 'text', text: '' },
                { type: 'blank', answer: '' }
              ]
            }
          ]
        }
      ])

      return
    }

    if (type === 'summary') {
      setQuestions(prev => [
        ...prev,
        {
          id: Date.now(),
          type: 'summary',
          instruction:
            'Complete the summary below. Choose NO MORE THAN THREE WORDS from the passage for each answer.',
          columns: ['Summary', 'Answer'],
          rows: [
            {
              id: Date.now(),
              cells: [
                { type: 'text', text: '' },
                { type: 'blank', answer: '' }
              ]
            }
          ]
        }
      ])

      return
    }

    if (type === 'mcq') {
      setQuestions(prev => [
        ...prev,
        {
          id: Date.now(),
          type: 'mcq',
          mode: 'single',
          question: '',
          options: ['', '', '', ''],
          answer: '',
          answers: []
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
        options: [],
        answer: ''
      }
    ])
  }

  const removeQuestion = questionId => {
    setQuestions(prev => prev.filter(q => q.id !== questionId))
  }

  const updateQuestion = (questionId, field, value) => {
    setQuestions(prev =>
      prev.map(q => (q.id === questionId ? { ...q, [field]: value } : q))
    )
  }

  const updateMcqMode = (questionId, mode) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        return {
          ...q,
          mode,
          answer: mode === 'single' ? q.answer || '' : '',
          answers: mode === 'multi' ? q.answers || [] : []
        }
      })
    )
  }

  const updateOption = (questionId, index, value) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        const options = [...q.options]
        options[index] = value

        return {
          ...q,
          options
        }
      })
    )
  }

  const addOption = questionId => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        return {
          ...q,
          options: [...q.options, '']
        }
      })
    )
  }

  const removeOption = (questionId, optionIndex) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q
        if (q.options.length <= 2) return q

        const removedLetter = letters[optionIndex]
        const options = q.options.filter((_, index) => index !== optionIndex)

        return {
          ...q,
          options,
          answer: q.answer === removedLetter ? '' : q.answer || '',
          answers: (q.answers || []).filter(answer => answer !== removedLetter)
        }
      })
    )
  }

  const toggleMultiAnswer = (questionId, optionIndex) => {
    const letter = letters[optionIndex]

    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        const current = q.answers || []

        const updated = current.includes(letter)
          ? current.filter(item => item !== letter)
          : current.length < 2
            ? [...current, letter]
            : current

        return {
          ...q,
          answers: updated
        }
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

  const updateTableColumn = (questionId, columnIndex, value) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        const columns = [...q.columns]
        columns[columnIndex] = value

        return {
          ...q,
          columns
        }
      })
    )
  }

  const addTableColumn = questionId => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        return {
          ...q,
          columns: [...q.columns, `Column ${q.columns.length + 1}`],
          rows: q.rows.map(row => ({
            ...row,
            cells: [...row.cells, { type: 'text', text: '' }]
          }))
        }
      })
    )
  }

  const removeTableColumn = (questionId, columnIndex) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q
        if (q.columns.length <= 2) return q

        return {
          ...q,
          columns: q.columns.filter((_, index) => index !== columnIndex),
          rows: q.rows.map(row => ({
            ...row,
            cells: row.cells.filter((_, index) => index !== columnIndex)
          }))
        }
      })
    )
  }

  const addTableRow = questionId => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        return {
          ...q,
          rows: [
            ...q.rows,
            {
              id: Date.now(),
              cells: q.columns.map(() => ({
                type: 'text',
                text: ''
              }))
            }
          ]
        }
      })
    )
  }

  const removeTableRow = (questionId, rowId) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q
        if (q.rows.length <= 1) return q

        return {
          ...q,
          rows: q.rows.filter(row => row.id !== rowId)
        }
      })
    )
  }

  const updateTableCell = (questionId, rowId, cellIndex, field, value) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        return {
          ...q,
          rows: q.rows.map(row => {
            if (row.id !== rowId) return row

            return {
              ...row,
              cells: row.cells.map((cell, index) =>
                index === cellIndex ? { ...cell, [field]: value } : cell
              )
            }
          })
        }
      })
    )
  }

  const toggleTableCellType = (questionId, rowId, cellIndex) => {
    setQuestions(prev =>
      prev.map(q => {
        if (q.id !== questionId) return q

        return {
          ...q,
          rows: q.rows.map(row => {
            if (row.id !== rowId) return row

            return {
              ...row,
              cells: row.cells.map((cell, index) => {
                if (index !== cellIndex) return cell

                return cell.type === 'blank'
                  ? { type: 'text', text: cell.answer || '' }
                  : { type: 'blank', answer: cell.text || '' }
              })
            }
          })
        }
      })
    )
  }

  useEffect(() => {
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
  }, [paragraphs])

  const validateQuestions = () => {
    for (const question of questions) {
      if (question.type === 'mcq') {
        const filledOptions = question.options.filter(option => option.trim())

        if (!question.question.trim()) {
          alert('Please fill all MCQ questions.')
          return false
        }

        if (filledOptions.length < 2) {
          alert('MCQ questions need at least 2 options.')
          return false
        }

        if ((question.mode || 'single') === 'multi') {
          if ((question.answers || []).length !== 2) {
            alert('Choose TWO Answers questions must have exactly 2 correct answers.')
            return false
          }
        } else if (!question.answer) {
          alert('Single Answer MCQ questions must have 1 correct answer.')
          return false
        }
      }

      if (question.type === 'fitb') {
        if (!question.question.trim() || !question.answer.trim()) {
          alert('Please fill all Fill Blank questions and answers.')
          return false
        }
      }

      if (question.type === 'tfng') {
        if (!question.question.trim() || !question.answer) {
          alert('Please fill all T/F/NG statements and answers.')
          return false
        }
      }

      if (question.type === 'matching') {
        for (const paragraph of question.paragraphs) {
          if (!paragraph.answer) {
            alert('Please select correct headings for all matching paragraphs.')
            return false
          }
        }
      }

      if (question.type === 'table' || question.type === 'summary') {
        if (!question.instruction?.trim()) {
          alert('Please add table instructions.')
          return false
        }

        let blankCount = 0

        for (const row of question.rows) {
          for (const cell of row.cells) {
            if (cell.type === 'blank') {
              blankCount++

              if (!cell.answer?.trim()) {
                alert('Every blank cell needs a correct answer.')
                return false
              }
            }
          }
        }

        if (blankCount === 0) {
          alert('Table / Summary Completion needs at least one blank answer cell.')
          return false
        }
      }
    }

    return true
  }

  const handleSave = async () => {
    if (saving) return

    if (!title.trim()) {
      alert('Please add a title.')
      return
    }

    if (questions.length === 0) {
      alert('Please add at least one question.')
      return
    }

    if (passageMode === 'standard' && !fullPassage.trim()) {
      alert('Please add the reading passage.')
      return
    }

    if (passageMode === 'sections' && paragraphs.some(p => !p.text.trim())) {
      alert('Please fill all paragraph sections.')
      return
    }

    if (!validateQuestions()) return

    if (isEditMode && hasSubmissions) {
      const ok = window.confirm(
        'This reading already has student submissions. Changing questions, answers or headings may affect previous results. Continue?'
      )

      if (!ok) return
    }

    setSaving(true)

    const cleanedQuestions = questions.map(question => {
      if (question.type === 'mcq') {
        const filledOptions = question.options.filter(option => option.trim())

        return {
          id: question.id,
          type: 'mcq',
          mode: question.mode || 'single',
          question: question.question || '',
          options: filledOptions,
          answer:
            (question.mode || 'single') === 'single'
              ? question.answer || ''
              : '',
          answers:
            (question.mode || 'single') === 'multi'
              ? question.answers || []
              : []
        }
      }

      if (question.type === 'table' || question.type === 'summary') {
        return {
          id: question.id,
          type: question.type,
          instruction: question.instruction || '',
          columns: question.columns.map(column => column.trim() || 'Column'),
          rows: question.rows.map(row => ({
            id: row.id,
            cells: row.cells.map(cell =>
              cell.type === 'blank'
                ? { type: 'blank', answer: cell.answer || '' }
                : { type: 'text', text: cell.text || '' }
            )
          }))
        }
      }

      if (question.type === 'matching') {
        return {
          id: question.id,
          type: 'matching',
          paragraphs: question.paragraphs.map(p => ({
            letter: p.letter || '',
            answer: p.answer || ''
          }))
        }
      }

      return {
        id: question.id,
        type: question.type,
        question: question.question || '',
        options: question.options || [],
        answer: question.answer || ''
      }
    })

    const payload = removeUndefined({
      title,
      timeLimit,
      dueDate,
      assignTo,
      passageMode,
      passage: fullPassage,
      paragraphs,
      headings,
      questions: cleanedQuestions,
      updatedAt: new Date().toISOString()
    })

    try {
      if (isEditMode) {
        await updateDoc(doc(db, 'readings', id), payload)
      } else {
        await addDoc(
          collection(db, 'readings'),
          removeUndefined({
            ...payload,
            createdBy: user.uid,
            createdAt: new Date().toISOString(),
            archived: false
          })
        )
      }

      setSaved(true)

      setTimeout(() => {
        navigate('/teacher')
      }, 1000)
    } catch (error) {
      console.error(error)
      alert('Could not save reading homework.')
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

      <div className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          {isEditMode ? 'Edit IELTS Reading' : 'Create IELTS Reading'}
        </h1>

        <p className="text-gray-400 text-sm mb-8">
          {isEditMode
            ? 'Update the passage, questions, headings, due date or assignments.'
            : 'Build IELTS-style reading homework with different question types.'}
        </p>

        {saved && (
          <div className="bg-green-50 text-green-600 rounded-xl p-4 mb-6 text-sm font-medium">
            ✓ Reading homework saved. Redirecting...
          </div>
        )}

        {isEditMode && hasSubmissions && (
          <div className="bg-amber-50 text-amber-700 rounded-xl p-4 mb-6 text-sm font-medium">
            ⚠ This reading already has student submissions. Changing questions,
            answers or headings may affect previous student results.
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

          <div className="mb-4">
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

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-5">
          <h2 className="font-semibold text-gray-800 mb-4">
            Assign Students
          </h2>

          {students.length === 0 ? (
            <p className="text-sm text-gray-400">No students found.</p>
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
            <textarea
              rows={14}
              value={fullPassage}
              onChange={e => setFullPassage(e.target.value)}
              placeholder="Paste the full reading passage here..."
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
            />
          ) : (
            <div>
              <div className="flex flex-col gap-4">
                {paragraphs.map(paragraph => (
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

              <button
                onClick={() => addQuestion('table')}
                className="text-xs bg-emerald-50 text-emerald-600 px-3 py-2 rounded-lg hover:bg-emerald-100"
              >
                + Table Completion
              </button>

              <button
                onClick={() => addQuestion('summary')}
                className="text-xs bg-rose-50 text-rose-600 px-3 py-2 rounded-lg hover:bg-rose-100"
              >
                + Summary Completion
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
                  <span className="text-xs font-medium px-3 py-1.5 rounded-full bg-purple-50 text-purple-600">
{getQuestionTypeLabel(question)}
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
                    <input
                      value={question.question}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'question',
                          e.target.value
                        )
                      }
                      placeholder={`Statement ${index + 1}`}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 mb-3"
                    />

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
                    <input
                      value={question.question}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'question',
                          e.target.value
                        )
                      }
                      placeholder="Question..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 mb-3"
                    />

                    <input
                      value={question.answer}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'answer',
                          e.target.value
                        )
                      }
                      placeholder="Correct answer"
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                    />
                  </div>
                )}

                {(question.type === 'table' || question.type === 'summary') && (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">
                      Instruction
                    </label>

                    <textarea
                      rows={2}
                      value={question.instruction}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'instruction',
                          e.target.value
                        )
                      }
                      placeholder={
                        question.type === 'summary'
                          ? 'Complete the summary below. Choose NO MORE THAN THREE WORDS from the passage for each answer.'
                          : 'Complete the table below. Choose NO MORE THAN THREE WORDS from the passage for each answer.'
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 mb-4 resize-none"
                    />

                    <div className="overflow-x-auto border border-gray-100 rounded-xl">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-100">
                            {question.columns.map((column, columnIndex) => (
                              <th
                                key={columnIndex}
                                className="p-3 border border-white min-w-[180px]"
                              >
                                <div className="flex gap-2 items-center">
                                  <input
                                    value={column}
                                    onChange={e =>
                                      updateTableColumn(
                                        question.id,
                                        columnIndex,
                                        e.target.value
                                      )
                                    }
                                    className="w-full bg-white border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none"
                                  />

                                  {question.columns.length > 2 && (
                                    <button
                                      onClick={() =>
                                        removeTableColumn(
                                          question.id,
                                          columnIndex
                                        )
                                      }
                                      className="text-red-400 text-xs"
                                    >
                                      ×
                                    </button>
                                  )}
                                </div>
                              </th>
                            ))}

                            <th className="p-3 border border-white w-20">
                              Row
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          {question.rows.map(row => (
                            <tr key={row.id}>
                              {row.cells.map((cell, cellIndex) => (
                                <td
                                  key={cellIndex}
                                  className="p-3 border border-white bg-gray-50 align-top"
                                >
                                  <div className="flex gap-2 mb-2">
                                    <button
                                      onClick={() =>
                                        toggleTableCellType(
                                          question.id,
                                          row.id,
                                          cellIndex
                                        )
                                      }
                                      className={`text-xs px-2 py-1 rounded-lg ${
                                        cell.type === 'blank'
                                          ? 'bg-purple-600 text-white'
                                          : 'bg-gray-200 text-gray-600'
                                      }`}
                                    >
                                      {cell.type === 'blank'
                                        ? 'Blank'
                                        : 'Text'}
                                    </button>
                                  </div>

                                  {cell.type === 'blank' ? (
                                    <input
                                      value={cell.answer || ''}
                                      onChange={e =>
                                        updateTableCell(
                                          question.id,
                                          row.id,
                                          cellIndex,
                                          'answer',
                                          e.target.value
                                        )
                                      }
                                      placeholder="Correct answer"
                                      className="w-full border border-purple-200 bg-white rounded-lg px-2 py-2 text-xs outline-none"
                                    />
                                  ) : (
                                    <textarea
                                      rows={3}
                                      value={cell.text || ''}
                                      onChange={e =>
                                        updateTableCell(
                                          question.id,
                                          row.id,
                                          cellIndex,
                                          'text',
                                          e.target.value
                                        )
                                      }
                                      placeholder="Cell text"
                                      className="w-full border border-gray-200 bg-white rounded-lg px-2 py-2 text-xs outline-none resize-none"
                                    />
                                  )}
                                </td>
                              ))}

                              <td className="p-3 border border-white bg-gray-50">
                                {question.rows.length > 1 && (
                                  <button
                                    onClick={() =>
                                      removeTableRow(question.id, row.id)
                                    }
                                    className="text-xs text-red-500"
                                  >
                                    Remove
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex gap-2 mt-4">
                      <button
                        onClick={() => addTableRow(question.id)}
                        className="text-sm bg-emerald-50 text-emerald-600 px-4 py-2 rounded-xl hover:bg-emerald-100"
                      >
                        + Add Row
                      </button>

                      <button
                        onClick={() => addTableColumn(question.id)}
                        className="text-sm bg-gray-100 text-gray-600 px-4 py-2 rounded-xl hover:bg-gray-200"
                      >
                        + Add Column
                      </button>
                    </div>
                  </div>
                )}

                {question.type === 'mcq' && (
                  <div>
                    <input
                      value={question.question}
                      onChange={e =>
                        updateQuestion(
                          question.id,
                          'question',
                          e.target.value
                        )
                      }
                      placeholder="Question..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 mb-3"
                    />

                    <div className="flex gap-2 mb-4">
                      <button
                        onClick={() => updateMcqMode(question.id, 'single')}
                        className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                          (question.mode || 'single') === 'single'
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'border-gray-200 text-gray-500'
                        }`}
                      >
                        Single Answer
                      </button>

                      <button
                        onClick={() => updateMcqMode(question.id, 'multi')}
                        className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                          question.mode === 'multi'
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'border-gray-200 text-gray-500'
                        }`}
                      >
                        Choose TWO Answers
                      </button>
                    </div>

                    {question.mode === 'multi' && (
                      <p className="text-xs text-amber-600 bg-amber-50 rounded-xl p-3 mb-3">
                        Select exactly two correct options. Students will also choose two.
                      </p>
                    )}

                    <div className="flex flex-col gap-2">
                      {question.options.map((option, optionIndex) => (
                        <div key={optionIndex} className="flex items-center gap-2">
                          {question.mode === 'multi' ? (
                            <button
                              onClick={() =>
                                option.trim() &&
                                toggleMultiAnswer(question.id, optionIndex)
                              }
                              className={`w-6 h-6 rounded-md border-2 flex-shrink-0 ${
                                (question.answers || []).includes(
                                  letters[optionIndex]
                                )
                                  ? 'bg-purple-600 border-purple-600'
                                  : 'border-gray-300'
                              }`}
                            >
                              {(question.answers || []).includes(
                                letters[optionIndex]
                              ) && <span className="text-white text-xs">✓</span>}
                            </button>
                          ) : (
                            <button
                              onClick={() =>
                                option.trim() &&
                                updateQuestion(
                                  question.id,
                                  'answer',
                                  letters[optionIndex]
                                )
                              }
                              className={`w-6 h-6 rounded-full border-2 flex-shrink-0 ${
                                question.answer === letters[optionIndex]
                                  ? 'bg-purple-600 border-purple-600'
                                  : 'border-gray-300'
                              }`}
                            />
                          )}

                          <input
                            value={option}
                            onChange={e =>
                              updateOption(
                                question.id,
                                optionIndex,
                                e.target.value
                              )
                            }
                            placeholder={`Option ${letters[optionIndex]}`}
                            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                          />

                          {question.options.length > 2 && (
                            <button
                              onClick={() =>
                                removeOption(question.id, optionIndex)
                              }
                              className="text-xs text-red-400 hover:text-red-600 px-2"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => addOption(question.id)}
                      className="mt-3 text-sm bg-gray-100 text-gray-600 px-4 py-2 rounded-xl hover:bg-gray-200"
                    >
                      + Add Option
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
        >
          {saving
            ? 'Saving...'
            : isEditMode
              ? 'Save Changes'
              : 'Save & Assign Reading'}
        </button>
      </div>
    </div>
  )
}