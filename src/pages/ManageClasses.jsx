import { useEffect, useState } from 'react'
import { auth, db, functions } from '../firebase'
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  getDoc
} from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { useNavigate, useSearchParams } from 'react-router-dom'

const DEFAULT_SCHOOL_ID = 'maxima'
const ALL_SCHOOLS_ID = 'all'

const getManagedSchoolsCall = httpsCallable(functions, 'getManagedSchools')
const saveManagedClassCall = httpsCallable(functions, 'saveManagedClass')
const setManagedClassArchivedCall = httpsCallable(functions, 'setManagedClassArchived')
const deleteManagedClassCall = httpsCallable(functions, 'deleteManagedClass')

const COLOR_OPTIONS = [
  { id: 'purple', label: 'Purple', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-500' },
  { id: 'blue', label: 'Blue', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500' },
  { id: 'green', label: 'Green', bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', dot: 'bg-green-500' },
  { id: 'amber', label: 'Amber', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-500' },
  { id: 'rose', label: 'Rose', bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', dot: 'bg-rose-500' },
  { id: 'cyan', label: 'Cyan', bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200', dot: 'bg-cyan-500' },
  { id: 'indigo', label: 'Indigo', bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', dot: 'bg-indigo-500' },
  { id: 'fuchsia', label: 'Fuchsia', bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', border: 'border-fuchsia-200', dot: 'bg-fuchsia-500' }
]

function getColorStyle(colorId) {
  return COLOR_OPTIONS.find(c => c.id === colorId) || COLOR_OPTIONS[0]
}

function schoolIdOf(data) {
  return data?.schoolId || DEFAULT_SCHOOL_ID
}

function errorMessage(error, fallback) {
  return error?.message || fallback
}

export default function ManageClasses() {
  const [user, setUser] = useState(null)
  const [userRole, setUserRole] = useState('')
  const [userProfile, setUserProfile] = useState(null)
  const [authChecking, setAuthChecking] = useState(true)

  const [schools, setSchools] = useState([])
  const [schoolsLoading, setSchoolsLoading] = useState(true)
  const [schoolsError, setSchoolsError] = useState('')
  const [selectedSchoolId, setSelectedSchoolId] = useState(DEFAULT_SCHOOL_ID)

  const [classes, setClasses] = useState([])
  const [students, setStudents] = useState([])
  const [teachers, setTeachers] = useState([])
  const [loading, setLoading] = useState(true)
  const [classesError, setClassesError] = useState('')

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingClass, setEditingClass] = useState(null)

  const [formSchoolId, setFormSchoolId] = useState('')
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formColor, setFormColor] = useState('purple')
  const [formStudentIds, setFormStudentIds] = useState([])
  const [formTeacherId, setFormTeacherId] = useState('')
  const [formSearch, setFormSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const routeSchoolId = searchParams.get('school') || ''

  // ============================================================
  // Auth check (admin or teacher only)
  // ============================================================
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid))

        if (!userSnap.exists()) {
          alert('User profile not found.')
          navigate('/login')
          return
        }

        const userData = userSnap.data()

        if (userData.role !== 'admin' && userData.role !== 'teacher') {
          alert('Access denied. Only admins and teachers can manage classes.')
          navigate('/student')
          return
        }

        if (userData.status !== 'approved' || userData.deleted === true) {
          alert('Your account is not active.')
          navigate('/login')
          return
        }

        setUser(currentUser)
        setUserRole(userData.role)
        setUserProfile(userData)

        if (userData.role === 'teacher') {
          setSelectedSchoolId(schoolIdOf(userData))
          setSchoolsLoading(false)
        }

        setAuthChecking(false)
      } catch (error) {
        console.error(error)
        alert('Could not verify your access.')
        navigate('/login')
      }
    })

    return unsub
  }, [navigate])

  // ============================================================
  // Admin school list
  // School metadata is server-only, so Manage Classes loads it via callable.
  // ============================================================
  useEffect(() => {
    if (authChecking || !user || userRole !== 'admin') return

    let cancelled = false

    const loadSchools = async () => {
      setSchoolsLoading(true)
      setSchoolsError('')

      try {
        const result = await getManagedSchoolsCall({})
        const managedSchools = Array.isArray(result.data?.schools)
          ? result.data.schools
          : []

        if (!cancelled) {
          setSchools(managedSchools)
        }
      } catch (error) {
        console.error('Could not load schools:', error)
        if (!cancelled) {
          setSchools([])
          setSchoolsError(errorMessage(error, 'Could not load schools.'))
        }
      } finally {
        if (!cancelled) setSchoolsLoading(false)
      }
    }

    loadSchools()

    return () => {
      cancelled = true
    }
  }, [authChecking, user, userRole])

  // ============================================================
  // Keep admin school scope valid and synchronized with the URL.
  // AdminDashboard passes ?school=<id> so the same school view carries over.
  // ============================================================
  useEffect(() => {
    if (authChecking || userRole !== 'admin' || schoolsLoading) return

    const requestedSchoolId = routeSchoolId || selectedSchoolId || DEFAULT_SCHOOL_ID
    const requestedExists = requestedSchoolId === ALL_SCHOOLS_ID || schools.some(
      school => school.schoolId === requestedSchoolId
    )
    const fallbackSchoolId = schools.some(school => school.schoolId === DEFAULT_SCHOOL_ID)
      ? DEFAULT_SCHOOL_ID
      : schools[0]?.schoolId || ALL_SCHOOLS_ID
    const nextSchoolId = requestedExists ? requestedSchoolId : fallbackSchoolId

    if (selectedSchoolId !== nextSchoolId) {
      setSelectedSchoolId(nextSchoolId)
    }

    if (routeSchoolId !== nextSchoolId) {
      setSearchParams({ school: nextSchoolId }, { replace: true })
    }
  }, [
    authChecking,
    userRole,
    schoolsLoading,
    schools,
    routeSchoolId,
    selectedSchoolId,
    setSearchParams
  ])

  // ============================================================
  // Subscribe to classes (live)
  // Admin: selected school only, or all schools in explicit All Schools view.
  // Teacher: own school + own teacherId. This query shape matches P1B rules.
  // ============================================================
  useEffect(() => {
    if (authChecking || !user) return
    if (userRole === 'admin' && schoolsLoading) return

    setLoading(true)
    setClassesError('')

    let q

    if (userRole === 'admin') {
      q = selectedSchoolId === ALL_SCHOOLS_ID
        ? query(collection(db, 'classes'))
        : query(
            collection(db, 'classes'),
            where('schoolId', '==', selectedSchoolId)
          )
    } else {
      const teacherSchoolId = schoolIdOf(userProfile)
      q = query(
        collection(db, 'classes'),
        where('schoolId', '==', teacherSchoolId),
        where('teacherId', '==', user.uid)
      )
    }

    const unsub = onSnapshot(
      q,
      snap => {
        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(classItem => {
            if (classItem.archived) return false

            if (userRole === 'admin') {
              return selectedSchoolId === ALL_SCHOOLS_ID ||
                schoolIdOf(classItem) === selectedSchoolId
            }

            return (
              schoolIdOf(classItem) === schoolIdOf(userProfile) &&
              (classItem.teacherId === user.uid || classItem.createdBy === user.uid)
            )
          })
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

        setClasses(list)
        setLoading(false)
      },
      error => {
        console.error('Classes snapshot error:', error)
        setClasses([])
        setClassesError(errorMessage(error, 'Could not load classes.'))
        setLoading(false)
      }
    )

    return unsub
  }, [
    authChecking,
    user,
    userRole,
    userProfile,
    selectedSchoolId,
    schoolsLoading
  ])

  // ============================================================
  // Subscribe to students
  // Admin reads the existing student query, then applies the selected school.
  // Teacher keeps the existing teacherIds compatibility query and own-school filter.
  // ============================================================
  useEffect(() => {
    if (authChecking || !user) return
    if (userRole === 'admin' && schoolsLoading) return

    const q = userRole === 'admin'
      ? query(collection(db, 'users'), where('role', '==', 'student'))
      : query(
          collection(db, 'users'),
          where('role', '==', 'student'),
          where('teacherIds', 'array-contains', user.uid)
        )

    return onSnapshot(
      q,
      snap => {
        const teacherSchoolId = schoolIdOf(userProfile)

        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(student => {
            if (student.status !== 'approved' || student.deleted === true) return false
            if (student.accountType === 'individual' || student.schoolId === '__individual__') return false

            if (userRole === 'admin') {
              return selectedSchoolId === ALL_SCHOOLS_ID ||
                schoolIdOf(student) === selectedSchoolId
            }

            return schoolIdOf(student) === teacherSchoolId
          })
          .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))

        setStudents(list)
      },
      error => {
        console.error('Students snapshot error:', error)
        setStudents([])
      }
    )
  }, [
    authChecking,
    user,
    userRole,
    userProfile,
    selectedSchoolId,
    schoolsLoading
  ])

  // ============================================================
  // Subscribe to teachers (admin only), scoped to the selected school.
  // All Schools remains a cross-school view only.
  // ============================================================
  useEffect(() => {
    if (authChecking || !user || userRole !== 'admin') {
      setTeachers([])
      return
    }
    if (schoolsLoading) return

    const q = query(collection(db, 'users'), where('role', '==', 'teacher'))

    return onSnapshot(
      q,
      snap => {
        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(teacher => {
            if (teacher.status !== 'approved' || teacher.deleted === true) return false
            return selectedSchoolId === ALL_SCHOOLS_ID ||
              schoolIdOf(teacher) === selectedSchoolId
          })
          .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))

        setTeachers(list)
      },
      error => {
        console.error('Teachers snapshot error:', error)
        setTeachers([])
      }
    )
  }, [
    authChecking,
    user,
    userRole,
    selectedSchoolId,
    schoolsLoading
  ])

  // ============================================================
  // Derived school state
  // ============================================================
  const selectedSchool = userRole === 'admin'
    ? schools.find(school => school.schoolId === selectedSchoolId) || null
    : null

  const selectedSchoolLabel = userRole === 'admin'
    ? selectedSchoolId === ALL_SCHOOLS_ID
      ? 'All Schools'
      : selectedSchool?.name || selectedSchoolId
    : schoolIdOf(userProfile)

  const selectedSchoolCanCreate = userRole !== 'admin' || (
    selectedSchoolId !== ALL_SCHOOLS_ID &&
    selectedSchool?.status === 'active'
  )

  const schoolNameOf = schoolId => {
    const school = schools.find(item => item.schoolId === schoolId)
    return school?.name || schoolId
  }

  // ============================================================
  // Student/class helpers
  // ============================================================
  const getValidStudentIdsForClass = classItem => {
    const classSchoolId = schoolIdOf(classItem)

    return (Array.isArray(classItem?.studentIds) ? classItem.studentIds : [])
      .filter(studentId => {
        const student = students.find(item => item.id === studentId)
        return Boolean(student) && schoolIdOf(student) === classSchoolId
      })
  }

  const getStudentName = studentId => {
    const student = students.find(s => s.id === studentId)
    return student?.name || student?.email || ''
  }

  const isSystemClass = classItem =>
    (classItem.name || '').trim().toLowerCase() === 'all' ||
    classItem.system === true ||
    classItem.isSystem === true

  // ============================================================
  // Form helpers
  // ============================================================
  const resetForm = () => {
    setEditingClass(null)
    setFormSchoolId('')
    setFormName('')
    setFormDescription('')
    setFormColor('purple')
    setFormStudentIds([])
    setFormTeacherId('')
    setFormSearch('')
  }

  const openCreateModal = () => {
    if (userRole === 'admin') {
      if (selectedSchoolId === ALL_SCHOOLS_ID) {
        alert('Choose one school before creating a class. All Schools is a view-only scope for class creation.')
        return
      }

      if (!selectedSchool || selectedSchool.status !== 'active') {
        alert('Choose an active school before creating a class.')
        return
      }
    }

    setEditingClass(null)
    setFormSchoolId(
      userRole === 'admin'
        ? selectedSchoolId
        : schoolIdOf(userProfile)
    )
    setFormName('')
    setFormDescription('')
    setFormColor('purple')
    setFormStudentIds([])
    setFormTeacherId(userRole === 'teacher' ? user?.uid || '' : '')
    setFormSearch('')
    setShowCreateModal(true)
  }

  const openEditModal = classItem => {
    setEditingClass(classItem)
    setFormSchoolId(schoolIdOf(classItem))
    setFormName(classItem.name || '')
    setFormDescription(classItem.description || '')
    setFormColor(classItem.color || 'purple')
    setFormStudentIds(getValidStudentIdsForClass(classItem))
    setFormTeacherId(classItem.teacherId || (userRole === 'teacher' ? user?.uid || '' : ''))
    setFormSearch('')
    setShowCreateModal(true)
  }

  const closeModal = () => {
    setShowCreateModal(false)
    resetForm()
  }

  const handleSchoolScopeChange = nextSchoolId => {
    if (saving) return

    if (showCreateModal) {
      closeModal()
    }

    setSelectedSchoolId(nextSchoolId)
    setSearchParams({ school: nextSchoolId }, { replace: true })
  }

  const toggleStudent = studentId => {
    setFormStudentIds(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    )
  }

  // ============================================================
  // Modal school/teacher/student scope
  // ============================================================
  const formSchool = userRole === 'admin'
    ? schools.find(school => school.schoolId === formSchoolId) || null
    : null

  const availableTeachers = userRole === 'admin'
    ? teachers.filter(teacher => schoolIdOf(teacher) === formSchoolId)
    : []

  const schoolEligibleStudents = formSchoolId
    ? students.filter(student => schoolIdOf(student) === formSchoolId)
    : []

  const filteredStudents = schoolEligibleStudents.filter(student => {
    if (!formSearch.trim()) return true
    const searchQuery = formSearch.toLowerCase()
    return (
      (student.name || '').toLowerCase().includes(searchQuery) ||
      (student.email || '').toLowerCase().includes(searchQuery)
    )
  })

  const formSchoolIsActive = userRole !== 'admin' || formSchool?.status === 'active'

  // ============================================================
  // Server-authoritative create/edit
  // P1B: browser no longer writes class documents directly.
  // ============================================================
  const handleSave = async () => {
    if (saving) return

    if (!formName.trim()) {
      alert('Please enter a class name.')
      return
    }

    const schoolId = editingClass
      ? schoolIdOf(editingClass)
      : formSchoolId || (userRole === 'teacher' ? schoolIdOf(userProfile) : '')

    if (!schoolId) {
      alert('Please select a school for this class.')
      return
    }

    if (userRole === 'admin' && !formSchoolIsActive) {
      alert('Classes can only be created or edited while the school is active.')
      return
    }

    let teacherId = user?.uid || ''

    if (userRole === 'admin') {
      teacherId = editingClass?.teacherId || formTeacherId || ''

      if (!teacherId) {
        alert('Please select a teacher for this class.')
        return
      }

      if (editingClass?.teacherId && formTeacherId !== editingClass.teacherId) {
        alert('The teacher is locked after class creation. Create a new class for a different teacher.')
        return
      }

      const selectedTeacher = teachers.find(teacher => teacher.id === teacherId)
      if (!selectedTeacher || schoolIdOf(selectedTeacher) !== schoolId) {
        alert('The selected teacher is not an active teacher in this school.')
        return
      }
    }

    const eligibleStudentIds = new Set(
      students
        .filter(student => schoolIdOf(student) === schoolId)
        .map(student => student.id)
    )

    const hasCrossSchoolSelection = formStudentIds.some(
      studentId => !eligibleStudentIds.has(studentId)
    )

    if (hasCrossSchoolSelection) {
      alert('Every selected student must belong to the same school as the class.')
      return
    }

    const cleanedStudentIds = Array.from(new Set(formStudentIds))

    setSaving(true)

    try {
      await saveManagedClassCall({
        ...(editingClass?.id ? { classId: editingClass.id } : {}),
        schoolId,
        name: formName.trim(),
        description: formDescription.trim(),
        color: formColor,
        teacherId,
        studentIds: cleanedStudentIds
      })

      closeModal()
    } catch (error) {
      console.error('Could not save class:', error)
      alert(`Could not save class. ${errorMessage(error, 'Please try again.')}`)
    } finally {
      setSaving(false)
    }
  }

  const handleArchiveClass = async classItem => {
    if (isSystemClass(classItem)) {
      alert('The ALL class is a system group and cannot be archived or deleted.')
      return
    }

    const confirmed = window.confirm(
      `Archive class "${classItem.name}"?\n\nThis will only hide the class group from Manage Classes. Students, homework assignments and existing results will not be deleted.`
    )

    if (!confirmed) return

    try {
      await setManagedClassArchivedCall({
        classId: classItem.id,
        archived: true
      })
    } catch (error) {
      console.error('Could not archive class:', error)
      alert(`Could not archive class. ${errorMessage(error, 'Please try again.')}`)
    }
  }

  const handleDeleteClass = async classItem => {
    if (isSystemClass(classItem)) {
      alert('The ALL class is a system group and cannot be archived or deleted.')
      return
    }

    const confirmed = window.confirm(
      `Delete class "${classItem.name}" permanently?\n\nThis will only delete the class group. Students, homework assignments, submissions and results will not be deleted. This action cannot be undone.`
    )

    if (!confirmed) return

    try {
      await deleteManagedClassCall({ classId: classItem.id })
    } catch (error) {
      console.error('Could not delete class:', error)
      alert(`Could not delete class. ${errorMessage(error, 'Please try again.')}`)
    }
  }

  // ============================================================
  // Loading state
  // ============================================================
  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Checking access...</p>
      </div>
    )
  }

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />
        <button
          onClick={() => navigate(userRole === 'admin' ? '/admin' : '/teacher')}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Back to dashboard
        </button>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">
              Manage Classes
            </h1>
            <p className="text-gray-400 text-sm">
              Group students into classes to assign homework faster.
            </p>
          </div>

          <button
            onClick={openCreateModal}
            disabled={!selectedSchoolCanCreate || (userRole === 'admin' && schoolsLoading)}
            className="bg-purple-600 text-white rounded-xl px-6 py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + Create Class
          </button>
        </div>

        {userRole === 'admin' ? (
          <div className="bg-white border border-purple-100 rounded-2xl p-5 mb-8">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-semibold text-gray-800">School class view</h2>
                  <span className="text-xs bg-purple-50 text-purple-600 px-2 py-1 rounded-full">P1B</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Classes, teachers and students are scoped to one school. All Schools is available for viewing, but class creation requires one active school.
                </p>
              </div>

              <div className="w-full md:w-80">
                <label className="text-xs text-gray-400 mb-1 block">Viewing school</label>
                <select
                  value={selectedSchoolId}
                  onChange={e => handleSchoolScopeChange(e.target.value)}
                  disabled={schoolsLoading}
                  className="w-full border border-purple-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                >
                  {schools.map(school => (
                    <option key={school.schoolId} value={school.schoolId}>
                      {school.name}{school.status !== 'active' ? ' (Inactive)' : ''}
                    </option>
                  ))}
                  <option value={ALL_SCHOOLS_ID}>All Schools</option>
                </select>
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
              <span>
                Current view: <span className="font-semibold text-purple-700">{selectedSchoolLabel}</span>
              </span>
              {selectedSchoolId === ALL_SCHOOLS_ID && (
                <span className="text-amber-600">Choose one school before creating a class.</span>
              )}
              {selectedSchoolId !== ALL_SCHOOLS_ID && selectedSchool?.status !== 'active' && !schoolsLoading && (
                <span className="text-amber-600">This school is inactive. Existing classes are view-only for editing; archive/delete remain server-controlled.</span>
              )}
              {schoolsError && (
                <span className="text-red-500">{schoolsError}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white border border-gray-100 rounded-2xl px-5 py-4 mb-8 text-sm text-gray-500">
            School: <span className="font-semibold text-gray-700">{selectedSchoolLabel}</span>
          </div>
        )}

        {classesError && (
          <div className="bg-red-50 border border-red-100 text-red-600 rounded-xl px-4 py-3 text-sm mb-6">
            {classesError}
          </div>
        )}

        {loading ? (
          <p className="text-gray-400 text-sm text-center py-12">
            Loading classes...
          </p>
        ) : classes.length === 0 ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-12 text-center">
            <div className="text-5xl mb-4">📚</div>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">
              No classes in this view
            </h2>
            <p className="text-sm text-gray-500 mb-6">
              {userRole === 'admin' && selectedSchoolId === ALL_SCHOOLS_ID
                ? 'No active class groups were found across the current schools.'
                : 'Create the first class for this school to start grouping students.'}
            </p>
            {selectedSchoolCanCreate && (
              <button
                onClick={openCreateModal}
                className="bg-purple-600 text-white rounded-xl px-6 py-3 text-sm font-medium hover:bg-purple-700"
              >
                + Create First Class
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {classes.map(classItem => {
              const colorStyle = getColorStyle(classItem.color)
              const validStudentIds = getValidStudentIdsForClass(classItem)
              const staleStudentCount = (classItem.studentIds || []).length - validStudentIds.length
              const studentCount = validStudentIds.length
              const classSchoolId = schoolIdOf(classItem)
              const classSchool = schools.find(item => item.schoolId === classSchoolId)
              const classSchoolActive = userRole !== 'admin' || classSchool?.status === 'active'

              return (
                <div
                  key={classItem.id}
                  className={`bg-white border-2 rounded-2xl p-5 ${colorStyle.border}`}
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-3 h-3 rounded-full flex-shrink-0 ${colorStyle.dot}`} />
                      <h3 className="font-semibold text-gray-900 truncate">
                        {classItem.name}
                      </h3>
                    </div>

                    <span
                      className={`text-xs font-medium px-2 py-1 rounded-full flex-shrink-0 ${colorStyle.bg} ${colorStyle.text}`}
                    >
                      {studentCount} {studentCount === 1 ? 'student' : 'students'}
                    </span>
                  </div>

                  {userRole === 'admin' && selectedSchoolId === ALL_SCHOOLS_ID && (
                    <p className="text-[11px] font-medium text-purple-600 mb-2">
                      School: {schoolNameOf(classSchoolId)}
                    </p>
                  )}

                  {classItem.description && (
                    <p className="text-xs text-gray-500 mb-4 line-clamp-2">
                      {classItem.description}
                    </p>
                  )}

                  {userRole === 'admin' && classItem.teacherId && (
                    <p className="text-xs text-gray-400 mb-4">
                      Teacher: {teachers.find(t => t.id === classItem.teacherId)?.name || teachers.find(t => t.id === classItem.teacherId)?.email || 'Assigned teacher'}
                    </p>
                  )}

                  {studentCount > 0 && (
                    <div className="bg-gray-50 rounded-xl p-3 mb-4 max-h-32 overflow-y-auto">
                      <div className="flex flex-col gap-1">
                        {validStudentIds.slice(0, 5).map(studentId => (
                          <p key={studentId} className="text-xs text-gray-600 truncate">
                            • {getStudentName(studentId)}
                          </p>
                        ))}
                        {studentCount > 5 && (
                          <p className="text-xs text-gray-400 italic">
                            + {studentCount - 5} more
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {studentCount === 0 && (
                    <div className="bg-gray-50 rounded-xl p-3 mb-4">
                      <p className="text-xs text-gray-400">
                        No active students in this class.
                      </p>
                    </div>
                  )}

                  {staleStudentCount > 0 && (
                    <p className="text-[11px] text-amber-600 mb-4">
                      {staleStudentCount} deleted/missing student reference{staleStudentCount === 1 ? '' : 's'} hidden. Click Edit and Save to clean this class.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => openEditModal(classItem)}
                      disabled={!classSchoolActive}
                      className="flex-1 bg-gray-100 text-gray-700 rounded-xl py-2 text-xs font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Edit
                    </button>
                    {!isSystemClass(classItem) && (
                      <>
                        <button
                          onClick={() => handleArchiveClass(classItem)}
                          className="bg-amber-50 text-amber-600 rounded-xl px-3 py-2 text-xs font-medium hover:bg-amber-100"
                        >
                          Archive
                        </button>
                        <button
                          onClick={() => handleDeleteClass(classItem)}
                          className="bg-red-50 text-red-600 rounded-xl px-3 py-2 text-xs font-medium hover:bg-red-100"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* CREATE / EDIT MODAL */}
      {/* ============================================================ */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingClass ? 'Edit Class' : 'Create New Class'}
              </h2>
              <button
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-600 text-xl"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {/* 1. School */}
              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  School *
                </label>
                <input
                  value={
                    userRole === 'admin'
                      ? schoolNameOf(formSchoolId)
                      : formSchoolId
                  }
                  readOnly
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-gray-100 text-gray-600 outline-none"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  {editingClass
                    ? 'School is locked after class creation.'
                    : 'The school comes from the current Manage Classes school view.'}
                </p>
              </div>

              {/* 2. Class name */}
              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Class name *
                </label>
                <input
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g. 9-A IELTS Hazırlık"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                  autoFocus
                />
              </div>

              {/* 3. Teacher */}
              {userRole === 'admin' ? (
                <div className="mb-4">
                  <label className="text-xs text-gray-400 mb-1 block">
                    Teacher *
                  </label>

                  <select
                    value={formTeacherId}
                    disabled={Boolean(editingClass?.teacherId)}
                    onChange={e => {
                      setFormTeacherId(e.target.value)
                      setFormStudentIds([])
                    }}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white disabled:bg-gray-100 disabled:text-gray-500"
                  >
                    <option value="">Select teacher</option>
                    {availableTeachers.map(teacher => (
                      <option key={teacher.id} value={teacher.id}>
                        {teacher.name || teacher.email}
                      </option>
                    ))}
                  </select>

                  <p className="text-[11px] text-gray-400 mt-1">
                    {editingClass?.teacherId
                      ? 'Teacher is locked after class creation.'
                      : 'Only active teachers from this school are available.'}
                  </p>
                </div>
              ) : (
                <div className="mb-4">
                  <label className="text-xs text-gray-400 mb-1 block">Teacher</label>
                  <input
                    value={userProfile?.name || userProfile?.email || 'Current teacher'}
                    readOnly
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-gray-100 text-gray-600 outline-none"
                  />
                </div>
              )}

              {/* Description */}
              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Description (optional)
                </label>
                <textarea
                  rows={2}
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  placeholder="e.g. Hafta içi 18:00, Ekim grubu"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
                />
              </div>

              {/* Color */}
              <div className="mb-5">
                <label className="text-xs text-gray-400 mb-2 block">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {COLOR_OPTIONS.map(color => (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() => setFormColor(color.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border-2 text-xs font-medium ${
                        formColor === color.id
                          ? `${color.bg} ${color.text} ${color.border}`
                          : 'bg-white border-gray-200 text-gray-500'
                      }`}
                    >
                      <span className={`w-3 h-3 rounded-full ${color.dot}`} />
                      {color.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 4. Students */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-400">
                    Students ({formStudentIds.length} selected)
                  </label>
                  {formStudentIds.length > 0 && (
                    <button
                      onClick={() => setFormStudentIds([])}
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      Clear all
                    </button>
                  )}
                </div>

                <input
                  value={formSearch}
                  onChange={e => setFormSearch(e.target.value)}
                  placeholder="Search students by name or email..."
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 mb-2"
                />

                <p className="text-[11px] text-gray-400 mb-3">
                  Only active students from this class school are shown. Removing a student from a class does not delete the student or their homework history.
                </p>

                {userRole === 'admin' && !formTeacherId ? (
                  <p className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl">
                    Select a teacher first, then choose students from this school.
                  </p>
                ) : schoolEligibleStudents.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl">
                    No active students found in this school.
                  </p>
                ) : filteredStudents.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl">
                    No students match "{formSearch}".
                  </p>
                ) : (
                  <div className="border border-gray-100 rounded-xl max-h-72 overflow-y-auto">
                    {filteredStudents.map(student => {
                      const checked = formStudentIds.includes(student.id)

                      return (
                        <label
                          key={student.id}
                          className={`flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${
                            checked ? 'bg-purple-50/40' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleStudent(student.id)}
                            className="accent-purple-600 w-4 h-4"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {student.name || 'No name'}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                              {student.email}
                            </p>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button
                onClick={closeModal}
                className="flex-1 bg-gray-100 text-gray-700 rounded-xl py-3 text-sm font-medium hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !formSchoolIsActive}
                className="flex-1 bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {saving
                  ? 'Saving...'
                  : editingClass
                    ? 'Save Changes'
                    : 'Create Class'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
