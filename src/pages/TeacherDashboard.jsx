import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc
} from 'firebase/firestore'
import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

export default function TeacherDashboard() {
  const [students, setStudents] = useState([])
  const [scores, setScores] = useState({})
  const [readings, setReadings] = useState([])
  const [submissions, setSubmissions] = useState([])

  const [selected, setSelected] = useState(null)
  const [selectedReview, setSelectedReview] = useState(null)
  const [selectedHomework, setSelectedHomework] = useState(null)
  const [assignmentDraft, setAssignmentDraft] = useState([])

  const [form, setForm] = useState({
    listening: '',
    reading: '',
    writing: '',
    speaking: '',
    date: ''
  })

  const [user, setUser] = useState(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState('')

  const navigate = useNavigate()

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      setUser(currentUser)

      const studentsQuery = query(
        collection(db, 'users'),
        where('role', '==', 'student')
      )

      onSnapshot(studentsQuery, snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        setStudents(list)

        list.forEach(student => {
          const scoreQuery = query(
            collection(db, 'scores'),
            where('uid', '==', student.id)
          )

          onSnapshot(scoreQuery, ssnap => {
            const data = ssnap.docs.map(d => ({ id: d.id, ...d.data() }))
            data.sort((a, b) => new Date(b.date) - new Date(a.date))

            setScores(prev => ({
              ...prev,
              [student.id]: data
            }))
          })
        })
      })

      onSnapshot(query(collection(db, 'readings')), snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        setReadings(list)
      })

      onSnapshot(query(collection(db, 'readingSubmissions')), snap => {
        setSubmissions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      })
    })

    return unsub
  }, [navigate])

  const activeReadings = readings.filter(r => !r.archived)
  const archivedReadings = readings.filter(r => r.archived)

  const overall = score => {
    const avg =
      (+score.listening +
        +score.reading +
        +score.writing +
        +score.speaking) /
      4

    return (Math.round(avg * 2) / 2).toFixed(1)
  }

  const handleAddScore = async () => {
    if (
      !form.listening ||
      !form.reading ||
      !form.writing ||
      !form.speaking ||
      !form.date
    ) {
      return
    }

    await addDoc(collection(db, 'scores'), {
      ...form,
      uid: selected.id,
      overall: overall(form),
      addedBy: user.uid
    })

    setForm({
      listening: '',
      reading: '',
      writing: '',
      speaking: '',
      date: ''
    })
  }

  const latestScore = studentId => scores[studentId]?.[0]

  const getStudentReadings = studentId => {
    return activeReadings.filter(reading =>
      reading.assignTo?.includes(studentId)
    )
  }

  const getSubmission = (studentId, readingId) => {
    return submissions.find(
      sub => sub.uid === studentId && sub.readingId === readingId
    )
  }

  const getCompletedCount = readingId => {
    return submissions.filter(sub => sub.readingId === readingId).length
  }

  const openAssignmentManager = reading => {
    setSelectedHomework(reading)
    setAssignmentDraft(reading.assignTo || [])
  }

  const toggleAssignment = studentId => {
    setAssignmentDraft(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    )
  }

  const saveAssignments = async () => {
    if (!selectedHomework) return

    await updateDoc(doc(db, 'readings', selectedHomework.id), {
      assignTo: assignmentDraft,
      archived: false
    })

    setSelectedHomework(null)
    setAssignmentDraft([])
  }

  const archiveHomework = async reading => {
    const ok = window.confirm(
      `"${reading.title}" will be archived and removed from students' homework list. Existing results will stay saved.`
    )

    if (!ok) return

    await updateDoc(doc(db, 'readings', reading.id), {
      archived: true,
      assignTo: []
    })
  }

  const restoreHomework = async reading => {
    await updateDoc(doc(db, 'readings', reading.id), {
      archived: false
    })
  }

  const deleteHomework = async reading => {
    const completedCount = getCompletedCount(reading.id)

    if (completedCount > 0) {
      const forceDelete = window.confirm(
        `"${reading.title}" has ${completedCount} student submission(s).

Deleting will permanently remove:
- Homework
- Student answers
- Results/Bands

Continue permanent delete?`
      )

      if (!forceDelete) return

      const relatedSubs = submissions.filter(
        sub => sub.readingId === reading.id
      )

      for (const sub of relatedSubs) {
        await deleteDoc(doc(db, 'readingSubmissions', sub.id))
      }

      await deleteDoc(doc(db, 'readings', reading.id))
      return
    }

    const ok = window.confirm(`Delete "${reading.title}" permanently?`)

    if (!ok) return

    await deleteDoc(doc(db, 'readings', reading.id))
  }

  const duplicateHomework = async reading => {
    const ok = window.confirm(
      `Duplicate "${reading.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      assignTo,
      archived,
      ...copyData
    } = reading

    await addDoc(collection(db, 'readings'), {
      ...copyData,
      title: `${reading.title} Copy`,
      assignTo: [],
      archived: false,
      createdBy: user.uid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const normalize = value => value?.toString().trim().toLowerCase()

  const getHeadingText = (reading, number) => {
    if (!number) return 'No answer'
    const index = Number(number) - 1
    return reading.headings?.[index] || `Heading ${number}`
  }

  const isNormalCorrect = (submission, question) => {
    const userAnswer = normalize(submission.answers?.[question.id])
    const correctAnswer = normalize(question.answer)

    return userAnswer === correctAnswer
  }

  const isMatchingCorrect = (submission, question, paragraph) => {
    const userAnswer = submission.answers?.[question.id]?.[paragraph.letter]
      ?.toString()
      .trim()

    const correctAnswer = paragraph.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  const getStudentAnalytics = studentId => {
    const studentSubs = submissions.filter(sub => sub.uid === studentId)

    const stats = {
      matching: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      mcq: { correct: 0, total: 0 }
    }

    studentSubs.forEach(sub => {
      const reading = readings.find(r => r.id === sub.readingId)
      if (!reading) return

      reading.questions?.forEach(question => {
        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats.matching.total++

            if (isMatchingCorrect(sub, question, paragraph)) {
              stats.matching.correct++
            }
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(sub, question)) {
          stats[question.type].correct++
        }
      })
    })

    const percentage = item =>
      item.total ? Math.round((item.correct / item.total) * 100) : null

    const data = {
      matching: percentage(stats.matching),
      tfng: percentage(stats.tfng),
      fitb: percentage(stats.fitb),
      mcq: percentage(stats.mcq)
    }

    const weaknessList = Object.entries(data)
      .filter(([_, value]) => value !== null)
      .sort((a, b) => a[1] - b[1])

    return {
      ...data,
      weakest: weaknessList[0]?.[0] || null
    }
  }

  const getWeakestLabel = type => {
    if (type === 'matching') return 'Matching Headings'
    if (type === 'tfng') return 'True / False / Not Given'
    if (type === 'fitb') return 'Fill in the Blank'
    if (type === 'mcq') return 'Multiple Choice'
    return 'No data yet'
  }

  const getAnalyticsColor = value => {
    if (value === null || value === undefined) return 'text-gray-400'
    if (value >= 75) return 'text-green-600'
    if (value >= 60) return 'text-amber-600'
    return 'text-red-500'
  }

  const handlePrint = student => {
    const studentScores = scores[student.id] || []
    const printWindow = window.open('', '_blank')

    printWindow.document.write(`
      <html>
        <head>
          <title>${student.name} - IELTS Scores</title>
          <style>
            body { font-family: sans-serif; padding: 40px; color: #111; }
            h1 { font-size: 24px; margin-bottom: 4px; }
            p { color: #666; font-size: 14px; margin-bottom: 30px; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #7c3aed; color: white; padding: 10px 14px; text-align: left; font-size: 13px; }
            td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #eee; }
            .overall { font-weight: bold; color: #7c3aed; }
            img { height: 50px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <img src="${window.location.origin}/1.png" />
          <h1>${student.name}</h1>
          <p>${student.email} — IELTS Score Report</p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Listening</th>
                <th>Reading</th>
                <th>Writing</th>
                <th>Speaking</th>
                <th>Overall</th>
              </tr>
            </thead>
            <tbody>
              ${studentScores
                .map(
                  s => `
                <tr>
                  <td>${s.date}</td>
                  <td>${s.listening}</td>
                  <td>${s.reading}</td>
                  <td>${s.writing}</td>
                  <td>${s.speaking}</td>
                  <td class="overall">${s.overall}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </body>
      </html>
    `)

    printWindow.document.close()
    printWindow.print()
  }

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      setPasswordMsg('Password must be at least 6 characters')
      return
    }

    try {
      await updatePassword(auth.currentUser, newPassword)
      setPasswordMsg('Password changed successfully!')
      setNewPassword('')
    } catch (err) {
      setPasswordMsg(
        'Error: Please log out and log back in first, then try again.'
      )
    }
  }

  const renderHomeworkCard = (reading, archived = false) => (
    <div
      key={reading.id}
      className={`border rounded-xl p-4 flex items-center justify-between gap-4 ${
        archived
          ? 'border-gray-100 bg-gray-50 opacity-80'
          : 'border-gray-100 bg-gray-50'
      }`}
    >
      <div>
        <p className="text-sm font-medium text-gray-800">
          {reading.title}
        </p>

        <p className="text-xs text-gray-400 mt-0.5">
          Assigned to {reading.assignTo?.length || 0} students · Completed by{' '}
          {getCompletedCount(reading.id)} students · {reading.timeLimit} min
        </p>

        {archived && (
          <p className="text-xs text-amber-600 mt-1 font-medium">
            Archived — hidden from students
          </p>
        )}
      </div>

      <div className="flex gap-2 flex-wrap justify-end">
        {!archived && (
          <>
            <button
              onClick={() => navigate(`/edit-reading/${reading.id}`)}
              className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-100"
            >
              Edit
            </button>

            <button
              onClick={() => duplicateHomework(reading)}
              className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
            >
              Duplicate
            </button>

            <button
              onClick={() => openAssignmentManager(reading)}
              className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
            >
              Manage
            </button>
          </>
        )}

        {archived ? (
          <button
            onClick={() => restoreHomework(reading)}
            className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
          >
            Restore
          </button>
        ) : (
          <button
            onClick={() => archiveHomework(reading)}
            className="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-xl hover:bg-amber-100"
          >
            Archive
          </button>
        )}

        <button
          onClick={() => deleteHomework(reading)}
          className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
        >
          Delete
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">{user?.email}</span>

          <button
            onClick={() => setShowPasswordModal(true)}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            Change Password
          </button>

          <button
            onClick={() => {
              signOut(auth)
              navigate('/')
            }}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            Logout
          </button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Teacher Dashboard
        </h1>

        <p className="text-gray-400 text-sm mb-6">
          Manage students, scores and reusable reading homework
        </p>

        <div className="flex gap-3 mb-8">
          <button
            onClick={() => navigate('/create-reading')}
            className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-700"
          >
            📖 Create Reading Homework
          </button>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Homework Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Reuse, duplicate, assign, unassign, archive or delete reading homework.
              </p>
            </div>

            <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
              {activeReadings.length} active
            </span>
          </div>

          {activeReadings.length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No active reading homework.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {activeReadings.map(reading => renderHomeworkCard(reading))}
            </div>
          )}

          {archivedReadings.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                Archived Homework
              </h3>

              <div className="flex flex-col gap-3">
                {archivedReadings.map(reading =>
                  renderHomeworkCard(reading, true)
                )}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4">
          {students.length === 0 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">
              No students signed up yet.
            </div>
          )}

          {students.map(student => {
            const studentReadings = getStudentReadings(student.id)
            const analytics = getStudentAnalytics(student.id)

            return (
              <div
                key={student.id}
                className="bg-white border border-gray-100 rounded-2xl overflow-hidden"
              >
                <div
                  className="flex items-center justify-between p-5 cursor-pointer hover:bg-gray-50"
                  onClick={() =>
                    setSelected(selected?.id === student.id ? null : student)
                  }
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-semibold text-sm">
                      {student.name?.charAt(0).toUpperCase()}
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {student.name}
                      </p>

                      <p className="text-xs text-gray-400">
                        {student.email}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {latestScore(student.id) && (
                      <div className="text-right">
                        <p className="text-xs text-gray-400">Latest band</p>
                        <p className="text-lg font-bold text-purple-600">
                          {latestScore(student.id).overall}
                        </p>
                      </div>
                    )}

                    <div className="text-right">
                      <p className="text-xs text-gray-400">Reading done</p>
                      <p className="text-sm font-semibold text-gray-700">
                        {
                          studentReadings.filter(reading =>
                            getSubmission(student.id, reading.id)
                          ).length
                        }
                        /{studentReadings.length}
                      </p>
                    </div>

                    <div className="text-gray-300 text-lg">
                      {selected?.id === student.id ? '▲' : '▼'}
                    </div>
                  </div>
                </div>

                {selected?.id === student.id && (
                  <div className="border-t border-gray-100 p-5">
                    <div className="mb-8">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Log a new score for {student.name}
                      </h3>

                      <div className="grid grid-cols-2 gap-3 mb-3">
                        {['listening', 'reading', 'writing', 'speaking'].map(
                          skill => (
                            <div key={skill}>
                              <label className="text-xs text-gray-400 capitalize mb-1 block">
                                {skill}
                              </label>

                              <input
                                type="number"
                                min="0"
                                max="9"
                                step="0.5"
                                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                                placeholder="e.g. 7.5"
                                value={form[skill]}
                                onChange={e =>
                                  setForm(prev => ({
                                    ...prev,
                                    [skill]: e.target.value
                                  }))
                                }
                              />
                            </div>
                          )
                        )}
                      </div>

                      <div className="mb-3">
                        <label className="text-xs text-gray-400 mb-1 block">
                          Test date
                        </label>

                        <input
                          type="date"
                          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                          value={form.date}
                          onChange={e =>
                            setForm(prev => ({
                              ...prev,
                              date: e.target.value
                            }))
                          }
                        />
                      </div>

                      <button
                        onClick={handleAddScore}
                        className="w-full bg-purple-600 text-white rounded-xl py-2.5 text-sm font-medium hover:bg-purple-700"
                      >
                        Save score for {student.name}
                      </button>
                    </div>

                    {scores[student.id]?.length > 0 && (
                      <div className="mb-8">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold text-gray-700">
                            Score history
                          </h3>

                          <button
                            onClick={() => handlePrint(student)}
                            className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg"
                          >
                            🖨️ Print scores
                          </button>
                        </div>

                        <div className="flex flex-col gap-2">
                          {scores[student.id].map(score => (
                            <div
                              key={score.id}
                              className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0"
                            >
                              <div>
                                <p className="text-sm text-gray-700">
                                  {score.date}
                                </p>

                                <p className="text-xs text-gray-400">
                                  L:{score.listening} R:{score.reading} W:
                                  {score.writing} S:{score.speaking}
                                </p>
                              </div>

                              <div className="text-lg font-bold text-purple-600">
                                {score.overall}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {analytics.weakest && (
                      <div className="mb-8">
                        <h3 className="text-sm font-semibold text-gray-700 mb-3">
                          Reading Weakness Analytics
                        </h3>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                          {[
                            ['Matching', analytics.matching],
                            ['TFNG', analytics.tfng],
                            ['Fill Blank', analytics.fitb],
                            ['MCQ', analytics.mcq]
                          ].map(([label, value]) => (
                            <div
                              key={label}
                              className="bg-gray-50 rounded-xl p-4 text-center"
                            >
                              <p className="text-xs text-gray-400 mb-1">
                                {label}
                              </p>

                              <p
                                className={`text-xl font-bold ${getAnalyticsColor(
                                  value
                                )}`}
                              >
                                {value ?? '--'}%
                              </p>
                            </div>
                          ))}
                        </div>

                        <div className="bg-purple-50 rounded-xl p-4">
                          <p className="text-xs text-gray-500 mb-1">
                            Weakest Area
                          </p>

                          <p className="font-semibold text-purple-700">
                            {getWeakestLabel(analytics.weakest)}
                          </p>
                        </div>
                      </div>
                    )}

                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Reading homework results
                      </h3>

                      {studentReadings.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active reading homework assigned to this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentReadings.map(reading => {
                            const submission = getSubmission(
                              student.id,
                              reading.id
                            )

                            return (
                              <div
                                key={reading.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {reading.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {reading.questions?.length || 0} question
                                      sets · {reading.timeLimit} min
                                    </p>
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Band
                                        </p>

                                        <p className="text-lg font-bold text-purple-600">
                                          {submission.result?.band}
                                        </p>
                                      </div>

                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Score
                                        </p>

                                        <p className="text-sm font-semibold text-gray-700">
                                          {submission.result?.correct}/
                                          {submission.result?.total}
                                        </p>
                                      </div>

                                      <button
                                        onClick={() =>
                                          setSelectedReview({
                                            student,
                                            reading,
                                            submission
                                          })
                                        }
                                        className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                                      >
                                        Review
                                      </button>
                                    </div>
                                  ) : (
                                    <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                      Not done
                                    </span>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {selectedHomework && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  Manage Assignment
                </h2>

                <p className="text-sm text-gray-400">
                  {selectedHomework.title}
                </p>
              </div>

              <button
                onClick={() => {
                  setSelectedHomework(null)
                  setAssignmentDraft([])
                }}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            <div className="flex flex-col gap-3 mb-6">
              {students.map(student => {
                const completed = getSubmission(student.id, selectedHomework.id)

                return (
                  <label
                    key={student.id}
                    className="flex items-center justify-between gap-4 border border-gray-100 rounded-xl p-4 cursor-pointer hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={assignmentDraft.includes(student.id)}
                        onChange={() => toggleAssignment(student.id)}
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
                    </div>

                    {completed ? (
                      <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                        Completed
                      </span>
                    ) : assignmentDraft.includes(student.id) ? (
                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
                        Assigned
                      </span>
                    ) : (
                      <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">
                        Not assigned
                      </span>
                    )}
                  </label>
                )
              })}
            </div>

            <button
              onClick={saveAssignments}
              className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700"
            >
              Save assignments
            </button>
          </div>
        </div>
      )}

      {selectedReview && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  Reading Review
                </h2>

                <p className="text-sm text-gray-400">
                  {selectedReview.student.name} — {selectedReview.reading.title}
                </p>

                <p className="text-sm text-purple-600 font-semibold mt-1">
                  Band {selectedReview.submission.result?.band} ·{' '}
                  {selectedReview.submission.result?.correct}/
                  {selectedReview.submission.result?.total} correct
                </p>
              </div>

              <button
                onClick={() => setSelectedReview(null)}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="border border-gray-100 rounded-2xl p-5">
                <h3 className="font-semibold text-gray-800 mb-4">
                  Reading Passage
                </h3>

                {selectedReview.reading.passageMode === 'sections' ? (
                  <div className="space-y-6">
                    {selectedReview.reading.paragraphs.map(paragraph => (
                      <div key={paragraph.id}>
                        <h4 className="font-semibold text-gray-900 mb-2">
                          Paragraph {paragraph.letter}
                        </h4>

                        <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                          {paragraph.text}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                    {selectedReview.reading.passage}
                  </p>
                )}
              </div>

              <div className="border border-gray-100 rounded-2xl p-5">
                <h3 className="font-semibold text-gray-800 mb-4">
                  Student Answers
                </h3>

                <div className="flex flex-col gap-4">
                  {selectedReview.reading.questions.map((question, index) => (
                    <div
                      key={question.id}
                      className="border border-gray-100 rounded-xl p-4"
                    >
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs text-gray-400">
                          Q{index + 1}
                        </span>

                        <span className="text-xs bg-purple-50 text-purple-600 px-2 py-1 rounded-full">
                          {question.type === 'matching'
                            ? 'Matching Headings'
                            : question.type === 'tfng'
                              ? 'T/F/NG'
                              : question.type === 'fitb'
                                ? 'Fill blank'
                                : 'MCQ'}
                        </span>
                      </div>

                      {question.type === 'matching' ? (
                        <div className="flex flex-col gap-3">
                          {question.paragraphs.map(paragraph => {
                            const correct = isMatchingCorrect(
                              selectedReview.submission,
                              question,
                              paragraph
                            )

                            const userAnswer =
                              selectedReview.submission.answers?.[
                                question.id
                              ]?.[paragraph.letter]

                            const correctAnswer = paragraph.answer

                            return (
                              <div
                                key={paragraph.letter}
                                className={`rounded-xl p-3 border ${
                                  correct
                                    ? 'bg-green-50 border-green-100'
                                    : 'bg-red-50 border-red-100'
                                }`}
                              >
                                <div className="flex justify-between mb-2">
                                  <p className="text-sm font-semibold text-gray-800">
                                    Paragraph {paragraph.letter}
                                  </p>

                                  <p
                                    className={`text-xs font-semibold ${
                                      correct
                                        ? 'text-green-600'
                                        : 'text-red-600'
                                    }`}
                                  >
                                    {correct ? 'Correct' : 'Wrong'}
                                  </p>
                                </div>

                                <p className="text-xs text-gray-500">
                                  Student:
                                </p>

                                <p className="text-sm text-gray-800 mb-2">
                                  {userAnswer
                                    ? `${userAnswer}. ${getHeadingText(
                                        selectedReview.reading,
                                        userAnswer
                                      )}`
                                    : 'No answer'}
                                </p>

                                {!correct && (
                                  <>
                                    <p className="text-xs text-gray-500">
                                      Correct:
                                    </p>

                                    <p className="text-sm font-medium text-green-700">
                                      {correctAnswer}.{' '}
                                      {getHeadingText(
                                        selectedReview.reading,
                                        correctAnswer
                                      )}
                                    </p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm text-gray-800 mb-3">
                            {question.question}
                          </p>

                          <div
                            className={`rounded-xl p-3 border ${
                              isNormalCorrect(
                                selectedReview.submission,
                                question
                              )
                                ? 'bg-green-50 border-green-100'
                                : 'bg-red-50 border-red-100'
                            }`}
                          >
                            <div className="flex justify-between mb-2">
                              <p className="text-xs text-gray-500">
                                Student answer:
                              </p>

                              <p
                                className={`text-xs font-semibold ${
                                  isNormalCorrect(
                                    selectedReview.submission,
                                    question
                                  )
                                    ? 'text-green-600'
                                    : 'text-red-600'
                                }`}
                              >
                                {isNormalCorrect(
                                  selectedReview.submission,
                                  question
                                )
                                  ? 'Correct'
                                  : 'Wrong'}
                              </p>
                            </div>

                            <p className="text-sm text-gray-800 mb-2">
                              {selectedReview.submission.answers?.[
                                question.id
                              ] || 'No answer'}
                            </p>

                            {!isNormalCorrect(
                              selectedReview.submission,
                              question
                            ) && (
                              <>
                                <p className="text-xs text-gray-500">
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
              </div>
            </div>
          </div>
        </div>
      )}

      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h2 className="font-semibold text-gray-800 mb-4">
              Change Password
            </h2>

            {passwordMsg && (
              <div
                className={`text-sm rounded-xl p-3 mb-4 ${
                  passwordMsg.includes('Error')
                    ? 'bg-red-50 text-red-600'
                    : 'bg-green-50 text-green-600'
                }`}
              >
                {passwordMsg}
              </div>
            )}

            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1 block">
                New password
              </label>

              <input
                type="password"
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                placeholder="At least 6 characters"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowPasswordModal(false)
                  setPasswordMsg('')
                  setNewPassword('')
                }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500"
              >
                Cancel
              </button>

              <button
                onClick={handleChangePassword}
                className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-medium"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}