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
const saveManagedClassCall = httpsCallable(functions, 'saveManagedClassV2')
const setManagedClassArchivedCall = httpsCallable(functions, 'setManagedClassArchivedV2')
const deleteManagedClassCall = httpsCallable(functions, 'deleteManagedClassV2')

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


// Lightweight icons preserve the project's dependency-free design approach.
function ClassIcon({ name, className = 'w-5 h-5' }) {
  const paths = {
    class: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 10h18M8 2v6M16 2v6" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    school: <><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M9 10h.01M15 10h.01" /></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2" /></>,
    'user-plus': <><path d="M15 19v-1a6 6 0 0 0-12 0v1M9 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM19 8v8M15 12h8"/></>,
    teacher: <><circle cx="9" cy="7" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5h5v11h-4"/></>,
    plus: <path d="M12 5v14M5 12h14" />,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/></>,
    edit: <><path d="M13 6 18 11M4 20l4.3-1 11-11a2 2 0 0 0-3-3l-11 11L4 20Z"/></>,
    archive: <><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 13h4"/></>,
    trash: <><path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <path d="M18 6 6 18M6 6l12 12"/>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01" /></>
  }
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.class}</svg>
}

function getInitials(value) {
  return (value || 'S').trim().split(/\s+/).slice(0, 2).map(word => word[0] || '').join('').toUpperCase()
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

  // V2 presentation state. None of these controls change stored Firestore data.
  const [classSearch, setClassSearch] = useState('')
  const [teacherFilter, setTeacherFilter] = useState('all')
  const [memberFilter, setMemberFilter] = useState('all')
  const [classSort, setClassSort] = useState('name')
  const [classView, setClassView] = useState('cards')
  const [detailClassId, setDetailClassId] = useState(null)
  const [openActionsId, setOpenActionsId] = useState(null)
  const [showUngrouped, setShowUngrouped] = useState(false)
  const [formSection, setFormSection] = useState('details')
  const [formSelectedOnly, setFormSelectedOnly] = useState(false)
  const [rosterStatus, setRosterStatus] = useState('loading')

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

    setRosterStatus('loading')

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
        setRosterStatus('ready')
      },
      error => {
        console.error('Students snapshot error:', error)
        setStudents([])
        setRosterStatus('error')
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
    setFormSelectedOnly(false)
    setFormSection('details')
  }

  const openCreateModal = () => {
    if (rosterStatus !== 'ready') {
      alert('The student roster is still loading or could not be loaded. Please try again when it is available.')
      return
    }
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
    setFormSelectedOnly(false)
    setFormSection('details')
    setShowCreateModal(true)
  }

  const openEditModal = (classItem, startSection = 'details') => {
    if (rosterStatus !== 'ready') {
      alert('The student roster is still loading or could not be loaded. Please try again when it is available.')
      return
    }
    setEditingClass(classItem)
    setFormSchoolId(schoolIdOf(classItem))
    setFormName(classItem.name || '')
    setFormDescription(classItem.description || '')
    setFormColor(classItem.color || 'purple')
    setFormStudentIds(getValidStudentIdsForClass(classItem))
    setFormTeacherId(classItem.teacherId || (userRole === 'teacher' ? user?.uid || '' : ''))
    setFormSearch('')
    setFormSelectedOnly(false)
    setFormSection(startSection)
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
    setDetailClassId(null)
    setOpenActionsId(null)
    setShowUngrouped(false)
    setClassSearch('')
    setTeacherFilter('all')
    setMemberFilter('all')
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
    if (formSelectedOnly && !formStudentIds.includes(student.id)) return false
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

  // ----------------------------------------------
  // Manage Classes V2: presentation-only dashboard
  // ----------------------------------------------
  const activeGroups = classes.filter(classItem => !isSystemClass(classItem))
  const groupedStudentIds = new Set(activeGroups.flatMap(classItem => getValidStudentIdsForClass(classItem)))
  const totalGroupedStudents = groupedStudentIds.size
  const ungroupedStudents = students.filter(student => !groupedStudentIds.has(student.id))
  const teacherIdsWithGroups = new Set(activeGroups.map(classItem => classItem.teacherId).filter(Boolean))
  const schoolIsAll = userRole === 'admin' && selectedSchoolId === ALL_SCHOOLS_ID
  const normalizedClassSearch = classSearch.trim().toLocaleLowerCase()
  const visibleTeachers = userRole === 'admin' ? teachers : []

  const filteredClasses = classes
    .filter(classItem => {
      const memberIds = getValidStudentIdsForClass(classItem)
      if (memberFilter === 'populated' && memberIds.length === 0) return false
      if (memberFilter === 'empty' && memberIds.length > 0) return false
      if (teacherFilter !== 'all' && classItem.teacherId !== teacherFilter) return false
      if (!normalizedClassSearch) return true

      const teacherLabel = userRole === 'admin'
        ? teachers.find(teacher => teacher.id === classItem.teacherId)?.name ||
          teachers.find(teacher => teacher.id === classItem.teacherId)?.email || ''
        : userProfile?.name || userProfile?.email || ''

      const memberNames = memberIds.map(studentId => {
        const student = students.find(item => item.id === studentId)
        return `${student?.name || ''} ${student?.email || ''}`
      }).join(' ')

      return [classItem.name, classItem.description, teacherLabel, memberNames,
        schoolIsAll ? schoolNameOf(schoolIdOf(classItem)) : '']
        .join(' ').toLocaleLowerCase().includes(normalizedClassSearch)
    })
    .sort((first, second) => {
      if (classSort === 'members_desc' || classSort === 'members_asc') {
        const difference = getValidStudentIdsForClass(first).length - getValidStudentIdsForClass(second).length
        if (difference !== 0) return classSort === 'members_desc' ? -difference : difference
      }
      return (first.name || '').localeCompare(second.name || '')
    })

  const detailClass = detailClassId ? classes.find(item => item.id === detailClassId) : null
  const canEditClass = classItem => rosterStatus === 'ready' && (userRole !== 'admin' ||
    schools.find(school => school.schoolId === schoolIdOf(classItem))?.status === 'active')
  const activeClassLabel = activeGroups.length === 1 ? 'active class' : 'active classes'
  const cardSchoolName = classItem => schoolNameOf(schoolIdOf(classItem))
  const teacherNameOf = classItem => {
    if (userRole === 'teacher') return userProfile?.name || userProfile?.email || 'You'
    const teacher = teachers.find(item => item.id === classItem.teacherId)
    return teacher?.name || teacher?.email || 'Assigned teacher'
  }

  const renderClassCard = classItem => {
    const color = getColorStyle(classItem.color)
    const memberIds = getValidStudentIdsForClass(classItem)
    const missingCount = rosterStatus !== 'ready' ? 0 : Math.max((Array.isArray(classItem.studentIds) ? classItem.studentIds.length : 0) - memberIds.length, 0)
    const canEdit = canEditClass(classItem)
    const systemClass = isSystemClass(classItem)
    const listStyle = classView === 'list'

    return (
      <article key={classItem.id} className={`relative group bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300 transition-all ${listStyle ? 'px-5 py-4' : 'p-5'}`}>
        <div className={`flex ${listStyle ? 'flex-col lg:flex-row lg:items-center' : 'flex-col'} gap-4`}>
          <div className="flex flex-1 items-start gap-3 min-w-0">
            <div className={`w-11 h-11 rounded-xl shrink-0 flex items-center justify-center ${color.bg} ${color.text}`}>
              <ClassIcon name={systemClass ? 'layers' : 'class'} className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-semibold text-slate-900 break-words">{classItem.name}</h3>
                {systemClass && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">System group</span>}
              </div>
              <p className="mt-1 text-xs text-slate-500 flex items-center gap-1.5"><ClassIcon name="teacher" className="w-3.5 h-3.5" /> <span className="truncate">{teacherNameOf(classItem)}</span></p>
              {schoolIsAll && <p className="mt-1 text-xs font-medium text-violet-700 truncate">{cardSchoolName(classItem)}</p>}
            </div>
            <div className="relative shrink-0">
              <button type="button" aria-label={`More actions for ${classItem.name}`} aria-expanded={openActionsId === classItem.id} onClick={() => setOpenActionsId(prev => prev === classItem.id ? null : classItem.id)} className="w-9 h-9 rounded-xl border border-slate-200 text-slate-500 flex items-center justify-center hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-violet-500">
                <ClassIcon name="more" className="w-5 h-5" />
              </button>
              {openActionsId === classItem.id && (
                <div className="absolute right-0 top-11 z-20 w-48 rounded-xl border border-slate-200 bg-white shadow-xl p-1.5">
                  <button type="button" onClick={() => { setOpenActionsId(null); openEditModal(classItem) }} disabled={!canEdit} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"><ClassIcon name="edit" className="w-4 h-4" /> Edit details</button>
                  {!systemClass && <>
                    <button type="button" onClick={() => { setOpenActionsId(null); handleArchiveClass(classItem) }} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-amber-700 hover:bg-amber-50"><ClassIcon name="archive" className="w-4 h-4" /> Archive class</button>
                    <button type="button" onClick={() => { setOpenActionsId(null); handleDeleteClass(classItem) }} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50"><ClassIcon name="trash" className="w-4 h-4" /> Delete class</button>
                  </>}
                  {systemClass && <p className="px-3 py-2 text-xs text-slate-400">Protected system group</p>}
                </div>
              )}
            </div>
          </div>

          <div className={`${listStyle ? 'lg:w-44' : ''} flex flex-col justify-center`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800 flex items-center gap-1.5"><ClassIcon name="users" className="h-4 w-4 text-slate-400" /> {rosterStatus === 'ready' ? memberIds.length : '—'} <span className="font-normal text-slate-500">students</span></span>
              {!listStyle && <span className={`h-2 w-2 rounded-full ${color.dot}`} />}
            </div>
            {!listStyle && <p className="mt-2 text-xs text-slate-500 line-clamp-2 min-h-[2rem]">{classItem.description || (systemClass ? 'School-wide system grouping.' : 'A teaching group for assigning learning activities.')}</p>}
          </div>

          {!listStyle && (
            <div className="min-h-[62px] rounded-xl bg-slate-50 border border-slate-100 p-3">
              {rosterStatus !== 'ready' ? <p className="text-xs text-slate-500">Loading class members...</p> : memberIds.length > 0 ? (
                <div className="flex items-center gap-2 flex-wrap">
                  {memberIds.slice(0, 4).map(studentId => (
                    <span key={studentId} title={getStudentName(studentId)} className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-slate-200 px-2.5 py-1.5 text-[11px] text-slate-700 max-w-full">
                      <span className="h-5 w-5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-bold flex items-center justify-center shrink-0">{getInitials(getStudentName(studentId))}</span>
                      <span className="truncate max-w-[115px]">{getStudentName(studentId)}</span>
                    </span>
                  ))}
                  {memberIds.length > 4 && <span className="text-xs font-medium text-slate-500">+{memberIds.length - 4} more</span>}
                </div>
              ) : <p className="text-xs text-slate-500 flex items-center gap-2"><ClassIcon name="info" className="h-4 w-4" /> No active students in this class yet.</p>}
            </div>
          )}

          {missingCount > 0 && <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">{missingCount} inactive or missing student reference{missingCount === 1 ? '' : 's'} hidden. Edit and Save to clean this class.</p>}

          <div className={`flex flex-wrap items-center gap-2 ${listStyle ? 'lg:justify-end' : ''}`}>
            <button type="button" disabled={rosterStatus !== 'ready'} onClick={() => { setOpenActionsId(null); setDetailClassId(classItem.id) }} className="flex-1 lg:flex-none inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40">
              <ClassIcon name="users" className="h-4 w-4" /> View students
            </button>
            <button type="button" onClick={() => { setOpenActionsId(null); openEditModal(classItem, 'students') }} disabled={!canEdit} className="flex-1 lg:flex-none inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed">
              <ClassIcon name="edit" className="h-4 w-4" /> Manage class
            </button>
          </div>
        </div>
      </article>
    )
  }

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center text-slate-500 gap-3">
        <div className="w-9 h-9 border-4 border-violet-100 border-t-violet-600 rounded-full animate-spin" />
        <p className="text-sm">Checking class management access...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-[74px] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/1.png" alt="Maxima" className="h-9 w-auto max-w-[120px] object-contain shrink-0" />
            <span className="h-7 w-px bg-slate-200 hidden sm:block" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 truncate">Class Management</p>
              <p className="text-[11px] text-slate-500 truncate">Maxima · {userRole === 'admin' ? 'Admin Workspace' : 'Teacher Workspace'}</p>
            </div>
          </div>
          <button type="button" onClick={() => navigate(userRole === 'admin' ? '/admin' : '/teacher')} className="flex items-center justify-center gap-2 rounded-xl bg-slate-100 px-3 sm:px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-700 hover:bg-slate-200 whitespace-nowrap">
            <ClassIcon name="back" className="w-4 h-4" /> Back to dashboard
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-7 sm:py-9 space-y-6">
        <section className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-700 mb-2">Teaching organisation</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Manage Classes</h1>
            <p className="text-sm text-slate-500 mt-2 max-w-2xl">Keep students organised, see which groups need attention and manage class membership in one place.</p>
          </div>
          <button type="button" onClick={() => { setOpenActionsId(null); openCreateModal() }} disabled={!selectedSchoolCanCreate || rosterStatus !== 'ready' || (userRole === 'admin' && schoolsLoading)} className="inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 bg-violet-600 text-white text-sm font-semibold shadow-sm hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed">
            <ClassIcon name="plus" className="w-4 h-4" /> Create class
          </button>
        </section>

        <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 bg-violet-50 rounded-xl flex items-center justify-center text-violet-700"><ClassIcon name="school" className="h-5 w-5" /></div>
              <div>
                <p className="text-sm font-semibold text-slate-800">School scope</p>
                <p className="mt-0.5 text-sm text-slate-500">{selectedSchoolLabel}</p>
              </div>
            </div>
            {userRole === 'admin' ? (
              <label className="w-full md:max-w-sm">
                <span className="block text-xs font-semibold text-slate-500 mb-1.5">Viewing school</span>
                <select value={selectedSchoolId} onChange={event => handleSchoolScopeChange(event.target.value)} disabled={schoolsLoading} className="w-full border border-slate-200 rounded-xl bg-white px-4 py-2.5 text-sm text-slate-800 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100 disabled:opacity-60">
                  {schools.map(school => <option key={school.schoolId} value={school.schoolId}>{school.name}{school.status !== 'active' ? ' (Inactive)' : ''}</option>)}
                  <option value={ALL_SCHOOLS_ID}>All Schools</option>
                </select>
              </label>
            ) : (
              <span className="inline-flex items-center rounded-full bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700">Your teaching groups</span>
            )}
          </div>
          {schoolIsAll && <p className="mt-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-xl px-3.5 py-3"><ClassIcon name="info" className="h-4 w-4 shrink-0" /> All Schools is a viewing scope. Choose one active school before creating a class.</p>}
          {userRole === 'admin' && selectedSchoolId !== ALL_SCHOOLS_ID && selectedSchool?.status !== 'active' && !schoolsLoading && <p className="mt-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-xl px-3.5 py-3"><ClassIcon name="info" className="h-4 w-4 shrink-0" /> This school is inactive. Editing and creating are disabled; archive/delete remain server-controlled.</p>}
          {schoolsError && <p role="alert" className="mt-4 text-sm text-rose-700 bg-rose-50 rounded-lg p-3">{schoolsError}</p>}
        </section>

        {rosterStatus === 'error' && <div role="alert" className="bg-rose-50 border border-rose-100 text-rose-700 rounded-xl px-4 py-3 text-sm">Student roster could not be loaded. Class editing is disabled to protect existing membership. Please refresh or check access.</div>}
        {classesError && <div role="alert" className="bg-rose-50 border border-rose-100 text-rose-700 rounded-xl px-4 py-3 text-sm">{classesError}</div>}

        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4" aria-label="Class management overview">
          {[
            { label: 'Active groups', value: activeGroups.length, icon: 'class', note: 'Excludes system groups' },
            { label: 'Students in groups', value: totalGroupedStudents, icon: 'users', note: 'Unique active students' },
            { label: 'Not in a group', value: ungroupedStudents.length, icon: 'info', note: 'Within current view' },
            { label: 'Teachers with groups', value: teacherIdsWithGroups.size, icon: 'teacher', note: 'Assigned to active groups' }
          ].map(metric => (
            <article key={metric.label} className="bg-white border border-slate-200 rounded-2xl px-4 sm:px-5 py-4 shadow-sm">
              <div className="flex justify-between items-start gap-2">
                <span className="text-xs sm:text-sm text-slate-500">{metric.label}</span>
                <span className="h-9 w-9 bg-slate-100 text-slate-500 rounded-xl flex items-center justify-center"><ClassIcon name={metric.icon} className="w-4 h-4" /></span>
              </div>
              <p className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">{loading || rosterStatus !== 'ready' ? '—' : metric.value}</p>
              <p className="mt-1 text-[11px] text-slate-400">{metric.note}</p>
            </article>
          ))}
        </section>

        {!loading && rosterStatus === 'ready' && ungroupedStudents.length > 0 && selectedSchoolCanCreate && (
          <section className="rounded-2xl bg-violet-50 border border-violet-100 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-xl bg-white text-violet-700 flex items-center justify-center shrink-0"><ClassIcon name="user-plus" className="h-4 w-4" /></div>
              <div><p className="font-semibold text-sm text-slate-800">{ungroupedStudents.length} student{ungroupedStudents.length !== 1 ? 's' : ''} without a regular class group</p><p className="text-xs text-slate-500 mt-1">Students are counted within your visible school and teacher scope. System-wide “All” groups are excluded.</p></div>
            </div>
            <button type="button" onClick={() => setShowUngrouped(prev => !prev)} aria-expanded={showUngrouped} className="inline-flex items-center justify-center gap-2 text-xs font-semibold text-violet-700 bg-white border border-violet-200 rounded-xl px-3.5 py-2.5 whitespace-nowrap hover:bg-violet-100">{showUngrouped ? 'Hide students' : 'View students'} <ClassIcon name="chevron" className="w-4 h-4" /></button>
          </section>
        )}
        {showUngrouped && !loading && rosterStatus === 'ready' && ungroupedStudents.length > 0 && (
          <section className="bg-white border border-violet-100 rounded-2xl p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-slate-800">Students awaiting class grouping</h2><span className="text-xs text-slate-500">{ungroupedStudents.length} visible students</span></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-56 overflow-y-auto">
              {ungroupedStudents.map(student => <div key={student.id} className="rounded-xl border border-slate-200 px-3 py-2.5 flex items-center gap-2"><span className="h-8 w-8 rounded-full bg-slate-100 text-slate-600 text-xs font-bold flex items-center justify-center shrink-0">{getInitials(student.name || student.email)}</span><div className="min-w-0"><p className="text-xs font-medium text-slate-800 truncate">{student.name || 'Unnamed student'}</p><p className="text-[11px] text-slate-500 truncate">{student.email || ''}</p></div></div>)}
            </div>
          </section>
        )}

        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Your classes</h2>
              <p className="text-xs text-slate-500 mt-1">{loading ? 'Loading...' : `${filteredClasses.length} shown of ${classes.length} total class records`}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setClassView('cards')} aria-label="Card view" aria-pressed={classView === 'cards'} className={`h-9 w-9 flex items-center justify-center rounded-lg border ${classView === 'cards' ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}><ClassIcon name="grid" className="w-4 h-4" /></button>
              <button type="button" onClick={() => setClassView('list')} aria-label="List view" aria-pressed={classView === 'list'} className={`h-9 w-9 flex items-center justify-center rounded-lg border ${classView === 'list' ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}><ClassIcon name="list" className="w-4 h-4" /></button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <label className="relative block md:col-span-2">
              <ClassIcon name="search" className="absolute left-3 top-3 h-4 w-4 text-slate-400 pointer-events-none" />
              <input aria-label="Search classes, students or teachers" type="search" value={classSearch} onChange={event => setClassSearch(event.target.value)} placeholder="Search class, student or teacher..." className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 placeholder:text-slate-400 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
            </label>
            <label className="sr-only" htmlFor="classMemberFilter">Filter classes by membership</label>
            <select id="classMemberFilter" value={memberFilter} onChange={event => setMemberFilter(event.target.value)} className="w-full px-3 py-2.5 border border-slate-200 bg-white rounded-xl text-sm text-slate-700 outline-none focus:border-violet-400"><option value="all">All class sizes</option><option value="populated">With students</option><option value="empty">Empty groups</option></select>
            <label className="sr-only" htmlFor="classSort">Sort classes</label>
            <select id="classSort" value={classSort} onChange={event => setClassSort(event.target.value)} className="w-full px-3 py-2.5 border border-slate-200 bg-white rounded-xl text-sm text-slate-700 outline-none focus:border-violet-400"><option value="name">Name A–Z</option><option value="members_desc">Most students</option><option value="members_asc">Fewest students</option></select>
          </div>
          {userRole === 'admin' && visibleTeachers.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2"><span className="text-xs font-medium text-slate-500">Teacher:</span><select aria-label="Filter by teacher" value={teacherFilter} onChange={event => setTeacherFilter(event.target.value)} className="w-full sm:w-72 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"><option value="all">All teachers</option>{visibleTeachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name || teacher.email}</option>)}</select></div>
          )}
          {(classSearch || memberFilter !== 'all' || classSort !== 'name' || teacherFilter !== 'all') && <button type="button" onClick={() => { setClassSearch(''); setMemberFilter('all'); setTeacherFilter('all'); setClassSort('name') }} className="text-xs font-semibold text-violet-700 hover:text-violet-900">Clear filters</button>}
        </section>

        {loading ? (
          <section className="rounded-2xl bg-white border border-slate-200 py-16 flex items-center justify-center gap-3 text-sm text-slate-500"><div className="h-6 w-6 rounded-full border-2 border-violet-100 border-t-violet-600 animate-spin" /> Loading classes...</section>
        ) : classes.length === 0 ? (
          <section className="bg-white border border-dashed border-slate-300 rounded-2xl px-6 py-16 text-center"><div className="mx-auto h-14 w-14 bg-violet-50 rounded-2xl flex items-center justify-center text-violet-600"><ClassIcon name="class" className="h-7 w-7" /></div><h2 className="font-semibold text-lg text-slate-800 mt-4">No class groups yet</h2><p className="text-sm text-slate-500 mt-2">{schoolIsAll ? 'No active classes were found across these schools.' : 'Create a class to bring your students together.'}</p>{selectedSchoolCanCreate && rosterStatus === 'ready' && <button type="button" onClick={openCreateModal} className="mt-5 px-5 py-3 rounded-xl text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700">Create first class</button>}</section>
        ) : filteredClasses.length === 0 ? (
          <section className="bg-white border border-slate-200 rounded-2xl px-6 py-14 text-center"><ClassIcon name="search" className="h-9 w-9 mx-auto text-slate-300" /><h2 className="font-semibold text-slate-800 mt-3">No matching classes</h2><p className="text-sm text-slate-500 mt-1">Try a different search or reset your filters.</p><button type="button" onClick={() => { setClassSearch(''); setMemberFilter('all'); setTeacherFilter('all'); setClassSort('name') }} className="mt-4 text-sm font-semibold text-violet-700">Reset filters</button></section>
        ) : (
          <section className={classView === 'cards' ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4' : 'flex flex-col gap-3'}>
            {filteredClasses.map(renderClassCard)}
          </section>
        )}
        <p className="text-[11px] text-slate-400 pb-4">Classes are teaching groups. Removing students from groups does not delete students or their existing homework results.</p>
      </main>

      {/* Read-only class details. No Firestore writes. */}
      {detailClass && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-slate-950/40" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setDetailClassId(null) }}>
          <section role="dialog" aria-modal="true" aria-label={`Class details: ${detailClass.name}`} className="w-full max-w-xl max-h-[90vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 sm:p-6 border-b border-slate-200 flex items-start justify-between gap-4"><div><p className="text-xs uppercase text-violet-700 font-bold tracking-widest">Class details</p><h2 className="text-xl font-bold text-slate-900 mt-1">{detailClass.name}</h2><p className="text-xs text-slate-500 mt-1">{teacherNameOf(detailClass)}{schoolIsAll ? ` · ${cardSchoolName(detailClass)}` : ''}</p></div><button type="button" aria-label="Close class details" onClick={() => setDetailClassId(null)} className="h-9 w-9 rounded-xl flex items-center justify-center hover:bg-slate-100 text-slate-500"><ClassIcon name="close" className="w-5 h-5" /></button></div>
            <div className="p-5 sm:p-6 overflow-y-auto"><div className="flex flex-wrap gap-2 mb-4"><span className="text-xs font-semibold text-violet-700 bg-violet-50 px-3 py-1.5 rounded-lg">{getValidStudentIdsForClass(detailClass).length} students</span><span className="text-xs font-medium text-slate-600 bg-slate-100 px-3 py-1.5 rounded-lg">{detailClass.description || 'No description'}</span></div>
              <h3 className="text-sm font-semibold text-slate-800 mb-3">Class roster</h3>
              {getValidStudentIdsForClass(detailClass).length === 0 ? <p className="text-sm text-slate-500 bg-slate-50 rounded-xl p-4">This class has no active students. Use Manage students to add members.</p> : (
                <div className="space-y-2">{getValidStudentIdsForClass(detailClass).map(studentId => {
                  const student = students.find(item => item.id === studentId)
                  return <div key={studentId} className="rounded-xl border border-slate-200 px-3 py-3 flex items-center gap-3"><span className="h-9 w-9 rounded-full bg-violet-100 text-violet-700 font-bold text-xs flex items-center justify-center shrink-0">{getInitials(student?.name || student?.email)}</span><div className="min-w-0"><p className="text-sm font-semibold text-slate-800 truncate">{student?.name || student?.email}</p><p className="text-xs text-slate-500 truncate">{student?.email || ''}</p></div></div>
                })}</div>
              )}
            </div>
            <div className="p-4 sm:p-5 border-t border-slate-200 flex gap-3"><button type="button" onClick={() => setDetailClassId(null)} className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-700 font-semibold text-sm hover:bg-slate-200">Close</button><button type="button" disabled={!canEditClass(detailClass)} onClick={() => { const item = detailClass; setDetailClassId(null); openEditModal(item, 'students') }} className="flex-1 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-40">Manage students</button></div>
          </section>
        </div>
      )}

      {/* Create/Edit: same server-authoritative handlers and constraints */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-3 sm:p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-label={editingClass ? 'Edit class' : 'Create class'} className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[94vh] flex flex-col overflow-hidden">
            <div className="px-5 sm:px-7 py-5 border-b border-slate-200 flex items-start justify-between gap-3">
              <div><p className="text-xs font-bold text-violet-700 uppercase tracking-widest">{editingClass ? 'Edit group' : 'New teaching group'}</p><h2 className="text-lg sm:text-xl font-bold text-slate-900 mt-1">{editingClass ? editingClass.name : 'Create a class'}</h2><p className="text-xs text-slate-500 mt-1">Manage class details and student membership together.</p></div>
              <button type="button" onClick={closeModal} disabled={saving} aria-label="Close class form" className="h-9 w-9 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-40"><ClassIcon name="close" className="w-5 h-5" /></button>
            </div>
            <div className="px-5 sm:px-7 pt-4 border-b border-slate-200 flex gap-3">
              <button type="button" onClick={() => setFormSection('details')} aria-current={formSection === 'details' ? 'step' : undefined} className={`px-4 py-3 border-b-2 text-sm font-semibold flex items-center gap-2 ${formSection === 'details' ? 'border-violet-600 text-violet-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}><ClassIcon name="class" className="h-4 w-4" /> Class details</button>
              <button type="button" onClick={() => setFormSection('students')} aria-current={formSection === 'students' ? 'step' : undefined} className={`px-4 py-3 border-b-2 text-sm font-semibold flex items-center gap-2 ${formSection === 'students' ? 'border-violet-600 text-violet-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}><ClassIcon name="users" className="h-4 w-4" /> Students <span className="rounded-full bg-slate-100 text-slate-700 px-2 py-0.5 text-xs">{formStudentIds.length}</span></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5">
              {formSection === 'details' ? (
                <div className="space-y-5">
                  <div className="grid md:grid-cols-2 gap-4">
                    <label className="block"><span className="block text-xs font-semibold text-slate-600 mb-1.5">School</span><input readOnly value={userRole === 'admin' ? schoolNameOf(formSchoolId) : formSchoolId} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600" /><span className="mt-1 block text-[11px] text-slate-400">School is fixed for this class.</span></label>
                    {userRole === 'admin' ? <label className="block"><span className="block text-xs font-semibold text-slate-600 mb-1.5">Teacher <span className="text-rose-500">*</span></span><select value={formTeacherId} disabled={Boolean(editingClass?.teacherId)} onChange={event => { setFormTeacherId(event.target.value); setFormStudentIds([]) }} className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 bg-white disabled:bg-slate-50 disabled:text-slate-500"><option value="">Select a teacher</option>{availableTeachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name || teacher.email}</option>)}</select><span className="mt-1 block text-[11px] text-slate-400">{editingClass?.teacherId ? 'Teacher is locked after creation.' : 'Only active teachers in this school.'}</span></label>
                    : <label className="block"><span className="block text-xs font-semibold text-slate-600 mb-1.5">Teacher</span><input readOnly value={userProfile?.name || userProfile?.email || 'Current teacher'} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600" /></label>}
                  </div>
                  <label className="block"><span className="block text-xs font-semibold text-slate-600 mb-1.5">Class name <span className="text-rose-500">*</span></span><input autoFocus value={formName} onChange={event => setFormName(event.target.value)} placeholder="e.g. IELTS Foundation — Group A" className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" /></label>
                  <label className="block"><span className="block text-xs font-semibold text-slate-600 mb-1.5">Description <span className="font-normal text-slate-400">(optional)</span></span><textarea rows={3} value={formDescription} onChange={event => setFormDescription(event.target.value)} placeholder="Schedule, level, target exam or group notes" className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 resize-y" /></label>
                  <div><p className="text-xs font-semibold text-slate-600 mb-2">Group color</p><div className="flex flex-wrap gap-2" role="group" aria-label="Class color">{COLOR_OPTIONS.map(color => <button key={color.id} type="button" onClick={() => setFormColor(color.id)} aria-pressed={formColor === color.id} className={`px-3 py-2 flex items-center gap-2 text-xs rounded-xl border-2 font-medium ${formColor === color.id ? `${color.bg} ${color.text} ${color.border}` : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}><span className={`w-3 h-3 rounded-full ${color.dot}`} />{color.label}{formColor === color.id && <ClassIcon name="check" className="w-3.5 h-3.5" />}</button>)}</div></div>
                  <div className="bg-violet-50 rounded-xl p-4 flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-violet-900">Add students to this class</p><p className="text-xs text-violet-700 mt-1">Selected: {formStudentIds.length}. You can add students now or after creating the class.</p></div><button type="button" onClick={() => setFormSection('students')} className="text-xs font-semibold text-violet-700 whitespace-nowrap hover:underline">Choose students →</button></div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3"><div><h3 className="font-semibold text-slate-800">Choose class members</h3><p className="text-xs text-slate-500 mt-1">Only approved students from this class school can be selected.</p></div><span className="text-xs font-semibold bg-violet-50 text-violet-700 rounded-lg px-3 py-2 shrink-0">{formStudentIds.length} selected</span></div>
                  {userRole === 'admin' && !formTeacherId && <div role="status" className="text-xs text-amber-700 bg-amber-50 rounded-xl px-4 py-3">Select a teacher on the Class details tab before choosing students.</div>}
                  <div className="flex flex-col sm:flex-row gap-2">
                    <label className="relative flex-1"><ClassIcon name="search" className="absolute top-3 left-3.5 w-4 h-4 text-slate-400" /><input type="search" value={formSearch} onChange={event => setFormSearch(event.target.value)} placeholder="Search by student name or email" className="w-full rounded-xl pl-10 pr-3 py-2.5 border border-slate-200 text-sm text-slate-700 focus:border-violet-400 outline-none" /></label>
                    <label className="inline-flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-200 px-3 text-xs font-medium text-slate-700 py-2.5 cursor-pointer"><input type="checkbox" checked={formSelectedOnly} onChange={event => setFormSelectedOnly(event.target.checked)} className="accent-violet-600" /> Selected only</label>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center justify-between"><p className="text-xs text-slate-500">{filteredStudents.length} shown · {schoolEligibleStudents.length} available</p><div className="flex gap-3"><button type="button" disabled={userRole === 'admin' && !formTeacherId || filteredStudents.length === 0} onClick={() => setFormStudentIds(previous => Array.from(new Set([...previous, ...filteredStudents.map(student => student.id)])))} className="text-xs font-semibold text-violet-700 hover:underline disabled:opacity-40">Select visible</button><button type="button" disabled={formStudentIds.length === 0} onClick={() => setFormStudentIds([])} className="text-xs font-semibold text-rose-600 hover:underline disabled:opacity-40">Clear selected</button></div></div>
                  {userRole === 'admin' && !formTeacherId ? <div className="text-center rounded-xl bg-slate-50 p-10 text-sm text-slate-500">Select a teacher to start adding students.</div> : schoolEligibleStudents.length === 0 ? <div className="text-center rounded-xl bg-slate-50 p-10 text-sm text-slate-500">No approved students found in this school.</div> : filteredStudents.length === 0 ? <div className="text-center rounded-xl bg-slate-50 p-10 text-sm text-slate-500">No students match the current filters.</div> : (
                    <div className="border border-slate-200 rounded-xl overflow-y-auto max-h-[42vh] divide-y divide-slate-100">{filteredStudents.map(student => { const checked = formStudentIds.includes(student.id); return <label key={student.id} className={`flex gap-3 px-4 py-3 items-center cursor-pointer hover:bg-slate-50 ${checked ? 'bg-violet-50/50' : 'bg-white'}`}><input type="checkbox" checked={checked} onChange={() => toggleStudent(student.id)} className="w-4 h-4 accent-violet-600 shrink-0" /><span className="h-9 w-9 bg-slate-100 text-slate-600 rounded-full flex items-center justify-center shrink-0 text-xs font-bold">{getInitials(student.name || student.email)}</span><span className="min-w-0"><span className="block text-sm text-slate-800 font-medium truncate">{student.name || 'Unnamed student'}</span><span className="block text-xs text-slate-500 truncate">{student.email || ''}</span></span>{checked && <span className="ml-auto text-violet-600"><ClassIcon name="check" className="h-4 w-4" /></span>}</label> })}</div>
                  )}
                  <p className="text-xs text-slate-500">Changing class membership does not delete students, their homework assignments, submissions or results.</p>
                </div>
              )}
            </div>
            <div className="px-5 sm:px-7 py-4 border-t border-slate-200 bg-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs text-slate-500">{editingClass ? 'Updating existing class' : 'Creating a new class'} · <strong className="text-slate-700">{formStudentIds.length}</strong> students</p>
              <div className="flex gap-2 sm:gap-3"><button type="button" disabled={saving} onClick={closeModal} className="flex-1 sm:flex-none rounded-xl bg-slate-100 text-slate-700 px-5 py-2.5 font-semibold text-sm hover:bg-slate-200 disabled:opacity-40">Cancel</button><button type="button" disabled={saving || !formSchoolIsActive} onClick={handleSave} className="flex-1 sm:flex-none rounded-xl bg-violet-600 text-white px-6 py-2.5 font-semibold text-sm hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed">{saving ? 'Saving...' : editingClass ? 'Save changes' : 'Create class'}</button></div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
