  import { useState, useEffect } from 'react'
  import { auth, db } from '../firebase'
  import { collection, query, where, onSnapshot, doc, getDoc } from 'firebase/firestore'
  import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
  import { useNavigate } from 'react-router-dom'

  function uniqueCleanValues(values) {
    return Array.from(
      new Set(
        values
          .filter(value => value !== undefined && value !== null)
          .map(value => value.toString().trim())
          .filter(Boolean)
      )
    )
  }

  function getCurrentUserAssignmentValues(userOrUid, profile) {
    if (!userOrUid) return []

    if (typeof userOrUid === 'string') {
      return uniqueCleanValues([
        userOrUid,
        profile?.uid,
        profile?.id,
        profile?.email,
        profile?.email?.toLowerCase()
      ])
    }

    return uniqueCleanValues([
      userOrUid?.uid,
      userOrUid?.email,
      userOrUid?.email?.toLowerCase(),
      profile?.uid,
      profile?.id,
      profile?.email,
      profile?.email?.toLowerCase()
    ])
  }

  const isHiddenForCurrentUser = (item, userOrUid, profile) => {
    if (!Array.isArray(item?.hiddenFor)) return false

    const hiddenValues = item.hiddenFor.map(normalizeId)
    const currentUserValues = getCurrentUserAssignmentValues(userOrUid, profile)
      .map(normalizeId)
      .filter(Boolean)

    return currentUserValues.some(value => hiddenValues.includes(value))
  }

  function normalizeId(value) {
    return value === undefined || value === null
      ? ''
      : value.toString().trim().toLowerCase()
  }

  function getAssignmentValues(item) {
    return [
      ...(Array.isArray(item?.assignTo) ? item.assignTo : []),
      ...(Array.isArray(item?.assignedTo) ? item.assignedTo : []),
      ...(Array.isArray(item?.studentIds) ? item.studentIds : []),
      ...(Array.isArray(item?.assignedStudentIds) ? item.assignedStudentIds : []),
      ...(Array.isArray(item?.assignedEmails) ? item.assignedEmails : [])
    ]
  }

  function isAssignedToCurrentUser(item, user, profile) {
    const assignedValues = getAssignmentValues(item).map(normalizeId)

    const currentUserValues = getCurrentUserAssignmentValues(user, profile)
      .map(normalizeId)
      .filter(Boolean)

    return currentUserValues.some(value => assignedValues.includes(value))
  }

  function listenAssignedCollection(collectionName, user, profile, onItems, options = {}) {
    if (!user) return () => {}

    const uidValues = uniqueCleanValues([
      user.uid,
      profile?.uid,
      profile?.id
    ])

    const emailValues = uniqueCleanValues([
      user.email,
      user.email?.toLowerCase(),
      profile?.email,
      profile?.email?.toLowerCase()
    ])

    const allAssignmentValues = uniqueCleanValues([
      ...uidValues,
      ...emailValues
    ])

    const querySpecs = [
      ['assignTo', allAssignmentValues],
      ['assignedTo', allAssignmentValues],
      ['studentIds', uidValues],
      ['assignedStudentIds', uidValues],
      ['assignedEmails', emailValues]
    ]

    const queryTargets = []
    const seenTargets = new Set()

    querySpecs.forEach(([fieldName, values]) => {
      values.forEach(value => {
        const key = `${fieldName}:${normalizeId(value)}`

        if (!value || seenTargets.has(key)) return

        seenTargets.add(key)
        queryTargets.push({ fieldName, value })
      })
    })

    if (queryTargets.length === 0) {
      onItems([])
      return () => {}
    }

    let active = true
    const resultBuckets = {}

    const emit = () => {
      if (!active) return

      const mergedMap = new Map()

      Object.values(resultBuckets).forEach(items => {
        items.forEach(item => {
          mergedMap.set(item.id, item)
        })
      })

      let merged = Array.from(mergedMap.values()).filter(item =>
        isAssignedToCurrentUser(item, user, profile) &&
        !isHiddenForCurrentUser(item, user, profile)
      )

      if (typeof options.filter === 'function') {
        merged = merged.filter(options.filter)
      }

      if (typeof options.sort === 'function') {
        merged = [...merged].sort(options.sort)
      }

      onItems(merged)
    }

    const unsubscribers = queryTargets.map(({ fieldName, value }) => {
      const key = `${fieldName}:${normalizeId(value)}`
      const q = query(
        collection(db, collectionName),
        where(fieldName, 'array-contains', value)
      )

      return onSnapshot(
        q,
        snap => {
          resultBuckets[key] = snap.docs.map(d => ({
            id: d.id,
            ...d.data()
          }))

          emit()
        },
        error => {
          console.warn(`Assignment query failed for ${collectionName}.${fieldName}`, error)
          resultBuckets[key] = []
          emit()
        }
      )
    })

    return () => {
      active = false
      unsubscribers.forEach(unsubscribe => unsubscribe())
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

  function calculateSkillAnalytics(homeworks, submissions, idField, typeKeys) {
    const stats = {}

    typeKeys.forEach(key => {
      stats[key] = {
        correct: 0,
        total: 0
      }
    })

    let totalCorrect = 0
    let totalQuestions = 0

    submissions.forEach(submission => {
      const homework = homeworks.find(item => item.id === submission[idField])
      if (!homework) return

      homework.questions?.forEach(question => {
        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          const key = 'listeningMatching'

          if (!stats[key]) {
            stats[key] = { correct: 0, total: 0 }
          }

          question.matchingItems.forEach(item => {
            stats[key].total++
            totalQuestions++

            if (isListeningMatchingItemCorrect(submission, question, item)) {
              stats[key].correct++
              totalCorrect++
            }
          })

          return
        }

        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            if (!stats.matching) {
              stats.matching = { correct: 0, total: 0 }
            }

            stats.matching.total++
            totalQuestions++

            if (isMatchingCorrect(submission, question, paragraph)) {
              stats.matching.correct++
              totalCorrect++
            }
          })

          return
        }

        if (question.type === 'matchingInformation') {
          if (!stats.matchingInformation) {
            stats.matchingInformation = { correct: 0, total: 0 }
          }

          question.items?.forEach(item => {
            stats.matchingInformation.total++
            totalQuestions++

            if (isMatchingInformationCorrect(submission, question, item)) {
              stats.matchingInformation.correct++
              totalCorrect++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          if (!stats.sentenceEndings) {
            stats.sentenceEndings = { correct: 0, total: 0 }
          }

          question.items?.forEach(item => {
            stats.sentenceEndings.total++
            totalQuestions++

            if (isSentenceEndingCorrect(submission, question, item)) {
              stats.sentenceEndings.correct++
              totalCorrect++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          if (!stats.summaryOptions) {
            stats.summaryOptions = { correct: 0, total: 0 }
          }

          question.items?.forEach(item => {
            stats.summaryOptions.total++
            totalQuestions++

            if (isSummaryOptionCorrect(submission, question, item)) {
              stats.summaryOptions.correct++
              totalCorrect++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          const key = 'noteCompletion'

          if (!stats[key]) {
            stats[key] = { correct: 0, total: 0 }
          }

          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats[key].total++
              totalQuestions++

              if (isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats[key].correct++
                totalCorrect++
              }
            })
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          const key = 'listeningCompletion'

          if (!stats[key]) {
            stats[key] = { correct: 0, total: 0 }
          }

          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats[key].total++
              totalQuestions++

              if (isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats[key].correct++
                totalCorrect++
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

          if (!stats[key]) {
            stats[key] = { correct: 0, total: 0 }
          }

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++
                totalQuestions++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].correct++
                  totalCorrect++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) {
          stats[question.type] = { correct: 0, total: 0 }
        }

        stats[question.type].total++
        totalQuestions++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
          totalCorrect++
        }
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

    return {
      totalCorrect,
      totalQuestions,
      averageAccuracy,
      estimatedBand: estimateHomeworkBand(totalCorrect, totalQuestions),
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

      return listenAssignedCollection(
        'readings',
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

      const q = query(
        collection(db, 'readingSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setReadingSubmissions(data)
      })

      return unsub
    }, [user])

    useEffect(() => {
      if (!user) return

      return listenAssignedCollection(
        'listenings',
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

      const q = query(
        collection(db, 'listeningSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setListeningSubmissions(data)
      })

      return unsub
    }, [user])

    const readingAnalytics = calculateSkillAnalytics(
      readings,
      readingSubmissions,
      'readingId',
      ['matching', 'matchingInformation', 'sentenceEndings', 'summaryOptions', 'mcq', 'fitb', 'tfng', 'table', 'summary', 'note', 'noteCompletion']
    )

    const listeningAnalytics = calculateSkillAnalytics(
      listenings,
      listeningSubmissions,
      'listeningId',
      ['mcq', 'fitb', 'tfng', 'table', 'summary', 'note', 'listeningCompletion', 'listeningMatching']
    )

    const readingCompletion = {
      completed: readingSubmissions.filter(sub =>
        readings.some(reading => reading.id === sub.readingId)
      ).length,
      assigned: readings.length
    }

    const listeningCompletion = {
      completed: listeningSubmissions.filter(sub =>
        listenings.some(listening => listening.id === sub.listeningId)
      ).length,
      assigned: listenings.length
    }

    const hasData =
      readingSubmissions.length > 0 ||
      listeningSubmissions.length > 0 ||
      readings.length > 0 ||
      listenings.length > 0

    const renderSkillCard = (title, icon, analytics, completion, colorClass) => (
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
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

      return listenAssignedCollection(
        'readings',
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

      const q = query(
        collection(db, 'readingSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setSubmissions(data)
      })

      return unsub
    }, [user])

    const isDone = readingId =>
      submissions.some(s => s.readingId === readingId)

    const getResult = readingId =>
      submissions.find(s => s.readingId === readingId)?.result

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

                        <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                          Not completed
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-reading/${r.id}`)}
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

      return listenAssignedCollection(
        'listenings',
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

      const q = query(
        collection(db, 'listeningSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setSubmissions(data)
      })

      return unsub
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

      const q = query(
        collection(db, 'mockSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        data.sort(
          (a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
        )

        setMockSubmissions(data)
      })

      return unsub
    }, [user])

    useEffect(() => {
      if (!user) return

      return listenAssignedCollection(
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

    const completed = mockSubmissions.length
    const latest = mockSubmissions[0]
    const previous = mockSubmissions[1]

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

    const getWritingBand = submission => {
      const result = submission?.result || {}

      return (
        result.writing?.band ||
        result.writingBand ||
        submission?.writingReview?.overall ||
        submission?.review?.writingOverall ||
        null
      )
    }

    const getWritingStatus = submission => {
      const writingBand = getWritingBand(submission)

      if (writingBand) return `Reviewed · Band ${formatBand(writingBand)}`

      return 'Pending teacher review'
    }

    const latestOverall = getMockOverall(latest)
    const previousOverall = getMockOverall(previous)

    const trend = [...mockSubmissions]
      .reverse()
      .slice(-6)

    const overallChange = getChangeLabel(latestOverall, previousOverall)
    const latestMockTitle = latest
      ? mockMap[latest.mockTestId]?.title || latest.mockTitle || 'Mock Test'
      : 'No mock completed yet'

    if (completed === 0) {
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
            Once you complete a full mock test, your mock trend, latest estimate and section performance will appear here.
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
              Based on your completed full IELTS mock tests.
            </p>
          </div>

          <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
            {completed} completed
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-gray-900 text-white rounded-2xl p-5">
            <p className="text-xs text-gray-400 mb-1">
              Latest Mock Overall
            </p>

            <p className="text-4xl font-bold">
              {latestOverall ? formatBand(latestOverall) : '--'}
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
              {overallChange ? `${overallChange} from previous mock` : 'No previous mock yet'}
            </p>
          </div>
        </div>

        {trend.length > 1 && (
          <div className="mb-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Mock Progress Trend
            </h3>

            <div className="flex items-end gap-2 h-28 bg-gray-50 rounded-2xl p-4 overflow-x-auto">
              {trend.map((submission, index) => {
                const overall = Number(getMockOverall(submission)) || 0
                const height = Math.max(14, Math.min(100, (overall / 9) * 100))
                const title = mockMap[submission.mockTestId]?.title || `Mock ${index + 1}`

                return (
                  <div
                    key={submission.id}
                    className="flex flex-col items-center justify-end min-w-[58px] h-full"
                    title={title}
                  >
                    <p className="text-xs font-semibold text-purple-600 mb-1">
                      {overall ? formatBand(overall) : '--'}
                    </p>

                    <div
                      className="w-8 rounded-t-xl bg-purple-600"
                      style={{ height: `${height}%` }}
                    />

                    <p className="text-[10px] text-gray-400 mt-1">
                      M{index + 1}
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
            {mockSubmissions.slice(0, 4).map(submission => {
              const result = submission.result || {}
              const overall = getMockOverall(submission)
              const title = mockMap[submission.mockTestId]?.title || submission.mockTitle || 'Mock Test'

              return (
                <div
                  key={submission.id}
                  className="border border-gray-100 bg-gray-50 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {title}
                    </p>

                    <p className="text-xs text-gray-400 mt-0.5">
                      Submitted {submission.submittedAt ? new Date(submission.submittedAt).toLocaleDateString() : 'No date'}
                    </p>

                    <p className="text-xs text-gray-500 mt-1">
                      L {formatBand(result.listening?.band)} · R {formatBand(result.reading?.band)} · Writing {getWritingStatus(submission)}
                    </p>
                  </div>

                  <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full font-semibold">
                    Overall {overall ? formatBand(overall) : '--'}
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

      return listenAssignedCollection(
        'vocabularyTests',
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

      const q = query(
        collection(db, 'vocabularySubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setSubmissions(data)
      })

      return unsub
    }, [user])

    const isDone = vocabularyTestId =>
      submissions.some(s => s.vocabularyTestId === vocabularyTestId)

    const getResult = vocabularyTestId =>
      submissions.find(s => s.vocabularyTestId === vocabularyTestId)?.result

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

      return listenAssignedCollection(
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

      const q = query(
        collection(db, 'mockSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setSubmissions(data)
      })

      return unsub
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

      const q = query(
        collection(db, 'writingSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setSubmissions(data)
      })

      return unsub
    }, [user])

    useEffect(() => {
      if (!user) return

      return listenAssignedCollection(
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
      .filter(sub => sub.reviewed && sub.review?.overall)
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

      return listenAssignedCollection(
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

      const q = query(
        collection(db, 'writingSubmissions'),
        where('uid', '==', user.uid)
      )

      const unsub = onSnapshot(q, snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(item => item.archived !== true)

        setSubmissions(data)
      })

      return unsub
    }, [user])

    const getSubmission = writingId =>
      submissions.find(s => s.writingId === writingId)

    const isDone = writingId => Boolean(getSubmission(writingId))

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
                        ⏱ {w.timeLimit || 60} min · Task 1 + Task 2
                      </p>

                      <div className="flex gap-2 mt-2 flex-wrap">
                        <span className={`text-xs px-3 py-1 rounded-full ${badge.style}`}>
                          {badge.text}
                        </span>

                        <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                          Not completed
                        </span>

                        <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                          Teacher graded
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/do-writing/${w.id}`)}
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
                        ⏱ {w.timeLimit || 60} min · Task 1 + Task 2
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

        {selectedReview && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
            <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-6">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">
                    Writing Feedback
                  </h2>

                  <p className="text-sm text-gray-400">
                    {selectedReview.writing.title}
                  </p>

                  <p className="text-sm text-purple-600 font-semibold mt-1">
                    {selectedReview.submission.reviewed
                      ? `Overall Band ${selectedReview.submission.review?.overall || '-'}`
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

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <div className="bg-purple-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Task 1 Band</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {selectedReview.submission.review?.task1Band || '-'}
                  </p>
                </div>

                <div className="bg-indigo-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Task 2 Band</p>
                  <p className="text-2xl font-bold text-indigo-600">
                    {selectedReview.submission.review?.task2Band || '-'}
                  </p>
                </div>

                <div className="bg-green-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Overall</p>
                  <p className="text-2xl font-bold text-green-600">
                    {selectedReview.submission.review?.overall || '-'}
                  </p>
                </div>
              </div>

              {selectedReview.submission.review?.rubric && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                  {Object.entries(getRubricAverages(selectedReview.submission.review)).map(
                    ([key, value]) => (
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
                    )
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="border border-gray-100 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-gray-800">
                      Task 1
                    </h3>

                    <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                      {selectedReview.submission.task1WordCount || 0} words
                    </span>
                  </div>

                  <p className="text-xs text-gray-400 mb-2">
                    Your answer
                  </p>

                  <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-gray-50 rounded-xl p-4 mb-4">
                    {selectedReview.submission.task1Answer}
                  </p>

                  <p className="text-xs text-gray-400 mb-2">
                    Teacher feedback
                  </p>

                  <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-green-50 rounded-xl p-4">
                    {selectedReview.submission.review?.task1Feedback || 'No feedback.'}
                  </p>
                </div>

                <div className="border border-gray-100 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-gray-800">
                      Task 2
                    </h3>

                    <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                      {selectedReview.submission.task2WordCount || 0} words
                    </span>
                  </div>

                  <p className="text-xs text-gray-400 mb-2">
                    Your answer
                  </p>

                  <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-gray-50 rounded-xl p-4 mb-4">
                    {selectedReview.submission.task2Answer}
                  </p>

                  <p className="text-xs text-gray-400 mb-2">
                    Teacher feedback
                  </p>

                  <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap bg-green-50 rounded-xl p-4">
                    {selectedReview.submission.review?.task2Feedback || 'No feedback.'}
                  </p>
                </div>
              </div>

              <div className="bg-purple-50 rounded-2xl p-5 mt-6">
                <p className="text-xs text-gray-500 mb-2">
                  General Feedback
                </p>

                <p className="text-sm text-purple-800 leading-7 whitespace-pre-wrap">
                  {selectedReview.submission.review?.generalFeedback || 'No general feedback.'}
                </p>
              </div>
            </div>
          </div>
        )}
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

    const navigate = useNavigate()

    useEffect(() => {
      if (!user) return

      const unsubReadings = listenAssignedCollection(
        'readings',
        user,
        profile,
        setReadings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubListenings = listenAssignedCollection(
        'listenings',
        user,
        profile,
        setListenings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubWritings = listenAssignedCollection(
        'writingHomeworks',
        user,
        profile,
        setWritings,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubVocabularyTests = listenAssignedCollection(
        'vocabularyTests',
        user,
        profile,
        setVocabularyTests,
        {
          filter: item => !item.archived,
          sort: sortByAssignedDateDesc
        }
      )

      const unsubMocks = listenAssignedCollection(
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

      const unsubReadingSubmissions = onSnapshot(
        query(collection(db, 'readingSubmissions'), where('uid', '==', user.uid)),
        snap => {
          setReadingSubmissions(
            snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => item.archived !== true)
          )
        }
      )

      const unsubListeningSubmissions = onSnapshot(
        query(collection(db, 'listeningSubmissions'), where('uid', '==', user.uid)),
        snap => {
          setListeningSubmissions(
            snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => item.archived !== true)
          )
        }
      )

      const unsubWritingSubmissions = onSnapshot(
        query(collection(db, 'writingSubmissions'), where('uid', '==', user.uid)),
        snap => {
          setWritingSubmissions(
            snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => item.archived !== true)
          )
        }
      )

      const unsubVocabularySubmissions = onSnapshot(
        query(collection(db, 'vocabularySubmissions'), where('uid', '==', user.uid)),
        snap => {
          setVocabularySubmissions(
            snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => item.archived !== true)
          )
        }
      )

      const unsubMockSubmissions = onSnapshot(
        query(collection(db, 'mockSubmissions'), where('uid', '==', user.uid)),
        snap => {
          setMockSubmissions(
            snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => item.archived !== true)
          )
        }
      )

      return () => {
        unsubReadingSubmissions()
        unsubListeningSubmissions()
        unsubWritingSubmissions()
        unsubVocabularySubmissions()
        unsubMockSubmissions()
      }
    }, [user])

    const hasReadingSubmission = readingId =>
      readingSubmissions.some(submission => submission.readingId === readingId)

    const hasListeningSubmission = listeningId =>
      listeningSubmissions.some(submission => submission.listeningId === listeningId)

    const hasWritingSubmission = writingId =>
      writingSubmissions.some(submission => submission.writingId === writingId)

    const hasVocabularySubmission = vocabularyTestId =>
      vocabularySubmissions.some(submission => submission.vocabularyTestId === vocabularyTestId)

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
          color: 'blue'
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
          color: 'amber'
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
                      Not completed yet
                    </p>
                  </div>

                  <button
                    onClick={() => navigate(item.path)}
                    className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700"
                  >
                    Start →
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

  export default function StudentDashboard() {
    const [scores, setScores] = useState([])
    const [user, setUser] = useState(null)
    const [showPasswordModal, setShowPasswordModal] = useState(false)
    const [newPassword, setNewPassword] = useState('')
    const [passwordMsg, setPasswordMsg] = useState('')
    const [activeTab, setActiveTab] = useState('overview')
    const [profile, setProfile] = useState(null)
    const navigate = useNavigate()

    const targetBand = profile?.targetBand !== undefined && profile?.targetBand !== null
      ? Number(profile.targetBand)
      : null

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

          unsubScores = onSnapshot(q, snap => {
            const data = snap.docs
              .map(d => ({ id: d.id, ...d.data() }))
              .filter(item => item.archived !== true)

            data.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))

            setScores(data)
          })
        } catch (error) {
          console.error(error)

          if (active) {
            await signOut(auth)
            navigate('/login')
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
    }, [navigate])

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