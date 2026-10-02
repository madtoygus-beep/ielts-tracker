import { useEffect, useMemo, useRef, useState } from 'react'
import { auth, db, functions } from '../firebase'
import {
  collection,
  doc,
  getDoc,
  getDocsFromServer,
  getDocFromServer,
  query,
  where,
  setDoc
} from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const syncMyObjectiveAssignments = httpsCallable(functions, 'syncMyObjectiveAssignments')
const submitVocabularySecure = httpsCallable(functions, 'submitVocabularySecure')
const getCompletedObjectiveReview = httpsCallable(functions, 'getCompletedObjectiveReview')

function getVocabularyBand(correct, total) {
  if (!total) return 0

  const percentage = correct / total

  if (percentage >= 0.97) return 9
  if (percentage >= 0.93) return 8.5
  if (percentage >= 0.87) return 8
  if (percentage >= 0.8) return 7.5
  if (percentage >= 0.72) return 7
  if (percentage >= 0.63) return 6.5
  if (percentage >= 0.53) return 6
  if (percentage >= 0.43) return 5.5
  if (percentage >= 0.33) return 5
  if (percentage >= 0.23) return 4.5

  return 4
}

function normalizeValue(value) {
  return value === undefined || value === null
    ? ''
    : value.toString().trim().toLowerCase()
}

function normalizeTypedAnswer(value) {
  return normalizeValue(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
}

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

function getSourceTeacherIds(source) {
  const explicitTeacherIds = Array.isArray(source?.teacherIds)
    ? source.teacherIds
    : []

  if (explicitTeacherIds.length > 0) {
    return uniqueCleanValues(explicitTeacherIds)
  }

  return uniqueCleanValues([
    source?.teacherId,
    source?.createdBy
  ])
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

function getCurrentUserValues(user, profile) {
  return [
    user?.uid,
    user?.email,
    user?.email?.toLowerCase(),
    profile?.uid,
    profile?.id,
    profile?.email,
    profile?.email?.toLowerCase()
  ]
    .map(normalizeValue)
    .filter(Boolean)
}

function isAssignedToCurrentUser(item, user, profile) {
  const assignmentValues = getAssignmentValues(item).map(normalizeValue)
  const currentValues = getCurrentUserValues(user, profile)

  return currentValues.some(value => assignmentValues.includes(value))
}

function isHiddenForCurrentUser(item, user, profile) {
  if (!Array.isArray(item?.hiddenFor)) return false

  const hiddenValues = item.hiddenFor.map(normalizeValue)
  const currentValues = getCurrentUserValues(user, profile)

  return currentValues.some(value => hiddenValues.includes(value))
}

function isSubmissionForVocabularyTest(submission, vocabularyTestId) {
  const target = normalizeValue(vocabularyTestId)

  return [
    submission?.vocabularyTestId,
    submission?.vocabularyId,
    submission?.testId,
    submission?.homeworkId
  ]
    .map(normalizeValue)
    .includes(target)
}

function answerKey(questionId) {
  return questionId
}

function getAcceptedAnswers(answer, acceptedAnswers = '') {
  const values = []

  if (answer) values.push(answer)

  acceptedAnswers
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .forEach(item => values.push(item))

  return values.map(normalizeTypedAnswer)
}

function isTypedAnswerCorrect(userAnswer, answer, acceptedAnswers = '') {
  const cleanUser = normalizeTypedAnswer(userAnswer)
  if (!cleanUser) return false

  return getAcceptedAnswers(answer, acceptedAnswers).includes(cleanUser)
}

function parseWordBank(value) {
  return (value || '')
    .split(/\r?\n|,|\s+[-\u2013\u2014]\s+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function getQuestionType(question) {
  return question?.type || 'mcq'
}

function getQuestionPrompt(question) {
  if (getQuestionType(question) === 'match_definition') return question.word || question.question
  if (getQuestionType(question) === 'word_bank') return question.sentence || question.question
  if (getQuestionType(question) === 'grammar_form') return question.sentence || question.question
  return question.question
}

function stableHash(value) {
  return Array.from(value || '').reduce(
    (hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0,
    7
  )
}

// Repair 07: sectionOrder is a display order, never a new answer key.
// Legacy records without it keep their first-appearance section order.
function buildVocabularyDisplayBlocks(source) {
  const questions = Array.isArray(source) ? source : []
  const blocks = []
  const groups = new Map()
  let currentMcqBlock = null

  questions.forEach((question, index) => {
    const type = question?.type || 'mcq'
    const storedOrder = Number(question?.sectionOrder)
    const explicitOrder = Number.isFinite(storedOrder) && storedOrder > 0
      ? storedOrder
      : null
    const order = explicitOrder ?? index + 1

    if (['match_definition', 'word_bank', 'grammar_form'].includes(type)) {
      currentMcqBlock = null
      const blockType = type === 'match_definition'
        ? 'matching'
        : type === 'word_bank' ? 'wordBank' : 'grammar'
      const groupId = type === 'word_bank'
        ? question.groupId || 'legacy-word-bank'
        : blockType
      const key = `${blockType}:${groupId}`
      let block = groups.get(key)

      if (!block) {
        block = { key, type: blockType, order, firstIndex: index, questions: [] }
        if (type === 'word_bank') {
          block.group = { groupId, questions: block.questions }
        }
        groups.set(key, block)
        blocks.push(block)
      }

      block.order = Math.min(block.order, order)
      block.questions.push(question)
      return
    }

    const startsNewSection = Boolean(question.sectionTitle?.trim())
    if (
      !currentMcqBlock ||
      startsNewSection ||
      currentMcqBlock.explicitOrder !== explicitOrder
    ) {
      currentMcqBlock = {
        key: `mcq:${index}`,
        type: 'mcq',
        order,
        explicitOrder,
        firstIndex: index,
        title: question.sectionTitle?.trim() ||
          question.taskTitle?.trim() || 'Vocabulary Multiple Choice',
        questions: []
      }
      blocks.push(currentMcqBlock)
    }

    currentMcqBlock.questions.push(question)
  })

  return blocks.sort((a, b) => a.order - b.order || a.firstIndex - b.firstIndex)
}

function getMatchingLetter(index) {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

function normalizeMultilineText(value) {
  return (value || '').replace(/\\n/g, '\n')
}

export default function DoVocabulary() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [test, setTest] = useState(null)
  const [answers, setAnswers] = useState({})
  const [timeLeft, setTimeLeft] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [alreadyDone, setAlreadyDone] = useState(false)
  const [result, setResult] = useState(null)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [matchingReviewVersion, setMatchingReviewVersion] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadCount, setReloadCount] = useState(0)
  const [operationError, setOperationError] = useState('')
  const [operationSlow, setOperationSlow] = useState(false)
  const [timerVersion, setTimerVersion] = useState(0)

  const timerRef = useRef(null)
  const submittingRef = useRef(false)
  const draftSavingRef = useRef(false)
  const readyRef = useRef(false)
  const submittedRef = useRef(false)
  const autoSubmitAttemptedRef = useRef(false)
  const sessionRef = useRef(0)
  const routeIdRef = useRef(id)
  routeIdRef.current = id

  useEffect(() => {
    let active = true
    readyRef.current = false
    setLoading(true)
    setLoadError('')

    const unsub = onAuthStateChanged(auth, async currentUser => {
      const generation = ++sessionRef.current
      const isCurrent = () => active && generation === sessionRef.current &&
        routeIdRef.current === id

      clearInterval(timerRef.current)
      readyRef.current = false
      submittedRef.current = false
      submittingRef.current = false
      draftSavingRef.current = false
      autoSubmitAttemptedRef.current = false
      setUser(null)
      setProfile(null)
      setTest(null)
      setAnswers({})
      setTimeLeft(null)
      setResult(null)
      setSubmitted(false)
      setAlreadyDone(false)
      setSubmitting(false)
      setDraftSaving(false)
      setDraftRestored(false)
      setMatchingReviewVersion(1)
      setOperationError('')
      setLoadError('')
      setLoading(true)
      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        const profileSnap = await getDoc(doc(db, 'users', currentUser.uid))

        if (!isCurrent()) return

        if (!profileSnap.exists()) {
          await signOut(auth)
          navigate('/login')
          return
        }

        const loadedProfile = profileSnap.data()

        if (
          loadedProfile.deleted === true ||
          loadedProfile.status !== 'approved' ||
          loadedProfile.role !== 'student'
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        setUser(currentUser)
        setProfile(loadedProfile)

        // 8D-2: students load the answer-key-free projection, never the source vocabulary test.
        let testSnap = await getDocFromServer(doc(db, 'studentVocabularyTests', id))

        if (!isCurrent()) return

        // Older assignments may predate the projection collections. Refresh only when needed.
        if (!testSnap.exists()) {
          try {
            await syncMyObjectiveAssignments({})
            if (!isCurrent()) return
            testSnap = await getDocFromServer(doc(db, 'studentVocabularyTests', id))
          } catch (syncError) {
            console.warn('Could not refresh sanitized vocabulary assignments:', syncError)
          }
        }

        if (!testSnap.exists()) {
          throw new Error(
            'The student-safe copy of this vocabulary practice is not available. Return to the dashboard and try again, or ask your teacher to refresh the assignment.'
          )
        }

        const data = {
          id: testSnap.id,
          ...testSnap.data(),
          questions: Array.isArray(testSnap.data().questions)
            ? testSnap.data().questions
            : []
        }

        if (!isAssignedToCurrentUser(data, currentUser, loadedProfile)) {
          alert('This vocabulary test is not assigned to you.')
          navigate('/student')
          return
        }

        if (isHiddenForCurrentUser(data, currentUser, loadedProfile) || data.archived === true) {
          alert('This vocabulary test is no longer available.')
          navigate('/student')
          return
        }

        setTest(data)
        setTimeLeft((data.timeLimit || 20) * 60)

        const existingQuery = query(
          collection(db, 'vocabularySubmissions'),
          where('uid', '==', currentUser.uid)
        )

        const existingSnap = await getDocsFromServer(existingQuery)

        if (!isCurrent()) return

        const submissions = existingSnap.docs
          .map(item => item.data())
          .filter(submission => isSubmissionForVocabularyTest(submission, id))
          .sort(
            (a, b) =>
              new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
          )

        if (submissions.length > 0) {
          const submission = submissions[0]

          // Answer keys are returned only after the server confirms this student submitted.
          const reviewResponse = await getCompletedObjectiveReview({
            type: 'vocabulary',
            assignmentId: id
          })

          if (!isCurrent()) return

          const reviewData = reviewResponse?.data || {}
          const reviewSource = reviewData.source

          if (!reviewSource || typeof reviewSource !== 'object') {
            throw new Error('Completed vocabulary review did not return the source document.')
          }

          setTest({
            ...reviewSource,
            id: reviewSource.id || id,
            questions: Array.isArray(reviewSource.questions)
              ? reviewSource.questions
              : []
          })
          setTimeLeft((data.timeLimit || 20) * 60)
          submittedRef.current = true
          setAlreadyDone(true)
          setMatchingReviewVersion(submission.matchingViewVersion === 1 ? 1 : 0)
          setAnswers(submission.answers || {})
          setResult(reviewData.result || submission.result || null)
          setSubmitted(true)
        } else {
          try {
            const draftSnap = await getDocFromServer(
              doc(
                db,
                'vocabularyDrafts',
                `${currentUser.uid}_${id}`
              )
            )

            if (!isCurrent()) return

            if (draftSnap.exists()) {
              const draft = draftSnap.data()

              if (
                draft.uid !== currentUser.uid ||
                draft.studentId !== currentUser.uid ||
                draft.vocabularyTestId !== id
              ) {
                throw new Error('The saved progress does not belong to this practice.')
              }

              setAnswers(draft.answers && typeof draft.answers === 'object' &&
                !Array.isArray(draft.answers) ? draft.answers : {})
              setTimeLeft(
                draft.timeLeft !== null && draft.timeLeft !== '' &&
                  Number.isFinite(Number(draft.timeLeft))
                  ? Math.min(Math.max(Number(draft.timeLeft), 0), (data.timeLimit || 20) * 60)
                  : (data.timeLimit || 20) * 60
              )
              setDraftRestored(true)
            }
          } catch (draftError) {
            console.warn('Could not restore vocabulary draft:', draftError)
            // Never turn a failed draft read into a fresh blank attempt.
            throw new Error(
              'Saved progress could not be checked. Your saved answers have not been overwritten. Check your connection and permissions, then retry.'
            )
          }
        }
        if (!isCurrent()) return
        readyRef.current = true
        setLoading(false)
      } catch (error) {
        console.error(error)
        if (!isCurrent()) return
        readyRef.current = false
        setLoadError(error?.message || 'Could not load vocabulary practice.')
        setLoading(false)
      }
    })

    return () => {
      active = false
      sessionRef.current += 1
      readyRef.current = false
      clearInterval(timerRef.current)
      unsub()
    }
  }, [id, navigate, reloadCount])

  const groupedQuestions = useMemo(() => {
    const questions = test?.questions || []

    return {
      matching: questions.filter(question => getQuestionType(question) === 'match_definition'),
      wordBank: questions.filter(question => getQuestionType(question) === 'word_bank'),
      grammar: questions.filter(question => getQuestionType(question) === 'grammar_form'),
      mcq: questions.filter(question => getQuestionType(question) === 'mcq' || !question.type)
    }
  }, [test])

  const wordBankGroups = useMemo(() => {
    const groups = []
    const byId = new Map()

    groupedQuestions.wordBank.forEach(question => {
      const groupId = question.groupId || 'legacy-word-bank'

      if (!byId.has(groupId)) {
        const group = {
          groupId,
          questions: []
        }

        byId.set(groupId, group)
        groups.push(group)
      }

      byId.get(groupId).questions.push(question)
    })

    return groups
  }, [groupedQuestions.wordBank])

  const orderedSections = useMemo(() => {
    const byKey = new Map()

    ;(test?.questions || []).forEach((question, questionIndex) => {
      const questionType = getQuestionType(question)

      const type =
        questionType === 'match_definition'
          ? 'matching'
          : questionType === 'word_bank'
            ? 'wordBank'
            : questionType === 'grammar_form'
              ? 'grammar'
              : 'mcq'

      const key =
        type === 'wordBank'
          ? `wordBank:${question.groupId || 'legacy-word-bank'}`
          : type

      const explicitOrder = Number(question.sectionOrder)
      const fallbackOrder = questionIndex + 1
      const order =
        Number.isFinite(explicitOrder) && explicitOrder > 0
          ? explicitOrder
          : fallbackOrder

      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          type,
          order,
          firstIndex: questionIndex,
          groupId:
            type === 'wordBank'
              ? question.groupId || 'legacy-word-bank'
              : ''
        })
        return
      }

      const current = byKey.get(key)
      current.order = Math.min(current.order, order)
      current.firstIndex = Math.min(current.firstIndex, questionIndex)
    })

    return Array.from(byKey.values())
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order
        return a.firstIndex - b.firstIndex
      })
      .map(section => {
        if (section.type !== 'wordBank') return section

        return {
          ...section,
          group: wordBankGroups.find(
            item => item.groupId === section.groupId
          )
        }
      })
      .filter(section =>
        section.type !== 'wordBank' || Boolean(section.group)
      )
  }, [test, wordBankGroups])

  // Repair 07: use the same saved section order for display and numbering.
  // Answer IDs and the raw matchingDefinitionOrder below remain unchanged.
  const displayBlocks = useMemo(
    () => buildVocabularyDisplayBlocks(test?.questions),
    [test]
  )

  const orderedQuestions = useMemo(
    () => displayBlocks.flatMap(block => block.questions),
    [displayBlocks]
  )

  const matchingDefinitionOrder = useMemo(() => {
    // During an active attempt the sanitized projection deliberately has no
    // definition attached to its word/question object. Do not reconstruct the
    // word-to-definition pairing in the browser. The ordered definition text is
    // supplied separately by the server-safe projection.
    if (test?.answerKeySeparated === true) return []

    const items = groupedQuestions.matching

    if (
      test?.matchingShuffle !== true ||
      items.length <= 1
    ) {
      return items
    }

    const shift =
      (stableHash(test?.id || test?.title || 'vocabulary') % (items.length - 1)) + 1

    return [
      ...items.slice(shift),
      ...items.slice(0, shift)
    ]
  }, [groupedQuestions.matching, test])

  const matchingDefinitionTexts = useMemo(() => {
    if (test?.answerKeySeparated === true && Array.isArray(test?.matchingDefinitions)) {
      return test.matchingDefinitions.map(value => value?.toString() || '')
    }

    return matchingDefinitionOrder.map(item => item?.definition || '')
  }, [matchingDefinitionOrder, test])

  const getGlobalQuestionNumber = question => {
    const index = orderedQuestions.findIndex(
      item => item.id === question.id
    )

    return index >= 0 ? index + 1 : 0
  }

  useEffect(() => {
    if (loading || loadError || !readyRef.current || timeLeft === null ||
      submitted || alreadyDone || draftSaving || submitting) return

    if (timeLeft <= 0) {
      if (!autoSubmitAttemptedRef.current) {
        autoSubmitAttemptedRef.current = true
        handleSubmit(true)
      }
      return
    }

    const deadline = Date.now() + timeLeft * 1000
    timerRef.current = setInterval(() => {
      if (draftSavingRef.current || submittingRef.current || !readyRef.current) return
      setTimeLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
    }, 1000)

    return () => clearInterval(timerRef.current)
  }, [timeLeft, submitted, alreadyDone, loading, loadError, draftSaving, submitting, timerVersion])

  useEffect(() => {
    setOperationSlow(false)
    if (!draftSaving && !submitting) return
    // A pending Firestore write is not a confirmed save. Do not race it with
    // a second write or tell the student it succeeded while disconnected.
    const timeout = setTimeout(() => setOperationSlow(true), 12000)
    return () => clearTimeout(timeout)
  }, [draftSaving, submitting])

  useEffect(() => {
    const warnBeforeLeaving = event => {
      if (!readyRef.current || submittedRef.current) return
      if (!Object.keys(answers).length && !draftSaving && !submitting) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [answers, draftSaving, submitting])

  const answersLocked = loading || Boolean(loadError) || submitted || alreadyDone ||
    draftSaving || submitting || timeLeft === null || timeLeft <= 0

  const cannotEditAnswers = () => answersLocked || !readyRef.current ||
    draftSavingRef.current || submittingRef.current || submittedRef.current ||
    routeIdRef.current !== id


  const formatTime = secs => {
    const safeSeconds = Math.max(Number(secs) || 0, 0)
    const m = Math.floor(safeSeconds / 60).toString().padStart(2, '0')
    const s = (safeSeconds % 60).toString().padStart(2, '0')

    return `${m}:${s}`
  }

  const handleAnswer = (questionId, value) => {
    if (cannotEditAnswers()) return
    setAnswers(prev => ({
      ...prev,
      [answerKey(questionId)]: value
    }))
  }

  const getWordSelectedForDefinition = definitionIndex => {
    const definitionLetter = getMatchingLetter(definitionIndex)

    return groupedQuestions.matching.find(
      question =>
        answers[answerKey(question.id)] === definitionLetter
    )?.id || ''
  }

  const getUsedMatchingWordIds = () => {
    return new Set(
      groupedQuestions.matching
        .filter(question =>
          Boolean(answers[answerKey(question.id)])
        )
        .map(question => question.id)
    )
  }

  const handleDefinitionWordMatch = (
    definitionIndex,
    selectedQuestionId
  ) => {
    if (cannotEditAnswers()) return
    const definitionLetter = getMatchingLetter(definitionIndex)
    if (!matchingDefinitionTexts[definitionIndex]) return
    if (selectedQuestionId && !groupedQuestions.matching.some(
      question => question.id === selectedQuestionId
    )) return

    setAnswers(prev => {
      const next = { ...prev }

      groupedQuestions.matching.forEach(question => {
        if (next[answerKey(question.id)] === definitionLetter) {
          delete next[answerKey(question.id)]
        }
      })

      if (selectedQuestionId) {
        next[answerKey(selectedQuestionId)] = definitionLetter
      }

      return next
    })
  }

  const isCorrect = (question, groupIndex = 0) => {
    const type = getQuestionType(question)
    const selected = answers[answerKey(question.id)]

    if (type === 'match_definition') {
      const selectedIndex = matchingDefinitionOrder.findIndex(
        (_, index) => getMatchingLetter(index) === selected
      )

      if (selectedIndex < 0) return false

      return matchingDefinitionOrder[selectedIndex]?.id === question.id
    }

    if (type === 'word_bank' || type === 'grammar_form') {
      return isTypedAnswerCorrect(
        selected,
        question.answerText || question.answer,
        question.acceptedAnswers || ''
      )
    }

    return Boolean(normalizeValue(selected)) && Boolean(normalizeValue(question.answer)) &&
      selected === question.answer
  }

  const calculateScore = () => {
    const questions = test?.questions || []
    let correct = 0
    let total = 0

    questions.forEach(question => {
      total++

      if (isCorrect(question)) {
        correct++
      }
    })

    const percentage = total ? Math.round((correct / total) * 100) : 0

    return {
      correct,
      total,
      percentage,
      band: getVocabularyBand(correct, total)
    }
  }

  const handleSaveAndContinueLater = async () => {
    if (!test || !user || cannotEditAnswers()) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setOperationError('You are offline. Reconnect before saving. Your answers are still on this page.')
      return
    }

    const generation = sessionRef.current
    const isCurrent = () => generation === sessionRef.current && routeIdRef.current === id
    draftSavingRef.current = true
    setDraftSaving(true)
    setOperationError('')
    clearInterval(timerRef.current)

    const submissionTeacherIds = getSourceTeacherIds(test)
    const payload = {
      uid: user.uid,
      studentId: user.uid,
      studentEmail: user.email || profile?.email || '',
      studentName: profile?.name || profile?.fullName || user.email || '',
      vocabularyTestId: id,
      vocabularyId: id,
      testId: id,
      homeworkId: id,
      vocabularyTitle: test.title || '',
      teacherId: submissionTeacherIds[0] || '',
      teacherIds: submissionTeacherIds,
      schoolId: test.schoolId || profile?.schoolId || 'maxima',
      answers: { ...answers },
      timeLeft: Math.max(Number(timeLeft) || 0, 0),
      updatedAt: new Date().toISOString()
    }

    try {
      await setDoc(
        doc(db, 'vocabularyDrafts', `${user.uid}_${id}`),
        payload,
        // Replace the entire answers map, including deleted/blank choices.
        // Preserve any other top-level metadata not owned by this screen.
        { mergeFields: Object.keys(payload) }
      )
      if (!isCurrent()) return
      readyRef.current = false
      navigate('/student')
    } catch (error) {
      console.error(error)
      if (!isCurrent()) return
      draftSavingRef.current = false
      setDraftSaving(false)
      // Restart even if a fast rejection batches saving=true/false together.
      setTimerVersion(version => version + 1)
      setOperationError(
        'Could not save your progress. Your answers are still here and the timer will continue. Check your connection or permissions and try again.'
      )
    }
  }

  const handleSubmit = async (autoSubmit = false) => {
    if (submittingRef.current || draftSavingRef.current || submittedRef.current ||
      submitted || alreadyDone || loading || loadError || !readyRef.current ||
      routeIdRef.current !== id || !test || !user) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setOperationError('You are offline. Reconnect and click Submit answers to retry. Your answers have not been submitted.')
      return
    }

    if (!autoSubmit) {
      const ok = window.confirm('Submit your vocabulary practice? You cannot retake it after submitting.')
      if (!ok) return
    }

    const generation = sessionRef.current
    const isCurrent = () => generation === sessionRef.current && routeIdRef.current === id
    submittingRef.current = true
    setSubmitting(true)
    setOperationError('')

    clearInterval(timerRef.current)

    try {
      // 8D-2: scoring and immutable submission creation happen on the server.
      const response = await submitVocabularySecure({
        vocabularyTestId: id,
        answers,
        finishedLate: timeLeft <= 0,
        autoSubmitted: autoSubmit
      })

      if (!isCurrent()) return

      const secureData = response?.data || {}
      let reviewSource = secureData.reviewSource
      let secureResult = secureData.result || null

      if (!reviewSource || typeof reviewSource !== 'object') {
        const reviewResponse = await getCompletedObjectiveReview({
          type: 'vocabulary',
          assignmentId: id
        })

        if (!isCurrent()) return

        reviewSource = reviewResponse?.data?.source
        secureResult = reviewResponse?.data?.result || secureResult
      }

      if (!reviewSource || typeof reviewSource !== 'object') {
        throw new Error('Secure Vocabulary submission did not return review data.')
      }

      // If another tab submitted first, restore the answers that are actually stored.
      if (secureData.alreadySubmitted === true) {
        const existingQuery = query(
          collection(db, 'vocabularySubmissions'),
          where('uid', '==', user.uid)
        )
        const existingSnap = await getDocsFromServer(existingQuery)

        if (!isCurrent()) return

        const storedSubmissions = existingSnap.docs
          .map(item => item.data())
          .filter(submission => isSubmissionForVocabularyTest(submission, id))
          .sort(
            (a, b) =>
              new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
          )

        if (storedSubmissions.length > 0) {
          const stored = storedSubmissions[0]
          setAnswers(stored.answers || {})
          setMatchingReviewVersion(stored.matchingViewVersion === 1 ? 1 : 0)
          secureResult = stored.result || secureResult
        }

        setAlreadyDone(true)
      } else {
        setMatchingReviewVersion(1)
      }

      setTest({
        ...reviewSource,
        id: reviewSource.id || id,
        questions: Array.isArray(reviewSource.questions)
          ? reviewSource.questions
          : []
      })
      submittedRef.current = true
      setResult(secureResult)
      setSubmitted(true)
      setDraftRestored(false)
      setSubmitting(false)
    } catch (error) {
      console.error('Secure Vocabulary submission failed:', error)
      if (!isCurrent()) return

      submittingRef.current = false
      setSubmitting(false)
      setTimerVersion(version => version + 1)
      setOperationError(
        'Could not submit your vocabulary practice. Your answers are still here. Please click Submit answers to retry.'
      )
    }
  }

  const getOptionText = (question, letter) => {
    const index = letters.indexOf(letter)
    return question.options?.[index] || ''
  }

  const getStudentAnswerText = (question, groupIndex = 0) => {
    const type = getQuestionType(question)
    const selected = answers[answerKey(question.id)]

    if (type === 'match_definition') {
      if (!selected) return 'No answer'
      const selectedIndex = matchingDefinitionOrder.findIndex(
        (_, index) => getMatchingLetter(index) === selected
      )
      const definition =
        matchingDefinitionOrder[selectedIndex]?.definition || ''

      return `${question.word || question.question} → ${definition}`
    }

    if (type === 'word_bank' || type === 'grammar_form') {
      return selected || 'No answer'
    }

    return selected ? `${selected}. ${getOptionText(question, selected)}` : 'No answer'
  }

  const getCorrectAnswerText = (question, groupIndex = 0) => {
    const type = getQuestionType(question)

    if (type === 'match_definition') {
      return `${question.word || question.question} → ${question.definition}`
    }

    if (type === 'word_bank' || type === 'grammar_form') {
      return question.answerText || question.answer
    }

    return `${question.answer}. ${getOptionText(question, question.answer)}`
  }

  const renderMatchingTask = () => {
    if (groupedQuestions.matching.length === 0) return null

    const heading =
      groupedQuestions.matching[0].taskTitle ||
      'Task A - Match the words with their definitions'

    const instruction =
      groupedQuestions.matching[0].instruction ||
      'Match the words with their definitions.'

    const matchingStartNumber =
      getGlobalQuestionNumber(groupedQuestions.matching[0])

    const usedWordIds = getUsedMatchingWordIds()

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          {heading}
        </h2>

        <p className="text-sm text-gray-500">
          {instruction}
        </p>

        <p className="text-xs text-purple-600 font-medium mt-2 mb-5">
          Choose the correct word for each definition. Each word can be used once.
        </p>

        <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-6">
          <p className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-3">
            Words
          </p>

          <div className="flex flex-wrap gap-2">
            {groupedQuestions.matching.map(question => {
              const isUsed = usedWordIds.has(question.id)

              return (
                <span
                  key={question.id}
                  className={`text-sm px-3 py-1.5 rounded-full border ${
                    isUsed
                      ? 'bg-green-50 border-green-200 text-green-700'
                      : 'bg-white border-purple-100 text-purple-700'
                  }`}
                >
                  {question.word || question.question}
                  {isUsed ? ' ✓' : ''}
                </span>
              )
            })}
          </div>
        </div>

        <div className="space-y-3">
          {matchingDefinitionTexts.map((definitionText, definitionIndex) => {
            const selectedQuestionId =
              getWordSelectedForDefinition(definitionIndex)

            return (
              <div
                key={`definition-${definitionIndex}`}
                className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] gap-4 items-center border border-gray-100 rounded-2xl p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-50 text-purple-600 text-sm font-semibold flex items-center justify-center">
                    {matchingStartNumber + definitionIndex}
                  </span>

                  <p className="text-sm text-gray-800 leading-7">
                    {definitionText}
                  </p>
                </div>

                <select
                  value={selectedQuestionId}
                  onChange={event =>
                    handleDefinitionWordMatch(
                      definitionIndex,
                      event.target.value
                    )
                  }
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
                >
                  <option value="">Select word</option>

                  {groupedQuestions.matching.map(wordQuestion => {
                    const usedElsewhere =
                      usedWordIds.has(wordQuestion.id) &&
                      wordQuestion.id !== selectedQuestionId

                    return (
                      <option
                        key={wordQuestion.id}
                        value={wordQuestion.id}
                        disabled={usedElsewhere}
                      >
                        {wordQuestion.word || wordQuestion.question}
                        {usedElsewhere ? ' — Used' : ''}
                      </option>
                    )
                  })}
                </select>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const renderWordBankTask = group => {
    if (!group) return null

    const groupQuestions = group.questions
    const firstQuestion = groupQuestions[0]

    const heading =
      firstQuestion?.taskTitle ||
      'Task B - Complete the sentences'

    const instruction =
      firstQuestion?.instruction ||
      'Use the words in the box.'

    const words = Array.from(
      new Set(
        groupQuestions.flatMap(question =>
          parseWordBank(question.wordBank)
        )
      )
    )

    return (
      <div
        key={group.groupId}
        className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm"
      >
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          {heading}
        </h2>

        <p className="text-sm text-gray-500 mb-4">
          {instruction}
        </p>

        {words.length > 0 && (
          <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-5">
            <div className="flex flex-wrap gap-2">
              {words.map((word, index) => (
                <span
                  key={`${word}-${index}`}
                  className="text-sm bg-white border border-purple-100 text-purple-700 px-3 py-1.5 rounded-full"
                >
                  {word}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          {groupQuestions.map(question => (
            <div
              key={question.id}
              className="border border-gray-100 rounded-2xl p-4"
            >
              <p className="text-sm text-gray-800 leading-7 mb-3">
                <span className="font-semibold mr-2">
                  {getGlobalQuestionNumber(question)}.
                </span>

                {question.sentence || question.question}
              </p>

              <input
                value={answers[answerKey(question.id)] || ''}
                onChange={event =>
                  handleAnswer(
                    question.id,
                    event.target.value
                  )
                }
                placeholder="Type the correct word or phrase..."
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderGrammarTask = () => {
    if (groupedQuestions.grammar.length === 0) return null

    const heading = groupedQuestions.grammar[0].taskTitle || 'Task C - Grammar Focus'
    const instruction = groupedQuestions.grammar[0].instruction || 'Complete the sentences using the correct form.'
    const grammarNote = normalizeMultilineText(
      groupedQuestions.grammar.find(question => question.grammarNote)?.grammarNote || ''
    )

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
        <h2 className="text-xl font-bold text-gray-900 mb-2">{heading}</h2>
        <p className="text-sm text-gray-500 mb-4">{instruction}</p>

        {grammarNote && (
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-5 text-sm text-gray-800 leading-7 whitespace-pre-wrap mb-5">
            {grammarNote}
          </div>
        )}

        <div className="space-y-4">
          {groupedQuestions.grammar.map((question, index) => (
            <div key={question.id} className="border border-gray-100 rounded-2xl p-4">
              <p className="text-sm text-gray-800 leading-7 mb-2">
                <span className="font-semibold mr-2">{getGlobalQuestionNumber(question)}.</span>
                {question.sentence || question.question}
              </p>

              <p className="text-sm font-semibold text-gray-900 mb-3 ml-6">
                {question.baseWord}
              </p>

              <input
                value={answers[answerKey(question.id)] || ''}
                onChange={event => handleAnswer(question.id, event.target.value)}
                placeholder="Type the correct form..."
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderMcqTask = (mcqQuestions = groupedQuestions.mcq, sectionHeading = '') => {
    if (!mcqQuestions?.length) return null

    const firstQuestion = mcqQuestions[0]
    const heading =
      sectionHeading ||
      firstQuestion?.sectionTitle?.trim() ||
      firstQuestion?.taskTitle?.trim() ||
      'Vocabulary Multiple Choice'

    const instruction =
      firstQuestion?.instruction?.trim() ||
      'Choose the best answer.'

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          {heading}
        </h2>
        <p className="text-sm text-gray-500 mb-6">{instruction}</p>

        <div className="flex flex-col gap-6">
          {mcqQuestions.map((question, index) => (
            <div key={question.id}>
              {question.sectionTitle?.trim() && question.sectionTitle.trim() !== heading && (
                <div className="mb-3 pt-1">
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-gray-200" />
                    <h3 className="text-sm font-semibold text-gray-700 px-2 text-center">
                      {question.sectionTitle}
                    </h3>
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>
                </div>
              )}

              <div className="border border-gray-100 rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-xs font-medium text-gray-400">Q{getGlobalQuestionNumber(question)}</span>
                  <span className="text-xs px-2 py-1 rounded-full bg-purple-50 text-purple-600">Vocabulary MCQ</span>
                </div>

                <p className="text-sm text-gray-800 mb-4">{question.question}</p>

                <div className="flex flex-col gap-2">
                  {question.options?.map((option, optionIndex) => {
                    const letter = letters[optionIndex]
                    const isSelected = answers[answerKey(question.id)] === letter

                    return (
                      <button
                        key={optionIndex}
                        type="button"
                        onClick={() => handleAnswer(question.id, letter)}
                        className={`text-left px-4 py-3 rounded-xl text-sm border transition-all ${
                          isSelected
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'border-gray-200 text-gray-700 hover:border-purple-300'
                        }`}
                      >
                        <span className="font-semibold mr-2">{letter}.</span>
                        {option}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const getDefinitionReview = question => {
    if (matchingReviewVersion !== 1 || getQuestionType(question) !== 'match_definition') return null
    const index = groupedQuestions.matching.findIndex(item => item.id === question.id)
    const definition = matchingDefinitionOrder[index]
    if (!definition) return null
    const selectedId = getWordSelectedForDefinition(index)
    const word = groupedQuestions.matching.find(item => item.id === selectedId)
    return {
      correct: Boolean(word && word.id === definition.id),
      prompt: definition.definition || '',
      studentAnswer: word ? word.word || word.question : 'No answer',
      correctAnswer: definition.word || definition.question || ''
    }
  }

  const reviewGroups = () => {
    return displayBlocks.map(section => {
      if (section.type === 'matching') {
        return [
          groupedQuestions.matching[0]?.taskTitle ||
            'Task A - Matching',
          groupedQuestions.matching
        ]
      }

      if (section.type === 'wordBank') {
        return [
          section.group?.questions?.[0]?.taskTitle ||
            'Task B - Complete the sentences',
          section.group?.questions || []
        ]
      }

      if (section.type === 'grammar') {
        return [
          groupedQuestions.grammar[0]?.taskTitle ||
            'Task C - Grammar completion',
          groupedQuestions.grammar
        ]
      }

      return [
        section.title ||
          section.questions?.[0]?.taskTitle ||
          'Vocabulary Multiple Choice',
        section.questions || []
      ]
    })
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
        <div className="bg-white border border-red-100 rounded-2xl p-6 max-w-lg">
          <h1 className="font-semibold text-gray-900 mb-3">Practice could not be loaded</h1>
          <p role="alert" className="text-sm text-red-600 mb-5">{loadError}</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => setReloadCount(count => count + 1)}
              className="bg-purple-600 text-white rounded-xl px-4 py-2 text-sm">Retry</button>
            <button type="button" onClick={() => navigate('/student')}
              className="bg-gray-100 rounded-xl px-4 py-2 text-sm">Back to dashboard</button>
          </div>
        </div>
      </div>
    )
  }

  if (loading || !test || test.id !== id) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  if (submitted && !result) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
        <div className="bg-white rounded-2xl p-6 max-w-lg text-center">
          <p className="text-gray-800 mb-4">This practice has already been submitted. Its saved score is unavailable. Please contact your teacher.</p>
          <button type="button" onClick={() => navigate('/student')}
            className="bg-purple-600 text-white px-4 py-2 rounded-xl">Back to dashboard</button>
        </div>
      </div>
    )
  }

  if (submitted && result) {
    return (
      <div className="min-h-screen bg-[#faf9f6]">
        <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
          <img src="/1.png" alt="Maxima" className="h-14 object-contain" />

          <button
            onClick={() => navigate('/student')}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Back to dashboard
          </button>
        </nav>

        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center shadow-sm mb-8">
            <div className="text-5xl font-bold text-purple-600 mb-2">
              {result.percentage}%
            </div>

            <p className="text-gray-400 text-sm mb-1">Vocabulary Practice Score</p>
            <p className="text-gray-600 text-sm mb-4">{result.correct} / {result.total} correct answers</p>

            <p className="text-green-600 text-sm bg-green-50 rounded-xl py-2 px-4 inline-block">
              {alreadyDone
                ? 'You already completed this vocabulary practice. You can review your answers.'
                : 'Submitted successfully. Review your answers below.'}
            </p>
          </div>

          <div className="space-y-6">
            {reviewGroups().map(([groupTitle, items], groupIndex) => (
              <div key={displayBlocks[groupIndex].key} className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                <h2 className="font-semibold text-gray-800 mb-5">{groupTitle}</h2>

                <div className="flex flex-col gap-4">
                  {items.map((question, index) => {
                    const definitionReview = getDefinitionReview(question)
                    const correct = definitionReview ? definitionReview.correct : isCorrect(question)

                    return (
                      <div
                        key={question.id}
                        className={`border rounded-xl p-5 ${correct ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}
                      >
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <p className="text-xs font-semibold text-gray-400">
                            Question {getGlobalQuestionNumber(question)}
                          </p>
                          <span className={`text-xs font-semibold ${correct ? 'text-green-600' : 'text-red-600'}`}>
                            {correct ? 'Correct' : 'Wrong'}
                          </span>
                        </div>

                        {question.sectionTitle?.trim() && (
                          <p className="text-xs font-semibold text-purple-600 mb-2">
                            {question.sectionTitle}
                          </p>
                        )}

                        <p className="text-sm font-medium text-gray-800 mb-4">
                          {definitionReview ? definitionReview.prompt : getQuestionPrompt(question)}
                        </p>

                        <p className="text-xs text-gray-500 mb-1">Your answer:</p>
                        <p className="text-sm text-gray-800 mb-3">
                          {definitionReview ? definitionReview.studentAnswer : getStudentAnswerText(question, index)}
                        </p>

                        {!correct && (
                          <>
                            <p className="text-xs text-gray-500 mb-1">Correct answer:</p>
                            <p className="text-sm font-medium text-green-700">
                              {definitionReview ? definitionReview.correctAnswer : getCorrectAnswerText(question, index)}
                            </p>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() => navigate('/student')}
            className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-8"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 uppercase tracking-wide">
            {test.title}
          </span>

          <div
            className={`font-mono text-lg font-bold px-4 py-1.5 rounded-xl ${
              timeLeft <= 60
                ? 'bg-red-50 text-red-600'
                : timeLeft <= 300
                  ? 'bg-amber-50 text-amber-600'
                  : 'bg-green-50 text-green-600'
            }`}
          >
            {formatTime(timeLeft)}
          </div>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-6 shadow-sm">
          <h1 className="text-xl font-bold text-gray-900 mb-2">{test.title}</h1>

          {test.instructions && (
            <p className="text-sm text-gray-500 whitespace-pre-wrap">{test.instructions}</p>
          )}

          <p className="text-xs text-purple-600 mt-3 font-medium">
            Complete all vocabulary tasks below.
          </p>

          {draftRestored && (
            <div className="mt-4 bg-blue-50 border border-blue-100 text-blue-700 rounded-xl px-4 py-3 text-sm">
              ✓ Your saved progress has been restored. Continue where you left off.
            </div>
          )}
        </div>

        {operationError && (
          <p role="alert" className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-4 mb-5 text-sm">
            {operationError}
          </p>
        )}
        {operationSlow && (draftSaving || submitting) && (
          <p role="status" className="bg-amber-50 text-amber-800 rounded-xl p-4 mb-5 text-sm">
            Waiting for the server to confirm. Keep this page open and check your connection. This operation has not been confirmed yet.
          </p>
        )}
        {timeLeft <= 0 && !submitting && (
          <p className="text-sm text-red-600 mb-4">Time has finished. Answers are locked; Submit answers remains available if a retry is needed.</p>
        )}

        <fieldset disabled={answersLocked} className="min-w-0 space-y-6">
          {displayBlocks.map(section => {
            if (section.type === 'matching') {
              return (
                <div key={section.key}>
                  {renderMatchingTask()}
                </div>
              )
            }

            if (section.type === 'wordBank') {
              return (
                <div key={section.key}>
                  {renderWordBankTask(section.group)}
                </div>
              )
            }

            if (section.type === 'grammar') {
              return (
                <div key={section.key}>
                  {renderGrammarTask()}
                </div>
              )
            }

            return (
              <div key={section.key}>
                {renderMcqTask(section.questions, section.title)}
              </div>
            )
          })}
        </fieldset>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-8">
          <button
            type="button"
            onClick={handleSaveAndContinueLater}
            disabled={
              draftSaving ||
              submitting ||
              timeLeft <= 0
            }
            className="w-full bg-white border border-purple-200 text-purple-700 rounded-xl py-4 text-sm font-medium hover:bg-purple-50 disabled:opacity-60"
          >
            {draftSaving
              ? 'Saving...'
              : 'Save & Continue Later'}
          </button>

          <button
            onClick={() => handleSubmit(false)}
            disabled={submitting || draftSaving}
            className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
          >
            {submitting ? 'Submitting...' : 'Submit answers'}
          </button>
        </div>
      </div>
    </div>
  )
}
