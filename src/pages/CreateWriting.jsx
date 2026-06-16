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

const DEFAULT_SCHOOL_ID = 'maxima'

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

function getLibraryVisibility(item) {
  return item?.visibility || item?.libraryVisibility || 'private'
}

function isSchoolLibraryItem(item) {
  return getLibraryVisibility(item) === 'school'
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

function filterResourcesByProfile(items, profile, teacherId) {
  if (isAdminProfile(profile)) return items

  return items.filter(item =>
    isSameSchool(item, profile) &&
    (isAssignedToTeacher(item, teacherId) || isSchoolLibraryItem(item))
  )
}

function filterClassStudentIds(classItem, visibleStudents) {
  const visibleStudentIds = new Set(visibleStudents.map(student => student.id))

  return (classItem.studentIds || []).filter(studentId =>
    visibleStudentIds.has(studentId)
  )
}

export default function CreateWriting() {
  const { id } = useParams()
  const isEditMode = Boolean(id)
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])
  const [search, setSearch] = useState('')

  const [title, setTitle] = useState('')
  const [contentType, setContentType] = useState('full_writing')
  const [visibility, setVisibility] = useState('private')
  const [dueDate, setDueDate] = useState('')
  const [assignTo, setAssignTo] = useState([])

  const [task1Title, setTask1Title] = useState('Writing Task 1')
  const [task1Prompt, setTask1Prompt] = useState(
    'You should spend about 20 minutes on this task. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.'
  )
  const [task1Image, setTask1Image] = useState('')
  const [task1ImageName, setTask1ImageName] = useState('')

  const [task2Title, setTask2Title] = useState('Writing Task 2')
  const [task2Prompt, setTask2Prompt] = useState(
    'You should spend about 40 minutes on this task. Write about the following topic. Give reasons for your answer and include any relevant examples from your own knowledge or experience.'
  )

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
        setProfile({ id: currentUser.uid, ...profile })
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
    if (!user || !profile) return

    const q = query(collection(db, 'users'), where('role', '==', 'student'))

    return onSnapshot(q, snap => {
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
  }, [user, profile])

  useEffect(() => {
    if (!user || !profile) return

    const q = query(collection(db, 'classes'))

    return onSnapshot(q, snap => {
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
  }, [user, profile])

  useEffect(() => {
    const loadWriting = async () => {
      if (!isEditMode) return

      const snap = await getDoc(doc(db, 'writingHomeworks', id))

      if (!snap.exists()) {
        alert('Writing homework not found.')
        navigate('/teacher')
        return
      }

      const data = snap.data()

      setTitle(data.title || '')
      setContentType(data.contentType || data.writingMode || 'full_writing')
      setVisibility(data.visibility || data.libraryVisibility || 'private')
      setDueDate(data.dueDate || '')
      setAssignTo(data.assignTo || [])

      setTask1Title(data.task1?.title || 'Writing Task 1')
      setTask1Prompt(data.task1?.prompt || '')
      setTask1Image(data.task1?.image || '')
      setTask1ImageName(data.task1?.imageName || '')

      setTask2Title(data.task2?.title || 'Writing Task 2')
      setTask2Prompt(data.task2?.prompt || '')
    }

    loadWriting()
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

  const hasTask1 = contentType !== 'task2_only'
  const hasTask2 = contentType !== 'task1_only'
  const writingTimeLimit = contentType === 'task1_only'
    ? 20
    : contentType === 'task2_only'
      ? 40
      : 60

  useEffect(() => {
    if (!user || !profile || isAdminProfile(profile) || students.length === 0) return

    const visibleStudentIds = new Set(students.map(student => student.id))

    setAssignTo(prev =>
      prev.filter(studentId => visibleStudentIds.has(studentId))
    )
  }, [user, profile, students])

  const cleanString = value => {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return ''
    return String(value)
  }

  const compressImageFile = file => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()

      reader.onload = () => {
        const image = new Image()

        image.onload = () => {
          const maxWidth = 1200
          const maxHeight = 900

          let { width, height } = image

          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height)
            width = Math.round(width * ratio)
            height = Math.round(height * ratio)
          }

          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height

          const ctx = canvas.getContext('2d')
          ctx.drawImage(image, 0, 0, width, height)

          const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
          resolve(dataUrl)
        }

        image.onerror = () => reject(new Error('Could not read image.'))
        image.src = reader.result
      }

      reader.onerror = () => reject(new Error('Could not upload image.'))
      reader.readAsDataURL(file)
    })
  }

  const buildSafePayload = () => ({
    title: cleanString(title).trim(),
    module: 'writing',
    contentType,
    writingMode: contentType,
    visibility,
    dueDate: cleanString(dueDate),
    assignTo: assignTo.map(id => cleanString(id)).filter(Boolean),
    assignedStudentIds: students.filter(student => assignTo.includes(student.id)).map(student => student.id),
    assignedEmails: students.filter(student => assignTo.includes(student.id)).map(student => student.email?.toLowerCase()).filter(Boolean),
    schoolId: getProfileSchoolId(profile),
    timeLimit: writingTimeLimit,
    task1Enabled: hasTask1,
    task2Enabled: hasTask2,
    task1: {
      title: cleanString(task1Title).trim() || 'Writing Task 1',
      prompt: cleanString(task1Prompt),
      image: cleanString(task1Image),
      imageName: cleanString(task1ImageName),
      minimumWords: 150,
      suggestedMinutes: 20
    },
    task2: {
      title: cleanString(task2Title).trim() || 'Writing Task 2',
      prompt: cleanString(task2Prompt),
      minimumWords: 250,
      suggestedMinutes: 40
    },
    updatedAt: new Date().toISOString()
  })

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

  const assignClassToWriting = classItem => {
    const classStudentIds = filterClassStudentIds(classItem, students)

    if (classStudentIds.length === 0) {
      alert('This class has no students yet.')
      return
    }

    setAssignTo(prev => Array.from(new Set([...prev, ...classStudentIds])))
  }

  const removeClassFromWriting = classItem => {
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

  const handleImageUpload = async event => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file.')
      return
    }

    try {
      const compressed = await compressImageFile(file)

      if (compressed.length > 950000) {
        alert('Image is still too large after compression. Please upload a smaller image.')
        event.target.value = ''
        return
      }

      setTask1Image(compressed)
      setTask1ImageName(file.name)
    } catch (error) {
      console.error(error)
      alert('Could not upload this image. Please try another image.')
      event.target.value = ''
    }
  }

  const handleSave = async () => {
    if (!title.trim()) {
      alert('Please add a title.')
      return
    }

    if (hasTask1 && !task1Prompt.trim()) {
      alert('Please add Task 1 prompt.')
      return
    }

    if (hasTask1 && !task1Image) {
      alert('Please upload Task 1 image.')
      return
    }

    if (hasTask2 && !task2Prompt.trim()) {
      alert('Please add Task 2 prompt.')
      return
    }

    if (assignTo.length === 0) {
      alert('Please assign at least one student.')
      return
    }

    setSaving(true)

    const payload = buildSafePayload()

    if (hasTask1 && !payload.task1.image.startsWith('data:image/')) {
      alert('Task 1 image is not valid. Please remove it and upload the image again.')
      setSaving(false)
      return
    }

    try {
      if (isEditMode) {
        await updateDoc(doc(db, 'writingHomeworks', id), payload)
      } else {
        await addDoc(collection(db, 'writingHomeworks'), {
          ...payload,
          createdBy: user.uid,
          teacherId: profile?.role === 'teacher' ? user.uid : '',
          teacherIds: profile?.role === 'teacher' ? [user.uid] : [],
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
      alert(`Could not save writing homework. ${error?.message || ''}`)
    } finally {
      setSaving(false)
    }
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
          {isEditMode ? 'Edit Writing Homework' : 'Create Writing Homework'}
        </h1>

        <p className="text-gray-500 mb-8">
          Create Full Writing, Task 1 only or Task 2 only homework.
        </p>

        {saved && (
          <div className="bg-green-50 text-green-600 rounded-xl p-4 mb-6 text-sm font-medium">
            ✓ Writing homework saved and assigned. Redirecting...
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
          <div className="space-y-6">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                Homework Details
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Library visibility</label>
                  <select value={visibility} onChange={e => setVisibility(e.target.value)} className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white">
                    <option value="private">My Library</option>
                    <option value="school">School Library</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Content type</label>
                  <select value={contentType} onChange={e => setContentType(e.target.value)} className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white">
                    <option value="full_writing">Full Writing</option>
                    <option value="task1_only">Task 1 Only</option>
                    <option value="task2_only">Task 2 Only</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    {contentType === 'task1_only'
                      ? 'Students will only see and submit Task 1.'
                      : contentType === 'task2_only'
                        ? 'Students will only see and submit Task 2.'
                        : 'Students will see and submit both Task 1 and Task 2.'}
                  </p>
                </div>
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Title
                </label>

                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Academic Writing Test 01"
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

              <div className="mt-4 bg-purple-50 border border-purple-100 rounded-xl p-4">
                <p className="text-xs text-purple-500 mb-1">Student timer</p>
                <p className="text-sm font-semibold text-purple-700">
                  {writingTimeLimit} minutes
                </p>
              </div>
            </div>

            {hasTask1 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Task 1
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Suggested 20 minutes · Minimum 150 words
                  </p>
                </div>

                <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                  Image based
                </span>
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Task 1 title
                </label>

                <input
                  value={task1Title}
                  onChange={e => setTask1Title(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                />
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Task 1 prompt
                </label>

                <textarea
                  rows={5}
                  value={task1Prompt}
                  onChange={e => setTask1Prompt(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
                />
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Task 1 image
                </label>

                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-white"
                />

                <p className="text-xs text-gray-400 mt-2">
                  Upload a chart, graph, map, diagram or process image. Images are compressed automatically before saving.
                </p>
              </div>

              {task1Image && (
                <div className="border border-gray-100 rounded-2xl p-4 bg-gray-50">
                  <div className="flex justify-between mb-3">
                    <p className="text-xs text-gray-500">
                      {task1ImageName || 'Task 1 image'}
                    </p>

                    <button
                      onClick={() => {
                        setTask1Image('')
                        setTask1ImageName('')
                      }}
                      className="text-xs text-red-500"
                    >
                      Remove
                    </button>
                  </div>

                  <img
                    src={task1Image}
                    alt="Task 1 preview"
                    className="w-full max-h-[420px] object-contain bg-white rounded-xl"
                  />
                </div>
              )}
            </div>

            )}

            {hasTask2 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Task 2
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Suggested 40 minutes · Minimum 250 words
                  </p>
                </div>

                <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                  Essay
                </span>
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Task 2 title
                </label>

                <input
                  value={task2Title}
                  onChange={e => setTask2Title(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                />
              </div>

              <div>
                <label className="text-xs text-gray-400 mb-1 block">
                  Task 2 question / prompt
                </label>

                <textarea
                  rows={7}
                  value={task2Prompt}
                  onChange={e => setTask2Prompt(e.target.value)}
                  placeholder="Some people believe that..."
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
                />
              </div>
            </div>
            )}

          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 h-fit sticky top-6">
            <h2 className="font-semibold text-gray-800 mb-2">
              Assign Students
            </h2>

            <p className="text-xs text-gray-400 mb-4">
              Search by name or email. Selected students will receive this writing homework.
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
                              onClick={() => removeClassFromWriting(classItem)}
                              className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-100 flex-shrink-0"
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              onClick={() => assignClassToWriting(classItem)}
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
                  : 'Save & Assign Writing'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}