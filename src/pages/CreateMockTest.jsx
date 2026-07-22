import { useEffect, useMemo, useState } from 'react'
import { auth, db } from '../firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  query,
  where
} from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const DEFAULT_SCHOOL_ID = 'maxima'

const FULL_MOCK_TIMES = {
  listening: 35,
  reading: 60,
  writing: 60
}

const MINI_MOCK_TIMES = {
  listening: 15,
  reading: 30,
  writing: 30
}

const ALL_MOCK_SECTIONS = {
  listening: true,
  reading: true,
  writing: true
}

function getStoredEnabledSections(data, mockType) {
  if (mockType !== 'mini_mock') {
    return { ...ALL_MOCK_SECTIONS }
  }

  if (data?.enabledSections && typeof data.enabledSections === 'object') {
    const stored = {
      listening: data.enabledSections.listening === true,
      reading: data.enabledSections.reading === true,
      writing: data.enabledSections.writing === true
    }

    if (Object.values(stored).some(Boolean)) {
      return stored
    }
  }

  const listeningIds = Array.isArray(data?.listeningIds)
    ? data.listeningIds.filter(Boolean)
    : data?.listeningId
      ? [data.listeningId]
      : []

  const readingIds = Array.isArray(data?.readingIds)
    ? data.readingIds.filter(Boolean)
    : data?.readingId
      ? [data.readingId]
      : []

  const inferred = {
    listening: listeningIds.length > 0,
    reading: readingIds.length > 0,
    writing: Boolean(data?.writingId)
  }

  return Object.values(inferred).some(Boolean)
    ? inferred
    : { ...ALL_MOCK_SECTIONS }
}

function normalizeTimeLimit(value, fallback) {
  const number = Number(value)

  if (!Number.isFinite(number)) return fallback

  return Math.max(5, Math.min(180, Math.round(number)))
}

function normalizeMiniSectionCount(value, fallback, max) {
  const number = Number(value)

  if (!Number.isFinite(number)) return fallback

  return Math.max(1, Math.min(max, Math.round(number)))
}

function getStoredMockTimes(data, mockType) {
  const defaults =
    mockType === 'mini_mock'
      ? MINI_MOCK_TIMES
      : FULL_MOCK_TIMES

  const stored = data?.sectionTimeLimits || {}

  return {
    listening: normalizeTimeLimit(
      stored.listening ?? data?.listeningTimeLimit,
      defaults.listening
    ),
    reading: normalizeTimeLimit(
      stored.reading ?? data?.readingTimeLimit,
      defaults.reading
    ),
    writing: normalizeTimeLimit(
      stored.writing ?? data?.writingTimeLimit,
      defaults.writing
    )
  }
}

function getWritingMode(item) {
  return (
    item?.contentType ||
    item?.writingMode ||
    item?.writingType ||
    'full_writing'
  )
}

function getWritingModeLabel(item) {
  const mode = getWritingMode(item)

  if (mode === 'task1_only') return 'Task 1 Only'
  if (mode === 'task2_only') return 'Task 2 Only'

  return 'Full Writing'
}

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

function listenMergedQueries(queryList, onItems, label = 'Firestore query') {
  if (!Array.isArray(queryList) || queryList.length === 0) {
    onItems([])
    return () => {}
  }

  let active = true
  const buckets = new Map()

  const emit = () => {
    if (!active) return

    const merged = new Map()

    buckets.forEach(items => {
      items.forEach(item => merged.set(item.id, item))
    })

    onItems(Array.from(merged.values()))
  }

  const unsubscribers = queryList.map((queryRef, index) =>
    onSnapshot(
      queryRef,
      snapshot => {
        buckets.set(
          index,
          snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        )
        emit()
      },
      error => {
        console.warn(`${label} failed`, error)
        buckets.set(index, [])
        emit()
      }
    )
  )

  return () => {
    active = false
    unsubscribers.forEach(unsubscribe => unsubscribe())
  }
}

function buildTeacherOwnedQueries(collectionName, teacherId) {
  const source = collection(db, collectionName)

  return [
    query(source, where('teacherIds', 'array-contains', teacherId)),
    query(source, where('teacherId', '==', teacherId)),
    query(source, where('createdBy', '==', teacherId))
  ]
}

function buildTeacherLibraryQueries(collectionName, teacherId, schoolId) {
  const source = collection(db, collectionName)

  return [
    ...buildTeacherOwnedQueries(collectionName, teacherId),
    query(
      source,
      where('schoolId', '==', schoolId),
      where('visibility', '==', 'school')
    ),
    query(
      source,
      where('schoolId', '==', schoolId),
      where('libraryVisibility', '==', 'school')
    )
  ]
}

export default function CreateMockTest() {
  const { id } = useParams()
  const isEditMode = Boolean(id)
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [checkingUser, setCheckingUser] = useState(true)

  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState('private')
  const [contentType, setContentType] = useState('full_mock')
  const [dueDate, setDueDate] = useState('')
  const [sectionTimeLimits, setSectionTimeLimits] = useState({
    ...FULL_MOCK_TIMES
  })

  const [readings, setReadings] = useState([])
  const [listenings, setListenings] = useState([])
  const [writings, setWritings] = useState([])
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])

  const [listeningIds, setListeningIds] = useState(['', '', '', ''])
  const [readingIds, setReadingIds] = useState(['', '', ''])
  const [writingId, setWritingId] = useState('')
  const [enabledSections, setEnabledSections] = useState({
    ...ALL_MOCK_SECTIONS
  })
  const [miniListeningCount, setMiniListeningCount] = useState(1)
  const [miniReadingCount, setMiniReadingCount] = useState(1)
  const [assignTo, setAssignTo] = useState([])

  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(isEditMode)
  const [existingMock, setExistingMock] = useState(null)

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
    const loadExistingMock = async () => {
      if (!isEditMode || !user || !profile) return

      try {
        const mockSnap = await getDoc(doc(db, 'mockTests', id))

        if (!mockSnap.exists()) {
          alert('Mock test not found.')
          navigate('/teacher')
          return
        }

        const data = {
          id: mockSnap.id,
          ...mockSnap.data()
        }

        if (
          !isAdminProfile(profile) &&
          (
            !isSameSchool(data, profile) ||
            !isAssignedToTeacher(data, user.uid)
          )
        ) {
          alert(
            'You cannot edit this School Library mock directly. Duplicate it into My Library first.'
          )
          navigate('/teacher')
          return
        }

        const existingMockType =
          data.contentType ||
          data.mockType ||
          'full_mock'

        setExistingMock(data)
        setTitle(data.title || '')
        setVisibility(data.visibility || data.libraryVisibility || 'private')
        setContentType(existingMockType)
        setEnabledSections(
          getStoredEnabledSections(data, existingMockType)
        )
        setDueDate(data.dueDate || '')
        setSectionTimeLimits(
          getStoredMockTimes(data, existingMockType)
        )

        const loadedListeningIds = Array.isArray(data.listeningIds)
          ? data.listeningIds.filter(Boolean)
          : data.listeningId
            ? [data.listeningId]
            : []

        const loadedReadingIds = Array.isArray(data.readingIds)
          ? data.readingIds.filter(Boolean)
          : data.readingId
            ? [data.readingId]
            : []

        const storedMiniCounts = data.miniSectionCounts || {}

        if (existingMockType === 'mini_mock') {
          setMiniListeningCount(
            normalizeMiniSectionCount(
              storedMiniCounts.listening,
              Math.max(loadedListeningIds.length, 1),
              4
            )
          )
          setMiniReadingCount(
            normalizeMiniSectionCount(
              storedMiniCounts.reading,
              Math.max(loadedReadingIds.length, 1),
              3
            )
          )
        } else {
          setMiniListeningCount(1)
          setMiniReadingCount(1)
        }

        setListeningIds([...loadedListeningIds, '', '', '', ''].slice(0, 4))
        setReadingIds([...loadedReadingIds, '', '', ''].slice(0, 3))
        setWritingId(data.writingId || '')

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
      } catch (error) {
        console.error('Could not load mock test for editing:', error)
        alert(
          `Could not open this mock test for editing.${error?.message ? `\n\n${error.message}` : ''}`
        )
        navigate('/teacher')
      } finally {
        setLoadingExisting(false)
      }
    }

    loadExistingMock()
  }, [id, isEditMode, navigate, profile, user])

  useEffect(() => {
    if (!user || !profile) return

    const schoolId = getProfileSchoolId(profile)
    const isAdmin = isAdminProfile(profile)

    const resourceQueries = collectionName =>
      isAdmin
        ? [query(collection(db, collectionName))]
        : buildTeacherLibraryQueries(
            collectionName,
            user.uid,
            schoolId
          )

    const subscribeResources = (collectionName, setter, label) =>
      listenMergedQueries(
        resourceQueries(collectionName),
        items => {
          const visibleItems = filterResourcesByProfile(
            items.filter(item => item.archived !== true),
            profile,
            user.uid
          )

          visibleItems.sort((a, b) =>
            (a.title || '').localeCompare(b.title || '')
          )

          setter(visibleItems)
        },
        label
      )

    const unsubReadings = subscribeResources(
      'readings',
      setReadings,
      'Mock reading library query'
    )

    const unsubListenings = subscribeResources(
      'listenings',
      setListenings,
      'Mock listening library query'
    )

    const unsubWritings = subscribeResources(
      'writingHomeworks',
      setWritings,
      'Mock writing library query'
    )

    const studentQueries = isAdmin
      ? [
          query(
            collection(db, 'users'),
            where('role', '==', 'student')
          )
        ]
      : [
          query(
            collection(db, 'users'),
            where('teacherIds', 'array-contains', user.uid)
          )
        ]

    const unsubStudents = listenMergedQueries(
      studentQueries,
      items => {
        const list = items.filter(student =>
          student.role === 'student' &&
          student.status === 'approved' &&
          student.deleted !== true
        )

        const visibleStudents = filterStudentsByProfile(
          list,
          profile,
          user.uid
        )

        visibleStudents.sort((a, b) =>
          (a.name || a.email || '').localeCompare(b.name || b.email || '')
        )

        setStudents(visibleStudents)
      },
      'Mock student query'
    )

    const classQueries = isAdmin
      ? [query(collection(db, 'classes'))]
      : buildTeacherOwnedQueries('classes', user.uid)

    const unsubClasses = listenMergedQueries(
      classQueries,
      items => {
        const list = items.filter(classItem => classItem.archived !== true)

        const visibleClasses = filterClassesByProfile(
          list,
          profile,
          user.uid
        ).sort((a, b) => (a.name || '').localeCompare(b.name || ''))

        setClasses(visibleClasses)
      },
      'Mock class query'
    )

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

  const isMiniMock = contentType === 'mini_mock'
  const mockTypeLabel = isMiniMock ? 'Mini Mock' : 'Full Mock'
  const activeSections = isMiniMock
    ? enabledSections
    : ALL_MOCK_SECTIONS
  const enabledSectionCount = Object.values(activeSections).filter(Boolean).length
  const listeningSlotCount = isMiniMock ? miniListeningCount : 4
  const readingSlotCount = isMiniMock ? miniReadingCount : 3
  const requiredReadingCount = readingSlotCount
  const activeListeningIds = listeningIds.slice(0, listeningSlotCount)
  const activeReadingIds = readingIds.slice(0, readingSlotCount)
  const selectedListeningIds = activeListeningIds.filter(Boolean)
  const selectedReadingIds = activeReadingIds.filter(Boolean)

  const selectedWriting = writings.find(item => item.id === writingId)
  const selectedWritingMode = activeSections.writing
    ? getWritingMode(selectedWriting)
    : 'none'
  const selectedWritingLabel = activeSections.writing
    ? getWritingModeLabel(selectedWriting)
    : 'No Writing'

  const hasDuplicateListenings =
    activeSections.listening &&
    selectedListeningIds.length !== new Set(selectedListeningIds).size

  const hasDuplicateReadings =
    activeSections.reading &&
    selectedReadingIds.length !== new Set(selectedReadingIds).size

  const validListeningSelection =
    !activeSections.listening ||
    (isMiniMock
      ? selectedListeningIds.length === listeningSlotCount
      : selectedListeningIds.length >= 1)

  const validReadingSelection =
    !activeSections.reading ||
    selectedReadingIds.length === requiredReadingCount

  const validWritingSelection =
    !activeSections.writing || Boolean(writingId)

  const totalTimeMinutes =
    (activeSections.listening ? Number(sectionTimeLimits.listening || 0) : 0) +
    (activeSections.reading ? Number(sectionTimeLimits.reading || 0) : 0) +
    (activeSections.writing ? Number(sectionTimeLimits.writing || 0) : 0)

  const enabledSectionLabels = [
    activeSections.listening ? 'Listening' : null,
    activeSections.reading ? 'Reading' : null,
    activeSections.writing ? selectedWritingLabel : null
  ].filter(Boolean)

  const flowSummary = enabledSectionLabels.join(' → ')

  const canCreate =
    title.trim() &&
    enabledSectionCount > 0 &&
    validListeningSelection &&
    !hasDuplicateListenings &&
    validReadingSelection &&
    !hasDuplicateReadings &&
    validWritingSelection &&
    (isEditMode || assignTo.length > 0) &&
    !saving &&
    !loadingExisting

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

  const handleMockTypeChange = value => {
    setContentType(value)

    if (value === 'mini_mock') {
      setMiniListeningCount(1)
      setMiniReadingCount(1)
      setEnabledSections({ ...ALL_MOCK_SECTIONS })
      setSectionTimeLimits({ ...MINI_MOCK_TIMES })
      return
    }

    setEnabledSections({ ...ALL_MOCK_SECTIONS })
    setSectionTimeLimits({ ...FULL_MOCK_TIMES })
  }

  const toggleMiniSection = section => {
    if (!isMiniMock) return

    setEnabledSections(previous => {
      const next = {
        ...previous,
        [section]: !previous[section]
      }

      if (!Object.values(next).some(Boolean)) {
        alert('Mini Mock must include at least one section.')
        return previous
      }

      return next
    })
  }

  const updateMiniListeningCount = value => {
    setMiniListeningCount(
      normalizeMiniSectionCount(value, miniListeningCount, 4)
    )
  }

  const updateMiniReadingCount = value => {
    setMiniReadingCount(
      normalizeMiniSectionCount(value, miniReadingCount, 3)
    )
  }

  const updateSectionTimeLimit = (section, value) => {
    setSectionTimeLimits(prev => ({
      ...prev,
      [section]: value
    }))
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
    const cleanListeningIds = activeSections.listening
      ? listeningIds.slice(0, listeningSlotCount).filter(Boolean)
      : []
    const cleanReadingIds = activeSections.reading
      ? readingIds.slice(0, readingSlotCount).filter(Boolean)
      : []
    const cleanWritingId = activeSections.writing
      ? writingId
      : ''

    if (!cleanTitle) {
      alert('Please add a mock test title.')
      return
    }

    if (enabledSectionCount === 0) {
      alert('Mini Mock must include at least one section.')
      return
    }

    if (
      activeSections.listening &&
      isMiniMock &&
      cleanListeningIds.length !== listeningSlotCount
    ) {
      alert(`Select exactly ${listeningSlotCount} Listening resource${listeningSlotCount === 1 ? '' : 's'} or turn Listening off.`)
      return
    }

    if (
      activeSections.listening &&
      !isMiniMock &&
      cleanListeningIds.length === 0
    ) {
      alert('Please select at least one Listening part/test.')
      return
    }

    if (
      activeSections.listening &&
      Array.from(new Set(cleanListeningIds)).length !== cleanListeningIds.length
    ) {
      alert(
        isMiniMock
          ? 'Please select different Listening resources.'
          : 'Please select different Listening tests or leave unused parts empty.'
      )
      return
    }

    if (
      activeSections.reading &&
      cleanReadingIds.length !== requiredReadingCount
    ) {
      alert(
        isMiniMock
          ? `Select exactly ${requiredReadingCount} Reading passage${requiredReadingCount === 1 ? '' : 's'} or turn Reading off.`
          : 'Please select Reading Passage 1, 2 and 3.'
      )
      return
    }

    if (
      activeSections.reading &&
      Array.from(new Set(cleanReadingIds)).length !== cleanReadingIds.length
    ) {
      alert(
        isMiniMock
          ? 'Please select different Reading passages.'
          : 'Please select three different Reading tests.'
      )
      return
    }

    if (activeSections.writing && !cleanWritingId) {
      alert('Select a Writing test or turn Writing off.')
      return
    }

    const cleanSectionTimeLimits = {
      listening: normalizeTimeLimit(
        sectionTimeLimits.listening,
        isMiniMock
          ? MINI_MOCK_TIMES.listening
          : FULL_MOCK_TIMES.listening
      ),
      reading: normalizeTimeLimit(
        sectionTimeLimits.reading,
        isMiniMock
          ? MINI_MOCK_TIMES.reading
          : FULL_MOCK_TIMES.reading
      ),
      writing: normalizeTimeLimit(
        sectionTimeLimits.writing,
        isMiniMock
          ? MINI_MOCK_TIMES.writing
          : FULL_MOCK_TIMES.writing
      )
    }

    if (!isEditMode && assignTo.length === 0) {
      alert('Please assign at least one student.')
      return
    }

    if (!user) {
      alert('User session expired. Please log in again.')
      navigate('/login')
      return
    }

    setSaving(true)

    const now = new Date().toISOString()

    const savedTotalTimeMinutes =
      (activeSections.listening ? cleanSectionTimeLimits.listening : 0) +
      (activeSections.reading ? cleanSectionTimeLimits.reading : 0) +
      (activeSections.writing ? cleanSectionTimeLimits.writing : 0)

    const payload = {
      title: cleanTitle,
      module: 'mock',
      contentType,
      mockType: contentType,
      enabledSections: { ...activeSections },
      miniSectionCounts: isMiniMock
        ? {
            listening: activeSections.listening ? listeningSlotCount : 0,
            reading: activeSections.reading ? readingSlotCount : 0
          }
        : {
            listening: 4,
            reading: 3
          },
      visibility,
      dueDate,
      listeningId: cleanListeningIds[0] || '',
      listeningIds: cleanListeningIds,
      readingIds: cleanReadingIds,
      writingId: cleanWritingId,
      writingMode: selectedWritingMode,
      sectionTimeLimits: cleanSectionTimeLimits,
      totalTimeMinutes: savedTotalTimeMinutes,
      assignTo,
      assignedStudentIds: selectedStudents.map(student => student.id),
      assignedEmails: selectedStudents
        .map(student => student.email?.toLowerCase())
        .filter(Boolean),
      schoolId: getProfileSchoolId(profile),
      mode: 'single-page-flow',
      updatedAt: now,
      updatedBy: user.uid
    }

    try {
      if (isEditMode) {
        await updateDoc(doc(db, 'mockTests', id), {
          ...payload,
          teacherId:
            existingMock?.teacherId ||
            existingMock?.createdBy ||
            (profile?.role === 'teacher' ? user.uid : ''),
          teacherIds:
            Array.isArray(existingMock?.teacherIds) &&
            existingMock.teacherIds.length > 0
              ? existingMock.teacherIds
              : profile?.role === 'teacher'
                ? [user.uid]
                : []
        })
      } else {
        await addDoc(collection(db, 'mockTests'), {
          ...payload,
          teacherId: profile?.role === 'teacher' ? user.uid : '',
          teacherIds: profile?.role === 'teacher' ? [user.uid] : [],
          createdBy: user.uid,
          createdAt: now,
          archived: false
        })
      }

      setSaved(true)

      setTimeout(() => {
        navigate('/teacher')
      }, 900)
    } catch (error) {
      console.error('Could not save mock test:', error)
      alert(
        `Could not save mock test.${error?.message ? `\n\n${error.message}` : ''}`
      )
    } finally {
      setSaving(false)
    }
  }

  if (checkingUser || loadingExisting) {
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
          {isEditMode
            ? `Edit ${mockTypeLabel}`
            : `Create ${mockTypeLabel}`}
        </h1>

        <p className="text-gray-500 mb-8">
          {isMiniMock
            ? 'Mini Mock format: choose any combination of Listening, Reading and Writing. You can also add extra Listening resources or Reading passages.'
            : 'Full Mock format: selected Listening part(s) → Reading Passage 1, 2, 3 → Writing inside a single controlled flow.'}
        </p>

        {saved && (
          <div className="bg-green-50 text-green-600 rounded-xl p-4 mb-6 text-sm font-medium">
            ✓ Mock test {isEditMode ? 'updated' : 'created'}. Redirecting...
          </div>
        )}

        {(
          (activeSections.listening && listenings.length === 0) ||
          (activeSections.reading && readings.length < requiredReadingCount) ||
          (activeSections.writing && writings.length === 0)
        ) && (
          <div className="bg-amber-50 border border-amber-100 text-amber-700 rounded-2xl p-5 mb-6 text-sm">
            {isMiniMock
              ? 'One or more enabled Mini Mock sections do not have enough available resources yet.'
              : 'You need at least 1 Listening, 3 Reading and 1 Writing resource before creating a Full Mock.'}
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
                  placeholder={isMiniMock ? 'e.g. Weekly Mini Mock 01' : 'e.g. Full IELTS Mock Test 01'}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                />
              </div>


              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Library visibility</label>
                  <select value={visibility} onChange={e => setVisibility(e.target.value)} className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white">
                    <option value="private">My Library</option>
                    <option value="school">School Library</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Mock type</label>
                  <select
                    value={contentType}
                    onChange={e => handleMockTypeChange(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-white text-gray-700 outline-none focus:border-purple-400"
                  >
                    <option value="full_mock">Full Mock</option>
                    <option value="mini_mock">Mini Mock</option>
                  </select>

                  <p className="text-[11px] text-gray-400 mt-1">
                    Full Mock keeps the complete IELTS structure. Mini Mock lets you switch Listening, Reading and Writing on or off.
                  </p>
                </div>
              </div>

              {isMiniMock && (
                <div className="mb-4">
                  <label className="text-xs text-gray-400 mb-2 block">
                    Mini Mock sections
                  </label>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      ['listening', 'Listening', '🎧'],
                      ['reading', 'Reading', '📖'],
                      ['writing', 'Writing', '✍️']
                    ].map(([key, label, icon]) => {
                      const enabled = enabledSections[key]

                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => toggleMiniSection(key)}
                          className={`text-left border rounded-2xl p-4 transition-all ${
                            enabled
                              ? 'border-purple-300 bg-purple-50'
                              : 'border-gray-200 bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-semibold text-gray-800">
                              {icon} {label}
                            </span>

                            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                              enabled
                                ? 'bg-purple-600 text-white'
                                : 'bg-white text-gray-400 border border-gray-200'
                            }`}>
                              {enabled ? 'Included' : 'Excluded'}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <p className="text-[11px] text-gray-400 mt-2">
                    Select any combination. At least one section must remain included.
                  </p>

                  {(enabledSections.listening || enabledSections.reading) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                      {enabledSections.listening && (
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">
                            Listening resources
                          </label>

                          <select
                            value={miniListeningCount}
                            onChange={e => updateMiniListeningCount(e.target.value)}
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-white text-gray-700 outline-none focus:border-purple-400"
                          >
                            {[1, 2, 3, 4].map(count => (
                              <option key={count} value={count}>
                                {count} Listening resource{count === 1 ? '' : 's'}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {enabledSections.reading && (
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">
                            Reading passages
                          </label>

                          <select
                            value={miniReadingCount}
                            onChange={e => updateMiniReadingCount(e.target.value)}
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-white text-gray-700 outline-none focus:border-purple-400"
                          >
                            {[1, 2, 3].map(count => (
                              <option key={count} value={count}>
                                {count} Reading passage{count === 1 ? '' : 's'}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

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

              <div className="mt-5 bg-gray-50 border border-gray-100 rounded-2xl p-4">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">
                      Section time limits
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      {isMiniMock
                        ? 'Set a custom time for each Mini Mock section.'
                        : 'Full Mock uses the standard section times.'}
                    </p>
                  </div>

                  <span className="text-xs bg-white text-purple-600 px-3 py-1 rounded-full">
                    {totalTimeMinutes} min total
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    ['listening', 'Listening'],
                    ['reading', 'Reading'],
                    ['writing', 'Writing']
                  ]
                    .filter(([key]) => activeSections[key])
                    .map(([key, label]) => (
                      <div key={key}>
                        <label className="text-xs text-gray-400 mb-1 block">
                          {label} / minutes
                        </label>

                        <input
                          type="number"
                          min="5"
                          max="180"
                          value={sectionTimeLimits[key]}
                          onChange={e =>
                            updateSectionTimeLimit(key, e.target.value)
                          }
                          disabled={!isMiniMock}
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white disabled:bg-gray-100 disabled:text-gray-500"
                        />
                      </div>
                    ))}
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                Select Test Parts
              </h2>

              <div className="grid grid-cols-1 gap-4">
                {activeSections.listening && (
                  <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">
                        Listening Parts
                      </h3>

                      <p className="text-xs text-gray-500 mt-1">
                        {isMiniMock
                          ? `Select exactly ${listeningSlotCount} Listening resource${listeningSlotCount === 1 ? '' : 's'}.`
                          : 'Select at least one Listening resource. You may leave unused slots empty.'}
                      </p>
                    </div>

                    <span className="text-xs bg-white text-purple-600 px-3 py-1 rounded-full">
                      {selectedListeningIds.length}/{listeningSlotCount} selected
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {Array.from({ length: listeningSlotCount }, (_, index) => index).map(index => (
                      <div key={index}>
                        <label className="text-xs text-gray-400 mb-1 block">
                          {isMiniMock
                            ? `Listening ${index + 1} / required`
                            : `Listening Slot ${index + 1} ${index === 0 ? '/ required' : '/ optional'}`}
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
                            {isMiniMock || index === 0
                              ? 'Select Listening resource'
                              : 'Optional: select Listening resource'}
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
                      {isMiniMock
                        ? 'Please choose different listening resources.'
                        : 'Please choose different listening tests or leave unused parts empty.'}
                    </p>
                  )}
                  </div>
                )}

                {activeSections.reading && Array.from({ length: readingSlotCount }, (_, index) => index).map(index => (
                  <div key={index}>
                    <label className="text-xs text-gray-400 mb-1 block">
                      {isMiniMock ? `Reading Passage ${index + 1} / required` : `Reading Passage ${index + 1}`}
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
                        {isMiniMock ? `Select Reading passage ${index + 1}` : `Select Reading passage ${index + 1}`}
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
                    {isMiniMock ? 'Please select different Reading passages.' : 'Please choose three different Reading passages.'}
                  </p>
                )}

                {activeSections.writing && (
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
                        {item.title} · {getWritingModeLabel(item)}
                      </option>
                    ))}
                  </select>

                  <p className="text-xs text-gray-400 mt-2">
                    Selected format: {writingId ? selectedWritingLabel : 'Choose a Writing resource'}. Writing is saved inside the mock submission and reviewed later.
                  </p>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">
                {mockTypeLabel} flow
              </h2>

              <p className="text-sm text-gray-500 leading-6">
                {isMiniMock
                  ? `Students complete ${flowSummary || 'the selected section'} in order. Extra Listening resources and Reading passages are included in the same section timer. The current total time is ${totalTimeMinutes} minutes.`
                  : 'Students move through the selected Listening part(s), three Reading passages and Writing with controlled section transitions.'}
              </p>
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 h-fit sticky top-6">
            <h2 className="font-semibold text-gray-800 mb-2">
              Assign Students
            </h2>

            <p className="text-xs text-gray-400 mb-4">
              Selected students will receive this {mockTypeLabel}.
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
              {saving
                ? isEditMode
                  ? 'Saving Changes...'
                  : 'Creating...'
                : isEditMode
                  ? 'Save Mock Changes'
                  : `Create ${mockTypeLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}