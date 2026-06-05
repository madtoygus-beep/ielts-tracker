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
  getDocs,
  updateDoc,
  deleteDoc
} from 'firebase/firestore'
import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const DEFAULT_SCHOOL_ID = 'maxima'

function getSchoolId(item) {
  return item?.schoolId || DEFAULT_SCHOOL_ID
}

export default function TeacherDashboard() {
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])
  const [scores, setScores] = useState({})

  const [readings, setReadings] = useState([])
  const [submissions, setSubmissions] = useState([])

  const [writings, setWritings] = useState([])
  const [writingSubmissions, setWritingSubmissions] = useState([])

  const [listenings, setListenings] = useState([])
  const [listeningSubmissions, setListeningSubmissions] = useState([])

  const [mockTests, setMockTests] = useState([])
  const [mockSubmissions, setMockSubmissions] = useState([])

  const [vocabularyTests, setVocabularyTests] = useState([])
  const [vocabularySubmissions, setVocabularySubmissions] = useState([])
  
  const [readingLibraryFilter, setReadingLibraryFilter] = useState('active')
  const [writingLibraryFilter, setWritingLibraryFilter] = useState('active')
  const [listeningLibraryFilter, setListeningLibraryFilter] = useState('active')
  const [vocabularyLibraryFilter, setVocabularyLibraryFilter] = useState('active')

  const [readingVisibilityFilter, setReadingVisibilityFilter] = useState('all')
  const [writingVisibilityFilter, setWritingVisibilityFilter] = useState('all')
  const [listeningVisibilityFilter, setListeningVisibilityFilter] = useState('all')
  const [vocabularyVisibilityFilter, setVocabularyVisibilityFilter] = useState('all')
  const [mockVisibilityFilter, setMockVisibilityFilter] = useState('all')

  const [mockContentTypeFilter, setMockContentTypeFilter] = useState('all')

  const [readingContentTypeFilter, setReadingContentTypeFilter] = useState('all')
  const [writingContentTypeFilter, setWritingContentTypeFilter] = useState('all')
  const [listeningContentTypeFilter, setListeningContentTypeFilter] = useState('all')
  const [vocabularyContentTypeFilter, setVocabularyContentTypeFilter] = useState('all')

  const [selected, setSelected] = useState(null)
  const [selectedStudentSection, setSelectedStudentSection] = useState('mock')
  const [selectedReview, setSelectedReview] = useState(null)
  const [selectedVocabularyReview, setSelectedVocabularyReview] = useState(null)

  const [selectedHomework, setSelectedHomework] = useState(null)
  const [selectedHomeworkType, setSelectedHomeworkType] = useState(null)
  const [assignmentDraft, setAssignmentDraft] = useState([])

  const [selectedWritingReview, setSelectedWritingReview] = useState(null)
  const [selectedMockWritingReview, setSelectedMockWritingReview] = useState(null)
  const [writingReviewForm, setWritingReviewForm] = useState({
    task1Band: '',
    task2Band: '',
    task1TA: '',
    task1CC: '',
    task1LR: '',
    task1GRA: '',
    task2TR: '',
    task2CC: '',
    task2LR: '',
    task2GRA: '',
    task1Feedback: '',
    task2Feedback: '',
    overall: '',
    generalFeedback: ''
  })

  const [form, setForm] = useState({
    listening: '',
    reading: '',
    writing: '',
    speaking: '',
    date: ''
  })

  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [analyticsStudentId, setAnalyticsStudentId] = useState('all')

  const navigate = useNavigate()

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

    const trackSnapshot = unsubscribe => {
      liveUnsubscribers.push(unsubscribe)
      return unsubscribe
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
        setProfile(profile)

        const isAdminUser = profile.role === 'admin'
        const teacherSchoolId = profile.schoolId || DEFAULT_SCHOOL_ID

        const studentsQuery = isAdminUser
          ? query(collection(db, 'users'), where('role', '==', 'student'))
          : query(
              collection(db, 'users'),
              where('role', '==', 'student'),
              where('teacherIds', 'array-contains', currentUser.uid)
            )

        trackSnapshot(
          onSnapshot(studentsQuery, snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(u => {
                if (u.deleted || u.status !== 'approved') return false
                if (isAdminUser) return true

                return getSchoolId(u) === teacherSchoolId
              })
              .sort((a, b) =>
                (a.name || a.email || '').localeCompare(b.name || b.email || '')
              )

            setStudents(list)
          })
        )

        const classesQuery = isAdminUser
          ? query(collection(db, 'classes'))
          : query(
              collection(db, 'classes'),
              where('teacherId', '==', currentUser.uid)
            )

        trackSnapshot(
          onSnapshot(classesQuery, snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(classItem => {
                if (classItem.archived === true) return false
                if (isAdminUser) return true

                return getSchoolId(classItem) === teacherSchoolId
              })
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

            setClasses(list)
          })
        )

        trackSnapshot(
          onSnapshot(collection(db, 'scores'), snap => {
            const groupedScores = {}

            snap.docs.forEach(scoreDoc => {
              const score = {
                id: scoreDoc.id,
                ...scoreDoc.data()
              }

              if (!score.uid) return

              if (!isAdminUser && getSchoolId(score) !== teacherSchoolId) return

              if (!groupedScores[score.uid]) {
                groupedScores[score.uid] = []
              }

              groupedScores[score.uid].push(score)
            })

            Object.keys(groupedScores).forEach(studentId => {
              groupedScores[studentId].sort(
                (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
              )
            })

            setScores(groupedScores)
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'readings')), snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => {
                if (isAdminUser) return true
                if (getSchoolId(item) !== teacherSchoolId) return false

                const itemVisibility = item.visibility || item.libraryVisibility || 'private'
                const isOwnedByTeacher = item.createdBy === currentUser.uid || item.teacherId === currentUser.uid

                return isOwnedByTeacher || itemVisibility === 'school'
              })

            list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            setReadings(list)
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'readingSubmissions')), snap => {
            setSubmissions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'writingHomeworks')), snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => {
                if (isAdminUser) return true
                if (getSchoolId(item) !== teacherSchoolId) return false

                const itemVisibility = item.visibility || item.libraryVisibility || 'private'
                const isOwnedByTeacher = item.createdBy === currentUser.uid || item.teacherId === currentUser.uid

                return isOwnedByTeacher || itemVisibility === 'school'
              })

            list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            setWritings(list)
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'writingSubmissions')), snap => {
            setWritingSubmissions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'listenings')), snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => {
                if (isAdminUser) return true
                if (getSchoolId(item) !== teacherSchoolId) return false

                const itemVisibility = item.visibility || item.libraryVisibility || 'private'
                const isOwnedByTeacher = item.createdBy === currentUser.uid || item.teacherId === currentUser.uid

                return isOwnedByTeacher || itemVisibility === 'school'
              })

            list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            setListenings(list)
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'listeningSubmissions')), snap => {
            setListeningSubmissions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'mockTests')), snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => {
                if (isAdminUser) return true
                if (getSchoolId(item) !== teacherSchoolId) return false

                const itemVisibility = item.visibility || item.libraryVisibility || 'private'
                const isOwnedByTeacher = item.createdBy === currentUser.uid || item.teacherId === currentUser.uid

                return isOwnedByTeacher || itemVisibility === 'school'
              })

            list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            setMockTests(list)
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'mockSubmissions')), snap => {
            setMockSubmissions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'vocabularyTests')), snap => {
            const list = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => {
                if (isAdminUser) return true
                if (getSchoolId(item) !== teacherSchoolId) return false

                const itemVisibility = item.visibility || item.libraryVisibility || 'private'
                const isOwnedByTeacher = item.createdBy === currentUser.uid || item.teacherId === currentUser.uid

                return isOwnedByTeacher || itemVisibility === 'school'
              })

            list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            setVocabularyTests(list)
          })
        )

        trackSnapshot(
          onSnapshot(query(collection(db, 'vocabularySubmissions')), snap => {
            setVocabularySubmissions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
          })
        )
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
      unsubAuth()
      clearLiveUnsubscribers()
    }
  }, [navigate])

  const activeReadings = readings.filter(r => !r.archived)
  const archivedReadings = readings.filter(r => r.archived)

  const activeWritings = writings.filter(w => !w.archived)
  const archivedWritings = writings.filter(w => w.archived)

  const activeListenings = listenings.filter(l => !l.archived)
  const archivedListenings = listenings.filter(l => l.archived)

  const activeMockTests = mockTests.filter(mock => !mock.archived)
  const archivedMockTests = mockTests.filter(mock => mock.archived)

  const activeVocabularyTests = vocabularyTests.filter(vocabulary => !vocabulary.archived)
  const archivedVocabularyTests = vocabularyTests.filter(vocabulary => vocabulary.archived)
  

  const overall = score => {
    const avg =
      (+score.listening +
        +score.reading +
        +score.writing +
        +score.speaking) /
      4

    return (Math.round(avg * 2) / 2).toFixed(1)
  }

  const normalizeAssignmentId = value =>
    value === undefined || value === null
      ? ''
      : value.toString().trim().toLowerCase()

  const uniqueCleanValues = values =>
    Array.from(
      new Set(
        values
          .filter(value => value !== undefined && value !== null)
          .map(value => value.toString().trim())
          .filter(Boolean)
      )
    )

  const getStudentPrimaryAssignmentId = student =>
    student?.uid || student?.authUid || student?.id || ''

  const getStudentAssignmentValues = student =>
    uniqueCleanValues([
      student?.id,
      student?.uid,
      student?.authUid,
      student?.email,
      student?.email?.toLowerCase()
    ])

  const getHomeworkAssignmentValues = homework =>
    uniqueCleanValues([
      ...(Array.isArray(homework?.assignTo) ? homework.assignTo : []),
      ...(Array.isArray(homework?.assignedTo) ? homework.assignedTo : []),
      ...(Array.isArray(homework?.studentIds) ? homework.studentIds : []),
      ...(Array.isArray(homework?.assignedStudentIds) ? homework.assignedStudentIds : []),
      ...(Array.isArray(homework?.assignedEmails) ? homework.assignedEmails : [])
    ])

  const isHomeworkAssignedToStudent = (homework, student) => {
    if (!homework || !student) return false

    const homeworkValues = getHomeworkAssignmentValues(homework).map(normalizeAssignmentId)
    const studentValues = getStudentAssignmentValues(student).map(normalizeAssignmentId)

    return studentValues.some(value => homeworkValues.includes(value))
  }

  const mapHomeworkAssignmentsToStudentIds = homework =>
    students
      .filter(student => isHomeworkAssignedToStudent(homework, student))
      .map(student => student.id)

  const getStudentByAnyId = studentId => {
    const normalized = normalizeAssignmentId(studentId)

    return students.find(student =>
      getStudentAssignmentValues(student)
        .map(normalizeAssignmentId)
        .includes(normalized)
    )
  }

  const submissionBelongsToStudent = (submission, student) => {
    if (!submission || !student) return false

    const studentValues = getStudentAssignmentValues(student).map(normalizeAssignmentId)
    return studentValues.includes(normalizeAssignmentId(submission.uid))
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
      uid: getStudentPrimaryAssignmentId(selected),
      overall: overall(form),
      addedBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : selected.teacherIds?.[0] || '',
      schoolId: profile?.schoolId || getSchoolId(selected)
    })

    setForm({
      listening: '',
      reading: '',
      writing: '',
      speaking: '',
      date: ''
    })
  }

  const latestScore = studentId => {
    const student = getStudentByAnyId(studentId)
    const scoreKey = getStudentPrimaryAssignmentId(student) || studentId

    return scores[scoreKey]?.[0] || scores[studentId]?.[0]
  }

  const getStudentReadings = studentId => {
    const student = getStudentByAnyId(studentId)
    return activeReadings.filter(reading =>
      isHomeworkAssignedToStudent(reading, student)
    )
  }

  const getStudentWritings = studentId => {
    const student = getStudentByAnyId(studentId)
    return activeWritings.filter(writing =>
      isHomeworkAssignedToStudent(writing, student)
    )
  }

  const getStudentListenings = studentId => {
    const student = getStudentByAnyId(studentId)
    return activeListenings.filter(listening =>
      isHomeworkAssignedToStudent(listening, student)
    )
  }

  const getStudentVocabularyTests = studentId => {
    const student = getStudentByAnyId(studentId)
    return activeVocabularyTests.filter(vocabularyTest =>
      isHomeworkAssignedToStudent(vocabularyTest, student)
    )
  }

  const isVocabularySubmissionForTest = (submission, vocabularyTestId) => {
    if (!submission || !vocabularyTestId) return false

    return [
      submission.vocabularyTestId,
      submission.vocabularyId,
      submission.testId,
      submission.homeworkId
    ]
      .map(normalizeAssignmentId)
      .includes(normalizeAssignmentId(vocabularyTestId))
  }

  const getSubmission = (studentId, readingId) => {
    const student = getStudentByAnyId(studentId)

    return submissions.find(
      sub => submissionBelongsToStudent(sub, student) && sub.readingId === readingId
    )
  }

  const getWritingSubmission = (studentId, writingId) => {
    const student = getStudentByAnyId(studentId)

    return writingSubmissions.find(
      sub => submissionBelongsToStudent(sub, student) && sub.writingId === writingId
    )
  }

  const getListeningSubmission = (studentId, listeningId) => {
    const student = getStudentByAnyId(studentId)

    return listeningSubmissions.find(
      sub => submissionBelongsToStudent(sub, student) && sub.listeningId === listeningId
    )
  }

  const getVocabularySubmission = (studentId, vocabularyTestId) => {
    const student = getStudentByAnyId(studentId)

    return vocabularySubmissions.find(
      sub =>
        submissionBelongsToStudent(sub, student) &&
        isVocabularySubmissionForTest(sub, vocabularyTestId)
    )
  }

  const getCompletedCount = readingId => {
    return submissions.filter(sub => sub.readingId === readingId).length
  }

  const getWritingSubmittedCount = writingId => {
    return writingSubmissions.filter(sub => sub.writingId === writingId).length
  }

  const getWritingReviewedCount = writingId => {
    return writingSubmissions.filter(
      sub => sub.writingId === writingId && sub.reviewed
    ).length
  }

  const getListeningCompletedCount = listeningId => {
    return listeningSubmissions.filter(sub => sub.listeningId === listeningId).length
  }

  const getVocabularyCompletedCount = vocabularyTestId => {
    return vocabularySubmissions.filter(sub =>
      isVocabularySubmissionForTest(sub, vocabularyTestId)
    ).length
  }

  const pendingReviewWritings = activeWritings.filter(writing => {
    const submitted = getWritingSubmittedCount(writing.id)
    const reviewed = getWritingReviewedCount(writing.id)

    return submitted > reviewed
  })

  const pendingWritingReviews = writingSubmissions
    .filter(submission => !submission.reviewed)
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const writing = writings.find(item => item.id === submission.writingId)

      if (!student || !writing) return null

      return {
        submission,
        student,
        writing
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.submittedAt || 0) -
      new Date(a.submission.submittedAt || 0)
    )

  const reviewedWritingReviews = writingSubmissions
    .filter(submission => submission.reviewed)
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const writing = writings.find(item => item.id === submission.writingId)

      if (!student || !writing) return null

      return {
        submission,
        student,
        writing
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.reviewedAt || b.submission.submittedAt || 0) -
      new Date(a.submission.reviewedAt || a.submission.submittedAt || 0)
    )

  const getMockWritingStatus = submission => {
    return (
      submission.result?.writing?.status ||
      submission.writingReview?.status ||
      submission.review?.writingStatus ||
      'pending_review'
    )
  }

  const getMockTask1Answer = submission => {
    return (
      submission.writingAnswers?.task1 ||
      submission.writing?.task1 ||
      submission.task1Answer ||
      ''
    )
  }

  const getMockTask2Answer = submission => {
    return (
      submission.writingAnswers?.task2 ||
      submission.writing?.task2 ||
      submission.task2Answer ||
      ''
    )
  }

  const getMockTask1WordCount = submission => {
    return (
      submission.result?.writing?.task1WordCount ||
      submission.writing?.task1WordCount ||
      submission.task1WordCount ||
      getWordCount(getMockTask1Answer(submission))
    )
  }

  const getMockTask2WordCount = submission => {
    return (
      submission.result?.writing?.task2WordCount ||
      submission.writing?.task2WordCount ||
      submission.task2WordCount ||
      getWordCount(getMockTask2Answer(submission))
    )
  }

  const getMockWritingReview = submission => {
    return submission.result?.writing?.review || submission.writingReview || null
  }

  const pendingMockWritingReviews = mockSubmissions
    .filter(submission => {
      if (submission.archived) return false
      if (!getMockTask1Answer(submission) && !getMockTask2Answer(submission)) return false

      return getMockWritingStatus(submission) !== 'reviewed'
    })
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const mock = mockTests.find(item => item.id === submission.mockTestId)

      if (!student) return null

      return {
        submission,
        student,
        mock
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.submittedAt || 0) -
      new Date(a.submission.submittedAt || 0)
    )

  const reviewedMockWritingReviews = mockSubmissions
    .filter(submission => {
      if (submission.archived) return false
      if (!getMockTask1Answer(submission) && !getMockTask2Answer(submission)) return false

      return getMockWritingStatus(submission) === 'reviewed'
    })
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const mock = mockTests.find(item => item.id === submission.mockTestId)

      if (!student) return null

      return {
        submission,
        student,
        mock
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.reviewedAt || b.submission.submittedAt || 0) -
      new Date(a.submission.reviewedAt || a.submission.submittedAt || 0)
    )

  const reviewedMockWritingCount = mockSubmissions.filter(
    submission => getMockWritingStatus(submission) === 'reviewed'
  ).length

  const submittedMockWritingCount = mockSubmissions.filter(
    submission => getMockTask1Answer(submission) || getMockTask2Answer(submission)
  ).length

  const totalPendingWritingReviews =
    pendingWritingReviews.length + pendingMockWritingReviews.length

  const reviewedWritingCount =
    writingSubmissions.filter(submission => submission.reviewed).length +
    reviewedMockWritingCount

  const submittedWritingCount =
    writingSubmissions.length + submittedMockWritingCount

  const formatDateShort = value => {
    if (!value) return 'No date'

    try {
      return new Date(value).toLocaleDateString()
    } catch (error) {
      return value
    }
  }


  const getLibraryVisibility = item =>
    item?.visibility || item?.libraryVisibility || 'private'

  const isSchoolLibraryItem = item => getLibraryVisibility(item) === 'school'

  const isOwnedByCurrentTeacher = item =>
    profile?.role === 'admin' || item?.createdBy === user?.uid || item?.teacherId === user?.uid

  const getLibraryContentType = (item, fallback = 'full') =>
    item?.contentType || item?.practiceType || fallback

  const getLibraryVisibilityLabel = item =>
    isSchoolLibraryItem(item) ? 'School Library' : 'My Library'

  const getContentTypeLabel = value => {
    const labels = {
      full_reading: 'Full Reading',
      short_reading: 'Short Reading',
      mini_reading: 'Mini Reading',
      passage_practice: 'Passage Practice',
      reading_skill: 'Skill Practice',
      full_listening: 'Full Listening',
      listening_part: 'Part Practice',
      part_1: 'Part 1',
      part_2: 'Part 2',
      part_3: 'Part 3',
      part_4: 'Part 4',
      mini_listening: 'Mini Listening',
      short_listening: 'Short Practice',
      listening_skill: 'Skill Practice',
      full_writing: 'Full Writing',
      task1_only: 'Task 1 Only',
      task2_only: 'Task 2 Only',
      vocabulary_quiz: 'Vocabulary Quiz',
      word_set: 'Word Set',
      mixed_practice: 'Mixed Practice',
      topic_vocabulary: 'Topic Vocabulary',
      academic_vocabulary: 'Academic Vocabulary',
      full_mock: 'Full Mock',
      reading_mock: 'Reading Mock',
      listening_mock: 'Listening Mock',
      writing_mock: 'Writing Mock'
    }

    return labels[value] || 'Practice'
  }

  const filterByVisibility = (items, visibilityFilter) => {
    if (visibilityFilter === 'school') return items.filter(isSchoolLibraryItem)
    if (visibilityFilter === 'private') return items.filter(item => !isSchoolLibraryItem(item))
    return items
  }

  const filterByContentType = (items, contentTypeFilter, fallback) => {
    if (contentTypeFilter === 'all') return items

    return items.filter(item =>
      getLibraryContentType(item, fallback) === contentTypeFilter
    )
  }

  const applyLibraryFilters = (items, visibilityFilter, contentTypeFilter, fallback) =>
    filterByContentType(
      filterByVisibility(items, visibilityFilter),
      contentTypeFilter,
      fallback
    )

  const librarySelectClass = 'border border-gray-200 rounded-xl px-3 py-2 text-xs bg-white text-gray-600 outline-none focus:border-purple-400'

  const filteredReadings = applyLibraryFilters(
    readingLibraryFilter === 'all'
      ? readings
      : readingLibraryFilter === 'archived'
        ? archivedReadings
        : activeReadings,
    readingVisibilityFilter,
    readingContentTypeFilter,
    'full_reading'
  )

  const filteredWritings = applyLibraryFilters(
    writingLibraryFilter === 'all'
      ? writings
      : writingLibraryFilter === 'archived'
        ? archivedWritings
        : writingLibraryFilter === 'pending'
          ? pendingReviewWritings
          : activeWritings,
    writingVisibilityFilter,
    writingContentTypeFilter,
    'full_writing'
  )

  const filteredListenings = applyLibraryFilters(
    listeningLibraryFilter === 'all'
      ? listenings
      : listeningLibraryFilter === 'archived'
        ? archivedListenings
        : activeListenings,
    listeningVisibilityFilter,
    listeningContentTypeFilter,
    'full_listening'
  )

  const filteredVocabularyTests = applyLibraryFilters(
    vocabularyLibraryFilter === 'all'
      ? vocabularyTests
      : vocabularyLibraryFilter === 'archived'
        ? archivedVocabularyTests
        : activeVocabularyTests,
    vocabularyVisibilityFilter,
    vocabularyContentTypeFilter,
    'vocabulary_quiz'
  )

  const filteredActiveMockTests = filterByContentType(
    filterByVisibility(activeMockTests, mockVisibilityFilter),
    mockContentTypeFilter,
    'full_mock'
  )
  const filteredArchivedMockTests = filterByContentType(
    filterByVisibility(archivedMockTests, mockVisibilityFilter),
    mockContentTypeFilter,
    'full_mock'
  )

  const openAssignmentManager = (homework, type) => {
    setSelectedHomework(homework)
    setSelectedHomeworkType(type)
    setAssignmentDraft(mapHomeworkAssignmentsToStudentIds(homework))
  }

  const toggleAssignment = studentId => {
    setAssignmentDraft(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    )
  }

  const assignClassToHomework = classItem => {
    const classStudentIds = classItem.studentIds || []

    if (classStudentIds.length === 0) {
      alert('This class has no students yet.')
      return
    }

    setAssignmentDraft(prev =>
      Array.from(new Set([...prev, ...classStudentIds]))
    )
  }

  const removeClassFromHomework = classItem => {
    const classStudentIds = classItem.studentIds || []

    setAssignmentDraft(prev =>
      prev.filter(studentId => !classStudentIds.includes(studentId))
    )
  }

  const isClassFullyAssignedToDraft = classItem => {
    const classStudentIds = classItem.studentIds || []
    if (classStudentIds.length === 0) return false
    return classStudentIds.every(studentId => assignmentDraft.includes(studentId))
  }

  const isClassPartlyAssignedToDraft = classItem => {
    const classStudentIds = classItem.studentIds || []
    if (classStudentIds.length === 0) return false
    return classStudentIds.some(studentId => assignmentDraft.includes(studentId))
  }

  const getStudentName = studentId => {
    const student = getStudentByAnyId(studentId)
    return student?.name || student?.email || 'Unknown student'
  }

  const saveAssignments = async () => {
    if (!selectedHomework || !selectedHomeworkType) return

    const collectionName =
      selectedHomeworkType === 'reading'
        ? 'readings'
        : selectedHomeworkType === 'listening'
          ? 'listenings'
          : selectedHomeworkType === 'mock'
            ? 'mockTests'
            : selectedHomeworkType === 'vocabulary'
              ? 'vocabularyTests'
              : 'writingHomeworks'

    const allowedStudentIds = new Set(students.map(student => student.id))
    const allowedDraftIds = profile?.role === 'admin'
      ? assignmentDraft
      : assignmentDraft.filter(studentId => allowedStudentIds.has(studentId))

    const selectedStudents = allowedDraftIds
      .map(studentId => students.find(student => student.id === studentId))
      .filter(Boolean)

    const finalAssignment = uniqueCleanValues(
      selectedStudents.map(student => getStudentPrimaryAssignmentId(student))
    )

    const assignedStudentIds = uniqueCleanValues(
      selectedStudents.map(student => student.id)
    )

    const assignedEmails = uniqueCleanValues(
      selectedStudents
        .map(student => student.email?.toLowerCase())
        .filter(Boolean)
    )

    const selectedVisibilityValues = new Set(
      selectedStudents
        .flatMap(student => getStudentAssignmentValues(student))
        .map(normalizeAssignmentId)
    )

    const hiddenFor = Array.isArray(selectedHomework.hiddenFor)
      ? selectedHomework.hiddenFor.filter(value =>
          !selectedVisibilityValues.has(normalizeAssignmentId(value))
        )
      : []

    await updateDoc(doc(db, collectionName, selectedHomework.id), {
      assignTo: finalAssignment,
      assignedStudentIds,
      assignedEmails,
      hiddenFor,
      archived: false,
      schoolId: profile?.schoolId || DEFAULT_SCHOOL_ID,
      teacherId: profile?.role === 'teacher'
        ? user.uid
        : selectedHomework.teacherId || selectedHomework.createdBy || user.uid,
      updatedBy: user.uid,
      updatedAt: new Date().toISOString()
    })

    setSelectedHomework(null)
    setSelectedHomeworkType(null)
    setAssignmentDraft([])
  }

  const removeHomeworkFromStudent = async (homework, type, student) => {
    if (!homework || !student || !type) return

    const typeLabel =
      type === 'reading'
        ? 'reading homework'
        : type === 'listening'
          ? 'listening homework'
          : type === 'vocabulary'
            ? 'vocabulary test'
            : type === 'mock'
              ? 'mock test'
              : 'writing homework'

    const confirmed = window.confirm(
      `Remove "${homework.title || 'this homework'}" from ${student.name || student.email}?\n\nThis will only remove the ${typeLabel} from this student. Existing submissions, answers and results will stay saved.`
    )

    if (!confirmed) return

    const collectionName =
      type === 'reading'
        ? 'readings'
        : type === 'listening'
          ? 'listenings'
          : type === 'mock'
            ? 'mockTests'
            : type === 'vocabulary'
              ? 'vocabularyTests'
              : 'writingHomeworks'

    const studentValues = getStudentAssignmentValues(student)
    const normalizedStudentValues = new Set(
      studentValues.map(normalizeAssignmentId)
    )

    const removeStudentValues = values =>
      Array.isArray(values)
        ? values.filter(value => !normalizedStudentValues.has(normalizeAssignmentId(value)))
        : []

    try {
      await updateDoc(doc(db, collectionName, homework.id), {
        assignTo: removeStudentValues(homework.assignTo),
        assignedTo: removeStudentValues(homework.assignedTo),
        studentIds: removeStudentValues(homework.studentIds),
        assignedStudentIds: removeStudentValues(homework.assignedStudentIds),
        assignedEmails: removeStudentValues(homework.assignedEmails),
        hiddenFor: uniqueCleanValues([
          ...(Array.isArray(homework.hiddenFor) ? homework.hiddenFor : []),
          ...studentValues
        ]),
        updatedBy: user.uid,
        updatedAt: new Date().toISOString()
      })
    } catch (error) {
      console.error('Could not remove homework from student:', error)
      alert('Could not remove homework from this student. Please check permissions and try again.')
    }
  }

  const archiveReadingHomework = async reading => {
    const ok = window.confirm(
      `"${reading.title}" will be archived and removed from students' homework list. Existing results will stay saved.`
    )

    if (!ok) return

    await updateDoc(doc(db, 'readings', reading.id), {
      archived: true,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: []
    })
  }

  const restoreReadingHomework = async reading => {
    await updateDoc(doc(db, 'readings', reading.id), {
      archived: false
    })
  }

  const deleteReadingHomework = async reading => {
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

  const duplicateReadingHomework = async reading => {
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
      assignedStudentIds,
      assignedEmails,
      hiddenFor,
      archived,
      ...copyData
    } = reading

    await addDoc(collection(db, 'readings'), {
      ...copyData,
      title: `${reading.title} Copy`,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: [],
      hiddenFor: [],
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : reading.teacherId || '',
      schoolId: profile?.schoolId || getSchoolId(reading),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveWritingHomework = async writing => {
    const ok = window.confirm(
      `"${writing.title}" will be archived and removed from students' writing homework list. Existing submissions will stay saved.`
    )

    if (!ok) return

    await updateDoc(doc(db, 'writingHomeworks', writing.id), {
      archived: true,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: []
    })
  }

  const restoreWritingHomework = async writing => {
    await updateDoc(doc(db, 'writingHomeworks', writing.id), {
      archived: false
    })
  }

  const deleteWritingHomework = async writing => {
    const submittedCount = getWritingSubmittedCount(writing.id)

    if (submittedCount > 0) {
      const forceDelete = window.confirm(
        `"${writing.title}" has ${submittedCount} student submission(s).

Deleting will permanently remove:
- Writing homework
- Student Task 1 / Task 2 answers
- Teacher reviews

Continue permanent delete?`
      )

      if (!forceDelete) return

      const relatedSubs = writingSubmissions.filter(
        sub => sub.writingId === writing.id
      )

      for (const sub of relatedSubs) {
        await deleteDoc(doc(db, 'writingSubmissions', sub.id))
      }

      await deleteDoc(doc(db, 'writingHomeworks', writing.id))
      return
    }

    const ok = window.confirm(`Delete "${writing.title}" permanently?`)
    if (!ok) return

    await deleteDoc(doc(db, 'writingHomeworks', writing.id))
  }

  const duplicateWritingHomework = async writing => {
    const ok = window.confirm(
      `Duplicate "${writing.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      assignTo,
      assignedStudentIds,
      assignedEmails,
      hiddenFor,
      archived,
      ...copyData
    } = writing

    await addDoc(collection(db, 'writingHomeworks'), {
      ...copyData,
      title: `${writing.title} Copy`,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: [],
      hiddenFor: [],
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : writing.teacherId || '',
      schoolId: profile?.schoolId || getSchoolId(writing),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveListeningHomework = async listening => {
    const ok = window.confirm(
      `"${listening.title}" will be archived and removed from students' listening homework list. Existing results will stay saved.`
    )

    if (!ok) return

    await updateDoc(doc(db, 'listenings', listening.id), {
      archived: true,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: []
    })
  }

  const restoreListeningHomework = async listening => {
    await updateDoc(doc(db, 'listenings', listening.id), {
      archived: false
    })
  }

  const deleteListeningHomework = async listening => {
    const completedCount = getListeningCompletedCount(listening.id)

    if (completedCount > 0) {
      const forceDelete = window.confirm(
        `"${listening.title}" has ${completedCount} student submission(s).

Deleting will permanently remove:
- Listening homework
- Student answers
- Results/Bands

Continue permanent delete?`
      )

      if (!forceDelete) return

      const relatedSubs = listeningSubmissions.filter(
        sub => sub.listeningId === listening.id
      )

      for (const sub of relatedSubs) {
        await deleteDoc(doc(db, 'listeningSubmissions', sub.id))
      }

      await deleteDoc(doc(db, 'listenings', listening.id))
      return
    }

    const ok = window.confirm(`Delete "${listening.title}" permanently?`)
    if (!ok) return

    await deleteDoc(doc(db, 'listenings', listening.id))
  }

  const duplicateListeningHomework = async listening => {
    const ok = window.confirm(
      `Duplicate "${listening.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      assignTo,
      assignedStudentIds,
      assignedEmails,
      hiddenFor,
      archived,
      ...copyData
    } = listening

    await addDoc(collection(db, 'listenings'), {
      ...copyData,
      title: `${listening.title} Copy`,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: [],
      hiddenFor: [],
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : listening.teacherId || '',
      schoolId: profile?.schoolId || getSchoolId(listening),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveVocabularyTest = async vocabularyTest => {
    const ok = window.confirm(
      `"${vocabularyTest.title}" will be archived and removed from students' vocabulary homework list. Existing results will stay saved.`
    )

    if (!ok) return

    await updateDoc(doc(db, 'vocabularyTests', vocabularyTest.id), {
      archived: true,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: []
    })
  }

  const restoreVocabularyTest = async vocabularyTest => {
    await updateDoc(doc(db, 'vocabularyTests', vocabularyTest.id), {
      archived: false
    })
  }

  const deleteVocabularyTest = async vocabularyTest => {
    const completedCount = getVocabularyCompletedCount(vocabularyTest.id)

    if (completedCount > 0) {
      const forceDelete = window.confirm(
        `"${vocabularyTest.title}" has ${completedCount} student submission(s).

Deleting will permanently remove:
- Vocabulary test
- Student answers
- Results

Continue permanent delete?`
      )

      if (!forceDelete) return

      const relatedSubs = vocabularySubmissions.filter(sub =>
        isVocabularySubmissionForTest(sub, vocabularyTest.id)
      )

      for (const sub of relatedSubs) {
        await deleteDoc(doc(db, 'vocabularySubmissions', sub.id))
      }

      await deleteDoc(doc(db, 'vocabularyTests', vocabularyTest.id))
      return
    }

    const ok = window.confirm(`Delete "${vocabularyTest.title}" permanently?`)
    if (!ok) return

    await deleteDoc(doc(db, 'vocabularyTests', vocabularyTest.id))
  }

  const duplicateVocabularyTest = async vocabularyTest => {
    const ok = window.confirm(
      `Duplicate "${vocabularyTest.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      assignTo,
      assignedStudentIds,
      assignedEmails,
      hiddenFor,
      archived,
      ...copyData
    } = vocabularyTest

    await addDoc(collection(db, 'vocabularyTests'), {
      ...copyData,
      title: `${vocabularyTest.title} Copy`,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: [],
      hiddenFor: [],
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : vocabularyTest.teacherId || '',
      schoolId: profile?.schoolId || getSchoolId(vocabularyTest),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveMockTest = async mockTest => {
    const ok = window.confirm(
      `"${mockTest.title}" will be archived and removed from students' mock test list. Existing submissions will stay saved.`
    )

    if (!ok) return

    await updateDoc(doc(db, 'mockTests', mockTest.id), {
      archived: true,
      assignTo: [],
      assignedStudentIds: [],
      assignedEmails: []
    })
  }

  const restoreMockTest = async mockTest => {
    await updateDoc(doc(db, 'mockTests', mockTest.id), {
      archived: false
    })
  }

  const deleteMockTest = async mockTest => {
    const submittedCount = getMockSubmittedCount(mockTest)

    if (submittedCount > 0) {
      const forceDelete = window.confirm(
        `"${mockTest.title}" has ${submittedCount} mock submission(s).

Deleting will permanently remove:
- Mock test
- Student mock answers
- Mock results/bands
- Writing reviews connected to this mock

Continue permanent delete?`
      )

      if (!forceDelete) return

      const relatedSubs = mockSubmissions.filter(
        submission => submission.mockTestId === mockTest.id
      )

      for (const submission of relatedSubs) {
        await deleteDoc(doc(db, 'mockSubmissions', submission.id))
      }

      await deleteDoc(doc(db, 'mockTests', mockTest.id))
      return
    }

    const ok = window.confirm(`Delete "${mockTest.title}" permanently?`)
    if (!ok) return

    await deleteDoc(doc(db, 'mockTests', mockTest.id))
  }

  const numberWords = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
    twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
    seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
  }

  const normalize = value => {
    if (value === undefined || value === null) return ''

    const clean = value
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:()]/g, '')
      .replace(/\s+/g, ' ')

    return numberWords[clean] || clean
  }

  const getWordCount = value => {
    const clean = normalize(value)
    if (!clean) return 0
    return clean.split(' ').filter(Boolean).length
  }

  const parseAcceptedAnswers = cell => {
    const main = cell.answer ? [cell.answer] : []
    const alternatives = cell.acceptedAnswers
      ? cell.acceptedAnswers.split(',').map(item => item.trim()).filter(Boolean)
      : []

    return [...main, ...alternatives]
  }

  const isWithinWordLimit = (value, maxWords) => {
    if (!maxWords) return true
    return getWordCount(value) <= Number(maxWords)
  }

  const sortAnswers = value => {
    if (!Array.isArray(value)) return []
    return [...value].map(v => v?.toString().trim()).sort()
  }

  const tableAnswerKey = (questionId, rowId, cellIndex) => {
    return `${questionId}_${rowId}_${cellIndex}`
  }

  const noteAnswerKey = (questionId, paragraphId, partId) => {
    return `${questionId}_${paragraphId}_${partId}`
  }

  const listeningCompletionAnswerKey = (questionId, sectionId, itemId) => {
    return `${questionId}_${sectionId}_${itemId}`
  }

  const matchingAnswerKey = (questionId, itemId) => {
    return `${questionId}_${itemId}`
  }

  const getHeadingText = (reading, number) => {
    if (!number) return 'No answer'
    const index = Number(number) - 1
    return reading.headings?.[index] || `Heading ${number}`
  }

  const getOptionText = (question, letter) => {
    if (!letter) return ''
    const index = letters.indexOf(letter)
    return question.options?.[index] || ''
  }

  const getAnswerText = (question, value) => {
    if (question.type === 'mcq') {
      if (Array.isArray(value)) {
        if (value.length === 0) return 'No answer'
        return value
          .map(letter => `${letter}. ${getOptionText(question, letter)}`)
          .join(', ')
      }

      if (!value) return 'No answer'
      return `${value}. ${getOptionText(question, value)}`
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return 'No answer'
      return value.join(', ')
    }

    return value || 'No answer'
  }

  const isNormalCorrect = (submission, question) => {
    if (question.type === 'mcq' && question.mode === 'multi') {
      const userAnswer = sortAnswers(submission.answers?.[question.id]).join('|')
      const correctAnswer = sortAnswers(question.answers || []).join('|')

      return userAnswer === correctAnswer
    }

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

  const isSentenceEndingCorrect = (submission, question, item) => {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  const isSummaryOptionCorrect = (submission, question, item) => {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  const getSentenceEndingText = (question, letter) => {
    if (!letter) return 'No answer'

    const index = letters.indexOf(letter)

    return question.endings?.[index] || `Ending ${letter}`
  }

  const isTableCellCorrect = (submission, question, row, cellIndex) => {
    const key = tableAnswerKey(question.id, row.id, cellIndex)
    const cell = row.cells[cellIndex]
    const userAnswer = normalize(submission.answers?.[key])
    const acceptedAnswers = parseAcceptedAnswers(cell).map(normalize)

    if (!isWithinWordLimit(submission.answers?.[key], cell.maxWords)) return false

    return acceptedAnswers.includes(userAnswer)
  }

  const isNoteCompletionPartCorrect = (submission, question, paragraph, part) => {
    const key = noteAnswerKey(question.id, paragraph.id, part.id)
    const userAnswer = submission.answers?.[key]

    if (question.mode === 'choose') {
      return userAnswer?.toString().trim() === part.answer?.toString().trim()
    }

    const acceptedAnswers = [
      part.answer,
      ...(part.acceptedAnswers
        ? part.acceptedAnswers.split(',').map(item => item.trim()).filter(Boolean)
        : [])
    ].map(normalize)

    if (!isWithinWordLimit(userAnswer, part.maxWords)) return false

    return acceptedAnswers.includes(normalize(userAnswer))
  }

  const isListeningCompletionPartCorrect = (submission, question, section, item) => {
    const key = listeningCompletionAnswerKey(question.id, section.id, item.id)
    const userAnswer = submission.answers?.[key]

    if (question.completionMode === 'choose') {
      return userAnswer?.toString().trim() === item.answer?.toString().trim()
    }

    const acceptedAnswers = [
      item.answer,
      ...(item.acceptedAnswers
        ? item.acceptedAnswers.split(',').map(answer => answer.trim()).filter(Boolean)
        : [])
    ].map(normalize)

    if (!isWithinWordLimit(userAnswer, item.maxWords)) return false

    return acceptedAnswers.includes(normalize(userAnswer))
  }

  const isListeningMatchingItemCorrect = (submission, question, item) => {
    const key = matchingAnswerKey(question.id, item.id)
    const userAnswer = normalize(submission.answers?.[key])
    const correctAnswer = normalize(item.answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const getStudentAnalytics = studentId => {
    const student = getStudentByAnyId(studentId)
    const studentSubs = submissions.filter(sub => submissionBelongsToStudent(sub, student))

    const stats = {
      matching: { correct: 0, total: 0 },
      sentenceEndings: { correct: 0, total: 0 },
      summaryOptions: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      summary: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      noteCompletion: { correct: 0, total: 0 },
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

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats.sentenceEndings.total++

            if (isSentenceEndingCorrect(sub, question, item)) {
              stats.sentenceEndings.correct++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats.summaryOptions.total++

            if (isSummaryOptionCorrect(sub, question, item)) {
              stats.summaryOptions.correct++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats.noteCompletion.total++

              if (isNoteCompletionPartCorrect(sub, question, paragraph, part)) {
                stats.noteCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats.table.total++

                if (isTableCellCorrect(sub, question, row, cellIndex)) {
                  stats.table.correct++
                }
              }
            })
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
      sentenceEndings: percentage(stats.sentenceEndings),
      summaryOptions: percentage(stats.summaryOptions),
      tfng: percentage(stats.tfng),
      fitb: percentage(stats.fitb),
      table: percentage(stats.table),
      summary: percentage(stats.summary),
      note: percentage(stats.note),
      noteCompletion: percentage(stats.noteCompletion),
      mcq: percentage(stats.mcq)
    }

    const weaknessList = Object.entries(data)
      .filter(([, value]) => value !== null)
      .sort((a, b) => a[1] - b[1])

    return {
      ...data,
      weakest: weaknessList[0]?.[0] || null
    }
  }

  const getWeakestLabel = type => {
    if (type === 'matching') return 'Matching Headings'
    if (type === 'sentenceEndings') return 'Sentence Endings'
    if (type === 'summaryOptions') return 'Summary Completion with Options'
    if (type === 'tfng') return 'True / False / Not Given'
    if (type === 'fitb') return 'Fill in the Blank'
    if (type === 'table') return 'Table Completion'
    if (type === 'summary') return 'Summary Completion'
    if (type === 'note') return 'Legacy Note Completion'
    if (type === 'noteCompletion') return 'Reading Note/Summary Completion'
    if (type === 'mcq') return 'Multiple Choice'
    return 'No data yet'
  }

  const getAnalyticsColor = value => {
    if (value === null || value === undefined) return 'text-gray-400'
    if (value >= 75) return 'text-green-600'
    if (value >= 60) return 'text-amber-600'
    return 'text-red-500'
  }




  const estimateReadingBand = (correct, total) => {
    if (!total) return null

    const percentage = (correct / total) * 100

    if (percentage >= 90) return 9
    if (percentage >= 85) return 8.5
    if (percentage >= 80) return 8
    if (percentage >= 75) return 7.5
    if (percentage >= 70) return 7
    if (percentage >= 65) return 6.5
    if (percentage >= 60) return 6
    if (percentage >= 50) return 5.5
    if (percentage >= 40) return 5
    if (percentage >= 30) return 4.5
    if (percentage >= 20) return 4
    return 3.5
  }

  const getReadingSubmissionResult = submission => {
    const reading = readings.find(item => item.id === submission.readingId)
    if (!reading) return null

    let correct = 0
    let total = 0

    reading.questions?.forEach(question => {
      if (question.type === 'matching') {
        question.paragraphs?.forEach(paragraph => {
          total++

          if (isMatchingCorrect(submission, question, paragraph)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'sentenceEndings') {
        question.items?.forEach(item => {
          total++

          if (isSentenceEndingCorrect(submission, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'summaryOptions') {
        question.items?.forEach(item => {
          total++

          if (isSummaryOptionCorrect(submission, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'noteCompletion') {
        question.paragraphs?.forEach(paragraph => {
          paragraph.parts?.forEach(part => {
            if (part.type !== 'blank') return

            total++

            if (isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
              correct++
            }
          })
        })

        return
      }

      if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type === 'blank') {
              total++

              if (isTableCellCorrect(submission, question, row, cellIndex)) {
                correct++
              }
            }
          })
        })

        return
      }

      total++

      if (isNormalCorrect(submission, question)) {
        correct++
      }
    })

    return {
      correct,
      total,
      accuracy: total ? Math.round((correct / total) * 100) : null,
      estimatedBand: estimateReadingBand(correct, total)
    }
  }

  const getAverageReadingEstimatedBand = () => {
    const bands = submissions
      .map(submission => {
        if (submission.result?.band) return Number(submission.result.band)
        if (submission.result?.estimatedBand) return Number(submission.result.estimatedBand)

        const result = getReadingSubmissionResult(submission)
        return result?.estimatedBand
      })
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getReadingCompletionStats = () => {
    const assigned = activeReadings.reduce(
      (sum, reading) => sum + (reading.assignTo?.length || 0),
      0
    )

    const activeReadingIds = activeReadings.map(reading => reading.id)

    const completed = submissions.filter(submission =>
      activeReadingIds.includes(submission.readingId)
    ).length

    const rate = assigned ? Math.round((completed / assigned) * 100) : 0

    return {
      assigned,
      completed,
      rate
    }
  }

  const getMostMissedReadingQuestions = () => {
    const stats = {}

    submissions.forEach(submission => {
      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach((question, questionIndex) => {
        const key = `${reading.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats[key].total++

            if (!isMatchingCorrect(submission, question, paragraph)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSentenceEndingCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSummaryOptionCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats[key].total++

              if (!isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getAtRiskReadingStudents = () => {
    return students
      .map(student => {
        const studentSubs = submissions
          .filter(sub => submissionBelongsToStudent(sub, student))
          .sort(
            (a, b) =>
              new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
          )

        const latest = studentSubs[0]

        if (!latest) return null

        const result = latest.result?.band
          ? {
              estimatedBand: Number(latest.result.band),
              accuracy: latest.result.accuracy || null
            }
          : getReadingSubmissionResult(latest)

        if (!result?.estimatedBand) return null

        return {
          student,
          latestBand: Number(result.estimatedBand),
          latestAccuracy: result.accuracy,
          submissions: studentSubs.length
        }
      })
      .filter(item => item && item.latestBand < 6)
      .sort((a, b) => a.latestBand - b.latestBand)
      .slice(0, 5)
  }

  const getReadingTypeAnalytics = () => {
    const stats = {
      matching: { correct: 0, total: 0 },
      sentenceEndings: { correct: 0, total: 0 },
      summaryOptions: { correct: 0, total: 0 },
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      summary: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      noteCompletion: { correct: 0, total: 0 }
    }

    submissions.forEach(submission => {
      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach(question => {
        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats.matching.total++

            if (isMatchingCorrect(submission, question, paragraph)) {
              stats.matching.correct++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats.sentenceEndings.total++

            if (isSentenceEndingCorrect(submission, question, item)) {
              stats.sentenceEndings.correct++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats.summaryOptions.total++

            if (isSummaryOptionCorrect(submission, question, item)) {
              stats.summaryOptions.correct++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats.noteCompletion.total++

              if (isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats.noteCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          const key = question.type === 'summary'
            ? 'summary'
            : question.type === 'note'
              ? 'note'
              : 'table'

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }


  const getStudentReadingSubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return submissions
      .filter(submission => submissionBelongsToStudent(submission, student))
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const getAverageReadingEstimatedBandFromSubmissions = targetSubmissions => {
    const bands = targetSubmissions
      .map(submission => {
        if (submission.result?.band) return Number(submission.result.band)
        if (submission.result?.estimatedBand) return Number(submission.result.estimatedBand)

        const result = getReadingSubmissionResult(submission)
        return result?.estimatedBand
      })
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getReadingCompletionStatsForStudent = studentId => {
    const assignedReadings = getStudentReadings(studentId)
    const completed = assignedReadings.filter(reading =>
      getSubmission(studentId, reading.id)
    ).length

    return {
      assigned: assignedReadings.length,
      completed,
      rate: assignedReadings.length
        ? Math.round((completed / assignedReadings.length) * 100)
        : 0
    }
  }

  const getReadingTypeAnalyticsForSubmissions = targetSubmissions => {
    const stats = {
      matching: { correct: 0, total: 0 },
      sentenceEndings: { correct: 0, total: 0 },
      summaryOptions: { correct: 0, total: 0 },
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      summary: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      noteCompletion: { correct: 0, total: 0 }
    }

    targetSubmissions.forEach(submission => {
      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach(question => {
        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats.matching.total++

            if (isMatchingCorrect(submission, question, paragraph)) {
              stats.matching.correct++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats.sentenceEndings.total++

            if (isSentenceEndingCorrect(submission, question, item)) {
              stats.sentenceEndings.correct++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats.summaryOptions.total++

            if (isSummaryOptionCorrect(submission, question, item)) {
              stats.summaryOptions.correct++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats.noteCompletion.total++

              if (isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats.noteCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          const key = question.type === 'summary'
            ? 'summary'
            : question.type === 'note'
              ? 'note'
              : 'table'

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }

  const getMostMissedReadingQuestionsForSubmissions = targetSubmissions => {
    const stats = {}

    targetSubmissions.forEach(submission => {
      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach((question, questionIndex) => {
        const key = `${reading.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats[key].total++

            if (!isMatchingCorrect(submission, question, paragraph)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSentenceEndingCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSummaryOptionCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats[key].total++

              if (!isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }


  const getStudentListeningSubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return listeningSubmissions
      .filter(submission => submissionBelongsToStudent(submission, student))
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const getListeningCompletionStatsForStudent = studentId => {
    const assignedListenings = getStudentListenings(studentId)
    const completed = assignedListenings.filter(listening =>
      getListeningSubmission(studentId, listening.id)
    ).length

    return {
      assigned: assignedListenings.length,
      completed,
      rate: assignedListenings.length
        ? Math.round((completed / assignedListenings.length) * 100)
        : 0
    }
  }

  const getAverageListeningBandFromSubmissions = targetSubmissions => {
    const bands = targetSubmissions
      .map(submission => Number(submission.result?.band))
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getListeningTypeAnalyticsForSubmissions = targetSubmissions => {
    const stats = {
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      listeningCompletion: { correct: 0, total: 0 },
      listeningMatching: { correct: 0, total: 0 }
    }

    targetSubmissions.forEach(submission => {
      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach(question => {
        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats.listeningMatching.total++

            if (isListeningMatchingItemCorrect(submission, question, item)) {
              stats.listeningMatching.correct++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats.listeningCompletion.total++

              if (isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats.listeningCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats.table.total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats.table.correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }

  const getMostMissedListeningQuestionsForSubmissions = targetSubmissions => {
    const stats = {}

    targetSubmissions.forEach(submission => {
      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach((question, questionIndex) => {
        const key = `${listening.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats[key].total++

            if (!isListeningMatchingItemCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats[key].total++

              if (!isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getStudentVocabularySubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return vocabularySubmissions
      .filter(submission => submissionBelongsToStudent(submission, student))
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const getVocabularyCompletionStatsForStudent = studentId => {
    const assignedVocabularyTests = getStudentVocabularyTests(studentId)
    const completed = assignedVocabularyTests.filter(vocabularyTest =>
      getVocabularySubmission(studentId, vocabularyTest.id)
    ).length

    return {
      assigned: assignedVocabularyTests.length,
      completed,
      rate: assignedVocabularyTests.length
        ? Math.round((completed / assignedVocabularyTests.length) * 100)
        : 0
    }
  }

  const getAverageVocabularyAccuracyFromSubmissions = targetSubmissions => {
    const percentages = targetSubmissions
      .map(submission => Number(submission.result?.percentage))
      .filter(value => !Number.isNaN(value) && value >= 0)

    if (percentages.length === 0) return null

    const avg = percentages.reduce((sum, value) => sum + value, 0) / percentages.length
    return Math.round(avg)
  }

  const getVocabularyTestPerformanceForSubmissions = targetSubmissions => {
    return targetSubmissions
      .map(submission => {
        const vocabularyTest = vocabularyTests.find(test =>
          isVocabularySubmissionForTest(submission, test.id)
        )

        return {
          id: submission.id,
          title: vocabularyTest?.title || submission.vocabularyTitle || 'Vocabulary Test',
          correct: submission.result?.correct || 0,
          total: submission.result?.total || vocabularyTest?.questions?.length || 0,
          percentage: submission.result?.percentage ?? null,
          submittedAt: submission.submittedAt
        }
      })
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
      .slice(0, 5)
  }

  const getMostMissedVocabularyQuestionsForSubmissions = targetSubmissions => {
    const stats = {}

    targetSubmissions.forEach(submission => {
      const vocabularyTest = vocabularyTests.find(test =>
        isVocabularySubmissionForTest(submission, test.id)
      )

      if (!vocabularyTest) return

      vocabularyTest.questions?.forEach((question, questionIndex) => {
        const selectedAnswer = submission.answers?.[question.id]
        const correctAnswer = question.answer
        const isCorrect = selectedAnswer === correctAnswer
        const key = `${vocabularyTest.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            question: question.question || '',
            wrong: 0,
            total: 0
          }
        }

        stats[key].total++

        if (!isCorrect) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getReadingTypeLabel = type => {
    if (type === 'matching') return 'Matching Headings'
    if (type === 'sentenceEndings') return 'Sentence Endings'
    if (type === 'summaryOptions') return 'Summary Completion with Options'
    if (type === 'mcq') return 'MCQ'
    if (type === 'fitb') return 'Fill Blank'
    if (type === 'tfng') return 'T/F/NG'
    if (type === 'table') return 'Table Completion'
    if (type === 'summary') return 'Summary Completion'
    if (type === 'note') return 'Legacy Note Completion'
    if (type === 'noteCompletion') return 'Reading Note/Summary Completion'
    return type
  }


  const getAverageListeningBand = () => {
    const bands = listeningSubmissions
      .map(sub => Number(sub.result?.band))
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getListeningCompletionStats = () => {
    const assigned = activeListenings.reduce(
      (sum, listening) => sum + (listening.assignTo?.length || 0),
      0
    )

    const activeListeningIds = activeListenings.map(listening => listening.id)

    const completed = listeningSubmissions.filter(submission =>
      activeListeningIds.includes(submission.listeningId)
    ).length

    const rate = assigned ? Math.round((completed / assigned) * 100) : 0

    return {
      assigned,
      completed,
      rate
    }
  }

  const getMostMissedListeningQuestions = () => {
    const stats = {}

    listeningSubmissions.forEach(submission => {
      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach((question, questionIndex) => {
        const key = `${listening.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats[key].total++

            if (!isListeningMatchingItemCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats[key].total++

              if (!isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getAtRiskListeningStudents = () => {
    return students
      .map(student => {
        const studentSubs = listeningSubmissions
          .filter(sub => submissionBelongsToStudent(sub, student) && sub.result?.band)
          .sort(
            (a, b) =>
              new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
          )

        const latest = studentSubs[0]

        if (!latest) return null

        return {
          student,
          latestBand: Number(latest.result.band),
          submissions: studentSubs.length
        }
      })
      .filter(item => item && item.latestBand < 6)
      .sort((a, b) => a.latestBand - b.latestBand)
      .slice(0, 5)
  }

  const getListeningTypeAnalytics = () => {
    const stats = {
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      listeningCompletion: { correct: 0, total: 0 },
      listeningMatching: { correct: 0, total: 0 }
    }

    listeningSubmissions.forEach(submission => {
      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach(question => {
        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats.listeningMatching.total++

            if (isListeningMatchingItemCorrect(submission, question, item)) {
              stats.listeningMatching.correct++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats.listeningCompletion.total++

              if (isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats.listeningCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats.table.total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats.table.correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }

  const getListeningTypeLabel = type => {
    if (type === 'listeningMatching') return 'Listening Matching'
    if (type === 'mcq') return 'MCQ'
    if (type === 'fitb') return 'Fill Blank'
    if (type === 'tfng') return 'T/F/NG'
    if (type === 'table') return 'Form/Table'
    if (type === 'note') return 'Legacy Note Completion'
    if (type === 'listeningCompletion') return 'Listening Note/Summary Completion'
    return type
  }

  const formatBand = value => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number.toFixed(1) : '-'
  }

  const getMockOverall = submission => {
    const result = submission?.result || {}

    return (
      result.reviewedOverall ||
      result.finalOverall ||
      result.overall ||
      result.overallEstimate ||
      null
    )
  }

  const getMockWritingBand = submission => {
    const result = submission?.result || {}

    return (
      result.writing?.band ||
      result.writingBand ||
      submission?.writingReview?.overall ||
      submission?.review?.writingOverall ||
      null
    )
  }

  const getMockWritingStatusLabel = submission => {
    const band = getMockWritingBand(submission)

    if (band) return `Reviewed · Band ${formatBand(band)}`

    return 'Pending teacher review'
  }

  const getMockTitle = submission => {
    const mock = mockTests.find(item => item.id === submission.mockTestId)

    return mock?.title || submission.mockTitle || 'Mock Test'
  }

  const getStudentMockSubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return mockSubmissions
      .filter(submission => submissionBelongsToStudent(submission, student) && submission.archived !== true)
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const latestMockSubmission = studentId => getStudentMockSubmissions(studentId)[0]

  const handlePrint = student => {
    const studentMocks = getStudentMockSubmissions(student.id)
    const printWindow = window.open('', '_blank')

    printWindow.document.write(`
      <html>
        <head>
          <title>${student.name} - Mock History</title>
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
          <p>${student.email} — Mock History Report</p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Mock</th>
                <th>Listening</th>
                <th>Reading</th>
                <th>Writing</th>
                <th>Overall</th>
              </tr>
            </thead>
            <tbody>
              ${studentMocks
                .map(submission => {
                  const result = submission.result || {}
                  return `
                    <tr>
                      <td>${formatDateShort(submission.submittedAt)}</td>
                      <td>${getMockTitle(submission)}</td>
                      <td>${formatBand(result.listening?.band)}</td>
                      <td>${formatBand(result.reading?.band)}</td>
                      <td>${getMockWritingBand(submission) ? formatBand(getMockWritingBand(submission)) : 'Pending'}</td>
                      <td class="overall">${formatBand(getMockOverall(submission))}</td>
                    </tr>
                  `
                })
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


  const getWritingMode = (writing, submission = {}) =>
    submission?.contentType ||
    submission?.writingMode ||
    writing?.contentType ||
    writing?.writingMode ||
    'full_writing'

  const isWritingTask1Enabled = (writing, submission = {}) => {
    if (submission?.task1Enabled === true) return true
    if (submission?.task1Enabled === false) return false

    return getWritingMode(writing, submission) !== 'task2_only'
  }

  const isWritingTask2Enabled = (writing, submission = {}) => {
    if (submission?.task2Enabled === true) return true
    if (submission?.task2Enabled === false) return false

    return getWritingMode(writing, submission) !== 'task1_only'
  }

  const getWritingTaskLabel = (writing, submission = {}) => {
    const task1Enabled = isWritingTask1Enabled(writing, submission)
    const task2Enabled = isWritingTask2Enabled(writing, submission)

    if (task1Enabled && task2Enabled) return 'Task 1 + Task 2'
    if (task1Enabled) return 'Task 1 Only'
    if (task2Enabled) return 'Task 2 Only'

    return 'Writing'
  }

  const getWritingSubmissionWordSummary = (writing, submission = {}) => {
    const parts = []

    if (isWritingTask1Enabled(writing, submission)) {
      parts.push(`Task 1: ${submission.task1WordCount || 0} words`)
    }

    if (isWritingTask2Enabled(writing, submission)) {
      parts.push(`Task 2: ${submission.task2WordCount || 0} words`)
    }

    return parts.join(' · ') || 'No answer'
  }

  const openWritingReview = ({ student, writing, submission }) => {
    setSelectedMockWritingReview(null)
    setSelectedWritingReview({ student, writing, submission })

    setWritingReviewForm({
      task1Band: submission.review?.task1Band || '',
      task2Band: submission.review?.task2Band || '',
      task1TA: submission.review?.rubric?.task1?.taskAchievement || '',
      task1CC: submission.review?.rubric?.task1?.coherenceCohesion || '',
      task1LR: submission.review?.rubric?.task1?.lexicalResource || '',
      task1GRA: submission.review?.rubric?.task1?.grammarRangeAccuracy || '',
      task2TR: submission.review?.rubric?.task2?.taskResponse || '',
      task2CC: submission.review?.rubric?.task2?.coherenceCohesion || '',
      task2LR: submission.review?.rubric?.task2?.lexicalResource || '',
      task2GRA: submission.review?.rubric?.task2?.grammarRangeAccuracy || '',
      task1Feedback: submission.review?.task1Feedback || '',
      task2Feedback: submission.review?.task2Feedback || '',
      overall: submission.review?.overall || '',
      generalFeedback: submission.review?.generalFeedback || ''
    })
  }

  const openMockWritingReview = ({ student, mock, submission }) => {
    const review = getMockWritingReview(submission) || {}

    setSelectedWritingReview(null)
    setSelectedMockWritingReview({ student, mock, submission })

    setWritingReviewForm({
      task1Band: review.task1Band || submission.result?.writing?.task1Band || '',
      task2Band: review.task2Band || submission.result?.writing?.task2Band || '',
      task1TA: review.rubric?.task1?.taskAchievement || '',
      task1CC: review.rubric?.task1?.coherenceCohesion || '',
      task1LR: review.rubric?.task1?.lexicalResource || '',
      task1GRA: review.rubric?.task1?.grammarRangeAccuracy || '',
      task2TR: review.rubric?.task2?.taskResponse || '',
      task2CC: review.rubric?.task2?.coherenceCohesion || '',
      task2LR: review.rubric?.task2?.lexicalResource || '',
      task2GRA: review.rubric?.task2?.grammarRangeAccuracy || '',
      task1Feedback: review.task1Feedback || '',
      task2Feedback: review.task2Feedback || '',
      overall: review.overall || submission.result?.writing?.band || '',
      generalFeedback: review.generalFeedback || ''
    })
  }

  const roundToHalf = value => {
    if (!value && value !== 0) return ''

    return (Math.round(Number(value) * 2) / 2).toFixed(1)
  }

  const averageBand = values => {
    const numbers = values
      .map(value => Number(value))
      .filter(value => !Number.isNaN(value) && value > 0)

    if (numbers.length === 0) return ''

    const avg = numbers.reduce((sum, value) => sum + value, 0) / numbers.length

    return roundToHalf(avg)
  }

  const currentNormalWritingReviewTask1Enabled = selectedWritingReview
    ? isWritingTask1Enabled(selectedWritingReview.writing, selectedWritingReview.submission)
    : true

  const currentNormalWritingReviewTask2Enabled = selectedWritingReview
    ? isWritingTask2Enabled(selectedWritingReview.writing, selectedWritingReview.submission)
    : true

  const currentWritingReviewTask1Enabled = selectedMockWritingReview
    ? true
    : currentNormalWritingReviewTask1Enabled

  const currentWritingReviewTask2Enabled = selectedMockWritingReview
    ? true
    : currentNormalWritingReviewTask2Enabled

  const suggestedTask1Band = currentWritingReviewTask1Enabled
    ? averageBand([
        writingReviewForm.task1TA,
        writingReviewForm.task1CC,
        writingReviewForm.task1LR,
        writingReviewForm.task1GRA
      ])
    : ''

  const suggestedTask2Band = currentWritingReviewTask2Enabled
    ? averageBand([
        writingReviewForm.task2TR,
        writingReviewForm.task2CC,
        writingReviewForm.task2LR,
        writingReviewForm.task2GRA
      ])
    : ''

  const suggestedOverallBand = averageBand([
    currentWritingReviewTask1Enabled
      ? writingReviewForm.task1Band || suggestedTask1Band
      : '',
    currentWritingReviewTask2Enabled
      ? writingReviewForm.task2Band || suggestedTask2Band
      : ''
  ])

  const useSuggestedBands = () => {
    setWritingReviewForm(prev => ({
      ...prev,
      task1Band: currentWritingReviewTask1Enabled
        ? prev.task1Band || suggestedTask1Band
        : prev.task1Band,
      task2Band: currentWritingReviewTask2Enabled
        ? prev.task2Band || suggestedTask2Band
        : prev.task2Band,
      overall: suggestedOverallBand || prev.overall
    }))
  }

  const resetWritingReviewForm = () => {
    setWritingReviewForm({
      task1Band: '',
      task2Band: '',
      task1TA: '',
      task1CC: '',
      task1LR: '',
      task1GRA: '',
      task2TR: '',
      task2CC: '',
      task2LR: '',
      task2GRA: '',
      task1Feedback: '',
      task2Feedback: '',
      overall: '',
      generalFeedback: ''
    })
  }

  const buildWritingReviewPayload = () => ({
    task1Enabled: currentWritingReviewTask1Enabled,
    task2Enabled: currentWritingReviewTask2Enabled,
    task1Band: currentWritingReviewTask1Enabled ? writingReviewForm.task1Band : '',
    task2Band: currentWritingReviewTask2Enabled ? writingReviewForm.task2Band : '',
    rubric: {
      task1: currentWritingReviewTask1Enabled
        ? {
            taskAchievement: writingReviewForm.task1TA,
            coherenceCohesion: writingReviewForm.task1CC,
            lexicalResource: writingReviewForm.task1LR,
            grammarRangeAccuracy: writingReviewForm.task1GRA
          }
        : {},
      task2: currentWritingReviewTask2Enabled
        ? {
            taskResponse: writingReviewForm.task2TR,
            coherenceCohesion: writingReviewForm.task2CC,
            lexicalResource: writingReviewForm.task2LR,
            grammarRangeAccuracy: writingReviewForm.task2GRA
          }
        : {}
    },
    task1Feedback: currentWritingReviewTask1Enabled ? writingReviewForm.task1Feedback : '',
    task2Feedback: currentWritingReviewTask2Enabled ? writingReviewForm.task2Feedback : '',
    overall: writingReviewForm.overall,
    generalFeedback: writingReviewForm.generalFeedback
  })

  const saveWritingReview = async () => {
    if (!selectedWritingReview) return

    if (!writingReviewForm.overall) {
      alert('Please enter overall writing band.')
      return
    }

    await updateDoc(
      doc(db, 'writingSubmissions', selectedWritingReview.submission.id),
      {
        reviewed: true,
        reviewedAt: new Date().toISOString(),
        reviewedBy: user.uid,
        review: buildWritingReviewPayload()
      }
    )

    setSelectedWritingReview(null)
    resetWritingReviewForm()
  }

  const saveMockWritingReview = async () => {
    if (!selectedMockWritingReview) return

    if (!writingReviewForm.overall) {
      alert('Please enter overall writing band.')
      return
    }

    const submission = selectedMockWritingReview.submission
    const result = submission.result || {}
    const review = buildWritingReviewPayload()
    const now = new Date().toISOString()

    const listeningBand = Number(result.listening?.band)
    const readingBand = Number(result.reading?.band)
    const writingBand = Number(writingReviewForm.overall)

    const overallInputs = [listeningBand, readingBand, writingBand].filter(
      value => !Number.isNaN(value) && value > 0
    )

    const finalOverall =
      overallInputs.length > 0
        ? roundToHalf(
            overallInputs.reduce((sum, value) => sum + value, 0) /
              overallInputs.length
          )
        : writingReviewForm.overall

    await updateDoc(
      doc(db, 'mockSubmissions', submission.id),
      {
        reviewedAt: now,
        reviewedBy: user.uid,
        writingReview: {
          status: 'reviewed',
          ...review
        },
        result: {
          ...result,
          writing: {
            ...(result.writing || {}),
            status: 'reviewed',
            band: writingReviewForm.overall,
            task1Band: writingReviewForm.task1Band,
            task2Band: writingReviewForm.task2Band,
            review
          },
          finalOverall,
          overallEstimate: finalOverall,
          overall: finalOverall
        }
      }
    )

    const mockScorePayload = {
      uid: submission.uid,
      date: (submission.submittedAt || now).slice(0, 10),
      source: 'mock_test',
      mockTestId: submission.mockTestId || '',
      listening: !Number.isNaN(listeningBand) && listeningBand > 0
        ? roundToHalf(listeningBand)
        : result.listening?.band || '',
      reading: !Number.isNaN(readingBand) && readingBand > 0
        ? roundToHalf(readingBand)
        : result.reading?.band || '',
      writing: writingReviewForm.overall,
      speaking: '',
      overall: finalOverall,
      updatedAt: now,
      updatedBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : submission.teacherId || '',
      schoolId: profile?.schoolId || DEFAULT_SCHOOL_ID
    }

    const scoreSnap = await getDocs(
      query(
        collection(db, 'scores'),
        where('uid', '==', submission.uid)
      )
    )

    const matchingScoreDocs = scoreSnap.docs.filter(scoreDoc => {
      const scoreData = scoreDoc.data()

      return (
        scoreData.mockTestId === submission.mockTestId ||
        scoreData.mockId === submission.mockTestId
      )
    })

    if (matchingScoreDocs.length > 0) {
      for (const scoreDoc of matchingScoreDocs) {
        await updateDoc(doc(db, 'scores', scoreDoc.id), mockScorePayload)
      }
    } else {
      await addDoc(collection(db, 'scores'), {
        ...mockScorePayload,
        createdAt: now
      })
    }

    setSelectedMockWritingReview(null)
    resetWritingReviewForm()
  }


  const getMockSubmittedCount = mockTest => {
    return mockSubmissions.filter(submission => submission.mockTestId === mockTest.id).length
  }

  const getMockAssignedCount = mockTest => {
    return mockTest.assignTo?.length || 0
  }

  const renderMockTestCard = (mockTest, archived = false, index = null) => (
    <div
      key={mockTest.id}
      className={`border rounded-xl p-4 flex items-center justify-between gap-4 ${
        archived
          ? 'border-gray-100 bg-gray-50 opacity-80'
          : 'border-gray-100 bg-gray-50'
      }`}
    >
      <div>
        <p className="text-sm font-medium text-gray-800">
          {index !== null ? `${index + 1}. ` : ''}{mockTest.title || 'Untitled Mock Test'}
        </p>

        <div className="flex gap-2 mt-2 mb-1 flex-wrap">
          <span className="text-[11px] bg-green-50 text-green-600 px-2.5 py-1 rounded-full">
            {getContentTypeLabel(getLibraryContentType(mockTest, 'full_mock'))}
          </span>
          <span className="text-[11px] bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">
            {getLibraryVisibilityLabel(mockTest)}
          </span>
        </div>

        <p className="text-xs text-gray-400 mt-0.5">
          Assigned to {getMockAssignedCount(mockTest)} students · Submitted by {getMockSubmittedCount(mockTest)} students
        </p>

        <p className="text-xs text-gray-400 mt-1">
          Listening + Reading + Writing full mock flow
        </p>

        {archived && (
          <p className="text-xs text-amber-600 mt-1 font-medium">
            Archived — hidden from students
          </p>
        )}
      </div>

      <div className="flex gap-2 flex-wrap justify-end">
        {!archived && (
          <button
            onClick={() => openAssignmentManager(mockTest, 'mock')}
            className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
          >
            Manage
          </button>
        )}

        {isOwnedByCurrentTeacher(mockTest) && (
          <>
            {archived ? (
              <button
                onClick={() => restoreMockTest(mockTest)}
                className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
              >
                Restore
              </button>
            ) : (
              <button
                onClick={() => archiveMockTest(mockTest)}
                className="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-xl hover:bg-amber-100"
              >
                Archive
              </button>
            )}

            <button
              onClick={() => deleteMockTest(mockTest)}
              className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )

  const renderReadingHomeworkCard = (reading, archived = false, index = null) => (
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
          {index !== null ? `${index + 1}. ` : ''}{reading.title}
        </p>

        <div className="flex gap-2 mt-2 mb-1 flex-wrap">
          <span className="text-[11px] bg-purple-50 text-purple-600 px-2.5 py-1 rounded-full">
            {getContentTypeLabel(getLibraryContentType(reading, 'full_reading'))}
          </span>
          <span className="text-[11px] bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">
            {getLibraryVisibilityLabel(reading)}
          </span>
        </div>

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
            {isOwnedByCurrentTeacher(reading) && (
            <button
              onClick={() => navigate(`/edit-reading/${reading.id}`)}
              className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-100"
            >
              Edit
            </button>
            )}

            <button
              onClick={() => duplicateReadingHomework(reading)}
              className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
            >
              Duplicate
            </button>

            <button
              onClick={() => openAssignmentManager(reading, 'reading')}
              className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
            >
              Manage
            </button>
          </>
        )}

        {isOwnedByCurrentTeacher(reading) && (
          <>
            {archived ? (
              <button
                onClick={() => restoreReadingHomework(reading)}
                className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
              >
                Restore
              </button>
            ) : (
              <button
                onClick={() => archiveReadingHomework(reading)}
                className="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-xl hover:bg-amber-100"
              >
                Archive
              </button>
            )}

            <button
              onClick={() => deleteReadingHomework(reading)}
              className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )

  const renderWritingHomeworkCard = (writing, archived = false, index = null) => {
    const submitted = getWritingSubmittedCount(writing.id)
    const reviewed = getWritingReviewedCount(writing.id)

    return (
      <div
        key={writing.id}
        className={`border rounded-xl p-4 flex items-center justify-between gap-4 ${
          archived
            ? 'border-gray-100 bg-gray-50 opacity-80'
            : 'border-gray-100 bg-gray-50'
        }`}
      >
        <div>
          <p className="text-sm font-medium text-gray-800">
            {index !== null ? `${index + 1}. ` : ''}{writing.title}
          </p>

          <div className="flex gap-2 mt-2 mb-1 flex-wrap">
            <span className="text-[11px] bg-purple-50 text-purple-600 px-2.5 py-1 rounded-full">
              {getContentTypeLabel(getLibraryContentType(writing, 'full_writing'))}
            </span>
            <span className="text-[11px] bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">
              {getLibraryVisibilityLabel(writing)}
            </span>
          </div>

          <p className="text-xs text-gray-400 mt-0.5">
            Assigned to {writing.assignTo?.length || 0} students · Submitted by{' '}
            {submitted} students · Reviewed {reviewed}/{submitted} ·{' '}
            {writing.timeLimit || 60} min
          </p>

          {submitted > reviewed && (
            <p className="text-xs text-amber-600 mt-1 font-medium">
              {submitted - reviewed} pending teacher review
            </p>
          )}

          {archived && (
            <p className="text-xs text-amber-600 mt-1 font-medium">
              Archived — hidden from students
            </p>
          )}
        </div>

        <div className="flex gap-2 flex-wrap justify-end">
          {!archived && (
            <>
              {isOwnedByCurrentTeacher(writing) && (
              <button
                onClick={() => navigate(`/edit-writing/${writing.id}`)}
                className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-100"
              >
                Edit
                </button>
            )}

              <button
                onClick={() => duplicateWritingHomework(writing)}
                className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
              >
                Duplicate
              </button>

              <button
                onClick={() => openAssignmentManager(writing, 'writing')}
                className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
              >
                Manage
              </button>
            </>
          )}

          {isOwnedByCurrentTeacher(writing) && (
            <>
              {archived ? (
                <button
                  onClick={() => restoreWritingHomework(writing)}
                  className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
                >
                  Restore
                </button>
              ) : (
                <button
                  onClick={() => archiveWritingHomework(writing)}
                  className="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-xl hover:bg-amber-100"
                >
                  Archive
                </button>
              )}

              <button
                onClick={() => deleteWritingHomework(writing)}
                className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const renderListeningHomeworkCard = (listening, archived = false, index = null) => (
    <div
      key={listening.id}
      className={`border rounded-xl p-4 flex items-center justify-between gap-4 ${
        archived
          ? 'border-gray-100 bg-gray-50 opacity-80'
          : 'border-gray-100 bg-gray-50'
      }`}
    >
      <div>
        <p className="text-sm font-medium text-gray-800">
          {index !== null ? `${index + 1}. ` : ''}{listening.title}
        </p>

        <div className="flex gap-2 mt-2 mb-1 flex-wrap">
          <span className="text-[11px] bg-purple-50 text-purple-600 px-2.5 py-1 rounded-full">
            {getContentTypeLabel(getLibraryContentType(listening, 'full_listening'))}
          </span>
          <span className="text-[11px] bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">
            {getLibraryVisibilityLabel(listening)}
          </span>
        </div>

        <p className="text-xs text-gray-400 mt-0.5">
          Assigned to {listening.assignTo?.length || 0} students · Completed by{' '}
          {getListeningCompletedCount(listening.id)} students · {listening.timeLimit || 30} min
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
            {isOwnedByCurrentTeacher(listening) && (
            <button
              onClick={() => navigate(`/edit-listening/${listening.id}`)}
              className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-100"
            >
              Edit
            </button>
            )}

            <button
              onClick={() => duplicateListeningHomework(listening)}
              className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
            >
              Duplicate
            </button>

            <button
              onClick={() => openAssignmentManager(listening, 'listening')}
              className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
            >
              Manage
            </button>
          </>
        )}

        {isOwnedByCurrentTeacher(listening) && (
          <>
            {archived ? (
              <button
                onClick={() => restoreListeningHomework(listening)}
                className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
              >
                Restore
              </button>
            ) : (
              <button
                onClick={() => archiveListeningHomework(listening)}
                className="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-xl hover:bg-amber-100"
              >
                Archive
              </button>
            )}

            <button
              onClick={() => deleteListeningHomework(listening)}
              className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )


  const renderVocabularyHomeworkCard = (vocabularyTest, archived = false, index = null) => (
    <div
      key={vocabularyTest.id}
      className={`border rounded-xl p-4 flex items-center justify-between gap-4 ${
        archived
          ? 'border-gray-100 bg-gray-50 opacity-80'
          : 'border-gray-100 bg-gray-50'
      }`}
    >
      <div>
        <p className="text-sm font-medium text-gray-800">
          {index !== null ? `${index + 1}. ` : ''}{vocabularyTest.title}
        </p>

        <div className="flex gap-2 mt-2 mb-1 flex-wrap">
          <span className="text-[11px] bg-purple-50 text-purple-600 px-2.5 py-1 rounded-full">
            {getContentTypeLabel(getLibraryContentType(vocabularyTest, 'vocabulary_quiz'))}
          </span>
          <span className="text-[11px] bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">
            {getLibraryVisibilityLabel(vocabularyTest)}
          </span>
        </div>

        <p className="text-xs text-gray-400 mt-0.5">
          Assigned to {vocabularyTest.assignTo?.length || 0} students · Completed by{' '}
          {getVocabularyCompletedCount(vocabularyTest.id)} students · {vocabularyTest.timeLimit || 20} min · {vocabularyTest.questions?.length || 0} questions
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
            {isOwnedByCurrentTeacher(vocabularyTest) && (
            <button
              onClick={() => navigate(`/edit-vocabulary/${vocabularyTest.id}`)}
              className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-xl hover:bg-blue-100"
            >
              Edit
            </button>
            )}

            <button
              onClick={() => duplicateVocabularyTest(vocabularyTest)}
              className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
            >
              Duplicate
            </button>

            <button
              onClick={() => openAssignmentManager(vocabularyTest, 'vocabulary')}
              className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
            >
              Manage
            </button>
          </>
        )}

        {isOwnedByCurrentTeacher(vocabularyTest) && (
          <>
            {archived ? (
              <button
                onClick={() => restoreVocabularyTest(vocabularyTest)}
                className="text-xs bg-green-50 text-green-600 px-3 py-2 rounded-xl hover:bg-green-100"
              >
                Restore
              </button>
            ) : (
              <button
                onClick={() => archiveVocabularyTest(vocabularyTest)}
                className="text-xs bg-amber-50 text-amber-600 px-3 py-2 rounded-xl hover:bg-amber-100"
              >
                Archive
              </button>
            )}

            <button
              onClick={() => deleteVocabularyTest(vocabularyTest)}
              className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )


  const averageReadingEstimatedBand = getAverageReadingEstimatedBand()
  const readingCompletionStats = getReadingCompletionStats()
  const mostMissedReadingQuestions = getMostMissedReadingQuestions()
  const atRiskReadingStudents = getAtRiskReadingStudents()
  const readingTypeAnalytics = getReadingTypeAnalytics()
  const selectedAnalyticsStudent = analyticsStudentId === 'all'
    ? null
    : getStudentByAnyId(analyticsStudentId)

  const selectedAnalyticsReadingSubmissions = selectedAnalyticsStudent
    ? getStudentReadingSubmissions(selectedAnalyticsStudent.id)
    : []
  const selectedAnalyticsReadingStats = selectedAnalyticsStudent
    ? getReadingCompletionStatsForStudent(selectedAnalyticsStudent.id)
    : null
  const selectedAnalyticsAverageReadingBand = selectedAnalyticsStudent
    ? getAverageReadingEstimatedBandFromSubmissions(selectedAnalyticsReadingSubmissions)
    : null
  const selectedAnalyticsReadingTypeAnalytics = selectedAnalyticsStudent
    ? getReadingTypeAnalyticsForSubmissions(selectedAnalyticsReadingSubmissions)
    : []
  const selectedAnalyticsMostMissedReadingQuestions = selectedAnalyticsStudent
    ? getMostMissedReadingQuestionsForSubmissions(selectedAnalyticsReadingSubmissions)
    : []
  const selectedAnalyticsWeakestReadingArea = selectedAnalyticsReadingTypeAnalytics
    .filter(item => item.percentage !== null && item.percentage !== undefined)
    .sort((a, b) => a.percentage - b.percentage)[0]

  const selectedAnalyticsListeningSubmissions = selectedAnalyticsStudent
    ? getStudentListeningSubmissions(selectedAnalyticsStudent.id)
    : []
  const selectedAnalyticsListeningStats = selectedAnalyticsStudent
    ? getListeningCompletionStatsForStudent(selectedAnalyticsStudent.id)
    : null
  const selectedAnalyticsAverageListeningBand = selectedAnalyticsStudent
    ? getAverageListeningBandFromSubmissions(selectedAnalyticsListeningSubmissions)
    : null
  const selectedAnalyticsListeningTypeAnalytics = selectedAnalyticsStudent
    ? getListeningTypeAnalyticsForSubmissions(selectedAnalyticsListeningSubmissions)
    : []
  const selectedAnalyticsMostMissedListeningQuestions = selectedAnalyticsStudent
    ? getMostMissedListeningQuestionsForSubmissions(selectedAnalyticsListeningSubmissions)
    : []
  const selectedAnalyticsWeakestListeningArea = selectedAnalyticsListeningTypeAnalytics
    .filter(item => item.percentage !== null && item.percentage !== undefined)
    .sort((a, b) => a.percentage - b.percentage)[0]

  const selectedAnalyticsVocabularySubmissions = selectedAnalyticsStudent
    ? getStudentVocabularySubmissions(selectedAnalyticsStudent.id)
    : []
  const selectedAnalyticsVocabularyStats = selectedAnalyticsStudent
    ? getVocabularyCompletionStatsForStudent(selectedAnalyticsStudent.id)
    : null
  const selectedAnalyticsAverageVocabularyAccuracy = selectedAnalyticsStudent
    ? getAverageVocabularyAccuracyFromSubmissions(selectedAnalyticsVocabularySubmissions)
    : null
  const selectedAnalyticsVocabularyPerformance = selectedAnalyticsStudent
    ? getVocabularyTestPerformanceForSubmissions(selectedAnalyticsVocabularySubmissions)
    : []
  const selectedAnalyticsMostMissedVocabularyQuestions = selectedAnalyticsStudent
    ? getMostMissedVocabularyQuestionsForSubmissions(selectedAnalyticsVocabularySubmissions)
    : []

  const averageListeningBand = getAverageListeningBand()
  const listeningCompletionStats = getListeningCompletionStats()
  const mostMissedListeningQuestions = getMostMissedListeningQuestions()
  const atRiskListeningStudents = getAtRiskListeningStudents()
  const listeningTypeAnalytics = getListeningTypeAnalytics()

  const teacherTabs = [
    ['overview', 'Overview'],
    ['students', 'Students'],
    ['reading', 'Reading'],
    ['listening', 'Listening'],
    ['vocabulary', 'Vocabulary'],
    ['writing', 'Writing'],
    ['mock', 'Mock Tests'],
    ['analytics', 'Analytics'],
    ['reviews', 'Reviews']
  ]

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
          Manage students, scores and reusable homework
        </p>

        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate('/create-reading')}
            className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-700"
          >
            📖 Create Reading Homework
          </button>

          <button
            onClick={() => navigate('/create-writing')}
            className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-700"
          >
            ✍️ Create Writing Homework
          </button>

          <button
            onClick={() => navigate('/create-listening')}
            className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-700"
          >
            🎧 Create Listening Homework
          </button>

          <button
            onClick={() => navigate('/create-vocabulary')}
            className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-700"
          >
            🧩 Create Vocabulary Test
          </button>

          <button
            onClick={() => navigate('/create-mock')}
            className="bg-green-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-green-700"
          >
            🧪 Create Mock Test
          </button>

          <button
            onClick={() => navigate('/teacher/classes')}
            className="bg-white border border-purple-200 text-purple-600 px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-50"
          >
            🏫 Manage Classes
          </button>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-2 mb-8 flex gap-2 overflow-x-auto">
          {teacherTabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`whitespace-nowrap px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                activeTab === key
                  ? 'bg-purple-600 text-white'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

{activeTab === 'overview' && (
          <>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-gray-900 text-white rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Pending Essays
            </p>

            <p className="text-3xl font-bold">
              {totalPendingWritingReviews}
            </p>

            <p className="text-xs text-gray-400 mt-2">
              Need teacher grading
            </p>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Reviewed Writing
            </p>

            <p className="text-3xl font-bold text-green-600">
              {reviewedWritingCount}
            </p>

            <p className="text-xs text-gray-400 mt-2">
              Total reviewed submissions
            </p>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Total Writing Submissions
            </p>

            <p className="text-3xl font-bold text-purple-600">
              {submittedWritingCount}
            </p>

            <p className="text-xs text-gray-400 mt-2">
              Submitted Task 1 + Task 2 sets
            </p>
          </div>
        </div>

        

          </>
        )}

        {activeTab === 'analytics' && (
          <>
            <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    👤 Student Analytics
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Select one student to see Reading, Listening and Vocabulary analytics separately.
                  </p>
                </div>

                <select
                  value={analyticsStudentId}
                  onChange={e => setAnalyticsStudentId(e.target.value)}
                  className="border border-gray-200 rounded-xl px-3 py-2 text-xs bg-white text-gray-600 outline-none focus:border-purple-400 min-w-[260px]"
                >
                  <option value="all">Select student</option>
                  {students.map(student => (
                    <option key={student.id} value={student.id}>
                      {student.name || student.email}
                    </option>
                  ))}
                </select>
              </div>

              {!selectedAnalyticsStudent ? (
                <div className="bg-gray-50 border border-gray-100 rounded-xl p-5 text-sm text-gray-400">
                  Choose a student from the list to view individual Reading, Listening and Vocabulary analytics.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-gray-900 text-white rounded-2xl p-5">
                      <p className="text-xs text-gray-400 mb-1">
                        Student
                      </p>

                      <p className="text-lg font-bold truncate">
                        {selectedAnalyticsStudent.name || selectedAnalyticsStudent.email}
                      </p>

                      <p className="text-xs text-gray-400 mt-2 truncate">
                        {selectedAnalyticsStudent.email}
                      </p>
                    </div>

                    <div className="bg-blue-50 rounded-2xl p-5">
                      <p className="text-xs text-gray-500 mb-1">
                        Reading
                      </p>

                      <p className="text-3xl font-bold text-blue-600">
                        {selectedAnalyticsReadingStats?.rate || 0}%
                      </p>

                      <p className="text-xs text-gray-500 mt-2">
                        {selectedAnalyticsReadingStats?.completed || 0}/{selectedAnalyticsReadingStats?.assigned || 0} completed · Avg Band {selectedAnalyticsAverageReadingBand || '--'}
                      </p>
                    </div>

                    <div className="bg-purple-50 rounded-2xl p-5">
                      <p className="text-xs text-gray-500 mb-1">
                        Listening
                      </p>

                      <p className="text-3xl font-bold text-purple-600">
                        {selectedAnalyticsListeningStats?.rate || 0}%
                      </p>

                      <p className="text-xs text-gray-500 mt-2">
                        {selectedAnalyticsListeningStats?.completed || 0}/{selectedAnalyticsListeningStats?.assigned || 0} completed · Avg Band {selectedAnalyticsAverageListeningBand || '--'}
                      </p>
                    </div>

                    <div className="bg-green-50 rounded-2xl p-5">
                      <p className="text-xs text-gray-500 mb-1">
                        Vocabulary
                      </p>

                      <p className="text-3xl font-bold text-green-600">
                        {selectedAnalyticsVocabularyStats?.rate || 0}%
                      </p>

                      <p className="text-xs text-gray-500 mt-2">
                        {selectedAnalyticsVocabularyStats?.completed || 0}/{selectedAnalyticsVocabularyStats?.assigned || 0} completed · Avg Accuracy {selectedAnalyticsAverageVocabularyAccuracy ?? '--'}%
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                    <div className="bg-gray-50 rounded-2xl p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-700">
                            📖 Reading Analytics
                          </h3>
                          <p className="text-xs text-gray-400 mt-1">
                            Weakest area: {selectedAnalyticsWeakestReadingArea ? getReadingTypeLabel(selectedAnalyticsWeakestReadingArea.key) : '--'}
                          </p>
                        </div>
                        <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                          {selectedAnalyticsReadingSubmissions.length} submissions
                        </span>
                      </div>

                      {selectedAnalyticsReadingTypeAnalytics.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-white rounded-xl p-4">
                          No completed reading homework yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3 mb-5">
                          {selectedAnalyticsReadingTypeAnalytics.map(item => (
                            <div key={item.key}>
                              <div className="flex justify-between mb-1">
                                <p className="text-xs text-gray-500">
                                  {getReadingTypeLabel(item.key)}
                                </p>
                                <p className={`text-xs font-semibold ${getAnalyticsColor(item.percentage)}`}>
                                  {item.percentage === null ? '--' : `${item.percentage}%`}
                                </p>
                              </div>
                              <div className="w-full bg-white rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-blue-600 h-2 rounded-full"
                                  style={{ width: `${item.percentage || 0}%` }}
                                />
                              </div>
                              <p className="text-[10px] text-gray-400 mt-1">
                                {item.correct}/{item.total} correct
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      <h4 className="text-xs font-semibold text-gray-500 mb-2">
                        Most Missed Reading Questions
                      </h4>
                      {selectedAnalyticsMostMissedReadingQuestions.length === 0 ? (
                        <p className="text-xs text-gray-400 bg-white rounded-xl p-3">
                          No missed-question data yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {selectedAnalyticsMostMissedReadingQuestions.map(item => (
                            <div key={item.label} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.label}
                                </p>
                                <p className="text-[10px] text-gray-400">
                                  {item.wrong}/{item.total} wrong
                                </p>
                              </div>
                              <span className="text-xs bg-red-50 text-red-600 px-2 py-1 rounded-full font-semibold">
                                {item.wrongRate}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="bg-gray-50 rounded-2xl p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-700">
                            🎧 Listening Analytics
                          </h3>
                          <p className="text-xs text-gray-400 mt-1">
                            Weakest area: {selectedAnalyticsWeakestListeningArea ? getListeningTypeLabel(selectedAnalyticsWeakestListeningArea.key) : '--'}
                          </p>
                        </div>
                        <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                          {selectedAnalyticsListeningSubmissions.length} submissions
                        </span>
                      </div>

                      {selectedAnalyticsListeningTypeAnalytics.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-white rounded-xl p-4">
                          No completed listening homework yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3 mb-5">
                          {selectedAnalyticsListeningTypeAnalytics.map(item => (
                            <div key={item.key}>
                              <div className="flex justify-between mb-1">
                                <p className="text-xs text-gray-500">
                                  {getListeningTypeLabel(item.key)}
                                </p>
                                <p className={`text-xs font-semibold ${getAnalyticsColor(item.percentage)}`}>
                                  {item.percentage === null ? '--' : `${item.percentage}%`}
                                </p>
                              </div>
                              <div className="w-full bg-white rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-purple-600 h-2 rounded-full"
                                  style={{ width: `${item.percentage || 0}%` }}
                                />
                              </div>
                              <p className="text-[10px] text-gray-400 mt-1">
                                {item.correct}/{item.total} correct
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      <h4 className="text-xs font-semibold text-gray-500 mb-2">
                        Most Missed Listening Questions
                      </h4>
                      {selectedAnalyticsMostMissedListeningQuestions.length === 0 ? (
                        <p className="text-xs text-gray-400 bg-white rounded-xl p-3">
                          No missed-question data yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {selectedAnalyticsMostMissedListeningQuestions.map(item => (
                            <div key={item.label} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.label}
                                </p>
                                <p className="text-[10px] text-gray-400">
                                  {item.wrong}/{item.total} wrong
                                </p>
                              </div>
                              <span className="text-xs bg-red-50 text-red-600 px-2 py-1 rounded-full font-semibold">
                                {item.wrongRate}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="bg-gray-50 rounded-2xl p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-700">
                            🧩 Vocabulary Analytics
                          </h3>
                          <p className="text-xs text-gray-400 mt-1">
                            Average accuracy: {selectedAnalyticsAverageVocabularyAccuracy ?? '--'}%
                          </p>
                        </div>
                        <span className="text-xs bg-green-50 text-green-600 px-3 py-1 rounded-full">
                          {selectedAnalyticsVocabularySubmissions.length} submissions
                        </span>
                      </div>

                      {selectedAnalyticsVocabularyPerformance.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-white rounded-xl p-4">
                          No completed vocabulary test yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2 mb-5">
                          {selectedAnalyticsVocabularyPerformance.map(item => (
                            <div key={item.id} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.title}
                                </p>
                                <p className="text-[10px] text-gray-400">
                                  {item.correct}/{item.total} correct · {formatDateShort(item.submittedAt)}
                                </p>
                              </div>
                              <span className={`text-xs px-2 py-1 rounded-full font-semibold ${item.percentage >= 70 ? 'bg-green-100 text-green-700' : item.percentage >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                {item.percentage ?? '--'}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      <h4 className="text-xs font-semibold text-gray-500 mb-2">
                        Most Missed Vocabulary Questions
                      </h4>
                      {selectedAnalyticsMostMissedVocabularyQuestions.length === 0 ? (
                        <p className="text-xs text-gray-400 bg-white rounded-xl p-3">
                          No missed vocabulary questions yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {selectedAnalyticsMostMissedVocabularyQuestions.map(item => (
                            <div key={item.label} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.label}
                                </p>
                                <p className="text-[10px] text-gray-400 truncate">
                                  {item.question || `${item.wrong}/${item.total} wrong`}
                                </p>
                              </div>
                              <span className="text-xs bg-red-50 text-red-600 px-2 py-1 rounded-full font-semibold">
                                {item.wrongRate}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {activeTab === 'reviews' && (
          <>
<div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Pending Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Essays submitted by students but not graded yet. Click Grade Now to open the review screen directly.
              </p>
            </div>

            <span className={`text-xs px-3 py-1.5 rounded-full ${
              pendingWritingReviews.length > 0
                ? 'bg-amber-50 text-amber-600'
                : 'bg-green-50 text-green-600'
            }`}>
              {pendingWritingReviews.length > 0
                ? `${pendingWritingReviews.length} pending`
                : 'All caught up'}
            </span>
          </div>

          {pendingWritingReviews.length === 0 ? (
            <div className="bg-green-50 text-green-700 rounded-xl p-4 text-sm">
              ✅ No pending writing reviews right now.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {pendingWritingReviews.slice(0, 6).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-amber-100 bg-amber-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.writing.title} · Submitted {formatDateShort(item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      {getWritingSubmissionWordSummary(item.writing, item.submission)}
                    </p>
                  </div>

                  <button
                    onClick={() => openWritingReview(item)}
                    className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                  >
                    Grade Now
                  </button>
                </div>
              ))}

              {pendingWritingReviews.length > 6 && (
                <p className="text-xs text-gray-400 text-center pt-2">
                  Showing latest 6 pending reviews. Use the Pending Review filter in Writing Homework Library for the full list.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Pending Mock Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Writing sections submitted inside full mock tests.
              </p>
            </div>

            <span className={`text-xs px-3 py-1.5 rounded-full ${
              pendingMockWritingReviews.length > 0
                ? 'bg-amber-50 text-amber-600'
                : 'bg-green-50 text-green-600'
            }`}>
              {pendingMockWritingReviews.length > 0
                ? `${pendingMockWritingReviews.length} pending`
                : 'All caught up'}
            </span>
          </div>

          {pendingMockWritingReviews.length === 0 ? (
            <div className="bg-green-50 text-green-700 rounded-xl p-4 text-sm">
              ✅ No pending mock writing reviews right now.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {pendingMockWritingReviews.slice(0, 8).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-purple-100 bg-purple-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.mock?.title || item.submission.mockTitle || 'Mock Test'} · Submitted {formatDateShort(item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      Task 1: {getMockTask1WordCount(item.submission) || 0} words · Task 2: {getMockTask2WordCount(item.submission) || 0} words
                    </p>
                  </div>

                  <button
                    onClick={() => openMockWritingReview(item)}
                    className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                  >
                    Grade Mock
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Reviewed Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Previously graded writing homework. Click Edit Review to update scores, rubric or feedback.
              </p>
            </div>

            <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
              {reviewedWritingReviews.length} reviewed
            </span>
          </div>

          {reviewedWritingReviews.length === 0 ? (
            <div className="bg-gray-50 text-gray-500 rounded-xl p-4 text-sm">
              No reviewed writing homework yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {reviewedWritingReviews.slice(0, 10).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-green-100 bg-green-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.writing.title} · Reviewed {formatDateShort(item.submission.reviewedAt || item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      {getWritingTaskLabel(item.writing, item.submission)} · Overall Band {item.submission.review?.overall || '-'}
                    </p>
                  </div>

                  <button
                    onClick={() => openWritingReview(item)}
                    className="text-xs bg-green-600 text-white px-4 py-2 rounded-xl hover:bg-green-700"
                  >
                    Edit Review
                  </button>
                </div>
              ))}

              {reviewedWritingReviews.length > 10 && (
                <p className="text-xs text-gray-400 text-center pt-2">
                  Showing latest 10 reviewed writing homework submissions.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Reviewed Mock Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Previously graded mock writing sections. Click Edit Mock Review to update the writing band and final mock overall.
              </p>
            </div>

            <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
              {reviewedMockWritingReviews.length} reviewed
            </span>
          </div>

          {reviewedMockWritingReviews.length === 0 ? (
            <div className="bg-gray-50 text-gray-500 rounded-xl p-4 text-sm">
              No reviewed mock writing yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {reviewedMockWritingReviews.slice(0, 10).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-purple-100 bg-purple-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.mock?.title || item.submission.mockTitle || 'Mock Test'} · Reviewed {formatDateShort(item.submission.reviewedAt || item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      Writing Band {item.submission.result?.writing?.band || item.submission.writingReview?.overall || '-'} · Overall {item.submission.result?.overall || item.submission.result?.overallEstimate || '-'}
                    </p>
                  </div>

                  <button
                    onClick={() => openMockWritingReview(item)}
                    className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                  >
                    Edit Mock Review
                  </button>
                </div>
              ))}

              {reviewedMockWritingReviews.length > 10 && (
                <p className="text-xs text-gray-400 text-center pt-2">
                  Showing latest 10 reviewed mock writing submissions.
                </p>
              )}
            </div>
          )}
        </div>


          </>
        )}

        {activeTab === 'reading' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Reading Homework Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Reuse, duplicate, assign, unassign, archive or delete reading homework.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeReadings.length})`],
                ['archived', `Archived (${archivedReadings.length})`],
                ['all', `All (${readings.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setReadingLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    readingLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={readingVisibilityFilter}
              onChange={e => setReadingVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={readingContentTypeFilter}
              onChange={e => setReadingContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Reading Types</option>
              <option value="full_reading">Full Reading</option>
              <option value="short_reading">Short Reading</option>
              <option value="mini_reading">Mini Reading</option>
              <option value="passage_practice">Passage Practice</option>
              <option value="reading_skill">Skill Practice</option>
            </select>
          </div>

          {filteredReadings.length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No reading homework found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredReadings.map((reading, index) =>
                renderReadingHomeworkCard(reading, reading.archived, index)
              )}
            </div>
          )}
        </div>


          </>
        )}

        {activeTab === 'listening' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Listening Homework Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Reuse, duplicate, assign, unassign, archive or delete listening homework.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeListenings.length})`],
                ['archived', `Archived (${archivedListenings.length})`],
                ['all', `All (${listenings.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setListeningLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    listeningLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={listeningVisibilityFilter}
              onChange={e => setListeningVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={listeningContentTypeFilter}
              onChange={e => setListeningContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Listening Types</option>
              <option value="full_listening">Full Listening</option>
              <option value="part_1">Part 1</option>
              <option value="part_2">Part 2</option>
              <option value="part_3">Part 3</option>
              <option value="part_4">Part 4</option>
              <option value="mini_listening">Mini Listening</option>
              <option value="short_listening">Short Practice</option>
              <option value="listening_skill">Skill Practice</option>
            </select>
          </div>

          {filteredListenings.length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No listening homework found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredListenings.map((listening, index) =>
                renderListeningHomeworkCard(listening, listening.archived, index)
              )}
            </div>
          )}
        </div>

          </>
        )}

        {activeTab === 'vocabulary' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Vocabulary Test Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Create, reuse, assign, archive or delete multiple choice vocabulary tests.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeVocabularyTests.length})`],
                ['archived', `Archived (${archivedVocabularyTests.length})`],
                ['all', `All (${vocabularyTests.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setVocabularyLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    vocabularyLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={vocabularyVisibilityFilter}
              onChange={e => setVocabularyVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={vocabularyContentTypeFilter}
              onChange={e => setVocabularyContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Vocabulary Types</option>
              <option value="vocabulary_quiz">Vocabulary Quiz</option>
              <option value="word_set">Word Set</option>
              <option value="mixed_practice">Mixed Practice</option>
              <option value="topic_vocabulary">Topic Vocabulary</option>
              <option value="academic_vocabulary">Academic Vocabulary</option>
            </select>
          </div>

          {filteredVocabularyTests.length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No vocabulary tests found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredVocabularyTests.map((vocabularyTest, index) =>
                renderVocabularyHomeworkCard(vocabularyTest, vocabularyTest.archived, index)
              )}
            </div>
          )}
        </div>

          </>
        )}

        {activeTab === 'writing' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Writing Homework Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Review Task 1 and Task 2 submissions, manage assignments and archive writing homework.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeWritings.length})`],
                ['pending', `Pending Review (${pendingReviewWritings.length})`],
                ['archived', `Archived (${archivedWritings.length})`],
                ['all', `All (${writings.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setWritingLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    writingLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={writingVisibilityFilter}
              onChange={e => setWritingVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={writingContentTypeFilter}
              onChange={e => setWritingContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Writing Types</option>
              <option value="full_writing">Full Writing</option>
              <option value="task1_only">Task 1 Only</option>
              <option value="task2_only">Task 2 Only</option>
            </select>
          </div>

          {filteredWritings.length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No writing homework found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredWritings.map((writing, index) =>
                renderWritingHomeworkCard(writing, writing.archived, index)
              )}
            </div>
          )}
        </div>


          </>
        )}

        {activeTab === 'mock' && (
          <>
            <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Mock Test Library
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Manage full mock tests and monitor student submissions.
                  </p>
                </div>

                <select
                  value={mockVisibilityFilter}
                  onChange={e => setMockVisibilityFilter(e.target.value)}
                  className={librarySelectClass}
                >
                  <option value="all">All Libraries</option>
                  <option value="private">My Library</option>
                  <option value="school">School Library</option>
                </select>

                <select
                  value={mockContentTypeFilter}
                  onChange={e => setMockContentTypeFilter(e.target.value)}
                  className={librarySelectClass}
                >
                  <option value="all">All Mock Types</option>
                  <option value="full_mock">Full Mock</option>
                  <option value="reading_mock">Reading Mock</option>
                  <option value="listening_mock">Listening Mock</option>
                  <option value="writing_mock">Writing Mock</option>
                </select>

                <button
                  onClick={() => navigate('/create-mock')}
                  className="text-xs bg-green-600 text-white px-4 py-2 rounded-xl hover:bg-green-700"
                >
                  + Create Mock Test
                </button>
              </div>

              {filteredActiveMockTests.length === 0 ? (
                <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                  No active mock tests found yet.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {filteredActiveMockTests.map((mockTest, index) => renderMockTestCard(mockTest, false, index))}
                </div>
              )}

              {filteredArchivedMockTests.length > 0 && (
                <div className="mt-8">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">
                    Archived Mock Tests
                  </h3>

                  <div className="flex flex-col gap-3">
                    {filteredArchivedMockTests.map((mockTest, index) => renderMockTestCard(mockTest, true, index))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'students' && (
          <>
        <div className="grid grid-cols-1 gap-4">
          {students.length === 0 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">
              No students signed up yet.
            </div>
          )}

          {students.map(student => {
            const studentReadings = getStudentReadings(student.id)
            const studentWritings = getStudentWritings(student.id)
            const studentListenings = getStudentListenings(student.id)
            const studentVocabularyTests = getStudentVocabularyTests(student.id)
            const analytics = getStudentAnalytics(student.id)

            const completedReadingCount = studentReadings.filter(reading =>
              getSubmission(student.id, reading.id)
            ).length

            const completedWritingCount = studentWritings.filter(writing =>
              getWritingSubmission(student.id, writing.id)
            ).length

            const completedListeningCount = studentListenings.filter(listening =>
              getListeningSubmission(student.id, listening.id)
            ).length

            const completedVocabularyCount = studentVocabularyTests.filter(vocabularyTest =>
              getVocabularySubmission(student.id, vocabularyTest.id)
            ).length

            return (
              <div
                key={student.id}
                className="bg-white border border-gray-100 rounded-2xl overflow-hidden"
              >
                <div
                  className="flex items-center justify-between p-5 cursor-pointer hover:bg-gray-50"
                  onClick={() => {
                    const isOpen = selected?.id === student.id
                    setSelected(isOpen ? null : student)
                    setSelectedStudentSection('mock')
                  }}
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
                    {latestMockSubmission(student.id) && (
                      <div className="text-right">
                        <p className="text-xs text-gray-400">Latest mock</p>
                        <p className="text-lg font-bold text-purple-600">
                          {formatBand(getMockOverall(latestMockSubmission(student.id)))}
                        </p>
                      </div>
                    )}

                    <div className="text-right">
                      <p className="text-xs text-gray-400">Reading done</p>
                      <p className="text-sm font-semibold text-gray-700">
                        {completedReadingCount}/{studentReadings.length}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs text-gray-400">Listening done</p>
                      <p className="text-sm font-semibold text-gray-700">
                        {completedListeningCount}/{studentListenings.length}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs text-gray-400">Vocabulary done</p>
                      <p className="text-sm font-semibold text-gray-700">
                        {completedVocabularyCount}/{studentVocabularyTests.length}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs text-gray-400">Writing done</p>
                      <p className="text-sm font-semibold text-gray-700">
                        {completedWritingCount}/{studentWritings.length}
                      </p>
                    </div>

                    <div className="text-gray-300 text-lg">
                      {selected?.id === student.id ? '▲' : '▼'}
                    </div>
                  </div>
                </div>

                {selected?.id === student.id && (
                  <div className="border-t border-gray-100 p-5">
                    <div className="flex flex-wrap gap-2 mb-6">
                      {[
                        ['mock', '🧠 Mock History'],
                        ['homework', '📚 Homework'],
                        ['reviews', '✍ Writing Reviews']
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelectedStudentSection(key)}
                          className={`text-xs px-4 py-2 rounded-xl font-medium ${
                            selectedStudentSection === key
                              ? 'bg-purple-600 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {selectedStudentSection === 'mock' && (
                      <>
                        <div className="mb-8">
                          <div className="flex items-center justify-between mb-3 gap-3">
                            <div>
                              <h3 className="text-sm font-semibold text-gray-700">
                                Mock History for {student.name}
                              </h3>
                              <p className="text-xs text-gray-400 mt-1">
                                Full mock results are listed here. Manual IELTS score logging was removed.
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={() => handlePrint(student)}
                              disabled={getStudentMockSubmissions(student.id).length === 0}
                              className="text-xs bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 px-3 py-1.5 rounded-lg"
                            >
                              🖨️ Print report
                            </button>
                          </div>

                          {getStudentMockSubmissions(student.id).length === 0 ? (
                            <div className="bg-gray-50 border border-gray-100 rounded-xl p-5 text-sm text-gray-400">
                              No completed mock test yet.
                            </div>
                          ) : (
                            <div className="flex flex-col gap-3">
                              {getStudentMockSubmissions(student.id).map(submission => {
                                const result = submission.result || {}
                                const overall = getMockOverall(submission)

                                return (
                                  <div
                                    key={submission.id}
                                    className="border border-gray-100 bg-gray-50 rounded-xl p-4"
                                  >
                                    <div className="flex items-start justify-between gap-4 mb-3">
                                      <div>
                                        <p className="text-sm font-semibold text-gray-800">
                                          {getMockTitle(submission)}
                                        </p>

                                        <p className="text-xs text-gray-400 mt-0.5">
                                          Submitted {formatDateShort(submission.submittedAt)}
                                        </p>
                                      </div>

                                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full font-semibold">
                                        Overall {formatBand(overall)}
                                      </span>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Listening</p>
                                        <p className="text-lg font-bold text-purple-600">
                                          {formatBand(result.listening?.band)}
                                        </p>
                                        <p className="text-[10px] text-gray-400 mt-1">
                                          {result.listening?.correct ?? '-'}/{result.listening?.total ?? '-'} correct
                                        </p>
                                      </div>

                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Reading</p>
                                        <p className="text-lg font-bold text-blue-600">
                                          {formatBand(result.reading?.band)}
                                        </p>
                                        <p className="text-[10px] text-gray-400 mt-1">
                                          {result.reading?.correct ?? '-'}/{result.reading?.total ?? '-'} correct
                                        </p>
                                      </div>

                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Writing</p>
                                        <p className="text-sm font-bold text-amber-700">
                                          {getMockWritingStatusLabel(submission)}
                                        </p>
                                      </div>

                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Status</p>
                                        <p className="text-sm font-semibold text-gray-700">
                                          {getMockWritingStatus(submission) === 'reviewed' ? 'Reviewed' : 'Waiting for writing review'}
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {selectedStudentSection === 'homework' && (
                      <>
                    {analytics.weakest && (
                      <div className="mb-8">
                        <h3 className="text-sm font-semibold text-gray-700 mb-3">
                          Reading Weakness Analytics
                        </h3>

                        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                          {[
                            ['Matching', analytics.matching],
                            ['Sentence Endings', analytics.sentenceEndings],
                            ['TFNG', analytics.tfng],
                            ['Fill Blank', analytics.fitb],
                            ['Table Completion', analytics.table],
                            ['Legacy Note Completion', analytics.note],
                            ['Reading Note/Summary Completion', analytics.noteCompletion],
                            ['MCQ', analytics.mcq]
                          ]
                            .filter(([, value]) => value !== null && value !== undefined)
                            .map(([label, value]) => (
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

                    <div className="mb-8">
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

                                      <button
                                        onClick={() => removeHomeworkFromStudent(reading, 'reading', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(reading, 'reading', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    <div className="mb-8">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Listening homework results
                      </h3>

                      {studentListenings.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active listening homework assigned to this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentListenings.map(listening => {
                            const submission = getListeningSubmission(
                              student.id,
                              listening.id
                            )

                            return (
                              <div
                                key={listening.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {listening.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {listening.questions?.length || 0} question sets · {listening.timeLimit || 30} min
                                    </p>

                                    {submission && (
                                      <p className="text-xs text-green-600 mt-1 font-medium">
                                        Submitted {formatDateShort(submission.submittedAt)}
                                      </p>
                                    )}
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Band
                                        </p>

                                        <p className="text-lg font-bold text-purple-600">
                                          {submission.result?.band || '-'}
                                        </p>
                                      </div>

                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Score
                                        </p>

                                        <p className="text-sm font-semibold text-gray-700">
                                          {submission.result?.correct ?? 0}/
                                          {submission.result?.total ?? 0}
                                        </p>
                                      </div>

                                      <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                                        Completed
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(listening, 'listening', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(listening, 'listening', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    <div className="mb-8">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Vocabulary test results
                      </h3>

                      {studentVocabularyTests.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active vocabulary test assigned to this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentVocabularyTests.map(vocabularyTest => {
                            const submission = getVocabularySubmission(
                              student.id,
                              vocabularyTest.id
                            )

                            return (
                              <div
                                key={vocabularyTest.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {vocabularyTest.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {vocabularyTest.questions?.length || 0} questions · {vocabularyTest.timeLimit || 20} min
                                    </p>

                                    {submission && (
                                      <p className="text-xs text-green-600 mt-1 font-medium">
                                        Submitted {formatDateShort(submission.submittedAt)}
                                      </p>
                                    )}
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Score
                                        </p>

                                        <p className="text-sm font-semibold text-gray-700">
                                          {submission.result?.correct || 0}/
                                          {submission.result?.total || 0}
                                        </p>
                                      </div>

                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Accuracy
                                        </p>

                                        <p className="text-lg font-bold text-purple-600">
                                          {submission.result?.percentage ?? 0}%
                                        </p>
                                      </div>

                                      <button
                                        onClick={() =>
                                          setSelectedVocabularyReview({
                                            student,
                                            vocabularyTest,
                                            submission
                                          })
                                        }
                                        className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                                      >
                                        Review
                                      </button>

                                      <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                                        Completed
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(vocabularyTest, 'vocabulary', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(vocabularyTest, 'vocabulary', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                      </>
                    )}

                    {selectedStudentSection === 'reviews' && (
                      <>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Writing homework results
                      </h3>

                      {studentWritings.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active writing homework assigned to this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentWritings.map(writing => {
                            const submission = getWritingSubmission(
                              student.id,
                              writing.id
                            )

                            return (
                              <div
                                key={writing.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {writing.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {getWritingTaskLabel(writing, submission || {})} · {writing.timeLimit || 60} min
                                    </p>

                                    {submission && (
                                      <p
                                        className={`text-xs mt-1 font-medium ${
                                          submission.reviewed
                                            ? 'text-green-600'
                                            : 'text-amber-600'
                                        }`}
                                      >
                                        {submission.reviewed
                                          ? `Reviewed — Band ${submission.review?.overall}`
                                          : 'Submitted — Waiting for review'}
                                      </p>
                                    )}
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      {isWritingTask1Enabled(writing, submission) && (
                                        <div className="text-right">
                                          <p className="text-xs text-gray-400">
                                            Task 1
                                          </p>

                                          <p className="text-sm font-semibold text-gray-700">
                                            {submission.task1WordCount || 0} words
                                          </p>
                                        </div>
                                      )}

                                      {isWritingTask2Enabled(writing, submission) && (
                                        <div className="text-right">
                                          <p className="text-xs text-gray-400">
                                            Task 2
                                          </p>

                                          <p className="text-sm font-semibold text-gray-700">
                                            {submission.task2WordCount || 0} words
                                          </p>
                                        </div>
                                      )}

                                      <button
                                        onClick={() =>
                                          openWritingReview({
                                            student,
                                            writing,
                                            submission
                                          })
                                        }
                                        className={`text-xs px-3 py-2 rounded-xl text-white ${
                                          submission.reviewed
                                            ? 'bg-green-600 hover:bg-green-700'
                                            : 'bg-purple-600 hover:bg-purple-700'
                                        }`}
                                      >
                                        {submission.reviewed ? 'Edit Review' : 'Grade'}
                                      </button>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(writing, 'writing', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(writing, 'writing', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

          </>
        )}

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
                  setSelectedHomeworkType(null)
                  setAssignmentDraft([])
                }}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            {classes.length > 0 && (
              <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-6">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="text-sm font-semibold text-purple-800">
                      Assign by Class
                    </p>

                    <p className="text-xs text-purple-500 mt-1">
                      Add or remove all students from a class for this homework.
                    </p>
                  </div>

                  <span className="text-xs bg-white text-purple-600 px-3 py-1 rounded-full">
                    {assignmentDraft.length} selected
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {classes.map(classItem => {
                    const classStudentIds = classItem.studentIds || []
                    const fullyAssigned = isClassFullyAssignedToDraft(classItem)
                    const partlyAssigned = isClassPartlyAssignedToDraft(classItem)

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
                                {classStudentIds.slice(0, 3).map(getStudentName).join(', ')}
                                {classStudentIds.length > 3
                                  ? ` +${classStudentIds.length - 3} more`
                                  : ''}
                              </p>
                            )}
                          </div>

                          {fullyAssigned ? (
                            <button
                              type="button"
                              onClick={() => removeClassFromHomework(classItem)}
                              className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-100 flex-shrink-0"
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => assignClassToHomework(classItem)}
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

            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Individual Students
              </p>

              {assignmentDraft.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignmentDraft([])}
                  className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-lg hover:bg-gray-200"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="flex flex-col gap-3 mb-6">
              {students.map(student => {
                const completed =
                  selectedHomeworkType === 'reading'
                    ? getSubmission(student.id, selectedHomework.id)
                    : selectedHomeworkType === 'listening'
                      ? getListeningSubmission(student.id, selectedHomework.id)
                      : selectedHomeworkType === 'mock'
                        ? mockSubmissions.find(
                            submission =>
                              submissionBelongsToStudent(submission, student) &&
                              submission.mockTestId === selectedHomework.id
                          )
                        : selectedHomeworkType === 'vocabulary'
                          ? getVocabularySubmission(student.id, selectedHomework.id)
                          : getWritingSubmission(student.id, selectedHomework.id)

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
                            : question.type === 'sentenceEndings'
                              ? 'Sentence Endings'
                              : question.type === 'tfng'
                              ? 'T/F/NG'
                              : question.type === 'fitb'
                                ? 'Fill blank'
                                : (question.type === 'table' || question.type === 'summary' || question.type === 'note')
                                  ? question.type === 'note' ? 'Note Completion' : 'Table Completion'
                                  : question.mode === 'multi'
                                    ? 'MCQ — Choose TWO'
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
                      ) : question.type === 'sentenceEndings' ? (
                        <div>
                          {question.instruction && (
                            <p className="text-sm text-gray-700 mb-4">
                              {question.instruction}
                            </p>
                          )}

                          <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-4">
                            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                              Endings
                            </p>

                            <div className="space-y-1">
                              {question.endings?.filter(Boolean).map((ending, endingIndex) => (
                                <p key={endingIndex} className="text-sm text-gray-700">
                                  <span className="font-semibold">
                                    {letters[endingIndex]}.
                                  </span>{' '}
                                  {ending}
                                </p>
                              ))}
                            </div>
                          </div>

                          <div className="flex flex-col gap-3">
                            {question.items?.map(item => {
                              const correct = isSentenceEndingCorrect(
                                selectedReview.submission,
                                question,
                                item
                              )

                              const userAnswer =
                                selectedReview.submission.answers?.[
                                  question.id
                                ]?.[item.id]

                              const correctAnswer = item.answer

                              return (
                                <div
                                  key={item.id}
                                  className={`rounded-xl p-3 border ${
                                    correct
                                      ? 'bg-green-50 border-green-100'
                                      : 'bg-red-50 border-red-100'
                                  }`}
                                >
                                  <div className="flex justify-between mb-2">
                                    <p className="text-sm font-semibold text-gray-800">
                                      {item.sentence}
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
                                      ? `${userAnswer}. ${getSentenceEndingText(
                                          question,
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
                                        {getSentenceEndingText(
                                          question,
                                          correctAnswer
                                        )}
                                      </p>
                                    </>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : question.type === 'noteCompletion' ? (
                        <div>
                          {question.instruction && (
                            <p className="text-sm text-gray-700 mb-4">
                              {question.instruction}
                            </p>
                          )}

                          <div className="space-y-4">
                            {question.paragraphs?.map(paragraph => (
                              <div key={paragraph.id} className="bg-gray-50 border border-gray-100 rounded-xl p-4">
                                <div className="text-sm text-gray-800 leading-8">
                                  {paragraph.parts?.map(part => {
                                    if (part.type === 'text') {
                                      return (
                                        <span key={part.id} className="whitespace-pre-wrap">
                                          {part.content}
                                        </span>
                                      )
                                    }

                                    const key = noteAnswerKey(question.id, paragraph.id, part.id)
                                    const correct = isNoteCompletionPartCorrect(
                                      selectedReview.submission,
                                      question,
                                      paragraph,
                                      part
                                    )

                                    return (
                                      <span
                                        key={part.id}
                                        className={`inline-flex items-center gap-2 mx-1 px-2 py-1 rounded-xl border ${
                                          correct
                                            ? 'bg-green-50 border-green-100'
                                            : 'bg-red-50 border-red-100'
                                        }`}
                                      >
                                        <span className="font-medium text-gray-800">
                                          {selectedReview.submission.answers?.[key] || 'No answer'}
                                        </span>

                                        {!correct && (
                                          <span className="text-xs font-semibold text-green-700">
                                            Correct: {[part.answer, part.acceptedAnswers].filter(Boolean).join(', ')}
                                          </span>
                                        )}
                                      </span>
                                    )
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : question.type === 'table' || question.type === 'summary' ? (
                        <div>
                          <p className="text-sm text-gray-700 mb-4">
                            {question.instruction}
                          </p>

                          <div className="overflow-x-auto">
                            <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                              <thead>
                                <tr className="bg-gray-100">
                                  {question.columns.map((column, columnIndex) => (
                                    <th
                                      key={columnIndex}
                                      className="p-3 text-left font-semibold text-gray-700 border border-white"
                                    >
                                      {column}
                                    </th>
                                  ))}
                                </tr>
                              </thead>

                              <tbody>
                                {question.rows.map(row => (
                                  <tr key={row.id}>
                                    {row.cells.map((cell, cellIndex) => {
                                      if (cell.type !== 'blank') {
                                        return (
                                          <td
                                            key={cellIndex}
                                            className="p-3 bg-gray-50 border border-white text-gray-700 whitespace-pre-wrap"
                                          >
                                            {cell.text}
                                          </td>
                                        )
                                      }

                                      const key = tableAnswerKey(
                                        question.id,
                                        row.id,
                                        cellIndex
                                      )

                                      const correct = isTableCellCorrect(
                                        selectedReview.submission,
                                        question,
                                        row,
                                        cellIndex
                                      )

                                      return (
                                        <td
                                          key={cellIndex}
                                          className={`p-3 border border-white ${
                                            correct
                                              ? 'bg-green-50'
                                              : 'bg-red-50'
                                          }`}
                                        >
                                          <p className="text-xs text-gray-500 mb-1">
                                            Student:
                                          </p>

                                          <p className="text-sm text-gray-800 mb-2">
                                            {selectedReview.submission.answers?.[
                                              key
                                            ] || 'No answer'}
                                          </p>

                                          {!correct && (
                                            <>
                                              <p className="text-xs text-gray-500 mb-1">
                                                Correct:
                                              </p>

                                              <p className="text-sm font-medium text-green-700">
                                                {[cell.answer, cell.acceptedAnswers].filter(Boolean).join(', ')}
                                              </p>
                                            </>
                                          )}
                                        </td>
                                      )
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
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
                              {getAnswerText(
                                question,
                                selectedReview.submission.answers?.[
                                  question.id
                                ]
                              )}
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
                                  {question.type === 'mcq' &&
                                  question.mode === 'multi'
                                    ? (question.answers || [])
                                        .map(
                                          letter =>
                                            `${letter}. ${getOptionText(
                                              question,
                                              letter
                                            )}`
                                        )
                                        .join(', ')
                                    : question.type === 'mcq'
                                      ? `${question.answer}. ${getOptionText(
                                          question,
                                          question.answer
                                        )}`
                                      : question.answer}
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

      {selectedVocabularyReview && (() => {
        const vocabularyTest = selectedVocabularyReview.vocabularyTest
        const submission = selectedVocabularyReview.submission
        const result = submission.result || {}

        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
            <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-6">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">
                    Vocabulary Review
                  </h2>

                  <p className="text-sm text-gray-400">
                    {selectedVocabularyReview.student.name} — {vocabularyTest.title}
                  </p>

                  <p className="text-sm text-purple-600 font-semibold mt-1">
                    {result.correct || 0}/{result.total || 0} correct · {result.percentage ?? 0}%
                  </p>
                </div>

                <button
                  onClick={() => setSelectedVocabularyReview(null)}
                  className="text-sm text-gray-400 hover:text-gray-600"
                >
                  Close
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <div className="bg-purple-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Score</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {result.correct || 0}/{result.total || 0}
                  </p>
                </div>

                <div className="bg-green-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Accuracy</p>
                  <p className="text-2xl font-bold text-green-600">
                    {result.percentage ?? 0}%
                  </p>
                </div>

                <div className="bg-amber-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Submitted</p>
                  <p className="text-sm font-bold text-amber-700">
                    {formatDateShort(submission.submittedAt)}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {vocabularyTest.questions?.map((question, index) => {
                  const selectedAnswer = submission.answers?.[question.id]
                  const correctAnswer = question.answer
                  const isCorrect = selectedAnswer === correctAnswer

                  return (
                    <div
                      key={question.id}
                      className={`border rounded-xl p-5 ${
                        isCorrect
                          ? 'bg-green-50 border-green-100'
                          : 'bg-red-50 border-red-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <p className="text-xs font-semibold text-gray-400">
                          Question {index + 1}
                        </p>

                        <span className={`text-xs font-semibold ${isCorrect ? 'text-green-600' : 'text-red-600'}`}>
                          {isCorrect ? 'Correct' : 'Wrong'}
                        </span>
                      </div>

                      <p className="text-sm font-medium text-gray-800 mb-4">
                        {question.question}
                      </p>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                        <div className="bg-white/70 rounded-xl p-4">
                          <p className="text-xs text-gray-500 mb-1">
                            Student answer
                          </p>

                          <p className="text-sm text-gray-800">
                            {selectedAnswer
                              ? `${selectedAnswer}. ${getOptionText(question, selectedAnswer)}`
                              : 'No answer'}
                          </p>
                        </div>

                        <div className="bg-white/70 rounded-xl p-4">
                          <p className="text-xs text-gray-500 mb-1">
                            Correct answer
                          </p>

                          <p className="text-sm font-medium text-green-700">
                            {correctAnswer
                              ? `${correctAnswer}. ${getOptionText(question, correctAnswer)}`
                              : 'No answer key'}
                          </p>
                        </div>
                      </div>

                      {Array.isArray(question.options) && question.options.length > 0 && (
                        <div className="bg-white/60 rounded-xl p-4">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                            Options
                          </p>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {question.options.map((option, optionIndex) => {
                              const letter = letters[optionIndex]

                              return (
                                <p
                                  key={optionIndex}
                                  className={`text-xs rounded-lg px-3 py-2 ${
                                    letter === correctAnswer
                                      ? 'bg-green-100 text-green-700 font-semibold'
                                      : letter === selectedAnswer && !isCorrect
                                        ? 'bg-red-100 text-red-700 font-semibold'
                                        : 'bg-gray-50 text-gray-600'
                                  }`}
                                >
                                  <span className="font-semibold">{letter}.</span> {option}
                                </p>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {(selectedWritingReview || selectedMockWritingReview) && (() => {
        const reviewTarget = selectedWritingReview || selectedMockWritingReview
        const isMockReview = Boolean(selectedMockWritingReview)
        const reviewTitle = isMockReview
          ? reviewTarget.mock?.title || reviewTarget.submission.mockTitle || 'Mock Test'
          : reviewTarget.writing.title

        const task1Prompt = isMockReview
          ? reviewTarget.mock?.writing?.task1?.prompt || reviewTarget.mock?.task1?.prompt || 'Mock Writing Task 1'
          : reviewTarget.writing.task1?.prompt

        const task1Image = isMockReview
          ? reviewTarget.mock?.writing?.task1?.image || reviewTarget.mock?.task1?.image
          : reviewTarget.writing.task1?.image

        const task2Prompt = isMockReview
          ? reviewTarget.mock?.writing?.task2?.prompt || reviewTarget.mock?.task2?.prompt || 'Mock Writing Task 2'
          : reviewTarget.writing.task2?.prompt

        const task1Answer = isMockReview
          ? getMockTask1Answer(reviewTarget.submission)
          : reviewTarget.submission.task1Answer

        const task2Answer = isMockReview
          ? getMockTask2Answer(reviewTarget.submission)
          : reviewTarget.submission.task2Answer

        const task1WordCount = isMockReview
          ? getMockTask1WordCount(reviewTarget.submission)
          : reviewTarget.submission.task1WordCount

        const task2WordCount = isMockReview
          ? getMockTask2WordCount(reviewTarget.submission)
          : reviewTarget.submission.task2WordCount

        const task1Enabled = isMockReview
          ? true
          : isWritingTask1Enabled(reviewTarget.writing, reviewTarget.submission)

        const task2Enabled = isMockReview
          ? true
          : isWritingTask2Enabled(reviewTarget.writing, reviewTarget.submission)

        const reviewTaskLabel = isMockReview
          ? 'Task 1 + Task 2'
          : getWritingTaskLabel(reviewTarget.writing, reviewTarget.submission)

        return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  {isMockReview ? 'Mock Writing Review' : 'Writing Review'}
                </h2>

                <p className="text-sm text-gray-400">
                  {reviewTarget.student.name} — {reviewTitle}
                </p>
              </div>

              <button
                onClick={() => {
                  setSelectedWritingReview(null)
                  setSelectedMockWritingReview(null)
                }}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-6">
                <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4">
                  <p className="text-xs text-purple-500 mb-1">Writing type</p>
                  <p className="text-sm font-semibold text-purple-800">
                    {reviewTaskLabel}
                  </p>
                </div>

                {task1Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-gray-800">
                        Task 1 Answer
                      </h3>

                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                        {task1WordCount || 0} words
                      </span>
                    </div>

                    <p className="text-xs text-gray-400 mb-3">
                      Prompt:
                    </p>

                    <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap mb-4 bg-gray-50 rounded-xl p-4">
                      {task1Prompt || 'No Task 1 prompt'}
                    </p>

                    {task1Image && (
                      <img
                        src={task1Image}
                        alt="Task 1"
                        className="w-full max-h-[320px] object-contain bg-gray-50 rounded-xl border border-gray-100 mb-4"
                      />
                    )}

                    <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap">
                      {task1Answer || 'No Task 1 answer'}
                    </p>
                  </div>
                )}

                {task2Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-gray-800">
                        Task 2 Answer
                      </h3>

                      <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                        {task2WordCount || 0} words
                      </span>
                    </div>

                    <p className="text-xs text-gray-400 mb-3">
                      Prompt:
                    </p>

                    <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap mb-4 bg-gray-50 rounded-xl p-4">
                      {task2Prompt || 'No Task 2 prompt'}
                    </p>

                    <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap">
                      {task2Answer || 'No Task 2 answer'}
                    </p>
                  </div>
                )}
              </div>

              <div className="border border-gray-100 rounded-2xl p-5 h-fit sticky top-5">
                <h3 className="font-semibold text-gray-800 mb-2">
                  Teacher Evaluation
                </h3>

                <p className="text-xs text-gray-400 mb-5">
                  Use IELTS Writing criteria. Suggested bands are calculated from the rubric, but you can still edit the final band manually.
                </p>

                <div className="bg-purple-50 rounded-2xl p-4 mb-5">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <p className="text-xs text-gray-500">
                        Suggested Overall
                      </p>

                      <p className="text-2xl font-bold text-purple-700">
                        {suggestedOverallBand || '--'}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={useSuggestedBands}
                      className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                    >
                      Use Suggested Bands
                    </button>
                  </div>

                  <div className={`grid gap-3 ${task1Enabled && task2Enabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {task1Enabled && (
                      <div className="bg-white rounded-xl p-3">
                        <p className="text-xs text-gray-400 mb-1">
                          Suggested Task 1
                        </p>

                        <p className="text-lg font-bold text-purple-600">
                          {suggestedTask1Band || '--'}
                        </p>
                      </div>
                    )}

                    {task2Enabled && (
                      <div className="bg-white rounded-xl p-3">
                        <p className="text-xs text-gray-400 mb-1">
                          Suggested Task 2
                        </p>

                        <p className="text-lg font-bold text-indigo-600">
                          {suggestedTask2Band || '--'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {task1Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-4 mb-5">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-semibold text-gray-800">
                        Task 1 Rubric
                      </h4>

                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                        Academic Task 1
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {[
                        ['task1TA', 'Task Achievement'],
                        ['task1CC', 'Coherence & Cohesion'],
                        ['task1LR', 'Lexical Resource'],
                        ['task1GRA', 'Grammar Range & Accuracy']
                      ].map(([key, label]) => (
                        <div key={key}>
                          <label className="text-xs text-gray-400 block mb-1">
                            {label}
                          </label>

                          <input
                            type="number"
                            min="0"
                            max="9"
                            step="0.5"
                            value={writingReviewForm[key]}
                            onChange={e =>
                              setWritingReviewForm(prev => ({
                                ...prev,
                                [key]: e.target.value
                              }))
                            }
                            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {task2Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-4 mb-5">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-semibold text-gray-800">
                        Task 2 Rubric
                      </h4>

                      <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                        Essay
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {[
                        ['task2TR', 'Task Response'],
                        ['task2CC', 'Coherence & Cohesion'],
                        ['task2LR', 'Lexical Resource'],
                        ['task2GRA', 'Grammar Range & Accuracy']
                      ].map(([key, label]) => (
                        <div key={key}>
                          <label className="text-xs text-gray-400 block mb-1">
                            {label}
                          </label>

                          <input
                            type="number"
                            min="0"
                            max="9"
                            step="0.5"
                            value={writingReviewForm[key]}
                            onChange={e =>
                              setWritingReviewForm(prev => ({
                                ...prev,
                                [key]: e.target.value
                              }))
                            }
                            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className={`grid gap-3 mb-5 ${task1Enabled && task2Enabled ? 'grid-cols-3' : 'grid-cols-2'}`}>
                  {task1Enabled && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">
                        Task 1 Band
                      </label>

                      <input
                        type="number"
                        min="0"
                        max="9"
                        step="0.5"
                        value={writingReviewForm.task1Band}
                        onChange={e =>
                          setWritingReviewForm(prev => ({
                            ...prev,
                            task1Band: e.target.value
                          }))
                        }
                        placeholder={suggestedTask1Band || ''}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                      />
                    </div>
                  )}

                  {task2Enabled && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">
                        Task 2 Band
                      </label>

                      <input
                        type="number"
                        min="0"
                        max="9"
                        step="0.5"
                        value={writingReviewForm.task2Band}
                        onChange={e =>
                          setWritingReviewForm(prev => ({
                            ...prev,
                            task2Band: e.target.value
                          }))
                        }
                        placeholder={suggestedTask2Band || ''}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                      />
                    </div>
                  )}

                  <div>
                    <label className="text-xs text-gray-400 block mb-1">
                      Overall
                    </label>

                    <input
                      type="number"
                      min="0"
                      max="9"
                      step="0.5"
                      value={writingReviewForm.overall}
                      onChange={e =>
                        setWritingReviewForm(prev => ({
                          ...prev,
                          overall: e.target.value
                        }))
                      }
                      placeholder={suggestedOverallBand || ''}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                    />
                  </div>
                </div>

                {task1Enabled && (
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 block mb-1">
                      Task 1 Feedback
                    </label>

                    <textarea
                      rows={4}
                      value={writingReviewForm.task1Feedback}
                      onChange={e =>
                        setWritingReviewForm(prev => ({
                          ...prev,
                          task1Feedback: e.target.value
                        }))
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none"
                      placeholder="Comment on Task 1..."
                    />
                  </div>
                )}

                {task2Enabled && (
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 block mb-1">
                      Task 2 Feedback
                    </label>

                    <textarea
                      rows={4}
                      value={writingReviewForm.task2Feedback}
                      onChange={e =>
                        setWritingReviewForm(prev => ({
                          ...prev,
                          task2Feedback: e.target.value
                        }))
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none"
                      placeholder="Comment on Task 2..."
                    />
                  </div>
                )}

                <div className="mb-5">
                  <label className="text-xs text-gray-400 block mb-1">
                    General Feedback
                  </label>

                  <textarea
                    rows={4}
                    value={writingReviewForm.generalFeedback}
                    onChange={e =>
                      setWritingReviewForm(prev => ({
                        ...prev,
                        generalFeedback: e.target.value
                      }))
                    }
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none"
                    placeholder="Overall writing feedback..."
                  />
                </div>

                <button
                  onClick={isMockReview ? saveMockWritingReview : saveWritingReview}
                  className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700"
                >
                  {isMockReview ? 'Save Mock Writing Review' : 'Save Writing Review'}
                </button>
              </div>
            </div>
          </div>
        </div>
        )
      })()}

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
