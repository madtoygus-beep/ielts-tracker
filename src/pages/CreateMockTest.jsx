import { useEffect, useMemo, useState } from 'react'
import { auth, db } from '../firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where
} from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

const DEFAULT_SCHOOL_ID = 'maxima'

function getProfileSchoolId(profile) {
  return profile?.schoolId || DEFAULT_SCHOOL_ID
}

function isAdminProfile(profile) {
  return profile?.role === 'admin'
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
    isAssignedToTeacher(student, teacherId)
  )
}

function filterClassesByProfile(classes, profile, teacherId) {
  if (isAdminProfile(profile)) return classes

  return classes.filter(classItem =>
    isAssignedToTeacher(classItem, teacherId)
  )
}

function filterResourcesByProfile(items, profile, teacherId) {
  if (isAdminProfile(profile)) return items

  return items.filter(item =>
    isAssignedToTeacher(item, teacherId)
  )
}

function filterClassStudentIds(classItem, visibleStudents) {
  const visibleStudentIds = new Set(visibleStudents.map(student => student.id))

  return (classItem.studentIds || []).filter(studentId =>
    visibleStudentIds.has(studentId)
  )
}

export default function CreateMockTest() {
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [checkingUser, setCheckingUser] = useState(true)

  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')

  const [readings, setReadings] = useState([])
  const [listenings, setListenings] = useState([])
  const [writings, setWritings] = useState([])
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])

  const [listeningIds, setListeningIds] = useState(['', '', '', ''])
  const [readingIds, setReadingIds] = useState(['', '', ''])
  const [writingId, setWritingId] = useState('')
  const [assignTo, setAssignTo] = useState([])

  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true

    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid))

        if (!active) return

        if (!userSnap.exists()) {
          alert('User profile not found.')
          navigate('/login')
          return
        }

        const profile = userSnap.data()

        if (
          profile.deleted === true ||
          profile.status !== 'approved' ||
          (profile.role !== 'teacher' && profile.role !== 'admin')
        ) {
          alert('You are not allowed to create mock tests.')
          await signOut(auth)
          navigate('/login')
          return
        }

        setUser(currentUser)
        setProfile({ id: currentUser.uid, ...profile })
        setCheckingUser(false)
      } catch (error) {
        console.error(error)

        if (active) {
          alert('Could not verify your account.')
          navigate('/login')
        }
      }
    })

    return () => {
      active = false
      unsub()
    }
  }, [navigate])

  useEffect(() => {
    if (!user || !profile) return

    const unsubReadings = onSnapshot(collection(db, 'readings'), snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(item => !item.archived)

      const visibleReadings = filterResourcesByProfile(
        list,
        profile,
        user.uid
      )

      visibleReadings.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      setReadings(visibleReadings)
    })

    const unsubListenings = onSnapshot(collection(db, 'listenings'), snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(item => !item.archived)

      const visibleListenings = filterResourcesByProfile(
        list,
        profile,
        user.uid
      )

      visibleListenings.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      setListenings(visibleListenings)
    })

    const unsubWritings = onSnapshot(collection(db, 'writingHomeworks'), snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(item => !item.archived)

      const visibleWritings = filterResourcesByProfile(
        list,
        profile,
        user.uid
      )

      visibleWritings.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      setWritings(visibleWritings)
    })

    const studentsQuery = query(
      collection(db, 'users'),
      where('role', '==', 'student')
    )

    const unsubStudents = onSnapshot(studentsQuery, snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(student => student.status === 'approved' && student.deleted !== true)

      const visibleStudents = filterStudentsByProfile(
        list,
        profile,
        user.uid
      )

      visibleStudents.sort((a, b) =>
        (a.name || a.email || '').localeCompare(b.name || b.email || '')
      )

      setStudents(visibleStudents)
    })

    const unsubClasses = onSnapshot(collection(db, 'classes'), snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(classItem => classItem.archived !== true)

      const visibleClasses = filterClassesByProfile(
        list,
        profile,
        user.uid
      ).sort((a, b) => (a.name || '').localeCompare(b.name || ''))

      setClasses(visibleClasses)
    })

    return () => {
      unsubReadings()
      unsubListenings()
      unsubWritings()
      unsubStudents()
      unsubClasses()
    }
  }, [user, profile])

  const filteredStudents = useMemo(() => {
    const term = search.trim().toLowerCase()

    if (!term) return students

    return students.filter(student => {
      const name = student.name?.toLowerCase() || ''
      const email = student.email?.toLowerCase() || ''

      return name.includes(term) || email.includes(term)
    })
  }, [students, search])

  const selectedStudents = useMemo(() => {
    return students.filter(student => assignTo.includes(student.id))
  }, [students, assignTo])


  useEffect(() => {
    if (!user || !profile || isAdminProfile(profile) || students.length === 0) return

    const visibleStudentIds = new Set(students.map(student => student.id))

    setAssignTo(prev =>
      prev.filter(studentId => visibleStudentIds.has(studentId))
    )
  }, [user, profile, students])

  const selectedListeningIds = listeningIds.filter(Boolean)
  const selectedReadingIds = readingIds.filter(Boolean)

  const hasDuplicateListenings =
    selectedListeningIds.length !== new Set(selectedListeningIds).size

  const hasDuplicateReadings =
    selectedReadingIds.length !== new Set(selectedReadingIds).size

  const canCreate =
    title.trim() &&
    selectedListeningIds.length >= 1 &&
    !hasDuplicateListenings &&
    selectedReadingIds.length === 3 &&
    !hasDuplicateReadings &&
    writingId &&
    assignTo.length > 0 &&
    !saving

  const updateListeningId = (index, value) => {
    setListeningIds(prev => {
      const copy = [...prev]
      copy[index] = value
      return copy
    })
  }

  const updateReadingId = (index, value) => {
    setReadingIds(prev => {
      const copy = [...prev]
      copy[index] = value
      return copy
    })
  }

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

  const assignClassToMock = classItem => {
    const classStudentIds = filterClassStudentIds(classItem, students)

    if (classStudentIds.length === 0) {
      alert('This class has no students yet.')
      return
    }

    setAssignTo(prev => Array.from(new Set([...prev, ...classStudentIds])))
  }

  const removeClassFromMock = classItem => {
    const classStudentIds = filterClassStudentIds(classItem, students)

    setAssignTo(prev =>
      prev.filter(studentId => !classStudentIds.includes(studentId))
    )
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

  const getStudentName = studentId => {
    const student = students.find(item => item.id === studentId)
    return student?.name || student?.email || 'Unknown student'
  }

  const handleSave = async () => {
    if (saving) return

    const cleanTitle = title.trim()
    const cleanListeningIds = listeningIds.filter(Boolean)
    const cleanReadingIds = readingIds.filter(Boolean)

    if (!cleanTitle) {
      alert('Please add a mock test title.')
      return
    }

    if (cleanListeningIds.length === 0) {
      alert('Please select at least one listening part/test.')
      return
    }

    if (Array.from(new Set(cleanListeningIds)).length !== cleanListeningIds.length) {
      alert('Please select different listening parts/tests or leave unused parts empty.')
      return
    }

    if (cleanReadingIds.length !== 3) {
      alert('Please select Reading Passage 1, 2 and 3.')
      return
    }

    if (Array.from(new Set(cleanReadingIds)).length !== 3) {
      alert('Please select three different reading tests.')
      return
    }

    if (!writingId) {
      alert('Please select a writing test.')
      return
    }

    if (assignTo.length === 0) {
      alert('Please assign at least one student.')
      return
    }

    if (!user) {
      alert('User session expired. Please log in again.')
      navigate('/login')
      return
    }

    setSaving(true)

    try {
      await addDoc(collection(db, 'mockTests'), {
        title: cleanTitle,
        dueDate,
        listeningId: cleanListeningIds[0] || '',
        listeningIds: cleanListeningIds,
        readingIds: cleanReadingIds,
        writingId,
        assignTo,
        schoolId: getProfileSchoolId(profile),
        mode: 'single-page-flow',
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false
      })

      setSaved(true)

      setTimeout(() => {
        navigate('/teacher')
      }, 900)
    } catch (error) {
      console.error(error)
      alert('Could not create mock test.')
    } finally {
      setSaving(false)
    }
  }

  if (checkingUser) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Checking permissions...</p>
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
          ← Back
        </button>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Create Full Mock Test
        </h1>

        <p className="text-gray-500 mb-8">
          IELTS format: selected Listening parts → Reading Passage 1, 2, 3 → Writing. Students complete it inside one flow.
        </p>

        {saved && (
          <div className="bg-green-50 text-green-600 rounded-xl p-4 mb-6 text-sm font-medium">
            ✓ Mock test created. Redirecting...
          </div>
        )}

        {(listenings.length === 0 || readings.length < 3 || writings.length === 0) && (
          <div className="bg-amber-50 border border-amber-100 text-amber-700 rounded-2xl p-5 mb-6 text-sm">
            You need at least 1 listening test, 3 reading tests and 1 writing test before creating a full mock.
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
          <div className="space-y-6">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                Mock Details
              </h2>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Mock test title
                </label>

                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Full IELTS Mock Test 01"
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

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                Select Test Parts
              </h2>

              <div className="grid grid-cols-1 gap-4">
                <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">
                        Listening Parts
                      </h3>

                      <p className="text-xs text-gray-500 mt-1">
                        Select at least one listening test. You may leave unused parts empty.
                      </p>
                    </div>

                    <span className="text-xs bg-white text-purple-600 px-3 py-1 rounded-full">
                      {selectedListeningIds.length}/4 selected
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {[0, 1, 2, 3].map(index => (
                      <div key={index}>
                        <label className="text-xs text-gray-400 mb-1 block">
                          Listening Part {index + 1} {index === 0 ? '/ required' : '/ optional'}
                        </label>

                        <select
                          value={listeningIds[index]}
                          onChange={e => updateListeningId(index, e.target.value)}
                          className={`w-full border rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white ${
                            hasDuplicateListenings && listeningIds[index]
                              ? 'border-red-300'
                              : 'border-gray-200'
                          }`}
                        >
                          <option value="">
                            {index === 0
                              ? 'Select listening part/test'
                              : 'Optional: select listening part/test'}
                          </option>

                          {listenings.map(item => (
                            <option key={item.id} value={item.id}>
                              {item.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  {hasDuplicateListenings && (
                    <p className="text-xs text-red-500 mt-3">
                      Please choose different listening tests or leave unused parts empty.
                    </p>
                  )}
                </div>

                {[0, 1, 2].map(index => (
                  <div key={index}>
                    <label className="text-xs text-gray-400 mb-1 block">
                      Reading Passage {index + 1}
                    </label>

                    <select
                      value={readingIds[index]}
                      onChange={e => updateReadingId(index, e.target.value)}
                      className={`w-full border rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white ${
                        hasDuplicateReadings && readingIds[index]
                          ? 'border-red-300'
                          : 'border-gray-200'
                      }`}
                    >
                      <option value="">
                        Select reading passage {index + 1}
                      </option>

                      {readings.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}

                {hasDuplicateReadings && (
                  <p className="text-xs text-red-500">
                    Please choose three different reading passages.
                  </p>
                )}

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Writing
                  </label>

                  <select
                    value={writingId}
                    onChange={e => setWritingId(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white"
                  >
                    <option value="">Select writing test</option>
                    {writings.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>

                  <p className="text-xs text-gray-400 mt-2">
                    Writing will be saved inside the mock submission and reviewed later.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                Single-page mock flow
              </h2>

              <p className="text-sm text-gray-500 leading-6">
                Students will not jump to separate homework pages. They will start the mock and move through each selected listening part, reading passage and writing section with Next Section buttons.
              </p>
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 h-fit sticky top-6">
            <h2 className="font-semibold text-gray-800 mb-2">
              Assign Students
            </h2>

            <p className="text-xs text-gray-400 mb-4">
              Selected students will receive this full mock test.
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
                              type="button"
                              onClick={() => removeClassFromMock(classItem)}
                              className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-100 flex-shrink-0"
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => assignClassToMock(classItem)}
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
                type="button"
                onClick={selectAllFiltered}
                className="flex-1 bg-purple-50 text-purple-600 rounded-xl py-2 text-xs font-medium"
              >
                Select filtered
              </button>

              <button
                type="button"
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
                        {student.name || 'Unnamed Student'}
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
                      {student.name || student.email}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleSave}
              disabled={!canCreate}
              className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-6 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? 'Creating...' : 'Create Full IELTS Mock Test'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}