  import { useState, useEffect } from 'react'
  import { auth, db, storage, functions } from '../firebase'
  import { collection, query, where, onSnapshot, doc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore'
  import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
  import { ref as storageRef, getDownloadURL } from 'firebase/storage'
  import { useNavigate } from 'react-router-dom'
  import { httpsCallable } from 'firebase/functions'

  const getStudentSubmissionAttemptStateCall = httpsCallable(
    functions,
    'getStudentSubmissionAttemptState'
  )

  function normalizeId(value) {
    return value === undefined || value === null
      ? ''
      : value.toString().trim().toLowerCase()
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

    const q = query(
      collection(db, collectionName),
      where('uid', '==', uid)
    )

    return subscribeSharedSnapshot(
      `uid:${collectionName}:${uid}`,
      q,
      items => {
        let nextItems = items.filter(item => item.archived !== true)

        if (typeof options.filter === 'function') {
          nextItems = nextItems.filter(options.filter)
        }

        if (typeof options.sort === 'function') {
          nextItems = [...nextItems].sort(options.sort)
        }

        onItems(nextItems)
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

    submissions.forEach(submission => {
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


  function StudentSkillAnalytics({ user, profile }) {
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

    const readingAnalytics = calculateSkillAnalytics(
      readings,
      readingSubmissions,
      'readingId',
      ['matching', 'matchingInformation', 'sentenceEndings', 'summaryOptions', 'mcq', 'fitb', 'tfng', 'table', 'summary', 'note', 'noteCompletion', 'shortAnswer'],
      { mcq_multi: 'mcq' }
    )

    const listeningAnalytics = calculateSkillAnalytics(
      listenings,
      listeningSubmissions,
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
        readingSubmissions.some(sub => sub.readingId === reading.id)
      ).length,
      assigned: readings.length
    }

    const listeningCompletion = {
      completed: listenings.filter(listening =>
        listeningSubmissions.some(sub => sub.listeningId === listening.id)
      ).length,
      assigned: listenings.length
    }

    const hasData =
      readingSubmissions.length > 0 ||
      listeningSubmissions.length > 0 ||
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


  function ReadingHomeworkSection({ user, profile }) {
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

    const getSubmission = readingId =>
      submissions.find(s => s.readingId === readingId)

    const getAttemptState = readingId => attemptStates[readingId] || null

    const hasOpenRetake = readingId =>
      getAttemptState(readingId)?.open === true

    const isDone = readingId =>
      Boolean(getSubmission(readingId)) && !hasOpenRetake(readingId)

    const getResult = readingId =>
      getSubmission(readingId)?.result

    const todoReadings = readings.filter(r => !isDone(r.id))
    const completedReadings = readings.filter(r => isDone(r.id))

    if (readings.length === 0) return null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          📖 Reading Homework
        </h2>

        {todoReadings.length > 0 && (
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
                    className="bg-white border border-red-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
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
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {r.title}
                      </p>

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


  function ListeningHomeworkSection({ user, profile }) {
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

    const isDone = listeningId =>
      submissions.some(s => s.listeningId === listeningId)

    const getResult = listeningId =>
      submissions.find(s => s.listeningId === listeningId)?.result

    const todoListenings = listenings.filter(l => !isDone(l.id))
    const completedListenings = listenings.filter(l => isDone(l.id))

    if (listenings.length === 0) return null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          🎧 Listening Homework
        </h2>

        {todoListenings.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoListenings.map((l, index) => {
                const badge = dueLabel(l)

                return (
                  <div
                    key={l.id}
                    className="bg-white border border-red-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
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

                        <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                          Not completed
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-listening/${l.id}`)}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700"
                    >
                      Start →
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

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
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {l.title}
                      </p>

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



  function MockAnalysis({ user, profile }) {
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

    const fullMockSubmissions = mockSubmissions.filter(
      submission => getSubmissionMockType(submission) !== 'mini_mock'
    )
    const miniMockSubmissions = mockSubmissions.filter(
      submission => getSubmissionMockType(submission) === 'mini_mock'
    )

    const completedFull = fullMockSubmissions.length
    const completedMini = miniMockSubmissions.length
    const latest = fullMockSubmissions[0]
    const previous = fullMockSubmissions[1]

    const latestOverall = getMockOverall(latest)
    const previousOverall = getMockOverall(previous)

    const trend = [...fullMockSubmissions]
      .reverse()
      .slice(-6)

    const overallChange = getChangeLabel(latestOverall, previousOverall)
    const latestMockTitle = latest
      ? getSubmissionMock(latest)?.title || latest.mockTitle || latest.title || 'Mock Test'
      : 'No Full Mock completed yet'

    if (mockSubmissions.length === 0) {
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
              {getWritingStatus(latest)}
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
            {mockSubmissions.slice(0, 6).map(submission => {
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


  function VocabularyHomeworkSection({ user, profile }) {
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

    const isDone = vocabularyTestId =>
      submissions.some(submission =>
        isVocabularySubmissionForTest(submission, vocabularyTestId)
      )

    const getResult = vocabularyTestId =>
      submissions.find(submission =>
        isVocabularySubmissionForTest(submission, vocabularyTestId)
      )?.result

    const todoVocabularyTests = vocabularyTests.filter(item => !isDone(item.id))
    const completedVocabularyTests = vocabularyTests.filter(item => isDone(item.id))

    if (vocabularyTests.length === 0) return null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          🧩 Vocabulary Tests
        </h2>

        {todoVocabularyTests.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoVocabularyTests.map((item, index) => {
                const badge = dueLabel(item)

                return (
                  <div
                    key={item.id}
                    className="bg-white border border-red-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
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

                        <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                          Not completed
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-vocabulary/${item.id}`)}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700"
                    >
                      Start →
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

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
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {item.title}
                      </p>

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


  function MockTestSection({ user, profile }) {
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

    const getSubmission = mockId =>
      submissions.find(submission => submission.mockTestId === mockId)

    const todoMocks = mocks.filter(mock => !getSubmission(mock.id))
    const completedMocks = mocks.filter(mock => getSubmission(mock.id))

    if (mocks.length === 0) return null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          🧠 Mock Tests
        </h2>

        {todoMocks.length > 0 && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
              To Do
            </p>

            <div className="flex flex-col gap-3">
              {todoMocks.map((mock, index) => {
                const badge = dueLabel(mock)

                return (
                  <div
                    key={mock.id}
                    className="bg-white border border-purple-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
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

                        <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                          Not completed
                        </span>

                        {hasSavedMockProgress(mock.id) && (
                          <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                            Progress saved
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-mock/${mock.id}`)}
                      className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700"
                    >
                      {hasSavedMockProgress(mock.id) ? 'Resume →' : 'Start →'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

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
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {mock.title}
                      </p>

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


  function WritingProgressAnalytics({ user, profile }) {
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

    const reviewed = submissions
      .filter(sub => {
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

  function WritingHomeworkSection({ user, profile }) {
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

    const getSubmission = writingId =>
      submissions.find(s => s.writingId === writingId)

    const getAttemptState = writingId => attemptStates[writingId] || null

    const hasOpenRetake = writingId =>
      getAttemptState(writingId)?.open === true

    const isDone = writingId =>
      Boolean(getSubmission(writingId)) && !hasOpenRetake(writingId)

    const todoWritings = writings.filter(w => !isDone(w.id))
    const completedWritings = writings.filter(w => isDone(w.id))

    if (writings.length === 0) return null

    return (
      <div className="mt-8 mb-8">
        <h2 className="font-semibold text-gray-800 mb-4">
          ✍️ Writing Homework
        </h2>

        {todoWritings.length > 0 && (
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
                    className="bg-white border border-red-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
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
                    className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {index + 1}. {w.title}
                      </p>

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
                        onClick={() =>
                          setSelectedReview({
                            writing: w,
                            submission
                          })
                        }
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


  function StudentTodoSummary({ user, profile }) {
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

    const hasListeningSubmission = listeningId =>
      listeningSubmissions.some(submission => submission.listeningId === listeningId)

    const hasOpenWritingRetake = writingId =>
      writingAttemptStates[writingId]?.open === true

    const hasWritingSubmission = writingId =>
      !hasOpenWritingRetake(writingId) &&
      writingSubmissions.some(submission => submission.writingId === writingId)

    const hasVocabularySubmission = vocabularyTestId =>
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

    const hasMockSubmission = mockId =>
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
          color: 'purple'
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
          color: 'violet'
        })),
      ...mocks
        .filter(item => !hasMockSubmission(item.id))
        .map(item => ({
          ...item,
          type: 'Mock Test',
          icon: '🧠',
          path: `/do-mock/${item.id}`,
          color: 'green'
        }))
    ].sort(sortByAssignedDateDesc)

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
              🔔 New / Remaining Homework
            </h2>

            <p className="text-xs text-gray-400 mt-1">
              Newly assigned or unfinished tasks are listed here.
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

        {todoItems.length === 0 ? (
          <div className="bg-green-50 text-green-700 rounded-xl p-4 text-sm">
            ✅ No remaining homework right now.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {todoItems.map((item, index) => {
              const badge = dueLabel(item)

              return (
                <div
                  key={`${item.type}-${item.id}`}
                  className="border border-gray-100 bg-gray-50 rounded-xl p-4 flex items-center justify-between gap-4"
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
                    className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700"
                  >
                    {item.isRetake ? 'Continue Retake →' : 'Start →'}
                  </button>
                </div>
              )
            })}

            {todoItems.length > 5 && (
              <p className="text-xs text-gray-400 text-center pt-1">
                Showing all remaining homework.
              </p>
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

  export default function StudentDashboard() {
    const [scores, setScores] = useState([])
    const [user, setUser] = useState(null)
    const [showPasswordModal, setShowPasswordModal] = useState(false)
    const [newPassword, setNewPassword] = useState('')
    const [passwordMsg, setPasswordMsg] = useState('')
    const [activeTab, setActiveTab] = useState('overview')
    const [profile, setProfile] = useState(null)
    const [dashboardLoadError, setDashboardLoadError] = useState('')
    const [dataSyncErrors, setDataSyncErrors] = useState({})
    const [authRetryKey, setAuthRetryKey] = useState(0)
    const navigate = useNavigate()

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

          setUser(currentUser)
          setProfile(profile)

          const q = query(
            collection(db, 'scores'),
            where('uid', '==', currentUser.uid)
          )

          setDashboardLoadError('')

          unsubScores = subscribeSharedSnapshot(
            `uid:scores:${currentUser.uid}`,
            q,
            items => {
              const data = items
                .filter(item => item.archived !== true)
                .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))

              setScores(data)
            }
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

    const mockScores = scores.filter(score => score.source === 'mock_test')
    const latestMockScore = mockScores[0]

    const overviewCards = [
      {
        title: 'Latest Mock Estimate',
        value: latestMockScore ? latestMockScore.overall : '--',
        note: latestMockScore ? latestMockScore.date || 'Mock completed' : 'No mock completed yet',
        style: 'bg-gray-900 text-white',
        valueStyle: 'text-white'
      },
      {
        title: 'Target Band',
        value: targetBand ? targetBand.toFixed(1) : 'Not set',
        note: targetBand
          ? 'Your target band set by admin'
          : 'Ask admin to set your target',
        style: 'bg-blue-50 text-gray-900',
        valueStyle: 'text-blue-600'
      },
      {
        title: 'Mock History',
        value: mockScores.length,
        note: mockScores.length === 1 ? '1 mock score saved' : `${mockScores.length} mock scores saved`,
        style: 'bg-purple-50 text-gray-900',
        valueStyle: 'text-purple-600'
      }
    ]

    const displayName = getStudentDisplayName(profile, user)
    const firstName = getFirstName(profile, user)
    const todayText = new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    })

    const tabs = [
      { key: 'overview', label: 'Overview', icon: '🏠' },
      { key: 'todo', label: 'To Do', icon: '🔔' },
      { key: 'reading', label: 'Reading', icon: '📖' },
      { key: 'listening', label: 'Listening', icon: '🎧' },
      { key: 'writing', label: 'Writing', icon: '✍️' },
      { key: 'vocabulary', label: 'Vocabulary', icon: '🧩' },
      { key: 'mock', label: 'Mock Tests', icon: '🧠' },
      { key: 'inbox', label: 'Messages & Files', icon: '💬' },
      { key: 'analytics', label: 'Analytics', icon: '📊' }
    ]

    const activeTabMeta = tabs.find(tab => tab.key === activeTab) || tabs[0]

    const renderOverview = () => (
      <div>
        <StudentTodoSummary user={user} profile={profile} />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {overviewCards.map(card => (
            <div
              key={card.title}
              className={`${card.style} rounded-2xl p-5 border border-gray-100`}
            >
              <p className="text-xs opacity-70 mb-1">
                {card.title}
              </p>

              <p className={`text-3xl font-bold ${card.valueStyle}`}>
                {card.value}
              </p>

              <p className="text-xs opacity-60 mt-2">
                {card.note}
              </p>
            </div>
          ))}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                🧠 Mock Progress
              </h2>

              <p className="text-sm text-gray-400 mt-1">
                Manual IELTS score logging was removed. Your progress is now based on mock tests, homework analytics and writing reviews.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setActiveTab('mock')}
              className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700"
            >
              View Mock History →
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button
            onClick={() => setActiveTab('todo')}
            className="bg-white border border-gray-100 rounded-2xl p-5 text-left hover:border-purple-200 hover:shadow-sm"
          >
            <p className="font-semibold text-gray-800 mb-1">
              🔔 To Do
            </p>

            <p className="text-sm text-gray-400">
              See new or remaining homework first.
            </p>
          </button>

          <button
            onClick={() => setActiveTab('mock')}
            className="bg-white border border-gray-100 rounded-2xl p-5 text-left hover:border-purple-200 hover:shadow-sm"
          >
            <p className="font-semibold text-gray-800 mb-1">
              🧠 Mock Tests
            </p>

            <p className="text-sm text-gray-400">
              Start or review your full IELTS mock tests.
            </p>
          </button>

          <button
            onClick={() => setActiveTab('analytics')}
            className="bg-white border border-gray-100 rounded-2xl p-5 text-left hover:border-purple-200 hover:shadow-sm"
          >
            <p className="font-semibold text-gray-800 mb-1">
              📊 Analytics
            </p>

            <p className="text-sm text-gray-400">
              See your reading, listening and writing progress.
            </p>
          </button>
        </div>
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
      <div className="min-h-screen bg-[#faf9f6]">
        <nav className="flex justify-between items-center px-4 sm:px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-40">
          <img
            src="/1.png"
            alt="Maxima"
            className="h-12 sm:h-14 object-contain"
          />

          <div className="flex items-center gap-2 sm:gap-4">
            <span className="hidden md:inline text-sm text-gray-400">
              {user?.email}
            </span>

            <button
              onClick={() => setShowPasswordModal(true)}
              className="text-xs sm:text-sm text-gray-400 hover:text-gray-600 bg-gray-50 px-3 py-2 rounded-xl"
            >
              Password
            </button>

            <button
              onClick={() => {
                signOut(auth)
                navigate('/')
              }}
              className="text-xs sm:text-sm text-gray-400 hover:text-gray-600 bg-gray-50 px-3 py-2 rounded-xl"
            >
              Logout
            </button>
          </div>
        </nav>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-10">
          {dataSyncErrorCount > 0 && (
            <div className="mb-5 bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Some dashboard data could not refresh.</p>
                <p className="text-xs text-amber-700 mt-1">
                  Your last successfully loaded data is still shown. Refresh when your connection is stable.
                </p>
              </div>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="self-start sm:self-auto bg-white border border-amber-200 px-3 py-2 rounded-xl text-xs font-semibold hover:bg-amber-100"
              >
                Refresh data
              </button>
            </div>
          )}

          <div className="bg-gray-900 text-white rounded-[2rem] p-6 md:p-8 mb-6 overflow-hidden relative">
            <div className="absolute -right-12 -top-12 w-48 h-48 bg-purple-500/20 rounded-full blur-2xl" />
            <div className="absolute right-20 bottom-0 w-36 h-36 bg-blue-500/10 rounded-full blur-2xl" />

            <div className="relative grid grid-cols-1 lg:grid-cols-[1.25fr_0.75fr] gap-6 items-end">
              <div>
                <p className="text-xs text-purple-200 uppercase tracking-[0.18em] mb-3">
                  {todayText}
                </p>

                <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3">
                  Welcome back, {firstName}
                </h1>

                <p className="text-sm md:text-base text-gray-300 max-w-2xl leading-7">
                  Your IELTS homework, mock tests, feedback and progress are all here. Start with your To Do list, then check your analytics.
                </p>

                <div className="flex flex-wrap gap-2 mt-5">
                  <button
                    type="button"
                    onClick={() => setActiveTab('todo')}
                    className="bg-white text-gray-900 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-100"
                  >
                    View To Do →
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('mock')}
                    className="bg-white/10 text-white border border-white/10 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-white/15"
                  >
                    Mock Tests
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('analytics')}
                    className="bg-white/10 text-white border border-white/10 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-white/15"
                  >
                    Analytics
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="bg-white/10 border border-white/10 rounded-2xl p-4">
                  <p className="text-[11px] text-gray-300 mb-1">Latest Mock</p>
                  <p className="text-2xl font-bold">{latestMockScore ? latestMockScore.overall : '--'}</p>
                </div>

                <div className="bg-white/10 border border-white/10 rounded-2xl p-4">
                  <p className="text-[11px] text-gray-300 mb-1">Mock Count</p>
                  <p className="text-2xl font-bold">{mockScores.length}</p>
                </div>

                <div className="bg-white/10 border border-white/10 rounded-2xl p-4">
                  <p className="text-[11px] text-gray-300 mb-1">Target</p>
                  <p className="text-2xl font-bold">{targetBand ? targetBand.toFixed(1) : '--'}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900">
                {activeTabMeta.icon} {activeTabMeta.label}
              </h2>

              <p className="text-sm text-gray-400 mt-1">
                {displayName} · {user?.email}
              </p>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-2 flex gap-2 overflow-x-auto max-w-full shadow-sm">
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`whitespace-nowrap px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    activeTab === tab.key
                      ? 'bg-purple-600 text-white shadow-sm'
                      : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  <span className="mr-1.5">{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'overview' && renderOverview()}

          {activeTab === 'todo' && (
            <StudentTodoSummary user={user} profile={profile} />
          )}

          {activeTab === 'reading' && (
            <ReadingHomeworkSection user={user} profile={profile} />
          )}

          {activeTab === 'listening' && (
            <ListeningHomeworkSection user={user} profile={profile} />
          )}

          {activeTab === 'writing' && (
            <WritingHomeworkSection user={user} profile={profile} />
          )}

          {activeTab === 'vocabulary' && (
            <VocabularyHomeworkSection user={user} profile={profile} />
          )}

          {activeTab === 'mock' && (
            <>
              <MockAnalysis user={user} profile={profile} />

              <MockTestSection user={user} profile={profile} />
            </>
          )}

          {activeTab === 'inbox' && (
            <StudentCommunicationCenter user={user} />
          )}

          {activeTab === 'analytics' && (
            <>
              <StudentSkillAnalytics user={user} profile={profile} />

              <WritingProgressAnalytics user={user} profile={profile} />
            </>
          )}
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