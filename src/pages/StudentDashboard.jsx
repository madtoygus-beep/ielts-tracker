  import { useState, useEffect, useMemo, useRef } from 'react'
  import { auth, db, storage, functions } from '../firebase'
  import { collection, query, where, onSnapshot, doc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore'
  import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
  import { ref as storageRef, getDownloadURL } from 'firebase/storage'
  import { useNavigate } from 'react-router-dom'
  import { httpsCallable } from 'firebase/functions'
  import { getStudentVisibleResultSnapshot, subscribeStudentVisibleResultSummaries } from '../services/studentResultService'

  const getStudentSubmissionAttemptStateCall = httpsCallable(
    functions,
    'getStudentSubmissionAttemptState'
  )
  const getStudentSubmissionAttemptHistoryCall = httpsCallable(functions, 'getStudentSubmissionAttemptHistory')
  const getStudentSubmissionAttemptReviewCall = httpsCallable(functions, 'getStudentSubmissionAttemptReview')

  function normalizeId(value) {
    return value === undefined || value === null
      ? ''
      : value.toString().trim().toLowerCase()
  }


  function submissionTimeMillis(submission) {
    const value = submission?.submittedAt || submission?.createdAt || submission?.date
    if (!value) return 0
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    if (value instanceof Date) return value.getTime()
    if (typeof value?.toMillis === 'function') return value.toMillis()
    if (typeof value?.toDate === 'function') return value.toDate().getTime()
    if (typeof value?.seconds === 'number') return value.seconds * 1000
    if (typeof value === 'number') return value
    return 0
  }

  function submissionAttemptNumber(submission) {
    const value = Number(submission?.attemptNumber)
    return Number.isInteger(value) && value >= 1 ? value : 1
  }

  function hasMeaningfulSubmissionValue(value) {
    if (value === undefined || value === null) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (typeof value === 'number' || typeof value === 'boolean') return true
    if (Array.isArray(value)) return value.some(hasMeaningfulSubmissionValue)
    if (typeof value === 'object') return Object.values(value).some(hasMeaningfulSubmissionValue)
    return false
  }

  function submissionHasMeaningfulAnswers(submission) {
    return submission?.hasMeaningfulAnswers === true ||
      hasMeaningfulSubmissionValue(submission?.answers) ||
      hasMeaningfulSubmissionValue(submission?.task1Answer) ||
      hasMeaningfulSubmissionValue(submission?.task2Answer) ||
      hasMeaningfulSubmissionValue(submission?.listeningAnswers) ||
      hasMeaningfulSubmissionValue(submission?.readingAnswers) ||
      hasMeaningfulSubmissionValue(submission?.writingAnswers)
  }

  function chooseCurrentSubmission(records, preferredSubmissionId = '') {
    const cleanRecords = (records || []).filter(Boolean)
    if (cleanRecords.length === 0) return null

    if (preferredSubmissionId) {
      const preferred = cleanRecords.find(record => record.id === preferredSubmissionId)
      if (preferred) return preferred
    }

    return [...cleanRecords].sort((a, b) => {
      const attemptDifference = submissionAttemptNumber(b) - submissionAttemptNumber(a)
      if (attemptDifference !== 0) return attemptDifference

      const aMeaningful = submissionHasMeaningfulAnswers(a)
      const bMeaningful = submissionHasMeaningfulAnswers(b)
      if (aMeaningful !== bMeaningful) return aMeaningful ? -1 : 1

      const timeDifference = submissionTimeMillis(b) - submissionTimeMillis(a)
      if (timeDifference !== 0) return timeDifference

      if ((a?.autoSubmitted === true) !== (b?.autoSubmitted === true)) {
        return a?.autoSubmitted === true ? 1 : -1
      }

      return (a?.id || '').localeCompare(b?.id || '')
    })[0]
  }

  function dedupeSubmissionHeads(submissions, getContentId, attemptStates = {}) {
    const groups = new Map()

    ;(submissions || []).forEach(submission => {
      const rawContentId = getContentId(submission)
      const contentId = rawContentId === undefined || rawContentId === null
        ? ''
        : rawContentId.toString()
      if (!contentId) return

      if (!groups.has(contentId)) groups.set(contentId, [])
      groups.get(contentId).push(submission)
    })

    return Array.from(groups.entries())
      .map(([contentId, records]) =>
        chooseCurrentSubmission(records, attemptStates?.[contentId]?.currentSubmissionId || '')
      )
      .filter(Boolean)
      .sort((a, b) => submissionTimeMillis(b) - submissionTimeMillis(a))
  }

  const STUDENT_ACCESS_CONTENT_CONFIG = Object.freeze({
    studentReadings: {
      contentType: 'reading',
      accessSourceCollection: 'readings',
      contentCollection: 'studentReadings'
    },
    studentListenings: {
      contentType: 'listening',
      accessSourceCollection: 'listenings',
      contentCollection: 'studentListenings'
    },
    studentVocabularyTests: {
      contentType: 'vocabulary',
      accessSourceCollection: 'vocabularyTests',
      contentCollection: 'studentVocabularyTests'
    },
    writingHomeworks: {
      contentType: 'writing',
      accessSourceCollection: 'writingHomeworks',
      contentCollection: 'writingHomeworks'
    },
    mockTests: {
      contentType: 'mock',
      accessSourceCollection: 'mockTests',
      contentCollection: 'mockTests'
    }
  })

  const sharedStudentSnapshotRegistry = new Map()
  const sharedStudentAccessContentRegistry = new Map()
  const STUDENT_DATA_ERROR_EVENT = 'maxima-student-data-error'

  function emitStudentDataError(key, error = null) {
    if (typeof window === 'undefined') return

    window.dispatchEvent(
      new CustomEvent(STUDENT_DATA_ERROR_EVENT, {
        detail: {
          key,
          message: error?.message || ''
        }
      })
    )
  }

  function subscribeSharedSnapshot(key, firestoreQuery, onItems) {
    let entry = sharedStudentSnapshotRegistry.get(key)

    if (!entry) {
      entry = {
        subscribers: new Set(),
        lastItems: null,
        unsubscribe: null
      }

      entry.unsubscribe = onSnapshot(
        firestoreQuery,
        snap => {
          const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          entry.lastItems = items
          emitStudentDataError(key)

          entry.subscribers.forEach(subscriber => {
            subscriber(items)
          })
        },
        error => {
          console.warn(`Student dashboard query failed: ${key}`, error)
          emitStudentDataError(key, error)
        }
      )

      sharedStudentSnapshotRegistry.set(key, entry)
    }

    entry.subscribers.add(onItems)

    if (entry.lastItems !== null) {
      onItems(entry.lastItems)
    }

    return () => {
      const currentEntry = sharedStudentSnapshotRegistry.get(key)
      if (!currentEntry) return

      currentEntry.subscribers.delete(onItems)

      if (currentEntry.subscribers.size === 0) {
        currentEntry.unsubscribe?.()
        sharedStudentSnapshotRegistry.delete(key)
        emitStudentDataError(key)
      }
    }
  }

  function listenUserCollection(collectionName, uid, onItems, options = {}) {
    if (!uid) return () => {}

    return subscribeStudentVisibleResultSummaries(
      uid,
      collectionName,
      items => {
        emitStudentDataError(`uid:${collectionName}:${uid}`)
        // A reopened attempt can carry an archived submission snapshot.
        // Keep this distinction separate from teacher archiving the source test.
        // Q2A result visibility is checked against canonical studentAccess.
        let nextItems = options.includeArchived === true
          ? items
          : items.filter(item => item.archived !== true)

        if (typeof options.filter === 'function') {
          nextItems = nextItems.filter(options.filter)
        }

        if (typeof options.sort === 'function') {
          nextItems = [...nextItems].sort(options.sort)
        }

        onItems(nextItems)
      },
      error => {
        console.warn(`Student result service failed: ${collectionName}`, error)
        emitStudentDataError(`uid:${collectionName}:${uid}`, error)
      }
    )
  }

  function studentAccessTimestampKey(value) {
    if (!value) return ''

    if (typeof value.toMillis === 'function') {
      return value.toMillis().toString()
    }

    if (Number.isFinite(value.seconds)) {
      return `${value.seconds}:${value.nanoseconds || 0}`
    }

    return value.toString()
  }

  function listenStudentAccessCollection(collectionName, user, profile, onItems, options = {}) {
    if (!user?.uid) {
      onItems([])
      return () => {}
    }

    const config = STUDENT_ACCESS_CONTENT_CONFIG[collectionName]

    if (!config) {
      console.warn(`Unknown studentAccess collection mapping: ${collectionName}`)
      onItems([])
      return () => {}
    }

    const uid = user.uid
    const schoolId = profile?.schoolId?.toString().trim() || 'maxima'
    const registryKey = `access-content:${uid}:${schoolId}:${config.contentType}:${collectionName}`

    let entry = sharedStudentAccessContentRegistry.get(registryKey)

    if (!entry) {
      entry = {
        subscribers: new Set(),
        lastItems: null,
        lastAccessSignature: null,
        loadVersion: 0,
        unsubscribe: null
      }

      const accessQuery = query(
        collection(db, 'studentAccess'),
        where('uid', '==', uid),
        where('schoolId', '==', schoolId)
      )

      entry.unsubscribe = subscribeSharedSnapshot(
        `studentAccess:${uid}:${schoolId}`,
        accessQuery,
        accessItems => {
          const matchingAccess = accessItems
            .filter(access =>
              access.accessType === 'assignment' &&
              access.status === 'active' &&
              access.contentType === config.contentType &&
              access.sourceCollection === config.accessSourceCollection &&
              Boolean(access.contentId)
            )
            .sort((a, b) => a.id.localeCompare(b.id))

          const accessSignature = matchingAccess
            .map(access =>
              `${access.id}:${studentAccessTimestampKey(access.updatedAt)}`
            )
            .join('|')

          if (
            entry.lastItems !== null &&
            entry.lastAccessSignature === accessSignature
          ) {
            return
          }

          entry.lastAccessSignature = accessSignature
          const loadVersion = ++entry.loadVersion

          if (matchingAccess.length === 0) {
            entry.lastItems = []
            emitStudentDataError(registryKey)

            entry.subscribers.forEach(subscriber => {
              subscriber([])
            })

            return
          }

          Promise.all(
            matchingAccess.map(async access => {
              const contentSnap = await getDoc(
                doc(db, config.contentCollection, access.contentId)
              )

              if (!contentSnap.exists()) {
                console.warn(
                  `studentAccess points to missing ${config.contentCollection}/${access.contentId}`
                )
                return null
              }

              return {
                id: contentSnap.id,
                ...contentSnap.data(),
                studentAccess: {
                  id: access.id,
                  status: access.status,
                  assignedAt: access.assignedAt || null,
                  dueAt: access.dueAt || null,
                  reviewPolicy: access.reviewPolicy || 'immediate',
                  reviewReleaseAt: access.reviewReleaseAt || null
                }
              }
            })
          )
            .then(items => {
              if (entry.loadVersion !== loadVersion) return

              const loadedItems = items.filter(Boolean)
              entry.lastItems = loadedItems
              emitStudentDataError(registryKey)

              entry.subscribers.forEach(subscriber => {
                subscriber(loadedItems)
              })
            })
            .catch(error => {
              if (entry.loadVersion !== loadVersion) return

              console.warn(
                `Student dashboard content load failed: ${registryKey}`,
                error
              )
              emitStudentDataError(registryKey, error)
            })
        }
      )

      sharedStudentAccessContentRegistry.set(registryKey, entry)
    }

    const subscriber = items => {
      let nextItems = items.filter(item => item.archived !== true)

      if (typeof options.filter === 'function') {
        nextItems = nextItems.filter(options.filter)
      }

      if (typeof options.sort === 'function') {
        nextItems = [...nextItems].sort(options.sort)
      }

      onItems(nextItems)
    }

    entry.subscribers.add(subscriber)

    if (entry.lastItems !== null) {
      subscriber(entry.lastItems)
    }

    return () => {
      const currentEntry = sharedStudentAccessContentRegistry.get(registryKey)
      if (!currentEntry) return

      currentEntry.subscribers.delete(subscriber)

      if (currentEntry.subscribers.size === 0) {
        currentEntry.loadVersion++
        currentEntry.unsubscribe?.()
        sharedStudentAccessContentRegistry.delete(registryKey)
        emitStudentDataError(registryKey)
      }
    }
  }

  function getBandColor(value) {
    const band = Number(value)
    if (band >= 7) return 'text-green-600'
    if (band >= 6) return 'text-amber-600'
    return 'text-red-500'
  }

  function getBandBg(value) {
    const band = Number(value)
    if (band >= 7) return 'bg-green-50'
    if (band >= 6) return 'bg-amber-50'
    return 'bg-red-50'
  }

  function toNumber(value) {
    if (value === undefined || value === null) return null
    if (typeof value === 'string' && value.trim() === '') return null

    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function formatBand(value) {
    const number = toNumber(value)
    return number === null ? '-' : number.toFixed(1)
  }

  function getChangeLabel(current, previous) {
    const c = toNumber(current)
    const p = toNumber(previous)

    if (c === null || p === null) return null

    const diff = c - p

    if (diff === 0) return 'No change'

    return `${diff > 0 ? '+' : ''}${diff.toFixed(1)}`
  }

  function getChangeColor(current, previous) {
    const c = toNumber(current)
    const p = toNumber(previous)

    if (c === null || p === null) return 'text-gray-400'
    if (c > p) return 'text-green-600'
    if (c < p) return 'text-red-500'
    return 'text-gray-400'
  }

  function average(numbers) {
    const clean = numbers
      .map(toNumber)
      .filter(value => value !== null)

    if (clean.length === 0) return null

    return clean.reduce((sum, value) => sum + value, 0) / clean.length
  }

  function daysUntilDue(dateString) {
    if (!dateString) return null

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const due = new Date(dateString)
    due.setHours(0, 0, 0, 0)

    return Math.ceil((due - today) / (1000 * 60 * 60 * 24))
  }

  function dueLabel(homework) {
    if (!homework.dueDate) {
      return {
        text: 'No deadline',
        style: 'bg-gray-100 text-gray-500'
      }
    }

    const days = daysUntilDue(homework.dueDate)

    if (days < 0) {
      return {
        text: 'Overdue',
        style: 'bg-red-50 text-red-600'
      }
    }

    if (days <= 3) {
      return {
        text: `Due in ${days} day${days !== 1 ? 's' : ''}`,
        style: 'bg-amber-50 text-amber-600'
      }
    }

    return {
      text: `Due in ${days} days`,
      style: 'bg-blue-50 text-blue-600'
    }
  }

  function getAssignedSortTime(item) {
    const value =
      item?.assignedAt ||
      item?.publishedAt ||
      item?.updatedAt ||
      item?.createdAt ||
      item?.dueDate ||
      ''

    const time = new Date(value).getTime()

    return Number.isNaN(time) ? 0 : time
  }

  function sortByAssignedDateDesc(a, b) {
    return getAssignedSortTime(b) - getAssignedSortTime(a)
  }


  function useWritingAttemptStates(user, writings, submissions) {
    const [attemptStates, setAttemptStates] = useState({})
    const [attemptStatesLoading, setAttemptStatesLoading] = useState(false)

    useEffect(() => {
      let active = true
      let loadVersion = 0

      if (!user?.uid) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const submittedWritingIds = writings
        .filter(writing =>
          submissions.some(submission => submission.writingId === writing.id)
        )
        .map(writing => writing.id)
        .filter(Boolean)

      if (submittedWritingIds.length === 0) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const loadAttemptStates = async () => {
        const version = ++loadVersion
        setAttemptStatesLoading(true)

        const entries = await Promise.all(
          submittedWritingIds.map(async contentId => {
            try {
              const response = await getStudentSubmissionAttemptStateCall({
                contentType: 'writing',
                contentId
              })

              return [contentId, response?.data || { open: false }]
            } catch (error) {
              console.warn(
                `Could not load Writing attempt state for ${contentId}:`,
                error
              )

              return [contentId, { open: false }]
            }
          })
        )

        if (!active || version !== loadVersion) return

        setAttemptStates(Object.fromEntries(entries))
        setAttemptStatesLoading(false)
      }

      loadAttemptStates()

      const refreshOnFocus = () => {
        loadAttemptStates()
      }

      window.addEventListener('focus', refreshOnFocus)

      return () => {
        active = false
        loadVersion++
        window.removeEventListener('focus', refreshOnFocus)
      }
    }, [user?.uid, writings, submissions])

    return { attemptStates, attemptStatesLoading }
  }



  function useReadingAttemptStates(user, readings, submissions) {
    const [attemptStates, setAttemptStates] = useState({})
    const [attemptStatesLoading, setAttemptStatesLoading] = useState(false)

    useEffect(() => {
      let active = true
      let loadVersion = 0

      if (!user?.uid) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const submittedReadingIds = readings
        .filter(reading =>
          submissions.some(submission => submission.readingId === reading.id)
        )
        .map(reading => reading.id)
        .filter(Boolean)

      if (submittedReadingIds.length === 0) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const loadAttemptStates = async () => {
        const version = ++loadVersion
        setAttemptStatesLoading(true)

        const entries = await Promise.all(
          submittedReadingIds.map(async contentId => {
            try {
              const response = await getStudentSubmissionAttemptStateCall({
                contentType: 'reading',
                contentId
              })

              return [contentId, response?.data || { open: false }]
            } catch (error) {
              console.warn(
                `Could not load Reading attempt state for ${contentId}:`,
                error
              )

              return [contentId, { open: false }]
            }
          })
        )

        if (!active || version !== loadVersion) return

        setAttemptStates(Object.fromEntries(entries))
        setAttemptStatesLoading(false)
      }

      loadAttemptStates()

      const refreshOnFocus = () => {
        loadAttemptStates()
      }

      window.addEventListener('focus', refreshOnFocus)

      return () => {
        active = false
        loadVersion++
        window.removeEventListener('focus', refreshOnFocus)
      }
    }, [user?.uid, readings, submissions])

    return { attemptStates, attemptStatesLoading }
  }



  function useListeningAttemptStates(user, listenings, submissions) {
    const [attemptStates, setAttemptStates] = useState({})
    const [attemptStatesLoading, setAttemptStatesLoading] = useState(false)

    useEffect(() => {
      let active = true
      let loadVersion = 0

      if (!user?.uid) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const submittedListeningIds = listenings
        .filter(listening =>
          submissions.some(submission => submission.listeningId === listening.id)
        )
        .map(listening => listening.id)
        .filter(Boolean)

      if (submittedListeningIds.length === 0) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const loadAttemptStates = async () => {
        const version = ++loadVersion
        setAttemptStatesLoading(true)

        const entries = await Promise.all(
          submittedListeningIds.map(async contentId => {
            try {
              const response = await getStudentSubmissionAttemptStateCall({
                contentType: 'listening',
                contentId
              })

              return [contentId, response?.data || { open: false }]
            } catch (error) {
              console.warn(
                `Could not load Listening attempt state for ${contentId}:`,
                error
              )

              return [contentId, { open: false }]
            }
          })
        )

        if (!active || version !== loadVersion) return

        setAttemptStates(Object.fromEntries(entries))
        setAttemptStatesLoading(false)
      }

      loadAttemptStates()

      const refreshOnFocus = () => {
        loadAttemptStates()
      }

      window.addEventListener('focus', refreshOnFocus)

      return () => {
        active = false
        loadVersion++
        window.removeEventListener('focus', refreshOnFocus)
      }
    }, [user?.uid, listenings, submissions])

    return { attemptStates, attemptStatesLoading }
  }


  function useVocabularyAttemptStates(user, vocabularyTests, submissions) {
    const [attemptStates, setAttemptStates] = useState({})
    const [attemptStatesLoading, setAttemptStatesLoading] = useState(false)

    useEffect(() => {
      let active = true
      let loadVersion = 0

      if (!user?.uid) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const submissionMatches = (submission, contentId) =>
        [
          submission?.vocabularyTestId,
          submission?.vocabularyId,
          submission?.testId,
          submission?.homeworkId
        ]
          .map(normalizeId)
          .includes(normalizeId(contentId))

      const submittedVocabularyIds = vocabularyTests
        .filter(test =>
          submissions.some(submission => submissionMatches(submission, test.id))
        )
        .map(test => test.id)
        .filter(Boolean)

      if (submittedVocabularyIds.length === 0) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const loadAttemptStates = async () => {
        const version = ++loadVersion
        setAttemptStatesLoading(true)

        const entries = await Promise.all(
          submittedVocabularyIds.map(async contentId => {
            try {
              const response = await getStudentSubmissionAttemptStateCall({
                contentType: 'vocabulary',
                contentId
              })

              return [contentId, response?.data || { open: false }]
            } catch (error) {
              console.warn(
                `Could not load Vocabulary attempt state for ${contentId}:`,
                error
              )

              return [contentId, { open: false }]
            }
          })
        )

        if (!active || version !== loadVersion) return

        setAttemptStates(Object.fromEntries(entries))
        setAttemptStatesLoading(false)
      }

      loadAttemptStates()

      const refreshOnFocus = () => {
        loadAttemptStates()
      }

      window.addEventListener('focus', refreshOnFocus)

      return () => {
        active = false
        loadVersion++
        window.removeEventListener('focus', refreshOnFocus)
      }
    }, [user?.uid, vocabularyTests, submissions])

    return { attemptStates, attemptStatesLoading }
  }


  function useMockAttemptStates(user, mocks, submissions) {
    const [attemptStates, setAttemptStates] = useState({})
    const [attemptStatesLoading, setAttemptStatesLoading] = useState(false)

    useEffect(() => {
      let active = true
      let loadVersion = 0

      if (!user?.uid) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const submittedMockIds = mocks
        .filter(mock =>
          submissions.some(submission => submission.mockTestId === mock.id)
        )
        .map(mock => mock.id)
        .filter(Boolean)

      if (submittedMockIds.length === 0) {
        setAttemptStates({})
        setAttemptStatesLoading(false)
        return () => {
          active = false
        }
      }

      const loadAttemptStates = async () => {
        const version = ++loadVersion
        setAttemptStatesLoading(true)

        const entries = await Promise.all(
          submittedMockIds.map(async contentId => {
            try {
              const response = await getStudentSubmissionAttemptStateCall({
                contentType: 'mock',
                contentId
              })

              return [contentId, response?.data || { open: false }]
            } catch (error) {
              console.warn(
                `Could not load Mock attempt state for ${contentId}:`,
                error
              )

              return [contentId, { open: false }]
            }
          })
        )

        if (!active || version !== loadVersion) return

        setAttemptStates(Object.fromEntries(entries))
        setAttemptStatesLoading(false)
      }

      loadAttemptStates()

      const refreshOnFocus = () => {
        loadAttemptStates()
      }

      window.addEventListener('focus', refreshOnFocus)

      return () => {
        active = false
        loadVersion++
        window.removeEventListener('focus', refreshOnFocus)
      }
    }, [user?.uid, mocks, submissions])

    return { attemptStates, attemptStatesLoading }
  }


  function getStudentDisplayName(profile, user) {
    const rawName = profile?.name || profile?.fullName || user?.displayName || user?.email || 'Student'
    const cleanName = rawName.toString().trim()

    if (!cleanName) return 'Student'
    if (cleanName.includes('@')) return cleanName.split('@')[0]

    return cleanName
  }

  function getFirstName(profile, user) {
    return getStudentDisplayName(profile, user).split(' ')[0] || 'there'
  }


  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

  const numberWords = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
    twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
    seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
  }

  function normalizeAnswer(value) {
    if (value === undefined || value === null) return ''

    const clean = value
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:()]/g, '')
      .replace(/\s+/g, ' ')

    return numberWords[clean] || clean
  }

  function sortAnswers(value) {
    if (!Array.isArray(value)) return []
    return [...value].map(v => v?.toString().trim()).sort()
  }

  function tableAnswerKey(questionId, rowId, cellIndex) {
    return `${questionId}_${rowId}_${cellIndex}`
  }

  function noteAnswerKey(questionId, paragraphId, partId) {
    return `${questionId}_${paragraphId}_${partId}`
  }

  function listeningCompletionAnswerKey(questionId, sectionId, itemId) {
    return `${questionId}_${sectionId}_${itemId}`
  }

  function matchingAnswerKey(questionId, itemId) {
    return `${questionId}_${itemId}`
  }

  function parseAcceptedAnswers(cell) {
    const main = cell.answer ? [cell.answer] : []
    const alternatives = cell.acceptedAnswers
      ? cell.acceptedAnswers.split(',').map(item => item.trim()).filter(Boolean)
      : []

    return [...main, ...alternatives]
  }

  function getWordCount(value) {
    const clean = normalizeAnswer(value)
    if (!clean) return 0
    return clean.split(' ').filter(Boolean).length
  }

  function isWithinWordLimit(value, maxWords) {
    if (!maxWords) return true
    return getWordCount(value) <= Number(maxWords)
  }

  function isNormalCorrect(submission, question) {
    if (question.type === 'mcq' && question.mode === 'multi') {
      const userAnswer = sortAnswers(submission.answers?.[question.id]).join('|')
      const correctAnswer = sortAnswers(question.answers || []).join('|')

      return userAnswer === correctAnswer
    }

    const userAnswer = normalizeAnswer(submission.answers?.[question.id])
    const correctAnswer = normalizeAnswer(question.answer)

    return userAnswer === correctAnswer
  }

  function isMatchingCorrect(submission, question, paragraph) {
    const userAnswer = submission.answers?.[question.id]?.[paragraph.letter]
      ?.toString()
      .trim()

    const correctAnswer = paragraph.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  function isMatchingInformationCorrect(submission, question, item) {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  function isSentenceEndingCorrect(submission, question, item) {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  function isSummaryOptionCorrect(submission, question, item) {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  function isTableCellCorrect(submission, question, row, cellIndex) {
    const key = tableAnswerKey(question.id, row.id, cellIndex)
    const cell = row.cells[cellIndex]
    const userAnswer = normalizeAnswer(submission.answers?.[key])
    const acceptedAnswers = parseAcceptedAnswers(cell).map(normalizeAnswer)

    if (!isWithinWordLimit(submission.answers?.[key], cell.maxWords)) return false

    return acceptedAnswers.includes(userAnswer)
  }

  function isNoteCompletionPartCorrect(submission, question, paragraph, part) {
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
    ].map(normalizeAnswer)

    return acceptedAnswers.includes(normalizeAnswer(userAnswer))
  }

  function isListeningCompletionPartCorrect(submission, question, section, item) {
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
    ].map(normalizeAnswer)

    if (!isWithinWordLimit(userAnswer, item.maxWords)) return false

    return acceptedAnswers.includes(normalizeAnswer(userAnswer))
  }

  function isListeningMatchingItemCorrect(submission, question, item) {
    const key = matchingAnswerKey(question.id, item.id)
    const userAnswer = normalizeAnswer(submission.answers?.[key])
    const correctAnswer = normalizeAnswer(item.answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  function estimateHomeworkBand(correct, total) {
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

  function getQuestionTypeLabel(type) {
    if (type === 'matching') return 'Matching Headings'
    if (type === 'matchingInformation') return 'Matching Information'
    if (type === 'listeningMatching') return 'Listening Matching'
    if (type === 'sentenceEndings') return 'Sentence Endings'
    if (type === 'mcq') return 'MCQ'
    if (type === 'fitb') return 'Fill Blank'
    if (type === 'tfng') return 'T/F/NG'
    if (type === 'table') return 'Table Completion'
    if (type === 'summaryOptions') return 'Summary Completion with Options'
    if (type === 'summary') return 'Summary Completion'
    if (type === 'note') return 'Note Completion'
    if (type === 'noteCompletion') return 'Note Completion'
    if (type === 'listeningCompletion') return 'Listening Note/Summary Completion'
    if (type === 'map') return 'Map Labelling'
    if (type === 'shortAnswer') return 'Short Answer'
    if (type === 'mcq_multi') return 'Multiple Choice (Multiple Answers)'
    return type
  }

  function getAnalyticsColor(value) {
    if (value === null || value === undefined) return 'text-gray-400'
    if (value >= 75) return 'text-green-600'
    if (value >= 60) return 'text-amber-600'
    return 'text-red-500'
  }

  function getAnalyticsBg(value) {
    if (value === null || value === undefined) return 'bg-gray-100'
    if (value >= 75) return 'bg-green-600'
    if (value >= 60) return 'bg-amber-500'
    return 'bg-red-500'
  }

  function calculateSkillAnalytics(homeworks, submissions, idField, typeKeys, breakdownAliases = {}) {
    const stats = {}

    typeKeys.forEach(key => {
      stats[key] = {
        correct: 0,
        total: 0
      }
    })

    let totalCorrect = 0
    let totalQuestions = 0
    const storedBands = []

    submissions.filter(submission => submission.excludedFromStats !== true).forEach(submission => {
      const result = submission?.result || {}
      const storedCorrect = Number(result.correct)
      const storedTotal = Number(result.total)

      if (
        Number.isFinite(storedCorrect) &&
        Number.isFinite(storedTotal) &&
        storedTotal > 0
      ) {
        totalCorrect += storedCorrect
        totalQuestions += storedTotal
      }

      const bandValue = result.band ?? result.estimatedBand
      const band = toNumber(bandValue)

      if (band !== null && band > 0) {
        storedBands.push(band)
      }

      const breakdown = result.gradingBreakdown

      if (!breakdown || typeof breakdown !== 'object') return

      Object.entries(breakdown).forEach(([rawKey, value]) => {
        const key = breakdownAliases[rawKey] || rawKey
        const correct = Number(value?.correct)
        const total = Number(value?.total)

        if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) {
          return
        }

        if (!stats[key]) {
          stats[key] = { correct: 0, total: 0 }
        }

        stats[key].correct += correct
        stats[key].total += total
      })
    })

    const typeAnalytics = Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)

    const attemptedTypes = typeAnalytics.filter(item => item.total > 0)

    const weakest = attemptedTypes.length
      ? [...attemptedTypes].sort((a, b) => a.percentage - b.percentage)[0]
      : null

    const averageAccuracy = totalQuestions
      ? Math.round((totalCorrect / totalQuestions) * 100)
      : null

    const estimatedBand = storedBands.length
      ? Math.round(
          (storedBands.reduce((sum, value) => sum + value, 0) / storedBands.length) * 10
        ) / 10
      : estimateHomeworkBand(totalCorrect, totalQuestions)

    return {
      totalCorrect,
      totalQuestions,
      averageAccuracy,
      estimatedBand,
      typeAnalytics,
      weakest
    }
  }


  function getReviewDate(submission) {
    return (
      submission.reviewedAt ||
      submission.submittedAt ||
      submission.createdAt ||
      ''
    )
  }

  function getWritingMode(writing, submission) {
    return (
      submission?.writingMode ||
      submission?.contentType ||
      writing?.writingMode ||
      writing?.contentType ||
      'full_writing'
    )
  }

  function getWritingModeLabel(writing, submission) {
    const mode = getWritingMode(writing, submission)

    if (mode === 'task1_only') return 'Writing Task 1'
    if (mode === 'task2_only') return 'Writing Task 2'
    return 'Task 1 + Task 2'
  }

  function getWritingTaskVisibility(writing, submission) {
    const mode = getWritingMode(writing, submission)

    return {
      hasTask1: mode !== 'task2_only',
      hasTask2: mode !== 'task1_only'
    }
  }

  function getWritingTimeLimit(writing, submission) {
    const stored = Number(writing?.timeLimit)
    if (Number.isFinite(stored) && stored > 0) return stored

    const mode = getWritingMode(writing, submission)
    if (mode === 'task1_only') return 20
    if (mode === 'task2_only') return 40
    return 60
  }

  function getRubricAverages(review) {
    const task1 = review?.rubric?.task1 || {}
    const task2 = review?.rubric?.task2 || {}

    return {
      taskResponse: average([
        task1.taskAchievement,
        task2.taskResponse
      ]),
      coherenceCohesion: average([
        task1.coherenceCohesion,
        task2.coherenceCohesion
      ]),
      lexicalResource: average([
        task1.lexicalResource,
        task2.lexicalResource
      ]),
      grammarRangeAccuracy: average([
        task1.grammarRangeAccuracy,
        task2.grammarRangeAccuracy
      ])
    }
  }

  function getCriterionLabel(key) {
    if (key === 'taskResponse') return 'TR / TA'
    if (key === 'coherenceCohesion') return 'CC'
    if (key === 'lexicalResource') return 'LR'
    if (key === 'grammarRangeAccuracy') return 'GRA'
    return key
  }

  function getCriterionFullLabel(key) {
    if (key === 'taskResponse') return 'Task Response / Achievement'
    if (key === 'coherenceCohesion') return 'Coherence & Cohesion'
    if (key === 'lexicalResource') return 'Lexical Resource'
    if (key === 'grammarRangeAccuracy') return 'Grammar Range & Accuracy'
    return key
  }


  function StudentSkillAnalytics({ user, profile, resultsVisibility }) {
    const [readings, setReadings] = useState([])
    const [readingSubmissions, setReadingSubmissions] = useState([])
    const [listenings, setListenings] = useState([])
    const [listeningSubmissions, setListeningSubmissions] = useState([])

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'studentReadings',
        user,
        profile,
        setReadings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'readingSubmissions',
        user.uid,
        setReadingSubmissions
      )
    }, [user])

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'studentListenings',
        user,
        profile,
        setListenings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'listeningSubmissions',
        user.uid,
        setListeningSubmissions
      )
    }, [user])

    const { attemptStates: readingAttemptStates } = useReadingAttemptStates(
      user,
      readings,
      readingSubmissions
    )

    const { attemptStates: listeningAttemptStates } = useListeningAttemptStates(
      user,
      listenings,
      listeningSubmissions
    )

    const currentReadingSubmissions = dedupeSubmissionHeads(
      readingSubmissions.filter(submission =>
        studentCanSeeResult(resultsVisibility, 'reading', submission.readingId)
      ),
      submission => submission.readingId,
      readingAttemptStates
    )

    const currentListeningSubmissions = dedupeSubmissionHeads(
      listeningSubmissions.filter(submission =>
        studentCanSeeResult(resultsVisibility, 'listening', submission.listeningId)
      ),
      submission => submission.listeningId,
      listeningAttemptStates
    )

    const readingAnalytics = calculateSkillAnalytics(
      readings,
      currentReadingSubmissions,
      'readingId',
      ['matching', 'matchingInformation', 'sentenceEndings', 'summaryOptions', 'mcq', 'fitb', 'tfng', 'table', 'summary', 'note', 'noteCompletion', 'shortAnswer'],
      { mcq_multi: 'mcq' }
    )

    const listeningAnalytics = calculateSkillAnalytics(
      listenings,
      currentListeningSubmissions,
      'listeningId',
      ['mcq', 'fitb', 'tfng', 'table', 'note', 'listeningCompletion', 'listeningMatching', 'map', 'shortAnswer'],
      {
        matching: 'listeningMatching',
        mcq_multi: 'mcq'
      }
    )

    // Count each active assignment once, even if it has duplicate submissions.
    const readingCompletion = {
      completed: readings.filter(reading =>
        currentReadingSubmissions.some(sub => sub.readingId === reading.id)
      ).length,
      assigned: readings.length
    }

    const listeningCompletion = {
      completed: listenings.filter(listening =>
        currentListeningSubmissions.some(sub => sub.listeningId === listening.id)
      ).length,
      assigned: listenings.length
    }

    const hasData =
      currentReadingSubmissions.length > 0 ||
      currentListeningSubmissions.length > 0 ||
      readings.length > 0 ||
      listenings.length > 0

    const renderSkillCard = (title, icon, analytics, completion, colorClass) => {
      // These values belong to this skill, not to StudentTodoSummary.
      const totalAssigned = completion.assigned
      const completedCount = completion.completed
      const completionRate = totalAssigned > 0
        ? Math.round((completedCount / totalAssigned) * 100)
        : null

      return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6">
        <div className="flex items-center justify-between gap-4 mb-5">
          <div>
            <h2 className="font-semibold text-gray-800">
              {icon} My {title} Analytics
            </h2>

            <p className="text-xs text-gray-400 mt-1">
              Based on your submitted {title.toLowerCase()} homework.
            </p>
          </div>

          <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">
            {completion.completed}/{completion.assigned} completed
          </span>
        </div>

        <div className="bg-purple-50 border border-purple-100 rounded-2xl p-5 mb-5">
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <p className="text-xs text-purple-500 mb-1">{title} Homework Completion</p>
              <p className="text-sm text-gray-600">
                {completedCount}/{totalAssigned} active assignments completed
              </p>
            </div>
            <p className="text-3xl font-bold text-purple-600">
              {completionRate === null ? '--' : `${completionRate}%`}
            </p>
          </div>
          <div className="w-full bg-white rounded-full h-3 overflow-hidden">
            <div
              className="bg-purple-600 h-3 rounded-full"
              style={{ width: `${completionRate ?? 0}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-green-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">Completed</p>
            <p className="text-3xl font-bold text-green-600">{completedCount}</p>
            <p className="text-xs text-gray-500 mt-2">Finished assignments</p>
          </div>

          <div className="bg-gray-900 text-white rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Average Accuracy
            </p>

            <p className="text-3xl font-bold">
              {analytics.averageAccuracy === null ? '--' : `${analytics.averageAccuracy}%`}
            </p>

            <p className="text-xs text-gray-400 mt-2">
              {analytics.totalCorrect}/{analytics.totalQuestions} correct
            </p>
          </div>

          <div className="bg-purple-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Estimated Band
            </p>

            <p className="text-3xl font-bold text-purple-600">
              {analytics.estimatedBand ? analytics.estimatedBand.toFixed(1) : '--'}
            </p>

            <p className="text-xs text-gray-500 mt-2">
              Homework estimate, not full IELTS band
            </p>
          </div>

          <div className="bg-amber-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Weakest Area
            </p>

            <p className="text-lg font-bold text-amber-700">
              {analytics.weakest ? getQuestionTypeLabel(analytics.weakest.key) : '--'}
            </p>

            <p className="text-xs text-gray-500 mt-2">
              {analytics.weakest
                ? `${analytics.weakest.percentage}% accuracy`
                : 'No question data yet'}
            </p>
          </div>
        </div>

        <div className="bg-gray-50 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Accuracy by Question Type
          </h3>

          {analytics.typeAnalytics.length === 0 ? (
            <p className="text-sm text-gray-400">
              No completed question-type data yet.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {analytics.typeAnalytics.map(item => (
                <div key={item.key}>
                <div className="flex justify-between mb-1">
                  <p className="text-xs text-gray-500">
                    {getQuestionTypeLabel(item.key)}
                  </p>

                  <p className={`text-xs font-semibold ${getAnalyticsColor(item.percentage)}`}>
                    {item.percentage === null ? '--' : `${item.percentage}%`}
                  </p>
                </div>

                <div className="w-full bg-white rounded-full h-2 overflow-hidden">
                  <div
                    className={`${item.percentage === null ? 'bg-gray-200' : colorClass} h-2 rounded-full`}
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
        </div>
      </div>
      )
    }

    if (!hasData) {
      return (
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-gray-800">
              📊 My Reading & Listening Analytics
            </h2>

            <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">
              No data yet
            </span>
          </div>

          <p className="text-sm text-gray-400">
            Once you complete reading or listening homework, your accuracy, estimated band and weakest question types will appear here.
          </p>
        </div>
      )
    }

    return (
      <div className="grid grid-cols-1 gap-6 mb-8">
        {renderSkillCard(
          'Reading',
          '📖',
          readingAnalytics,
          readingCompletion,
          'bg-blue-600'
        )}

        {renderSkillCard(
          'Listening',
          '🎧',
          listeningAnalytics,
          listeningCompletion,
          'bg-purple-600'
        )}
      </div>
    )
  }


  function ReadingHomeworkSection({ user, profile, mode = 'all' }) {
    const [readings, setReadings] = useState([])
    const [submissions, setSubmissions] = useState([])
    const navigate = useNavigate()

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'studentReadings',
        user,
        profile,
        setReadings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'readingSubmissions',
        user.uid,
        setSubmissions
      )
    }, [user])

    const { attemptStates, attemptStatesLoading } = useReadingAttemptStates(
      user,
      readings,
      submissions
    )

    const getAttemptState = readingId => attemptStates[readingId] || null

    const getSubmission = readingId =>
      chooseCurrentSubmission(
        submissions.filter(s => s.readingId === readingId),
        getAttemptState(readingId)?.currentSubmissionId || ''
      )

    const hasOpenRetake = readingId =>
      getAttemptState(readingId)?.open === true

    const isDone = readingId =>
      Boolean(getSubmission(readingId)) && !hasOpenRetake(readingId)

    const getResult = readingId =>
      getSubmission(readingId)?.result

    const todoReadings = readings.filter(r => !isDone(r.id))
    const completedReadings = readings.filter(r => isDone(r.id))

    if (readings.length === 0) return mode === 'completed' ? <StudentEmptyResults label="Reading" /> : null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          {mode === 'completed' ? '📖 Reading Results' : '📖 Reading Homework'}
        </h2>

        {mode !== 'completed' && todoReadings.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoReadings.map((r, index) => {
                const badge = dueLabel(r)
                const submission = getSubmission(r.id)
                const attemptState = getAttemptState(r.id)
                const retakeOpen = attemptState?.open === true

                return (
                  <div
                    key={r.id}
                    className="bg-white border border-red-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {r.title}
                      </p>

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {r.timeLimit} min · {r.questions?.length || 0} question sets
                      </p>

                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={`text-xs px-3 py-1 rounded-full ${badge.style}`}>
                          {badge.text}
                        </span>

                        {retakeOpen ? (
                          <>
                            <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1 rounded-full">
                              Attempt {attemptState.nextAttemptNumber || 2} reopened
                            </span>

                            <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                              {attemptState.mode === 'reopen_answers'
                                ? 'Previous answers restored'
                                : 'Start fresh'}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                            Not completed
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-reading/${r.id}`)}
                      disabled={Boolean(submission) && attemptStatesLoading && !attemptState}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {retakeOpen ? 'Continue Retake →' : 'Start →'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {mode === 'completed' && completedReadings.length === 0 && <StudentEmptyResults label="Reading" />}

        {completedReadings.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-3">
              Completed
            </p>

            <div className="flex flex-col gap-3">
              {completedReadings.map((r, index) => {
                const result = getResult(r.id)

                return (
                  <div
                    key={r.id}
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {r.title}
                      </p>
                      {getSubmission(r.id)?.excludedFromStats === true && (
                        <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Excluded from statistics</span>
                      )}

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {r.timeLimit} min · {r.questions?.length || 0} question sets
                      </p>

                      <p className="text-xs text-green-600 mt-1 font-medium">
                        ✓ Completed — Estimated Band {result?.band}
                      </p>
                    </div>

                    <button
                      onClick={() => navigate(`/do-reading/${r.id}`)}
                      className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                    >
                      Review Answers
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }


  function ListeningHomeworkSection({ user, profile, mode = 'all' }) {
    const [listenings, setListenings] = useState([])
    const [submissions, setSubmissions] = useState([])
    const navigate = useNavigate()

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'studentListenings',
        user,
        profile,
        setListenings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'listeningSubmissions',
        user.uid,
        setSubmissions
      )
    }, [user])

    const { attemptStates, attemptStatesLoading } = useListeningAttemptStates(
      user,
      listenings,
      submissions
    )

    const getAttemptState = listeningId => attemptStates[listeningId] || null

    const getSubmission = listeningId =>
      chooseCurrentSubmission(
        submissions.filter(s => s.listeningId === listeningId),
        getAttemptState(listeningId)?.currentSubmissionId || ''
      )

    const hasOpenRetake = listeningId =>
      getAttemptState(listeningId)?.open === true

    const isDone = listeningId =>
      Boolean(getSubmission(listeningId)) && !hasOpenRetake(listeningId)

    const getResult = listeningId =>
      getSubmission(listeningId)?.result

    const todoListenings = listenings.filter(l => !isDone(l.id))
    const completedListenings = listenings.filter(l => isDone(l.id))

    if (listenings.length === 0) return mode === 'completed' ? <StudentEmptyResults label="Listening" /> : null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          {mode === 'completed' ? '🎧 Listening Results' : '🎧 Listening Homework'}
        </h2>

        {mode !== 'completed' && todoListenings.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoListenings.map((l, index) => {
                const badge = dueLabel(l)
                const submission = getSubmission(l.id)
                const attemptState = getAttemptState(l.id)
                const retakeOpen = attemptState?.open === true

                return (
                  <div
                    key={l.id}
                    className="bg-white border border-red-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {l.title}
                      </p>

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {l.timeLimit || 30} min · {l.questions?.length || 0} questions
                      </p>

                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={`text-xs px-3 py-1 rounded-full ${badge.style}`}>
                          {badge.text}
                        </span>

                        {retakeOpen ? (
                          <>
                            <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1 rounded-full">
                              Attempt {attemptState.nextAttemptNumber || 2} reopened
                            </span>
                            <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                              {attemptState.mode === 'reopen_answers'
                                ? 'Previous answers restored'
                                : 'Start fresh'}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                            Not completed
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-listening/${l.id}`)}
                      disabled={Boolean(submission) && attemptStatesLoading && !attemptState}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {retakeOpen ? 'Continue Retake →' : 'Start →'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {mode === 'completed' && completedListenings.length === 0 && <StudentEmptyResults label="Listening" />}

        {completedListenings.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-3">
              Completed
            </p>

            <div className="flex flex-col gap-3">
              {completedListenings.map((l, index) => {
                const result = getResult(l.id)

                return (
                  <div
                    key={l.id}
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {l.title}
                      </p>
                      {getSubmission(l.id)?.excludedFromStats === true && (
                        <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Excluded from statistics</span>
                      )}

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {l.timeLimit || 30} min · {l.questions?.length || 0} questions
                      </p>

                      <p className="text-xs text-green-600 mt-1 font-medium">
                        ✓ Completed — Estimated Band {result?.band}
                      </p>
                    </div>

                    <button
                      onClick={() => navigate(`/do-listening/${l.id}`)}
                      className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                    >
                      Review Answers
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }



  function MockAnalysis({ user, profile, resultsVisibility }) {
    const [mockSubmissions, setMockSubmissions] = useState([])
    const [mockMap, setMockMap] = useState({})

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'mockSubmissions',
        user.uid,
        setMockSubmissions,
        {
          sort: (a, b) =>
            new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
        }
      )
    }, [user])

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'mockTests',
        user,
        profile,
        items => {
          const map = {}

          items.forEach(item => {
            map[item.id] = item
          })

          setMockMap(map)
        },
        {
          filter: item => !item.archived
        }
      )
    }, [user, profile])

    const getSubmissionMock = submission =>
      mockMap[submission?.mockTestId] || {}

    const getSubmissionMockType = submission => {
      const mock = getSubmissionMock(submission)

      return (
        submission?.mockType ||
        submission?.contentType ||
        mock?.mockType ||
        mock?.contentType ||
        'full_mock'
      )
    }

    const getSubmissionMockTypeLabel = submission =>
      getSubmissionMockType(submission) === 'mini_mock'
        ? 'Mini Mock'
        : 'Full Mock'

    const mockIncludesWriting = submission => {
      if (submission?.result?.enabledSections?.writing === false) return false
      if (submission?.enabledSections?.writing === false) return false
      if (submission?.result?.writing?.enabled === false) return false

      const mock = getSubmissionMock(submission)

      if (getSubmissionMockType(submission) !== 'mini_mock') return true

      if (mock?.enabledSections && typeof mock.enabledSections === 'object') {
        return mock.enabledSections.writing === true
      }

      return Boolean(
        submission?.writingId ||
        mock?.writingId ||
        submission?.result?.writing?.enabled
      )
    }

    const getValidBand = (...values) => {
      for (const value of values) {
        const band = toNumber(value)
        if (band !== null && band > 0) return band
      }

      return null
    }

    const getMockOverall = submission => {
      const result = submission?.result || {}

      return getValidBand(
        result.reviewedOverall,
        result.finalOverall,
        result.overall,
        result.overallEstimate
      )
    }

    const getWritingBand = submission => {
      const result = submission?.result || {}

      return getValidBand(
        result.writing?.band,
        result.writingBand,
        submission?.writingReview?.overall,
        submission?.review?.writingOverall
      )
    }

    const getWritingStatus = submission => {
      if (!mockIncludesWriting(submission)) return 'Not included'

      const writingBand = getWritingBand(submission)

      if (writingBand !== null) {
        return `Reviewed · Band ${formatBand(writingBand)}`
      }

      return 'Pending teacher review'
    }

    const currentMockSubmissions = dedupeSubmissionHeads(
      mockSubmissions.filter(submission =>
        studentCanSeeResult(resultsVisibility, 'mock', submission.mockTestId || submission.mockId)
      ),
      submission => submission.mockTestId || submission.mockId
    )

    const fullMockSubmissions = currentMockSubmissions.filter(
      submission => getSubmissionMockType(submission) !== 'mini_mock'
    )
    const miniMockSubmissions = currentMockSubmissions.filter(
      submission => getSubmissionMockType(submission) === 'mini_mock'
    )

    const completedFull = fullMockSubmissions.length
    const completedMini = miniMockSubmissions.length
    const countedFullMocks = fullMockSubmissions.filter(sub => sub.excludedFromStats !== true)
    const latest = countedFullMocks[0]
    const previous = countedFullMocks[1]

    const latestOverall = getMockOverall(latest)
    const previousOverall = getMockOverall(previous)

    const trend = [...countedFullMocks]
      .reverse()
      .slice(-6)

    const overallChange = getChangeLabel(latestOverall, previousOverall)
    const latestMockTitle = latest
      ? getSubmissionMock(latest)?.title || latest.mockTitle || latest.title || 'Mock Test'
      : 'No Full Mock included in statistics'

    if (currentMockSubmissions.length === 0) {
      return (
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-gray-800">
              🧠 My Mock Analysis
            </h2>

            <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">
              No completed mock yet
            </span>
          </div>

          <p className="text-sm text-gray-400">
            Once you complete a mock test, Full Mock and Mini Mock results will appear here separately.
          </p>
        </div>
      )
    }

    if (completedFull === 0) {
      return (
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <h2 className="font-semibold text-gray-800">
                🧠 My Mock Analysis
              </h2>
              <p className="text-xs text-gray-400 mt-1">
                Mini Mock results are kept separate from the Full Mock trend.
              </p>
            </div>

            <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1.5 rounded-full">
              {completedMini} Mini Mock completed
            </span>
          </div>

          <p className="text-sm text-gray-500">
            No Full Mock has been completed yet. Your Mini Mock results remain available in the Mock Tests list below.
          </p>
        </div>
      )
    }

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2 className="font-semibold text-gray-800">
              🧠 My Mock Analysis
            </h2>

            <p className="text-xs text-gray-400 mt-1">
              Full Mock trend only. Mini Mock results are listed separately and do not affect this trend.
            </p>
          </div>

          <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
            {completedFull} full · {completedMini} mini
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-gray-900 text-white rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Latest Full Mock Overall
            </p>

            <p className="text-4xl font-bold">
              {latestOverall !== null ? formatBand(latestOverall) : '--'}
            </p>

            <p className="text-xs text-gray-400 mt-2 truncate">
              {latestMockTitle}
            </p>
          </div>

          <div className="bg-purple-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Listening
            </p>

            <p className="text-3xl font-bold text-purple-600">
              {formatBand(latest?.result?.listening?.band)}
            </p>

            <p className="text-xs text-gray-500 mt-2">
              {latest?.result?.listening?.correct ?? '-'}/{latest?.result?.listening?.total ?? '-'} correct
            </p>
          </div>

          <div className="bg-blue-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Reading
            </p>

            <p className="text-3xl font-bold text-blue-600">
              {formatBand(latest?.result?.reading?.band)}
            </p>

            <p className="text-xs text-gray-500 mt-2">
              {latest?.result?.reading?.correct ?? '-'}/{latest?.result?.reading?.total ?? '-'} correct
            </p>
          </div>

          <div className="bg-amber-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Writing
            </p>

            <p className="text-lg font-bold text-amber-700">
              {latest ? getWritingStatus(latest) : 'No included result'}
            </p>

            <p className={`text-xs mt-2 ${getChangeColor(latestOverall, previousOverall)}`}>
              {overallChange ? `${overallChange} from previous Full Mock` : 'No previous Full Mock yet'}
            </p>
          </div>
        </div>

        {trend.length > 1 && (
          <div className="mb-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Full Mock Progress Trend
            </h3>

            <div className="flex items-end gap-2 h-28 bg-gray-50 rounded-2xl p-4 overflow-x-auto">
              {trend.map((submission, index) => {
                const overall = getMockOverall(submission)
                const height = overall === null
                  ? 0
                  : Math.max(14, Math.min(100, (overall / 9) * 100))
                const title = getSubmissionMock(submission)?.title || submission.mockTitle || `Full Mock ${index + 1}`

                return (
                  <div
                    key={submission.id}
                    className="flex flex-col items-center justify-end min-w-[58px] h-full"
                    title={title}
                  >
                    <p className="text-xs font-semibold text-purple-600 mb-1">
                      {overall === null ? '--' : formatBand(overall)}
                    </p>

                    <div
                      className="w-8 rounded-t-xl bg-purple-600"
                      style={{ height: `${height}%` }}
                    />

                    <p className="text-[10px] text-gray-400 mt-1">
                      F{index + 1}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Recent Mock Tests
          </h3>

          <div className="flex flex-col gap-2">
            {currentMockSubmissions.slice(0, 6).map(submission => {
              const result = submission.result || {}
              const overall = getMockOverall(submission)
              const title = getSubmissionMock(submission)?.title || submission.mockTitle || submission.title || 'Mock Test'
              const isMini = getSubmissionMockType(submission) === 'mini_mock'

              return (
                <div
                  key={submission.id}
                  className="border border-gray-100 bg-gray-50 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-800">
                        {title}
                      </p>
                      {submission.excludedFromStats === true && (
                        <span className="text-[10px] rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">Excluded from statistics</span>
                      )}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                        isMini
                          ? 'bg-blue-50 text-blue-600'
                          : 'bg-purple-50 text-purple-600'
                      }`}>
                        {getSubmissionMockTypeLabel(submission)}
                      </span>
                    </div>

                    <p className="text-xs text-gray-400 mt-0.5">
                      Submitted {submission.submittedAt ? new Date(submission.submittedAt).toLocaleDateString() : 'No date'}
                    </p>

                    <p className="text-xs text-gray-500 mt-1">
                      L {formatBand(result.listening?.band)} · R {formatBand(result.reading?.band)} · Writing {getWritingStatus(submission)}
                    </p>
                  </div>

                  <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full font-semibold">
                    Overall {overall === null ? '--' : formatBand(overall)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }


  function VocabularyHomeworkSection({ user, profile, mode = 'all' }) {
    const [vocabularyTests, setVocabularyTests] = useState([])
    const [submissions, setSubmissions] = useState([])
    const navigate = useNavigate()

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'studentVocabularyTests',
        user,
        profile,
        setVocabularyTests,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'vocabularySubmissions',
        user.uid,
        setSubmissions
      )
    }, [user])

    const isVocabularySubmissionForTest = (submission, vocabularyTestId) =>
      [
        submission?.vocabularyTestId,
        submission?.vocabularyId,
        submission?.testId,
        submission?.homeworkId
      ]
        .map(normalizeId)
        .includes(normalizeId(vocabularyTestId))

    const { attemptStates, attemptStatesLoading } = useVocabularyAttemptStates(
      user,
      vocabularyTests,
      submissions
    )

    const getAttemptState = vocabularyTestId =>
      attemptStates[vocabularyTestId] || null

    const getSubmission = vocabularyTestId =>
      chooseCurrentSubmission(
        submissions.filter(submission =>
          isVocabularySubmissionForTest(submission, vocabularyTestId)
        ),
        getAttemptState(vocabularyTestId)?.currentSubmissionId || ''
      )

    const hasOpenRetake = vocabularyTestId =>
      getAttemptState(vocabularyTestId)?.open === true

    const isDone = vocabularyTestId =>
      Boolean(getSubmission(vocabularyTestId)) && !hasOpenRetake(vocabularyTestId)

    const getResult = vocabularyTestId =>
      getSubmission(vocabularyTestId)?.result

    const todoVocabularyTests = vocabularyTests.filter(item => !isDone(item.id))
    const completedVocabularyTests = vocabularyTests.filter(item => isDone(item.id))

    if (vocabularyTests.length === 0) return mode === 'completed' ? <StudentEmptyResults label="Vocabulary" /> : null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          {mode === 'completed' ? '🧩 Vocabulary Results' : '🧩 Vocabulary Tests'}
        </h2>

        {mode !== 'completed' && todoVocabularyTests.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoVocabularyTests.map((item, index) => {
                const badge = dueLabel(item)
                const submission = getSubmission(item.id)
                const attemptState = getAttemptState(item.id)
                const retakeOpen = attemptState?.open === true

                return (
                  <div
                    key={item.id}
                    className="bg-white border border-red-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {item.title}
                      </p>

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {item.timeLimit || 20} min · {item.questions?.length || 0} questions
                      </p>

                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={`text-xs px-3 py-1 rounded-full ${badge.style}`}>
                          {badge.text}
                        </span>

                        {retakeOpen ? (
                          <>
                            <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1 rounded-full">
                              Attempt {attemptState.nextAttemptNumber || 2} reopened
                            </span>
                            <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                              {attemptState.mode === 'reopen_answers'
                                ? 'Previous answers restored'
                                : 'Start fresh'}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                            Not completed
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-vocabulary/${item.id}`)}
                      disabled={Boolean(submission) && attemptStatesLoading && !attemptState}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {retakeOpen ? 'Continue Retake →' : 'Start →'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {mode === 'completed' && completedVocabularyTests.length === 0 && <StudentEmptyResults label="Vocabulary" />}

        {completedVocabularyTests.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-3">
              Completed
            </p>

            <div className="flex flex-col gap-3">
              {completedVocabularyTests.map((item, index) => {
                const result = getResult(item.id)

                return (
                  <div
                    key={item.id}
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {item.title}
                      </p>
                      {getSubmission(item.id)?.excludedFromStats === true && (
                        <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Excluded from statistics</span>
                      )}

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {item.timeLimit || 20} min · {item.questions?.length || 0} questions
                      </p>

                      <p className="text-xs text-green-600 mt-1 font-medium">
                        ✓ Completed — {result?.correct || 0}/{result?.total || 0} correct · {result?.percentage ?? 0}%
                      </p>
                    </div>

                    <button
                      onClick={() => navigate(`/do-vocabulary/${item.id}`)}
                      className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                    >
                      Review Answers
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }


  function MockTestSection({ user, profile, mode = 'all' }) {
    const [mocks, setMocks] = useState([])
    const [submissions, setSubmissions] = useState([])
    const navigate = useNavigate()

    const getMockOverall = submission => {
      const result = submission?.result || {}

      return (
        result.finalOverall ||
        result.overall ||
        result.reviewedOverall ||
        result.overallEstimate ||
        null
      )
    }

    const getMockWritingBand = submission => {
      const result = submission?.result || {}

      return (
        result.writing?.band ||
        submission?.writingReview?.overall ||
        submission?.review?.writingOverall ||
        null
      )
    }

    const getMockType = mock =>
      mock?.mockType ||
      mock?.contentType ||
      'full_mock'

    const getMockTypeLabel = mock =>
      getMockType(mock) === 'mini_mock'
        ? 'Mini Mock'
        : 'Full Mock'

    const getMockEnabledSections = mock => {
      if (getMockType(mock) !== 'mini_mock') {
        return { listening: true, reading: true, writing: true }
      }

      if (mock?.enabledSections && typeof mock.enabledSections === 'object') {
        const stored = {
          listening: mock.enabledSections.listening === true,
          reading: mock.enabledSections.reading === true,
          writing: mock.enabledSections.writing === true
        }

        if (Object.values(stored).some(Boolean)) return stored
      }

      const inferred = {
        listening: Boolean(
          mock?.listeningId ||
          mock?.listeningIds?.filter(Boolean).length
        ),
        reading: Boolean(
          mock?.readingId ||
          mock?.readingIds?.filter(Boolean).length
        ),
        writing: Boolean(mock?.writingId)
      }

      return Object.values(inferred).some(Boolean)
        ? inferred
        : { listening: true, reading: true, writing: true }
    }

    const getMockWritingLabel = mock => {
      if (!getMockEnabledSections(mock).writing) return 'No Writing'

      const mode = mock?.writingMode || 'full_writing'

      if (mode === 'task1_only') return 'Writing Task 1'
      if (mode === 'task2_only') return 'Writing Task 2'

      return 'Full Writing'
    }

    const getMockSectionTimes = mock => {
      const isMini = getMockType(mock) === 'mini_mock'
      const enabled = getMockEnabledSections(mock)
      const defaults = isMini
        ? { listening: 15, reading: 30, writing: 30 }
        : { listening: 35, reading: 60, writing: 60 }
      const stored = mock?.sectionTimeLimits || {}

      return {
        listening: enabled.listening
          ? Number(stored.listening) || defaults.listening
          : 0,
        reading: enabled.reading
          ? Number(stored.reading) || defaults.reading
          : 0,
        writing: enabled.writing
          ? Number(stored.writing) || defaults.writing
          : 0
      }
    }

    const getMockTotalTime = mock => {
      const times = getMockSectionTimes(mock)

      return times.listening + times.reading + times.writing
    }

    const getMockFlowLabel = mock => {
      const enabled = getMockEnabledSections(mock)
      const parts = [
        enabled.listening ? 'Listening' : null,
        enabled.reading
          ? getMockType(mock) === 'mini_mock'
            ? 'Reading'
            : '3 Reading passages'
          : null,
        enabled.writing ? getMockWritingLabel(mock) : null
      ].filter(Boolean)

      return parts.join(' · ')
    }

    const hasSavedMockProgress = mockId => {
      if (!user?.uid || !mockId) return false

      try {
        return Boolean(
          localStorage.getItem(`mock_progress_${mockId}_${user.uid}`)
        )
      } catch {
        return false
      }
    }

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'mockTests',
        user,
        profile,
        setMocks,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'mockSubmissions',
        user.uid,
        setSubmissions
      )
    }, [user])

    const { attemptStates, attemptStatesLoading } = useMockAttemptStates(
      user,
      mocks,
      submissions
    )

    const getAttemptState = mockId => attemptStates[mockId] || null

    const getSubmission = mockId =>
      chooseCurrentSubmission(
        submissions.filter(submission => submission.mockTestId === mockId),
        getAttemptState(mockId)?.currentSubmissionId || ''
      )

    const hasOpenRetake = mockId =>
      getAttemptState(mockId)?.open === true

    const isDone = mockId =>
      Boolean(getSubmission(mockId)) && !hasOpenRetake(mockId)

    const todoMocks = mocks.filter(mock => !isDone(mock.id))
    const completedMocks = mocks.filter(mock => isDone(mock.id))

    if (mocks.length === 0) return mode === 'completed' ? <StudentEmptyResults label="Mock Test" /> : null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          {mode === 'completed' ? '🧠 Mock Results' : '🧠 Mock Tests'}
        </h2>

        {mode !== 'completed' && todoMocks.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoMocks.map((mock, index) => {
                const badge = dueLabel(mock)
                const submission = getSubmission(mock.id)
                const attemptState = getAttemptState(mock.id)
                const retakeOpen = attemptState?.open === true

                return (
                  <div
                    key={mock.id}
                    className="bg-white border border-purple-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {mock.title}
                      </p>

                      <p className="text-xs text-gray-400 mt-0.5">
                        {getMockFlowLabel(mock)} · {getMockTotalTime(mock)} min
                      </p>

                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={`text-xs px-3 py-1 rounded-full ${
                          getMockType(mock) === 'mini_mock'
                            ? 'bg-blue-50 text-blue-600'
                            : 'bg-purple-50 text-purple-600'
                        }`}>
                          {getMockTypeLabel(mock)}
                        </span>

                        <span className={`text-xs px-3 py-1 rounded-full ${badge.style}`}>
                          {badge.text}
                        </span>

                        {retakeOpen ? (
                          <>
                            <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1 rounded-full">
                              Attempt {attemptState.nextAttemptNumber || 2} reopened
                            </span>
                            <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                              {attemptState.mode === 'reopen_answers'
                                ? 'Previous answers restored'
                                : 'Start fresh'}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                            Not completed
                          </span>
                        )}

                        {hasSavedMockProgress(mock.id) && !retakeOpen && (
                          <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                            Progress saved
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-mock/${mock.id}`)}
                      disabled={Boolean(submission) && attemptStatesLoading && !attemptState}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {retakeOpen
                        ? 'Continue Retake →'
                        : hasSavedMockProgress(mock.id)
                          ? 'Resume →'
                          : 'Start →'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {mode === 'completed' && completedMocks.length === 0 && <StudentEmptyResults label="Mock Test" />}

        {completedMocks.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-3">
              Completed
            </p>

            <div className="flex flex-col gap-3">
              {completedMocks.map((mock, index) => {
                const submission = getSubmission(mock.id)
                const result = submission?.result
                const overall = getMockOverall(submission)
                const writingBand = getMockWritingBand(submission)

                return (
                  <div
                    key={mock.id}
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {mock.title}
                      </p>
                      {submission?.excludedFromStats === true && (
                        <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Excluded from statistics</span>
                      )}

                      <p className="text-xs text-gray-400 mt-0.5">
                        {getMockFlowLabel(mock)} · {getMockTotalTime(mock)} min
                      </p>

                      <p className="text-xs text-gray-400 mt-1">
                        Submitted {submission?.submittedAt ? new Date(submission.submittedAt).toLocaleDateString() : ''}
                      </p>

                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={`text-xs px-3 py-1 rounded-full ${
                          getMockType(mock) === 'mini_mock'
                            ? 'bg-blue-50 text-blue-600'
                            : 'bg-purple-50 text-purple-600'
                        }`}>
                          {getMockTypeLabel(mock)}
                        </span>

                        <span className="text-xs bg-green-50 text-green-600 px-3 py-1 rounded-full">
                          Completed
                        </span>

                        <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                          Overall {overall || '-'}
                        </span>

                        {getMockEnabledSections(mock).writing && (
                          <span
                            className={`text-xs px-3 py-1 rounded-full ${
                              writingBand
                                ? 'bg-green-50 text-green-600'
                                : 'bg-amber-50 text-amber-600'
                            }`}
                          >
                            {writingBand
                              ? `Writing Band ${formatBand(writingBand)}`
                              : 'Writing pending review'}
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-mock/${mock.id}`)}
                      className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                    >
                      Review Answers
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }


  function WritingProgressAnalytics({ user, profile, resultsVisibility }) {
    const [submissions, setSubmissions] = useState([])
    const [writingMap, setWritingMap] = useState({})

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'writingSubmissions',
        user.uid,
        setSubmissions
      )
    }, [user])

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'writingHomeworks',
        user,
        profile,
        items => {
        const map = {}

        items.forEach(item => {
          map[item.id] = item
        })

        setWritingMap(map)
      },
        {
          filter: item => !item.archived
        }
      )
    }, [user, profile])

    const currentWritingSubmissions = dedupeSubmissionHeads(
      submissions.filter(submission =>
        studentCanSeeResult(resultsVisibility, 'writing', submission.writingId)
      ),
      submission => submission.writingId
    )

    const reviewed = currentWritingSubmissions
      .filter(sub => {
        if (sub.excludedFromStats === true) return false
        const band = toNumber(sub.review?.overall)
        return sub.reviewed && band !== null && band > 0
      })
      .sort((a, b) => new Date(getReviewDate(a)) - new Date(getReviewDate(b)))

    if (reviewed.length === 0) {
      return (
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-gray-800">
              ✍️ Writing Progress Analytics
            </h2>

            <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">
              No reviewed writing yet
            </span>
          </div>

          <p className="text-sm text-gray-400">
            Once your teacher reviews your writing homework, your writing band trend and rubric strengths will appear here.
          </p>
        </div>
      )
    }

    const first = reviewed[0]
    const latest = reviewed[reviewed.length - 1]
    const previous = reviewed[reviewed.length - 2]

    const firstOverall = toNumber(first.review?.overall)
    const latestOverall = toNumber(latest.review?.overall)
    const previousOverall = previous ? toNumber(previous.review?.overall) : null

    const improvement =
      firstOverall !== null && latestOverall !== null
        ? latestOverall - firstOverall
        : null

    const latestRubric = getRubricAverages(latest.review)

    const criteria = [
      'taskResponse',
      'coherenceCohesion',
      'lexicalResource',
      'grammarRangeAccuracy'
    ]

    const rubricItems = criteria
      .map(key => ({
        key,
        value: latestRubric[key]
      }))
      .filter(item => item.value !== null)

    const weakest = rubricItems.length
      ? [...rubricItems].sort((a, b) => a.value - b.value)[0]
      : null

    const strongest = rubricItems.length
      ? [...rubricItems].sort((a, b) => b.value - a.value)[0]
      : null

    const recent = [...reviewed]
      .sort((a, b) => new Date(getReviewDate(b)) - new Date(getReviewDate(a)))
      .slice(0, 5)

    const trend = reviewed.slice(-5)

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
        <div className="flex items-center justify-between gap-4 mb-5">
          <div>
            <h2 className="font-semibold text-gray-800">
              ✍️ Writing Progress Analytics
            </h2>

            <p className="text-xs text-gray-400 mt-1">
              Based on teacher-reviewed Task 1 and Task 2 submissions.
            </p>
          </div>

          <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
            {reviewed.length} reviewed
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <div className="bg-gray-900 text-white rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Latest Writing Band
            </p>

            <p className="text-4xl font-bold">
              {formatBand(latestOverall)}
            </p>

            {previousOverall !== null && (
              <p className={`text-xs mt-2 ${getChangeColor(latestOverall, previousOverall)}`}>
                {getChangeLabel(latestOverall, previousOverall)} from previous review
              </p>
            )}
          </div>

          <div className="bg-purple-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Improvement Since First Review
            </p>

            <p className={`text-3xl font-bold ${
              improvement !== null && improvement >= 0
                ? 'text-green-600'
                : 'text-red-500'
            }`}>
              {improvement === null
                ? '-'
                : `${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}`}
            </p>

            <p className="text-xs text-gray-400 mt-2">
              First: {formatBand(firstOverall)} → Latest: {formatBand(latestOverall)}
            </p>
          </div>

          <div className="bg-amber-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Weakest Criterion
            </p>

            <p className="text-xl font-bold text-amber-700">
              {weakest ? getCriterionLabel(weakest.key) : '-'}
            </p>

            <p className="text-xs text-gray-500 mt-2">
              {weakest
                ? `${getCriterionFullLabel(weakest.key)} · ${formatBand(weakest.value)}`
                : 'Rubric data is not available yet.'}
            </p>
          </div>
        </div>

        <div className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">
              Last 5 Writing Trend
            </h3>

            {strongest && (
              <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                Strongest: {getCriterionLabel(strongest.key)}
              </span>
            )}
          </div>

          <div className="flex items-end gap-2 h-28 bg-gray-50 rounded-2xl p-4 overflow-x-auto">
            {trend.map((sub, index) => {
              const band = toNumber(sub.review?.overall) || 0
              const height = Math.max(14, Math.min(100, (band / 9) * 100))

              return (
                <div
                  key={sub.id}
                  className="flex flex-col items-center justify-end min-w-[54px] h-full"
                >
                  <p className="text-xs font-semibold text-purple-600 mb-1">
                    {formatBand(band)}
                  </p>

                  <div
                    className="w-8 rounded-t-xl bg-purple-600"
                    style={{ height: `${height}%` }}
                  />

                  <p className="text-[10px] text-gray-400 mt-1">
                    W{reviewed.length - trend.length + index + 1}
                  </p>
                </div>
              )
            })}
          </div>
        </div>

        {rubricItems.length > 0 && (
          <div className="mb-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Latest Rubric Breakdown
            </h3>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {rubricItems.map(item => {
                const percent = Math.min(100, Math.round((item.value / 9) * 100))

                return (
                  <div
                    key={item.key}
                    className="bg-gray-50 rounded-xl p-4"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-gray-500">
                        {getCriterionLabel(item.key)}
                      </p>

                      <p className={`text-sm font-bold ${getBandColor(item.value)}`}>
                        {formatBand(item.value)}
                      </p>
                    </div>

                    <div className="w-full bg-white rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-purple-600 h-2 rounded-full"
                        style={{ width: `${percent}%` }}
                      />
                    </div>

                    <p className="text-[10px] text-gray-400 mt-2">
                      {getCriterionFullLabel(item.key)}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Recent Writing Reviews
          </h3>

          <div className="flex flex-col gap-2">
            {recent.map(sub => {
              const homework = writingMap[sub.writingId]
              const rubric = getRubricAverages(sub.review)

              return (
                <div
                  key={sub.id}
                  className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                >
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {homework?.title || 'Writing Homework'}
                      </p>

                      <p className="text-xs text-gray-400">
                        {getReviewDate(sub)
                          ? new Date(getReviewDate(sub)).toLocaleDateString()
                          : 'No date'}
                      </p>
                    </div>

                    <p className="text-xl font-bold text-purple-600">
                      {formatBand(sub.review?.overall)}
                    </p>
                  </div>

                  <div className="grid grid-cols-4 gap-2">
                    {criteria.map(key => (
                      <div
                        key={key}
                        className="bg-white rounded-lg p-2 text-center"
                      >
                        <p className="text-[10px] text-gray-400">
                          {getCriterionLabel(key)}
                        </p>

                        <p className={`text-xs font-semibold ${getBandColor(rubric[key])}`}>
                          {formatBand(rubric[key])}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  function WritingHomeworkSection({ user, profile, mode = 'all' }) {
    const [writings, setWritings] = useState([])
    const [submissions, setSubmissions] = useState([])
    const [selectedReview, setSelectedReview] = useState(null)
    const navigate = useNavigate()

    useEffect(() => {
      if (!user) return

      return listenStudentAccessCollection(
        'writingHomeworks',
        user,
        profile,
        setWritings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      return listenUserCollection(
        'writingSubmissions',
        user.uid,
        setSubmissions
      )
    }, [user])

    const { attemptStates, attemptStatesLoading } = useWritingAttemptStates(
      user,
      writings,
      submissions
    )

    const getAttemptState = writingId => attemptStates[writingId] || null

    const getSubmission = writingId =>
      chooseCurrentSubmission(
        submissions.filter(s => s.writingId === writingId),
        getAttemptState(writingId)?.currentSubmissionId || ''
      )

    const hasOpenRetake = writingId =>
      getAttemptState(writingId)?.open === true

    const isDone = writingId =>
      Boolean(getSubmission(writingId)) && !hasOpenRetake(writingId)

    const todoWritings = writings.filter(w => !isDone(w.id))
    const completedWritings = writings.filter(w => isDone(w.id))

    if (writings.length === 0) return mode === 'completed' ? <StudentEmptyResults label="Writing" /> : null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          {mode === 'completed' ? '✍️ Writing Feedback' : '✍️ Writing Homework'}
        </h2>

        {mode !== 'completed' && todoWritings.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoWritings.map((w, index) => {
                const badge = dueLabel(w)
                const submission = getSubmission(w.id)
                const attemptState = getAttemptState(w.id)
                const retakeOpen = attemptState?.open === true

                return (
                  <div
                    key={w.id}
                    className="bg-white border border-red-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {w.title}
                      </p>

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {getWritingTimeLimit(w)} min · {getWritingModeLabel(w)}
                      </p>

                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={`text-xs px-3 py-1 rounded-full ${badge.style}`}>
                          {badge.text}
                        </span>

                        {retakeOpen ? (
                          <>
                            <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1 rounded-full">
                              Attempt {attemptState.nextAttemptNumber || 2} reopened
                            </span>

                            <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                              {attemptState.mode === 'reopen_answers'
                                ? 'Previous answers restored'
                                : 'Start fresh'}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                              Not completed
                            </span>

                            <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                              Teacher graded
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-writing/${w.id}`)}
                      disabled={Boolean(submission) && attemptStatesLoading && !attemptState}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {retakeOpen ? 'Continue Retake →' : 'Start →'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {mode === 'completed' && completedWritings.length === 0 && <StudentEmptyResults label="Writing" />}

        {completedWritings.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-3">
              Completed
            </p>

            <div className="flex flex-col gap-3">
              {completedWritings.map((w, index) => {
                const submission = getSubmission(w.id)
                const reviewed = Boolean(submission?.reviewed)

                return (
                  <div
                    key={w.id}
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {w.title}
                      </p>
                      {submission?.excludedFromStats === true && (
                        <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Excluded from statistics</span>
                      )}

                      <p className="text-xs text-gray-400 mt-0.5">
                        ⏱ {getWritingTimeLimit(w, submission)} min · {getWritingModeLabel(w, submission)}
                      </p>

                      {reviewed ? (
                        <p className="text-xs text-green-600 mt-1 font-medium">
                          ✓ Reviewed — Band {submission?.review?.overall || '-'}
                        </p>
                      ) : (
                        <p className="text-xs text-amber-600 mt-1 font-medium">
                          ✓ Submitted — Waiting for teacher review
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          try {
                            // Full Writing answers are loaded ONLY after the
                            // secure server rechecks assignment and retake state.
                            const snapshot = await getStudentVisibleResultSnapshot('writing', w.id)
                            const records = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
                            const selected = chooseCurrentSubmission(records, submission?.id || '')
                            if (!selected) throw new Error('Your completed submission was not found.')
                            setSelectedReview({ writing: w, submission: selected })
                          } catch (error) {
                            console.warn('Could not open Writing feedback:', error)
                            window.alert('Writing feedback could not be loaded. Check your assignment or retry.')
                          }
                        }}
                        className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                      >
                        {reviewed ? 'Review Feedback' : 'View Submission'}
                      </button>

                      <span
                        className={`text-xs px-3 py-1.5 rounded-full ${
                          reviewed
                            ? 'bg-green-50 text-green-600'
                            : 'bg-amber-50 text-amber-600'
                        }`}
                      >
                        {reviewed ? 'Reviewed' : 'Pending review'}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {selectedReview && (() => {
          const { hasTask1, hasTask2 } = getWritingTaskVisibility(
            selectedReview.writing,
            selectedReview.submission
          )
          const review = selectedReview.submission.review || {}
          const reviewed = Boolean(selectedReview.submission.reviewed)
          const bandCardCount = [hasTask1, hasTask2, true].filter(Boolean).length

          return (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
              <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-6">
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">
                      Writing Feedback
                    </h2>

                    <p className="text-sm text-gray-400">
                      {selectedReview.writing.title} · {getWritingModeLabel(selectedReview.writing, selectedReview.submission)}
                    </p>

                    <p className="text-sm text-purple-600 font-semibold mt-1">
                      {reviewed
                        ? `Overall Band ${review.overall || '-'}`
                        : 'Waiting for teacher review'}
                    </p>
                  </div>

                  <button
                    onClick={() => setSelectedReview(null)}
                    className="text-sm text-gray-400 hover:text-gray-600"
                  >
                    Close
                  </button>
                </div>

                {reviewed && (
                  <div className={`grid grid-cols-1 ${bandCardCount >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-3 mb-6`}>
                    {hasTask1 && (
                      <div className="bg-purple-50 rounded-xl p-4 text-center">
                        <p className="text-xs text-gray-500 mb-1">Task 1 Band</p>
                        <p className="text-2xl font-bold text-purple-600">
                          {review.task1Band || '-'}
                        </p>
                      </div>
                    )}

                    {hasTask2 && (
                      <div className="bg-indigo-50 rounded-xl p-4 text-center">
                        <p className="text-xs text-gray-500 mb-1">Task 2 Band</p>
                        <p className="text-2xl font-bold text-indigo-600">
                          {review.task2Band || '-'}
                        </p>
                      </div>
                    )}

                    <div className="bg-green-50 rounded-xl p-4 text-center">
                      <p className="text-xs text-gray-500 mb-1">Overall</p>
                      <p className="text-2xl font-bold text-green-600">
                        {review.overall || '-'}
                      </p>
                    </div>
                  </div>
                )}

                {reviewed && review.rubric && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                    {Object.entries(getRubricAverages(review)).map(([key, value]) => (
                      <div
                        key={key}
                        className="bg-gray-50 rounded-xl p-3 text-center"
                      >
                        <p className="text-xs text-gray-400 mb-1">
                          {getCriterionLabel(key)}
                        </p>

                        <p className={`text-lg font-bold ${getBandColor(value)}`}>
                          {formatBand(value)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                <div className={`grid grid-cols-1 ${hasTask1 && hasTask2 ? 'lg:grid-cols-2' : ''} gap-6`}>
                  {hasTask1 && (
                    <div className="border border-gray-100 rounded-2xl p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-semibold text-gray-800">Task 1</h3>
                        <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                          {selectedReview.submission.task1WordCount || 0} words
                        </span>
                      </div>

                      <p className="text-xs text-gray-400 mb-2">Your answer</p>
                      <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-gray-50 rounded-xl p-4 mb-4">
                        {selectedReview.submission.task1Answer || 'No Task 1 answer submitted.'}
                      </p>

                      {reviewed && (
                        <>
                          <p className="text-xs text-gray-400 mb-2">Teacher feedback</p>
                          <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-green-50 rounded-xl p-4">
                            {review.task1Feedback || 'No feedback.'}
                          </p>
                        </>
                      )}
                    </div>
                  )}

                  {hasTask2 && (
                    <div className="border border-gray-100 rounded-2xl p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-semibold text-gray-800">Task 2</h3>
                        <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                          {selectedReview.submission.task2WordCount || 0} words
                        </span>
                      </div>

                      <p className="text-xs text-gray-400 mb-2">Your answer</p>
                      <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-gray-50 rounded-xl p-4 mb-4">
                        {selectedReview.submission.task2Answer || 'No Task 2 answer submitted.'}
                      </p>

                      {reviewed && (
                        <>
                          <p className="text-xs text-gray-400 mb-2">Teacher feedback</p>
                          <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-green-50 rounded-xl p-4">
                            {review.task2Feedback || 'No feedback.'}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="bg-purple-50 rounded-2xl p-5 mt-6">
                  <p className="text-xs text-gray-500 mb-2">General Feedback</p>
                  <p className="text-sm text-purple-800 leading-7 whitespace-pre-wrap">
                    {reviewed
                      ? review.generalFeedback || 'No general feedback.'
                      : 'Your teacher has not reviewed this submission yet.'}
                  </p>
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    )
  }


  function StudentTodoSummary({ user, profile, compact = false, onViewAll = null }) {
    const [readings, setReadings] = useState([])
    const [listenings, setListenings] = useState([])
    const [writings, setWritings] = useState([])
    const [vocabularyTests, setVocabularyTests] = useState([])
    const [mocks, setMocks] = useState([])

    const [readingSubmissions, setReadingSubmissions] = useState([])
    const [listeningSubmissions, setListeningSubmissions] = useState([])
    const [writingSubmissions, setWritingSubmissions] = useState([])
    const [vocabularySubmissions, setVocabularySubmissions] = useState([])
    const [mockSubmissions, setMockSubmissions] = useState([])

    const { attemptStates: readingAttemptStates } = useReadingAttemptStates(
      user,
      readings,
      readingSubmissions
    )

    const { attemptStates: writingAttemptStates } = useWritingAttemptStates(
      user,
      writings,
      writingSubmissions
    )

    const { attemptStates: listeningAttemptStates } = useListeningAttemptStates(
      user,
      listenings,
      listeningSubmissions
    )

    const { attemptStates: vocabularyAttemptStates } = useVocabularyAttemptStates(
      user,
      vocabularyTests,
      vocabularySubmissions
    )

    const { attemptStates: mockAttemptStates } = useMockAttemptStates(
      user,
      mocks,
      mockSubmissions
    )

    const navigate = useNavigate()

    useEffect(() => {
      if (!user) return

      const unsubReadings = listenStudentAccessCollection(
        'studentReadings',
        user,
        profile,
        setReadings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubListenings = listenStudentAccessCollection(
        'studentListenings',
        user,
        profile,
        setListenings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubWritings = listenStudentAccessCollection(
        'writingHomeworks',
        user,
        profile,
        setWritings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubVocabularyTests = listenStudentAccessCollection(
        'studentVocabularyTests',
        user,
        profile,
        setVocabularyTests,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubMocks = listenStudentAccessCollection(
        'mockTests',
        user,
        profile,
        setMocks,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      return () => {
        unsubReadings()
        unsubListenings()
        unsubWritings()
        unsubVocabularyTests()
        unsubMocks()
      }
    }, [user, profile])

    useEffect(() => {
      if (!user) return

      const unsubReadingSubmissions = listenUserCollection(
        'readingSubmissions',
        user.uid,
        setReadingSubmissions
      )

      const unsubListeningSubmissions = listenUserCollection(
        'listeningSubmissions',
        user.uid,
        setListeningSubmissions
      )

      const unsubWritingSubmissions = listenUserCollection(
        'writingSubmissions',
        user.uid,
        setWritingSubmissions
      )

      const unsubVocabularySubmissions = listenUserCollection(
        'vocabularySubmissions',
        user.uid,
        setVocabularySubmissions
      )

      const unsubMockSubmissions = listenUserCollection(
        'mockSubmissions',
        user.uid,
        setMockSubmissions
      )

      return () => {
        unsubReadingSubmissions()
        unsubListeningSubmissions()
        unsubWritingSubmissions()
        unsubVocabularySubmissions()
        unsubMockSubmissions()
      }
    }, [user])

    const hasOpenReadingRetake = readingId =>
      readingAttemptStates[readingId]?.open === true

    const hasReadingSubmission = readingId =>
      !hasOpenReadingRetake(readingId) &&
      readingSubmissions.some(submission => submission.readingId === readingId)

    const hasOpenListeningRetake = listeningId =>
      listeningAttemptStates[listeningId]?.open === true

    const hasListeningSubmission = listeningId =>
      !hasOpenListeningRetake(listeningId) &&
      listeningSubmissions.some(submission => submission.listeningId === listeningId)

    const hasOpenWritingRetake = writingId =>
      writingAttemptStates[writingId]?.open === true

    const hasWritingSubmission = writingId =>
      !hasOpenWritingRetake(writingId) &&
      writingSubmissions.some(submission => submission.writingId === writingId)

    const hasOpenVocabularyRetake = vocabularyTestId =>
      vocabularyAttemptStates[vocabularyTestId]?.open === true

    const hasVocabularySubmission = vocabularyTestId =>
      !hasOpenVocabularyRetake(vocabularyTestId) &&
      vocabularySubmissions.some(submission =>
        [
          submission?.vocabularyTestId,
          submission?.vocabularyId,
          submission?.testId,
          submission?.homeworkId
        ]
          .map(normalizeId)
          .includes(normalizeId(vocabularyTestId))
      )

    const hasOpenMockRetake = mockId =>
      mockAttemptStates[mockId]?.open === true

    const hasMockSubmission = mockId =>
      !hasOpenMockRetake(mockId) &&
      mockSubmissions.some(submission => submission.mockTestId === mockId)

    const todoItems = [
      ...readings
        .filter(item => !hasReadingSubmission(item.id))
        .map(item => ({
          ...item,
          type: 'Reading',
          icon: '📖',
          path: `/do-reading/${item.id}`,
          color: 'blue',
          isRetake: hasOpenReadingRetake(item.id),
          retakeState: readingAttemptStates[item.id] || null
        })),
      ...listenings
        .filter(item => !hasListeningSubmission(item.id))
        .map(item => ({
          ...item,
          type: 'Listening',
          icon: '🎧',
          path: `/do-listening/${item.id}`,
          color: 'purple',
          isRetake: hasOpenListeningRetake(item.id),
          retakeState: listeningAttemptStates[item.id] || null
        })),
      ...writings
        .filter(item => !hasWritingSubmission(item.id))
        .map(item => ({
          ...item,
          type: 'Writing',
          icon: '✍️',
          path: `/do-writing/${item.id}`,
          color: 'amber',
          isRetake: hasOpenWritingRetake(item.id),
          retakeState: writingAttemptStates[item.id] || null
        })),
      ...vocabularyTests
        .filter(item => !hasVocabularySubmission(item.id))
        .map(item => ({
          ...item,
          type: 'Vocabulary',
          icon: '🧩',
          path: `/do-vocabulary/${item.id}`,
          color: 'violet',
          isRetake: hasOpenVocabularyRetake(item.id),
          retakeState: vocabularyAttemptStates[item.id] || null
        })),
      ...mocks
        .filter(item => !hasMockSubmission(item.id))
        .map(item => ({
          ...item,
          type: 'Mock Test',
          icon: '🧠',
          path: `/do-mock/${item.id}`,
          color: 'green',
          isRetake: hasOpenMockRetake(item.id),
          retakeState: mockAttemptStates[item.id] || null
        }))
    ].sort((a, b) => {
      const aDays = daysUntilDue(a.dueDate)
      const bDays = daysUntilDue(b.dueDate)
      const aPriority = aDays === null || !Number.isFinite(aDays) ? Infinity : aDays
      const bPriority = bDays === null || !Number.isFinite(bDays) ? Infinity : bDays
      return aPriority - bPriority || sortByAssignedDateDesc(a, b)
    })

    const overdueCount = todoItems.filter(item => daysUntilDue(item.dueDate) !== null && daysUntilDue(item.dueDate) < 0).length
    const urgentCount = todoItems.filter(item => {
      const days = daysUntilDue(item.dueDate)
      return days !== null && days >= 0 && days <= 3
    }).length

    const totalAssigned =
      readings.length +
      listenings.length +
      writings.length +
      vocabularyTests.length +
      mocks.length

    const completedCount = Math.max(totalAssigned - todoItems.length, 0)
    const completionRate = totalAssigned
      ? Math.round((completedCount / totalAssigned) * 100)
      : 0

    const visibleTodoItems = compact ? todoItems.slice(0, 4) : todoItems

    const getTypeBadgeStyle = type => {
      if (type === 'Reading') return 'bg-blue-50 text-blue-600'
      if (type === 'Listening') return 'bg-purple-50 text-purple-600'
      if (type === 'Writing') return 'bg-amber-50 text-amber-600'
      if (type === 'Vocabulary') return 'bg-violet-50 text-violet-600'
      return 'bg-green-50 text-green-600'
    }

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2 className="font-semibold text-gray-800">
              Your next assignments
            </h2>

            <p className="text-xs text-gray-400 mt-1">
              Prioritised by deadline, including teacher-reopened attempts.
            </p>
          </div>

          <span
            className={`text-xs px-3 py-1.5 rounded-full ${
              todoItems.length > 0
                ? 'bg-red-50 text-red-600'
                : 'bg-green-50 text-green-600'
            }`}
          >
            {todoItems.length > 0 ? `${todoItems.length} to do` : 'All done'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <div className="bg-gray-900 text-white rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Remaining Tasks
            </p>

            <p className="text-3xl font-bold">
              {todoItems.length}
            </p>

            <p className="text-xs text-gray-400 mt-2">
              Reading, listening, writing, vocabulary and mock tests
            </p>
          </div>

          <div className="bg-red-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Overdue
            </p>

            <p className="text-3xl font-bold text-red-600">
              {overdueCount}
            </p>

            <p className="text-xs text-gray-500 mt-2">
              Past due date
            </p>
          </div>

          <div className="bg-amber-50 rounded-2xl p-5">
            <p className="text-xs text-gray-500 mb-1">
              Due Soon
            </p>

            <p className="text-3xl font-bold text-amber-600">
              {urgentCount}
            </p>

            <p className="text-xs text-gray-500 mt-2">
              Due within 3 days
            </p>
          </div>
        </div>

        <div className="mb-5 rounded-xl bg-slate-50 px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-slate-600">Homework completion</span>
            <span className="font-bold text-indigo-700">{completedCount} / {totalAssigned} · {completionRate}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${completionRate}%` }} />
          </div>
        </div>

        {todoItems.length === 0 ? (
          <div className="bg-green-50 text-green-700 rounded-xl p-4 text-sm">
            ✅ No remaining homework right now.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {visibleTodoItems.map((item, index) => {
              const badge = dueLabel(item)

              return (
                <div
                  key={`${item.type}-${item.id}`}
                  className="border border-slate-200 bg-slate-50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2.5 py-1 rounded-full ${getTypeBadgeStyle(item.type)}`}>
                        {item.icon} {item.type}
                      </span>

                      <span className={`text-xs px-2.5 py-1 rounded-full ${badge.style}`}>
                        {badge.text}
                      </span>
                    </div>

                    <p className="text-sm font-medium text-gray-800">
                      {index + 1}. {item.title || 'Untitled homework'}
                    </p>

                    <p className="text-xs text-gray-400 mt-0.5">
                      {item.isRetake
                        ? `Attempt ${item.retakeState?.nextAttemptNumber || 2} reopened by teacher`
                        : 'Not completed yet'}
                    </p>
                  </div>

                  <button
                    onClick={() => navigate(item.path)}
                    className="shrink-0 self-start sm:self-auto bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-xs font-semibold hover:bg-indigo-700"
                  >
                    {item.isRetake ? 'Continue Retake →' : 'Start →'}
                  </button>
                </div>
              )
            })}

            {compact && onViewAll && (
              <button type="button" onClick={onViewAll}
                className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">
                {todoItems.length > visibleTodoItems.length
                  ? `View all ${todoItems.length} assignments`
                  : 'Open My Homework'} →
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  function StudentCommunicationCenter({ user }) {
    const [messages, setMessages] = useState([])
    const [materials, setMaterials] = useState([])
    const [openingMaterialId, setOpeningMaterialId] = useState('')

    useEffect(() => {
      if (!user) return

      const messagesQuery = query(
        collection(db, 'messages'),
        where('recipientIds', 'array-contains', user.uid)
      )

      const materialsQuery = query(
        collection(db, 'materials'),
        where('recipientIds', 'array-contains', user.uid)
      )

      const sortNewestFirst = (a, b) =>
        new Date(b.createdAt || 0) - new Date(a.createdAt || 0)

      const unsubMessages = subscribeSharedSnapshot(
        `recipient:messages:${user.uid}`,
        messagesQuery,
        items => {
          setMessages(
            items
              .filter(item => item.archived !== true)
              .sort(sortNewestFirst)
          )
        }
      )

      const unsubMaterials = subscribeSharedSnapshot(
        `recipient:materials:${user.uid}`,
        materialsQuery,
        items => {
          setMaterials(
            items
              .filter(item => item.archived !== true)
              .sort(sortNewestFirst)
          )
        }
      )

      return () => {
        unsubMessages()
        unsubMaterials()
      }
    }, [user])

    const unreadCount = messages.filter(
      message => !(message.readBy || []).includes(user?.uid)
    ).length

    const unopenedMaterialCount = materials.filter(
      material => !(material.readBy || []).includes(user?.uid)
    ).length

    const markMessageRead = async message => {
      if (!user || (message.readBy || []).includes(user.uid)) return

      try {
        await updateDoc(doc(db, 'messages', message.id), {
          readBy: arrayUnion(user.uid)
        })
      } catch (error) {
        console.warn('Could not mark message as read:', error)
      }
    }

    const openMaterial = async material => {
      if (!material?.storagePath) return

      setOpeningMaterialId(material.id)

      try {
        const url = await getDownloadURL(
          storageRef(storage, material.storagePath)
        )

        window.open(url, '_blank', 'noopener,noreferrer')

        if (user && !(material.readBy || []).includes(user.uid)) {
          try {
            await updateDoc(doc(db, 'materials', material.id), {
              readBy: arrayUnion(user.uid)
            })
          } catch (readError) {
            console.warn('Could not mark material as opened:', readError)
          }
        }
      } catch (error) {
        console.error('Could not open material:', error)
        alert('Could not open this file.')
      } finally {
        setOpeningMaterialId('')
      }
    }

    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="font-semibold text-gray-800">💬 Messages</h2>
              <p className="text-xs text-gray-400 mt-1">Messages from your teacher.</p>
            </div>
            <span className={`text-xs px-3 py-1.5 rounded-full ${unreadCount > 0 ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
              {unreadCount > 0 ? `${unreadCount} unread` : 'All read'}
            </span>
          </div>

          {messages.length === 0 ? (
            <div className="bg-gray-50 rounded-xl p-5 text-sm text-gray-400">
              No messages yet.
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map(message => {
                const isUnread = !(message.readBy || []).includes(user?.uid)

                return (
                  <button
                    key={message.id}
                    type="button"
                    onClick={() => markMessageRead(message)}
                    className={`w-full text-left border rounded-xl p-4 transition-all ${isUnread ? 'border-purple-200 bg-purple-50' : 'border-gray-100 bg-white hover:bg-gray-50'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className={`text-sm ${isUnread ? 'font-bold text-gray-900' : 'font-semibold text-gray-800'}`}>
                          {message.title}
                        </p>
                        <p className="text-xs text-purple-600 mt-1">
                          From {message.senderName || 'Teacher'}
                        </p>
                      </div>
                      {isUnread && (
                        <span className="text-[10px] bg-purple-600 text-white px-2 py-1 rounded-full">NEW</span>
                      )}
                    </div>

                    <p className="text-sm text-gray-600 leading-6 mt-3 whitespace-pre-wrap">
                      {message.body}
                    </p>

                    <p className="text-[11px] text-gray-400 mt-3">
                      {message.createdAt ? new Date(message.createdAt).toLocaleString() : ''}
                    </p>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="font-semibold text-gray-800">📚 Materials</h2>
              <p className="text-xs text-gray-400 mt-1">Lesson notes, PDFs and worksheets shared with you.</p>
            </div>
            <span className={`text-xs px-3 py-1.5 rounded-full ${unopenedMaterialCount > 0 ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-500'}`}>
              {unopenedMaterialCount > 0
                ? `${unopenedMaterialCount} unopened`
                : `${materials.length} file${materials.length === 1 ? '' : 's'}`}
            </span>
          </div>

          {materials.length === 0 ? (
            <div className="bg-gray-50 rounded-xl p-5 text-sm text-gray-400">
              No materials shared yet.
            </div>
          ) : (
            <div className="space-y-3">
              {materials.map(material => {
                const isUnopened = !(material.readBy || []).includes(user?.uid)

                return (
                <div key={material.id} className={`border rounded-xl p-4 ${isUnopened ? 'border-purple-200 bg-purple-50/40' : 'border-gray-100'}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-gray-800">📎 {material.title}</p>
                        {isUnopened && (
                          <span className="text-[10px] bg-purple-600 text-white px-2 py-1 rounded-full">NEW</span>
                        )}
                      </div>
                      <p className="text-xs text-purple-600 mt-1">From {material.senderName || 'Teacher'}</p>
                      <p className="text-xs text-gray-400 mt-1 truncate">{material.fileName}</p>
                      {material.description && (
                        <p className="text-sm text-gray-600 leading-6 mt-3 whitespace-pre-wrap">{material.description}</p>
                      )}
                      <p className="text-[11px] text-gray-400 mt-3">
                        {material.createdAt ? new Date(material.createdAt).toLocaleString() : ''}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => openMaterial(material)}
                      disabled={openingMaterialId === material.id}
                      className="flex-shrink-0 bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700 disabled:opacity-60"
                    >
                      {openingMaterialId === material.id ? 'Opening...' : 'Open File'}
                    </button>
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }


  // MAXIMA Student Learning Hub V2: presentation-only navigation and pictograms.
  // Academic submissions, attempt permissions, content access, and review rules stay unchanged.
  // Q2A: Student history is always scoped to the signed-in student's UID.
  // Archive/restore visibility is controlled by the canonical studentAccess
  // assignment status, not the archived flag on an older retake submission.
  // Do not fetch answer-key-bearing source documents or change review permissions.
  const STUDENT_HISTORY_CONFIG = Object.freeze({
    reading: { collection: 'readingSubmissions', label: 'Reading', contentIds: ['readingId'], titleFields: ['readingTitle', 'title'] },
    listening: { collection: 'listeningSubmissions', label: 'Listening', contentIds: ['listeningId'], titleFields: ['listeningTitle', 'title'] },
    writing: { collection: 'writingSubmissions', label: 'Writing', contentIds: ['writingId'], titleFields: ['writingTitle', 'title'] },
    vocabulary: { collection: 'vocabularySubmissions', label: 'Vocabulary', contentIds: ['vocabularyTestId', 'vocabularyId', 'testId', 'homeworkId'], titleFields: ['vocabularyTitle', 'title'] },
    mock: { collection: 'mockSubmissions', label: 'Mock', contentIds: ['mockTestId', 'mockId'], titleFields: ['mockTitle', 'title'] }
  })

  // Canonical source collections used when the backend archives/restores tests.
  const STUDENT_HISTORY_ACCESS_SOURCES = Object.freeze({
    reading: 'readings',
    listening: 'listenings',
    writing: 'writingHomeworks',
    vocabulary: 'vocabularyTests',
    mock: 'mockTests'
  })

  function emptyStudentVisibleContentIds() {
    return {
      reading: new Set(),
      listening: new Set(),
      writing: new Set(),
      vocabulary: new Set(),
      mock: new Set()
    }
  }

  // Build the current visible source IDs using only canonical studentAccess.
  // Old attempt snapshots may themselves be archived during a retake; their
  // visibility depends on the parent assignment, not that snapshot flag.
  function studentVisibleContentIdsFromAccess(accessItems) {
    const allowed = emptyStudentVisibleContentIds()
    ;(accessItems || []).forEach(access => {
      const source = STUDENT_HISTORY_ACCESS_SOURCES[access?.contentType]
      if (
        !source ||
        access?.accessType !== 'assignment' ||
        access?.sourceCollection !== source ||
        access?.status !== 'active' ||
        access?.adminHidden === true ||
        !access?.contentId
      ) return
      allowed[access.contentType].add(normalizeId(access.contentId))
    })
    return allowed
  }

  // A single shared real-time studentAccess query covers all 5 result types.
  // setContentArchivedState marks the matching assignments inactive on Archive,
  // then active again on Restore (unless an admin has separately hidden them).
  // This avoids reading privileged source documents from a student account.
  function useStudentResultsVisibility(user, profile) {
    const uid = user?.uid || ''
    const schoolId = profile?.schoolId?.toString().trim() || 'maxima'
    const identity = uid && profile ? `${uid}:${schoolId}` : ''
    const [state, setState] = useState({
      identity: '', ready: false, allowed: emptyStudentVisibleContentIds()
    })

    useEffect(() => {
      setState({ identity, ready: false, allowed: emptyStudentVisibleContentIds() })
      if (!identity) return undefined
      let subscribed = true

      const accessQuery = query(
        collection(db, 'studentAccess'),
        where('uid', '==', uid),
        where('schoolId', '==', schoolId)
      )

      const unsubscribe = subscribeSharedSnapshot(
        `studentAccess:${uid}:${schoolId}`,
        accessQuery,
        accessItems => {
          if (!subscribed) return
          const allowed = studentVisibleContentIdsFromAccess(accessItems)
          setState({ identity, ready: true, allowed })
        }
      )
      return () => {
        subscribed = false
        unsubscribe()
      }
    }, [uid, schoolId, identity])

    return state.identity === identity
      ? state
      : { identity, ready: false, allowed: emptyStudentVisibleContentIds() }
  }

  function studentCanSeeResult(visibility, category, contentId) {
    const id = normalizeId(contentId)
    return Boolean(id && visibility?.ready === true && visibility.allowed?.[category]?.has(id))
  }

  function historyContentId(record, config) {
    return [record?.contentId, ...config.contentIds.map(key => record?.[key])].find(value =>
      typeof value === 'string' && value.trim()
    ) || ''
  }

  function historyTitle(record, config) {
    const stored = config.titleFields.map(key => record?.[key]).find(value =>
      typeof value === 'string' && value.trim()
    )
    if (stored) return stored.trim()
    const id = historyContentId(record, config)
    return id ? `${config.label} · ${id.slice(0, 8)}` : `${config.label} submission`
  }

  function historyDate(record) {
    const milliseconds = submissionTimeMillis(record)
    if (!milliseconds) return 'Date not recorded'
    const date = new Date(milliseconds)
    if (Number.isNaN(date.getTime())) return 'Date not recorded'
    return date.toLocaleString('en-GB', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  }

  function historySummary(record, category) {
    const result = record?.result || {}
    if (category === 'writing') {
      if (!record?.reviewed) return 'Submitted · Teacher review pending'
      return `Teacher reviewed · Band ${formatBand(record?.review?.overall ?? record?.reviewOverall)}`
    }
    if (category === 'mock') {
      const overall = result.finalOverall ?? result.reviewedOverall ?? result.overall ?? result.overallEstimate
      const listening = result.listening?.band
      const reading = result.reading?.band
      const sections = [`Overall ${formatBand(overall)}`]
      if (toNumber(listening) !== null) sections.push(`Listening ${formatBand(listening)}`)
      if (toNumber(reading) !== null) sections.push(`Reading ${formatBand(reading)}`)
      return sections.join(' · ')
    }
    const correct = toNumber(result.correct)
    const total = toNumber(result.total)
    const score = correct !== null && total !== null
      ? `${correct}/${total} correct`
      : 'Submitted'
    const band = result.band ?? result.estimatedBand
    const percentage = toNumber(result.percentage)
    if (toNumber(band) !== null) return `${score} · Band ${formatBand(band)}`
    if (percentage !== null) return `${score} · ${Math.round(percentage)}%`
    return score
  }

  // Q2B read-only historic answer review. The trusted callable controls access;
  // these functions only render what it already authorized and returned.
  function studentReviewValue(value) {
    if (value === undefined || value === null || value === '') return '—'
    if (Array.isArray(value)) return value.length ? value.map(studentReviewValue).join(', ') : '—'
    if (typeof value === 'object') {
      return Object.entries(value).map(([key, item]) => `${key}: ${studentReviewValue(item)}`).join('; ') || '—'
    }
    return String(value)
  }

  function studentReviewQuestionTitle(question, fallback = '') {
    const fields = ['questionText', 'question', 'prompt', 'text', 'sentence', 'statement', 'word', 'term', 'title', 'label']
    const text = fields.map(key => question?.[key])
      .find(value => typeof value === 'string' && value.trim())
    return text || fallback || question?.id || 'Question'
  }

  function studentReviewRow(id, question, yourAnswer, correctAnswer) {
    return { id, question, yourAnswer: studentReviewValue(yourAnswer), correctAnswer: studentReviewValue(correctAnswer) }
  }

  function studentReviewQuestionRows(question, answers, type, sectionName) {
    const q = question || {}
    const qid = q.id || 'question'
    const label = studentReviewQuestionTitle(q, sectionName)
    const nested = answers?.[qid] || {}
    const rows = []
    const add = (id, subLabel, value, correct) => rows.push(studentReviewRow(
      id, subLabel ? `${label} · ${subLabel}` : label, value, correct
    ))

    if (type === 'reading' && q.type === 'matching') {
      ;(q.paragraphs || []).forEach((paragraph, i) =>
        add(`${qid}:paragraph:${i}`, `Paragraph ${paragraph.letter || i + 1}`,
          nested?.[paragraph.letter], paragraph.answer))
    } else if (type === 'reading' &&
      ['matchingInformation', 'sentenceEndings', 'summaryOptions', 'shortAnswer'].includes(q.type)) {
      ;(q.items || []).forEach((item, i) =>
        add(`${qid}:item:${i}`, studentReviewQuestionTitle(item, `Item ${i + 1}`),
          nested?.[item.id], item.answer))
    } else if (type === 'reading' && q.type === 'noteCompletion') {
      ;(q.paragraphs || []).forEach((paragraph, paragraphIndex) =>
        (paragraph.parts || []).forEach((part, i) => {
          if (part.type !== 'blank') return
          add(`${qid}:note:${paragraphIndex}:${i}`, `Blank ${paragraphIndex + 1}.${i + 1}`,
            answers?.[`${qid}_${paragraph.id}_${part.id}`], part.answer)
        }))
    } else if ((type === 'reading' || type === 'listening') &&
      ['table', 'summary', 'note'].includes(q.type)) {
      ;(q.rows || []).forEach((row, rowIndex) =>
        (row.cells || []).forEach((cell, cellIndex) => {
          if (cell.type !== 'blank') return
          add(`${qid}:table:${rowIndex}:${cellIndex}`, `Row ${rowIndex + 1}, blank ${cellIndex + 1}`,
            answers?.[`${qid}_${row.id}_${cellIndex}`], cell.answer)
        }))
    } else if (type === 'listening' && q.type === 'listeningCompletion') {
      ;(q.sections || []).forEach((section, sectionIndex) =>
        (section.parts || []).forEach((part, i) => {
          if (part.type !== 'blank') return
          add(`${qid}:completion:${sectionIndex}:${i}`, `Blank ${sectionIndex + 1}.${i + 1}`,
            answers?.[`${qid}_${section.id}_${part.id}`], part.answer)
        }))
    } else if (type === 'listening' && q.type === 'map') {
      ;(q.mapItems || []).forEach((item, i) =>
        add(`${qid}:map:${i}`, studentReviewQuestionTitle(item, `Location ${i + 1}`),
          answers?.[`${qid}_${item.id}`], item.answer))
    } else if (type === 'listening' && q.type === 'matching') {
      ;(q.matchingItems || []).forEach((item, i) =>
        add(`${qid}:matching:${i}`, studentReviewQuestionTitle(item, `Item ${i + 1}`),
          answers?.[`${qid}_${item.id}`], item.answer))
    } else {
      add(`${qid}:answer`, '', answers?.[qid], q.mode === 'multi' ? q.answers : q.answer)
    }
    return rows
  }

  function studentReviewObjectiveRows(source, answers, type, mockListening = false) {
    if (!source) return []
    if (type === 'reading') {
      return (source.questions || []).flatMap((question, index) =>
        studentReviewQuestionRows(question, answers, 'reading', `Question ${index + 1}`))
    }
    const parts = Array.isArray(source.parts) && source.parts.length
      ? source.parts
      : [{ id: 'part-1', questions: source.questions || [] }]
    return parts.flatMap((part, partIndex) => (part.questions || []).flatMap((question, i) => {
      const mappedQuestion = mockListening
        ? { ...question, id: `${source.id}__${part.id || `part-${partIndex + 1}`}__${question.id || i}` }
        : question
      return studentReviewQuestionRows(mappedQuestion, answers, 'listening',
        `Part ${partIndex + 1}, question ${i + 1}`)
    }))
  }

  function studentReviewVocabularyRows(source, answers) {
    const questions = Array.isArray(source?.questions) ? source.questions : []
    const matching = questions.filter(question => (question.type || 'mcq') === 'match_definition')
    let ordered = matching
    if (source?.matchingShuffle === true && matching.length > 1) {
      const hash = Array.from(source.id || source.title || 'vocabulary')
        .reduce((acc, character) => ((acc * 31) + character.charCodeAt(0)) >>> 0, 7)
      const shift = (hash % (matching.length - 1)) + 1
      ordered = [...matching.slice(shift), ...matching.slice(0, shift)]
    }
    return questions.map((question, index) => {
      let correct = question.answerText || question.answer
      if (question.type === 'match_definition') {
        const definitionIndex = ordered.findIndex(item => item.id === question.id)
        if (definitionIndex < 0) {
          correct = '—'
        } else {
          let number = definitionIndex + 1
          let letters = ''
          while (number > 0) {
            number -= 1
            letters = String.fromCharCode(65 + (number % 26)) + letters
            number = Math.floor(number / 26)
          }
          correct = letters
        }
      }
      return studentReviewRow(`vocab:${question.id || index}`,
        studentReviewQuestionTitle(question, `Question ${index + 1}`),
        answers?.[question.id], correct)
    })
  }

  function studentReviewMissingAnswerRows(answers, rows) {
    const used = new Set(rows.map(row => row.id))
    if (rows.length > 0) return rows
    return Object.entries(answers || {}).filter(([key]) => !used.has(key))
      .map(([key, answer]) => studentReviewRow(`saved:${key}`, key, answer, null))
  }

  function StudentAttemptReview({ payload, category }) {
    const submission = payload?.submission || {}
    const source = payload?.source || {}
    const mockSources = payload?.reviewSources || {}
    const groups = []
    if (category === 'reading' || category === 'listening') {
      groups.push({ label: `${category === 'reading' ? 'Reading' : 'Listening'} answers`,
        rows: studentReviewMissingAnswerRows(submission.answers,
          studentReviewObjectiveRows(source, submission.answers, category)) })
    } else if (category === 'vocabulary') {
      groups.push({ label: 'Vocabulary answers',
        rows: studentReviewMissingAnswerRows(submission.answers,
          studentReviewVocabularyRows(source, submission.answers)) })
    } else if (category === 'mock') {
      ;(mockSources.listenings || []).forEach((listening, i) =>
        groups.push({ label: `Listening ${i + 1}: ${listening.title || 'Part'}`,
          rows: studentReviewMissingAnswerRows(submission.listeningAnswers,
            studentReviewObjectiveRows(listening, submission.listeningAnswers, 'listening', true)) }))
      ;(mockSources.readings || []).forEach((reading, i) =>
        groups.push({ label: `Reading ${i + 1}: ${reading.title || 'Passage'}`,
          rows: studentReviewMissingAnswerRows(submission.readingAnswers?.[reading.id],
            studentReviewObjectiveRows(reading, submission.readingAnswers?.[reading.id], 'reading')) }))
      if (!(mockSources.listenings || []).length && Object.keys(submission.listeningAnswers || {}).length) {
        groups.push({ label: 'Saved Listening answers',
          rows: studentReviewMissingAnswerRows(submission.listeningAnswers, []) })
      }
      if (!(mockSources.readings || []).length && Object.keys(submission.readingAnswers || {}).length) {
        groups.push({ label: 'Saved Reading answers',
          rows: studentReviewMissingAnswerRows(submission.readingAnswers, []) })
      }
    }

    const writing = category === 'writing'
      ? { task1: submission.task1Answer || '', task2: submission.task2Answer || '' }
      : category === 'mock' ? (submission.writingAnswers || {}) : null
    const review = category === 'mock'
      ? (submission.result?.writing?.review || submission.review || null)
      : submission.review || null
    const reviewed = category === 'mock'
      ? (submission.result?.writing?.status === 'reviewed' || Boolean(review))
      : submission.reviewed === true

    return (
      <div className="mt-4 space-y-4 rounded-xl border border-indigo-100 bg-indigo-50/30 p-4" aria-label={`Attempt ${submission.attemptNumber} answer review`}>
        <p className="text-sm font-semibold text-indigo-950">Attempt {submission.attemptNumber} · Saved answers and feedback (read-only)</p>
        <p className="text-xs text-slate-600">The score shown above is the score saved for this attempt. Answer keys below come from the current test version; if a teacher edited the test after submission, they may differ from the original marking key.</p>
        {groups.map((group, groupIndex) => (
          <details key={`${group.label}:${groupIndex}`} open className="rounded-xl border border-slate-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900">{group.label} ({group.rows.length})</summary>
            <div className="space-y-2 border-t border-slate-100 p-3">
              {group.rows.length === 0 ? (
                <p className="text-xs text-slate-500">No saved answers for this section.</p>
              ) : group.rows.map((row, i) => (
                <div key={`${row.id}:${i}`} className="rounded-lg border border-slate-100 p-3">
                  <p className="mb-2 break-words text-sm font-medium text-slate-800">{i + 1}. {row.question}</p>
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    <div className="min-w-0 break-words rounded-lg bg-slate-50 p-2.5">
                      <span className="block font-semibold text-slate-500">Your saved answer</span>
                      <span className="mt-1 block whitespace-pre-wrap text-slate-900">{row.yourAnswer}</span>
                    </div>
                    <div className="min-w-0 break-words rounded-lg bg-green-50 p-2.5">
                      <span className="block font-semibold text-green-700">Current answer key</span>
                      <span className="mt-1 block whitespace-pre-wrap text-green-900">{row.correctAnswer}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        ))}
        {writing && (
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-sm font-semibold text-slate-900">Writing submission and teacher feedback</p>
            {['task1', 'task2'].map((task, i) => (
              <div key={task}>
                <p className="text-xs font-semibold text-slate-700">Task {i + 1} · Band {review?.[`${task}Band`] || '—'}</p>
                <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm text-slate-800">{writing[task] || `No Task ${i + 1} answer saved.`}</p>
                {review?.[`${task}Feedback`] && (
                  <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">{review[`${task}Feedback`]}</p>
                )}
              </div>
            ))}
            {review?.generalFeedback && (
              <p className="whitespace-pre-wrap break-words rounded-lg bg-blue-50 p-3 text-sm text-blue-900">General feedback: {review.generalFeedback}</p>
            )}
            {reviewed && review?.overall !== undefined && review?.overall !== null && (
              <p className="text-sm font-semibold text-indigo-900">Overall Writing band: {review.overall}</p>
            )}
            {!reviewed && <p className="text-xs text-amber-800">Awaiting teacher review.</p>}
          </div>
        )}
      </div>
    )
  }

  function StudentResultsHistory({ user, category, resultsVisibility }) {
    const config = STUDENT_HISTORY_CONFIG[category]
    const [records, setRecords] = useState([])
    const [archivedAttempts, setArchivedAttempts] = useState([])
    const [loading, setLoading] = useState(true)
    const [historyLoading, setHistoryLoading] = useState(false)
    const [historyError, setHistoryError] = useState('')
    const [visibleCount, setVisibleCount] = useState(20)
    const [refreshNumber, setRefreshNumber] = useState(0)
    const [expandedReview, setExpandedReview] = useState(null)
    const reviewRequestRef = useRef(0)

    const visibleIdsKey = resultsVisibility?.ready && config
      ? [...(resultsVisibility.allowed?.[category] || [])].sort().join('\u001f')
      : ''

    // Keep Q2A's live head submissions untouched. Q2B adds server-authorized
    // immutable snapshots, which Firestore rules deliberately hide from browsers.
    useEffect(() => {
      setRecords([])
      setLoading(true)
      setVisibleCount(20)
      if (!user?.uid || !config) {
        setLoading(false)
        return undefined
      }
      return listenUserCollection(config.collection, user.uid, items => {
        setRecords(items.filter(item => item.deleted !== true && item.status !== 'deleted'))
        setLoading(false)
      }, { includeArchived: true })
    }, [user?.uid, category])

    useEffect(() => {
      let active = true
      setArchivedAttempts([])
      setHistoryError('')
      setHistoryLoading(Boolean(user?.uid && config && resultsVisibility?.ready && visibleIdsKey))
      if (!user?.uid || !config || !resultsVisibility?.ready || !visibleIdsKey) {
        return () => { active = false }
      }

      getStudentSubmissionAttemptHistoryCall({ contentType: category })
        .then(response => {
          if (!active) return
          const attempts = Array.isArray(response?.data?.attempts) ? response.data.attempts : []
          setArchivedAttempts(attempts)
        })
        .catch(error => {
          if (!active) return
          console.warn('Historical attempt summary unavailable:', error)
          setHistoryError(error?.message || 'Saved earlier attempts could not be loaded.')
        })
        .finally(() => { if (active) setHistoryLoading(false) })

      return () => { active = false }
    }, [user?.uid, category, visibleIdsKey, resultsVisibility?.ready, refreshNumber])

    useEffect(() => {
      reviewRequestRef.current += 1
      setExpandedReview(null)
    }, [category, user?.uid, visibleIdsKey])

    const sortedRecords = useMemo(() => {
      if (!config || !resultsVisibility?.ready) return []
      const byAttempt = new Map()
      // Q1B hard deletion removes both the live head and immutable snapshots.
      // Never keep displaying a cached old attempt after its head is deleted.
      const heads = new Set(records.map(record => normalizeId(historyContentId(record, config))))
      // The live submission head wins when the same attempt is also present
      // in a historical snapshot taken when a retake was opened.
      for (const record of [...archivedAttempts, ...records]) {
        const contentId = historyContentId(record, config)
        if (record.isHistorical === true && !heads.has(normalizeId(contentId))) continue
        if (!studentCanSeeResult(resultsVisibility, category, contentId)) continue
        const key = `${normalizeId(contentId)}\u001f${submissionAttemptNumber(record)}`
        const previous = byAttempt.get(key)
        if (!previous || (previous.isHistorical === true && record.isHistorical !== true)) {
          byAttempt.set(key, record)
        } else if (previous.isHistorical !== true && record.isHistorical !== true) {
          byAttempt.set(key, chooseCurrentSubmission([previous, record]))
        }
      }
      return [...byAttempt.values()].sort((a, b) => {
        const dateDiff = submissionTimeMillis(b) - submissionTimeMillis(a)
        if (dateDiff) return dateDiff
        const attemptDiff = submissionAttemptNumber(b) - submissionAttemptNumber(a)
        if (attemptDiff) return attemptDiff
        return (b.id || '').localeCompare(a.id || '')
      })
    }, [records, archivedAttempts, config, resultsVisibility, category])

    const openAttemptReview = async record => {
      const contentId = historyContentId(record, config)
      const attemptNumber = submissionAttemptNumber(record)
      const key = `${normalizeId(contentId)}:${attemptNumber}`
      const seq = ++reviewRequestRef.current
      if (expandedReview?.key === key) {
        setExpandedReview(null)
        return
      }
      setExpandedReview({ key, loading: true, payload: null, error: '' })
      try {
        const response = await getStudentSubmissionAttemptReviewCall({
          contentType: category,
          contentId,
          attemptNumber
        })
        if (reviewRequestRef.current !== seq) return
        if (!response?.data?.ok || !response?.data?.submission) {
          throw new Error('The selected attempt could not be reviewed.')
        }
        setExpandedReview({ key, loading: false, payload: response.data, error: '' })
      } catch (error) {
        if (reviewRequestRef.current !== seq) return
        const message = error?.code === 'functions/failed-precondition'
          ? 'A retake is currently open. Submit the new attempt before reviewing answer keys.'
          : error?.code === 'functions/permission-denied'
            ? 'Review access is not available. Your teacher may have archived or hidden this test.'
            : error?.message || 'The selected attempt could not be opened.'
        setExpandedReview({ key, loading: false, payload: null, error: message })
      }
    }

    const stillLoading = loading || !resultsVisibility?.ready
    if (!config) return null

    return (
      <section aria-label={`${config.label} attempt history`} className="mt-6 mb-8">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{config.label} — All attempts</h2>
            <p className="mt-1 text-xs text-slate-500">
              Archived tests and their results remain hidden until restored. Reopened retakes keep their earlier attempts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              {stillLoading ? 'Loading…' : `${sortedRecords.length} attempt${sortedRecords.length === 1 ? '' : 's'}`}
            </span>
            <button type="button" onClick={() => { setRefreshNumber(n => n + 1); reviewRequestRef.current += 1; setExpandedReview(null) }}
              disabled={historyLoading || stillLoading}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">
              {historyLoading ? 'Syncing…' : 'Refresh history'}
            </button>
          </div>
        </div>
        {historyError && (
          <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            Earlier attempt snapshots are temporarily unavailable: {historyError}. Current submissions are still displayed.
          </p>
        )}
        {historyLoading && !historyError && (
          <p className="mb-3 text-xs text-slate-500">Checking saved earlier attempts…</p>
        )}
        {stillLoading ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">Loading visible attempts…</div>
        ) : sortedRecords.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
            No visible {config.label.toLowerCase()} submissions. Archived tests and their results are hidden until restored.
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {sortedRecords.slice(0, visibleCount).map(record => {
                const contentId = historyContentId(record, config)
                const attemptNumber = submissionAttemptNumber(record)
                const reviewKey = `${normalizeId(contentId)}:${attemptNumber}`
                const isExpanded = expandedReview?.key === reviewKey
                return (
                  <article key={record.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-semibold text-slate-900">{historyTitle(record, config)}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Attempt {attemptNumber} · Submitted {historyDate(record)}
                        </p>
                        <p className="mt-3 text-sm font-medium text-slate-700">{historySummary(record, category)}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {record.excludedFromStats === true && (
                            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                              Excluded from statistics · Result retained
                            </span>
                          )}
                          {category === 'writing' && (
                            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${record.reviewed ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                              {record.reviewed ? 'Reviewed' : 'Awaiting teacher review'}
                            </span>
                          )}
                          {record.archived === true && (
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">Retained earlier attempt</span>
                          )}
                        </div>
                      </div>
                      <button type="button" onClick={() => openAttemptReview(record)}
                        className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700">
                        {isExpanded ? 'Close review' : `Review Attempt ${attemptNumber}`}
                      </button>
                    </div>
                    {isExpanded && expandedReview?.loading && (
                      <div className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">Loading this attempt’s saved answers…</div>
                    )}
                    {isExpanded && expandedReview?.error && (
                      <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{expandedReview.error}</div>
                    )}
                    {isExpanded && expandedReview?.payload && (
                      <StudentAttemptReview payload={expandedReview.payload} category={category}/>
                    )}
                  </article>
                )
              })}
            </div>
            {visibleCount < sortedRecords.length && (
              <button type="button" onClick={() => setVisibleCount(count => count + 20)}
                className="mt-4 rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50">
                Show 20 more attempts
              </button>
            )}
          </>
        )}
      </section>
    )
  }

  function StudentEmptyResults({ label }) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-700">
          <StudentWorkspaceIcon name="results" className="h-6 w-6" />
        </div>
        <p className="text-base font-semibold text-slate-800">No completed {label} work yet</p>
        <p className="mt-2 text-sm text-slate-500">Complete an assigned activity to see its results here.</p>
      </div>
    )
  }

  function StudentWorkspaceIcon({ name, className = 'h-5 w-5' }) {
    const glyphs = {
      overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
      homework: <><path d="M9 3h6l2 2h3v16H4V5h3l2-2Z"/><path d="M9 3v3h6V3M8 12l2 2 5-5M8 18h8"/></>,
      mock: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3.5h6M9 10h6M9 14h6M9 18h4"/></>,
      results: <><circle cx="12" cy="8" r="5"/><path d="m8 12-2 9 6-3 6 3-2-9M9.5 8l1.5 1.5L14.5 6"/></>,
      progress: <><path d="M3 21h18M6 18v-6M12 18V4M18 18V9"/></>,
      inbox: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m4 7 8 6 8-6"/></>,
      reading: <path d="M4 19V5c3-1.5 5.5-1.5 8 0 2.5-1.5 5-1.5 8 0v14c-3-1.5-5.5-1.5-8 0-2.5-1.5-5-1.5-8 0ZM12 5v14"/>,
      listening: <><path d="M4 12v-2a8 8 0 0 1 16 0v2M4 12h3v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2ZM20 12h-3v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2Z"/></>,
      writing: <><path d="m4 16 11-11a3 3 0 0 1 4 4L8 20l-5 1 1-5Z"/><path d="m13 7 4 4"/></>,
      vocabulary: <><path d="M5 4h14v16H5zM9 4v16M12 9h4M12 13h4M12 17h4"/></>,
      all: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10h8M8 14h8"/></>,
      lock: <><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>,
      exit: <><path d="M10 17l5-5-5-5M15 12H3M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7"/></>,
      arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
      target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
      spark: <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>,
      clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
      check: <path d="m4 12 5 5L20 6"/>,
    }
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {glyphs[name] || glyphs.overview}
      </svg>
    )
  }

  const STUDENT_WORKSPACE_NAV = [
    { id: 'overview', label: 'My Dashboard', icon: 'overview', description: 'Your learning priorities and latest achievements' },
    { id: 'todo', label: 'My Homework', icon: 'homework', description: 'All assignments, reading, listening, writing and vocabulary' },
    { id: 'mock', label: 'Mock Tests', icon: 'mock', description: 'IELTS mock examinations and your test history' },
    { id: 'results', label: 'My Results', icon: 'results', description: 'Review completed work and teacher feedback' },
    { id: 'analytics', label: 'My Progress', icon: 'progress', description: 'Your IELTS skills, accuracy and writing development' },
    { id: 'inbox', label: 'Messages & Files', icon: 'inbox', description: 'Updates and learning materials from your teacher' },
  ]

  const STUDENT_HOMEWORK_CATEGORIES = [
    { id: 'todo', label: 'All Homework', icon: 'all' },
    { id: 'reading', label: 'Reading', icon: 'reading' },
    { id: 'listening', label: 'Listening', icon: 'listening' },
    { id: 'writing', label: 'Writing', icon: 'writing' },
    { id: 'vocabulary', label: 'Vocabulary', icon: 'vocabulary' },
  ]

  const STUDENT_RESULT_CATEGORIES = [
    { id: 'reading', label: 'Reading', icon: 'reading' },
    { id: 'listening', label: 'Listening', icon: 'listening' },
    { id: 'writing', label: 'Writing', icon: 'writing' },
    { id: 'vocabulary', label: 'Vocabulary', icon: 'vocabulary' },
    { id: 'mock', label: 'Mock Tests', icon: 'mock' },
  ]

  export default function StudentDashboard() {
    const [scores, setScores] = useState([])
    const [user, setUser] = useState(null)
    const [showPasswordModal, setShowPasswordModal] = useState(false)
    const [newPassword, setNewPassword] = useState('')
    const [passwordMsg, setPasswordMsg] = useState('')
    const [resultsCategory, setResultsCategory] = useState('writing')
    const [resultsView, setResultsView] = useState('history')
    const [activeTab, setActiveTab] = useState(() => {
      try {
        const storedTab = window.sessionStorage.getItem('maxima_student_dashboard_active_tab')
        const allowedTabs = [
          'overview',
          'results',
          'todo',
          'reading',
          'listening',
          'writing',
          'vocabulary',
          'mock',
          'inbox',
          'analytics'
        ]

        return allowedTabs.includes(storedTab) ? storedTab : 'overview'
      } catch {
        return 'overview'
      }
    })
    const [profile, setProfile] = useState(null)
    const [dashboardLoadError, setDashboardLoadError] = useState('')
    const [dataSyncErrors, setDataSyncErrors] = useState({})
    const [authRetryKey, setAuthRetryKey] = useState(0)
    const navigate = useNavigate()
    const resultsVisibility = useStudentResultsVisibility(user, profile)

    useEffect(() => {
      try {
        window.sessionStorage.setItem('maxima_student_dashboard_active_tab', activeTab)
      } catch {
        // Browser storage can be unavailable in restricted/private contexts.
      }
    }, [activeTab])

    const targetBand = profile?.targetBand !== undefined && profile?.targetBand !== null
      ? Number(profile.targetBand)
      : null

    useEffect(() => {
      const handleDataError = event => {
        const key = event?.detail?.key
        if (!key) return

        setDataSyncErrors(previous => {
          const next = { ...previous }
          const message = event?.detail?.message

          if (message) {
            next[key] = message
          } else {
            delete next[key]
          }

          return next
        })
      }

      window.addEventListener(STUDENT_DATA_ERROR_EVENT, handleDataError)

      return () => {
        window.removeEventListener(STUDENT_DATA_ERROR_EVENT, handleDataError)
      }
    }, [])

    useEffect(() => {
      let unsubScores = null
      let active = true

      const unsubAuth = onAuthStateChanged(auth, async currentUser => {
        if (unsubScores) {
          unsubScores()
          unsubScores = null
        }

        if (!currentUser) {
          navigate('/login')
          return
        }

        try {
          const profileSnap = await getDoc(doc(db, 'users', currentUser.uid))

          if (!active) return

          if (!profileSnap.exists()) {
            await signOut(auth)
            navigate('/login')
            return
          }

          const profile = profileSnap.data()

          if (
            profile.deleted ||
            profile.status === 'deleted' ||
            profile.status === 'pending' ||
            profile.status === 'rejected' ||
            profile.role !== 'student'
          ) {
            await signOut(auth)
            navigate('/login')
            return
          }

          if (profile.accountType === 'individual' || profile.schoolId === '__individual__') {
            navigate('/self-study', { replace: true })
            return
          }

          setUser(currentUser)
          setProfile(profile)

          setDashboardLoadError('')

          unsubScores = listenUserCollection(
            'scores',
            currentUser.uid,
            setScores,
            { sort: (a, b) => new Date(b.date || 0) - new Date(a.date || 0) }
          )
        } catch (error) {
          console.error('Could not load student profile:', error)

          if (active) {
            setDashboardLoadError(
              'We could not refresh your student profile. Check your connection and try again.'
            )
          }
        }
      })

      return () => {
        active = false
        unsubAuth()

        if (unsubScores) {
          unsubScores()
        }
      }
    }, [navigate, authRetryKey])

    const dataSyncErrorCount = Object.keys(dataSyncErrors).length

    if (dashboardLoadError && !user) {
      return (
        <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
          <div className="w-full max-w-md bg-white border border-red-100 rounded-2xl p-6 shadow-sm text-center">
            <div className="text-3xl mb-3">⚠️</div>
            <h1 className="text-lg font-semibold text-gray-900 mb-2">
              Dashboard could not refresh
            </h1>
            <p className="text-sm text-gray-500 leading-6 mb-5">
              {dashboardLoadError}
            </p>
            <button
              type="button"
              onClick={() => {
                setDashboardLoadError('')
                setAuthRetryKey(value => value + 1)
              }}
              className="bg-purple-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-purple-700"
            >
              Retry
            </button>
          </div>
        </div>
      )
    }

    const mockScores = dedupeSubmissionHeads(
      scores.filter(score =>
        score.source === 'mock_test' &&
        studentCanSeeResult(resultsVisibility, 'mock', score.mockTestId || score.mockId)
      ),
      score => score.mockTestId || score.mockId || score.id
    )
    const latestMockScore = mockScores.find(score => score.excludedFromStats !== true)

    const displayName = getStudentDisplayName(profile, user)
    const firstName = getFirstName(profile, user)
    const todayText = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', month: 'short', day: 'numeric'
    })
    const homeworkSectionIds = ['todo', 'reading', 'listening', 'writing', 'vocabulary']
    const studentSectionId = homeworkSectionIds.includes(activeTab) ? 'todo' : activeTab
    const studentPage = STUDENT_WORKSPACE_NAV.find(item => item.id === studentSectionId) || STUDENT_WORKSPACE_NAV[0]
    const targetDisplay = Number.isFinite(targetBand) && targetBand > 0
      ? targetBand.toFixed(1)
      : '--'
    const latestMockDisplay = formatBand(latestMockScore?.overall)

    const renderOverview = () => (
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-[26px] bg-slate-900 text-white shadow-sm">
          <div className="absolute -right-12 -top-20 h-64 w-64 rounded-full bg-indigo-500/20 blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 right-1/3 h-36 w-36 rounded-full bg-sky-500/10 blur-3xl pointer-events-none" />
          <div className="relative grid gap-6 p-6 sm:p-8 xl:grid-cols-[1.15fr_0.85fr] xl:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.17em] text-indigo-200 mb-3">{todayText} · Your learning space</p>
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">Welcome back, {firstName}.</h2>
              <p className="mt-3 text-sm leading-7 text-slate-300 max-w-xl">
                Focus on your next assignment, check your feedback and keep moving toward your IELTS goal.
              </p>
              <div className="flex flex-wrap gap-2 mt-5">
                <button type="button" onClick={() => setActiveTab('todo')}
                  className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-indigo-50">
                  My Homework <StudentWorkspaceIcon name="arrow" className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setActiveTab('results')}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/20">
                  View feedback
                </button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <div className="rounded-2xl border border-white/10 bg-white/10 p-3 sm:p-4">
                <p className="text-[11px] text-slate-300">Target band</p>
                <p className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums">{targetDisplay}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-3 sm:p-4">
                <p className="text-[11px] text-slate-300">Latest mock</p>
                <p className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums">{latestMockDisplay}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-3 sm:p-4">
                <p className="text-[11px] text-slate-300">Mock history</p>
                <p className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums">{mockScores.length}</p>
              </div>
            </div>
          </div>
        </section>

        <StudentTodoSummary user={user} profile={profile} compact onViewAll={() => setActiveTab('todo')} />

        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Explore your learning</h3>
              <p className="text-sm text-slate-500 mt-1">Your exams, teacher comments and performance are one click away.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { key: 'mock', icon: 'mock', label: 'Mock Tests', description: 'Start or review an IELTS mock examination' },
              { key: 'results', icon: 'results', label: 'My Results', description: 'Read feedback and revisit completed homework' },
              { key: 'analytics', icon: 'progress', label: 'My Progress', description: 'See your strong and weak question types' },
            ].map(item => (
              <button key={item.key} type="button" onClick={() => setActiveTab(item.key)}
                className="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
                <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
                  <StudentWorkspaceIcon name={item.icon} className="h-5 w-5" />
                </span>
                <span className="flex items-center justify-between gap-2 font-semibold text-slate-900">
                  {item.label}<StudentWorkspaceIcon name="arrow" className="h-4 w-4 text-slate-400 group-hover:text-indigo-700" />
                </span>
                <p className="mt-2 text-xs leading-5 text-slate-500">{item.description}</p>
              </button>
            ))}
          </div>
        </section>
      </div>
    )

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

    return (
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <div className="min-h-screen lg:flex">
          {/* Desktop learning navigation */}
          <aside className="hidden lg:flex lg:w-64 xl:w-72 shrink-0 flex-col border-r border-slate-200 bg-white sticky top-0 h-screen">
            <div className="px-6 py-7 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <img src="/1.png" alt="Maxima" className="h-9 max-w-[116px] object-contain" />
                <div className="border-l border-slate-200 pl-3">
                  <p className="text-xs font-bold tracking-wider text-slate-800">MAXIMA</p>
                  <p className="text-[11px] text-slate-500">Student Learning Hub</p>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-6">
              <p className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[.16em] text-slate-400">My workspace</p>
              <nav className="space-y-1" aria-label="Student navigation">
                {STUDENT_WORKSPACE_NAV.map(item => (
                  <button key={item.id} type="button" onClick={() => setActiveTab(item.id)}
                    aria-current={studentSectionId === item.id ? 'page' : undefined}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition-colors ${
                      studentSectionId === item.id
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}>
                    <StudentWorkspaceIcon name={item.icon} />
                    <span className="min-w-0 flex-1">{item.label}</span>
                  </button>
                ))}
              </nav>
              <div className="mt-7 border-t border-slate-100 pt-5">
                <p className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[.16em] text-slate-400">Quick access</p>
                <div className="space-y-1">
                  {STUDENT_HOMEWORK_CATEGORIES.slice(1).map(item => (
                    <button key={item.id} type="button" onClick={() => setActiveTab(item.id)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-xs font-medium ${
                        activeTab === item.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                      }`}>
                      <StudentWorkspaceIcon name={item.icon} className="h-4 w-4" />{item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="border-t border-slate-100 px-6 py-5">
              <p className="text-xs font-semibold text-slate-800 truncate" title={displayName}>{displayName}</p>
              <p className="mt-1 truncate text-[11px] text-slate-500" title={user?.email}>{user?.email}</p>
              <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <StudentWorkspaceIcon name="target" className="h-4 w-4 text-indigo-600" /> Target band {targetDisplay}
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
              <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-7 lg:px-9">
                <div className="flex min-w-0 items-center gap-3">
                  <img src="/1.png" alt="Maxima" className="h-8 max-w-[100px] object-contain lg:hidden" />
                  <p className="hidden text-sm font-semibold text-slate-800 sm:block">Student Learning Hub</p>
                  <span className="rounded-md bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700">STUDENT</span>
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:gap-3">
                  <span className="hidden max-w-[210px] truncate text-xs text-slate-500 xl:block" title={user?.email}>{user?.email}</span>
                  <button type="button" onClick={() => setShowPasswordModal(true)}
                    className="inline-flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
                    aria-label="Change password">
                    <StudentWorkspaceIcon name="lock" className="h-4 w-4" /><span className="hidden sm:inline">Password</span>
                  </button>
                  <button type="button" onClick={() => { signOut(auth); navigate('/') }}
                    className="inline-flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500" aria-label="Sign out">
                    <StudentWorkspaceIcon name="exit" className="h-4 w-4" /><span className="hidden sm:inline">Sign out</span>
                  </button>
                </div>
              </div>
              <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:hidden" aria-label="Mobile student navigation">
                {STUDENT_WORKSPACE_NAV.map(item => (
                  <button key={item.id} type="button" onClick={() => setActiveTab(item.id)}
                    aria-current={studentSectionId === item.id ? 'page' : undefined}
                    className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium ${
                      studentSectionId === item.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
                    }`}>
                    <StudentWorkspaceIcon name={item.icon} className="h-4 w-4" />{item.label}
                  </button>
                ))}
              </nav>
            </header>

            <main className="mx-auto max-w-[1440px] px-4 pb-20 pt-7 sm:px-7 sm:pt-9 lg:px-9">
              {dataSyncErrorCount > 0 && (
                <div role="alert" className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-amber-800">Some dashboard data could not refresh.</p>
                    <p className="mt-1 text-xs text-amber-700">Your last successfully loaded data is still shown. Refresh when your connection is stable.</p>
                  </div>
                  <button type="button" onClick={() => window.location.reload()}
                    className="shrink-0 self-start rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 sm:self-auto">
                    Refresh data
                  </button>
                </div>
              )}

              <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[.12em] text-indigo-700">Maxima / Student</p>
                  <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{studentPage.label}</h1>
                  <p className="mt-2 max-w-2xl text-sm text-slate-500">{studentPage.description}</p>
                </div>
                {studentSectionId !== 'overview' && (
                  <button type="button" onClick={() => setActiveTab('overview')}
                    className="inline-flex shrink-0 items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-indigo-200 hover:text-indigo-700">
                    <StudentWorkspaceIcon name="overview" className="h-4 w-4" /> Back to Dashboard
                  </button>
                )}
              </div>

              {studentSectionId === 'todo' && (
                <nav aria-label="Homework categories" className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
                  {STUDENT_HOMEWORK_CATEGORIES.map(item => (
                    <button key={item.id} type="button" onClick={() => setActiveTab(item.id)}
                      aria-current={activeTab === item.id ? 'page' : undefined}
                      className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium ${
                        activeTab === item.id ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                      }`}>
                      <StudentWorkspaceIcon name={item.icon} className="h-4 w-4" />{item.label}
                    </button>
                  ))}
                </nav>
              )}

              {activeTab === 'results' && (
                <>
                  <div className="mb-5 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
                    All Attempts lists saved results from tests you can currently access. Archived tests and their results are hidden until a teacher restores them; earlier retake attempts remain available. Use Current Assignment Reviews for existing review screens.
                  </div>
                  <nav aria-label="Completed work categories" className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
                    {STUDENT_RESULT_CATEGORIES.map(item => (
                      <button key={item.id} type="button" onClick={() => setResultsCategory(item.id)}
                        aria-current={resultsCategory === item.id ? 'page' : undefined}
                        className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium ${
                          resultsCategory === item.id ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                        }`}>
                        <StudentWorkspaceIcon name={item.icon} className="h-4 w-4" />{item.label}
                      </button>
                    ))}
                  </nav>
                  <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Results view">
                    <button type="button" onClick={() => setResultsView('history')}
                      aria-pressed={resultsView === 'history'}
                      className={`rounded-xl border px-4 py-2 text-sm font-medium ${resultsView === 'history' ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                      All Attempts
                    </button>
                    <button type="button" onClick={() => setResultsView('active')}
                      aria-pressed={resultsView === 'active'}
                      className={`rounded-xl border px-4 py-2 text-sm font-medium ${resultsView === 'active' ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                      Current Assignment Reviews
                    </button>
                  </div>
                </>
              )}

              {activeTab === 'overview' && renderOverview()}
              {activeTab === 'todo' && <StudentTodoSummary user={user} profile={profile} />}
              {activeTab === 'reading' && <ReadingHomeworkSection user={user} profile={profile} />}
              {activeTab === 'listening' && <ListeningHomeworkSection user={user} profile={profile} />}
              {activeTab === 'writing' && <WritingHomeworkSection user={user} profile={profile} />}
              {activeTab === 'vocabulary' && <VocabularyHomeworkSection user={user} profile={profile} />}

              {activeTab === 'mock' && (
                <>
                  <MockAnalysis user={user} profile={profile} resultsVisibility={resultsVisibility} />
                  <MockTestSection user={user} profile={profile} />
                </>
              )}

              {activeTab === 'results' && (
                <div>
                  {resultsView === 'history' && <StudentResultsHistory user={user} category={resultsCategory} resultsVisibility={resultsVisibility} />}
                  {resultsView === 'active' && (
                    <>
                      {resultsCategory === 'reading' && <ReadingHomeworkSection user={user} profile={profile} mode="completed" />}
                      {resultsCategory === 'listening' && <ListeningHomeworkSection user={user} profile={profile} mode="completed" />}
                      {resultsCategory === 'writing' && <WritingHomeworkSection user={user} profile={profile} mode="completed" />}
                      {resultsCategory === 'vocabulary' && <VocabularyHomeworkSection user={user} profile={profile} mode="completed" />}
                      {resultsCategory === 'mock' && <MockTestSection user={user} profile={profile} mode="completed" />}
                    </>
                  )}
                </div>
              )}

              {activeTab === 'inbox' && <StudentCommunicationCenter user={user} />}
              {activeTab === 'analytics' && (
                <>
                  <StudentSkillAnalytics user={user} profile={profile} resultsVisibility={resultsVisibility} />
                  <WritingProgressAnalytics user={user} profile={profile} resultsVisibility={resultsVisibility} />
                </>
              )}
            </main>
          </div>
        </div>

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
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
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
