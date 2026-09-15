import { useEffect, useMemo, useRef, useState } from 'react'
import { auth, db } from '../firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { useNavigate, useParams } from 'react-router-dom'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

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
    .split(/\n|,|\u2013|-/)
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

  const timerRef = useRef(null)
  const submittingRef = useRef(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        const profileSnap = await getDoc(doc(db, 'users', currentUser.uid))

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

        const testSnap = await getDoc(doc(db, 'vocabularyTests', id))

        if (!testSnap.exists()) {
          alert('Vocabulary test not found.')
          navigate('/student')
          return
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

        const existingSnap = await getDocs(existingQuery)

        const submissions = existingSnap.docs
          .map(item => item.data())
          .filter(submission => isSubmissionForVocabularyTest(submission, id))
          .sort(
            (a, b) =>
              new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
          )

        if (submissions.length > 0) {
          const submission = submissions[0]

          setAlreadyDone(true)
          setAnswers(submission.answers || {})
          setResult(submission.result || null)
          setSubmitted(true)
        }
      } catch (error) {
        console.error(error)
        alert('Could not load vocabulary test.')
        navigate('/student')
      }
    })

    return unsub
  }, [id, navigate])

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

  const matchingDefinitionOrder = useMemo(() => {
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

  const matchingQuestionCount = groupedQuestions.matching.length
  const wordBankStartNumber = matchingQuestionCount + 1
  const grammarStartNumber =
    matchingQuestionCount + groupedQuestions.wordBank.length + 1
  const mcqStartNumber =
    matchingQuestionCount +
    groupedQuestions.wordBank.length +
    groupedQuestions.grammar.length +
    1

  const getGlobalQuestionNumber = question => {
    const type = getQuestionType(question)

    if (type === 'match_definition') {
      const index = groupedQuestions.matching.findIndex(
        item => item.id === question.id
      )
      return index + 1
    }

    if (type === 'word_bank') {
      const index = groupedQuestions.wordBank.findIndex(
        item => item.id === question.id
      )
      return wordBankStartNumber + index
    }

    if (type === 'grammar_form') {
      const index = groupedQuestions.grammar.findIndex(
        item => item.id === question.id
      )
      return grammarStartNumber + index
    }

    const index = groupedQuestions.mcq.findIndex(
      item => item.id === question.id
    )
    return mcqStartNumber + index
  }

  useEffect(() => {
    if (timeLeft === null || submitted) return

    if (timeLeft <= 0) {
      handleSubmit(true)
      return
    }

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => Math.max(prev - 1, 0))
    }, 1000)

    return () => clearInterval(timerRef.current)
  }, [timeLeft, submitted])

  const formatTime = secs => {
    const safeSeconds = Math.max(Number(secs) || 0, 0)
    const m = Math.floor(safeSeconds / 60).toString().padStart(2, '0')
    const s = (safeSeconds % 60).toString().padStart(2, '0')

    return `${m}:${s}`
  }

  const handleAnswer = (questionId, value) => {
    setAnswers(prev => ({
      ...prev,
      [answerKey(questionId)]: value
    }))
  }

  const isCorrect = (question, groupIndex = 0) => {
    const type = getQuestionType(question)
    const selected = answers[answerKey(question.id)]

    if (type === 'match_definition') {
      const selectedIndex = letters.indexOf(selected)

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

    return selected === question.answer
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

  const handleSubmit = async (autoSubmit = false) => {
    if (submittingRef.current || submitted || alreadyDone || !test || !user) return

    if (!autoSubmit) {
      const ok = window.confirm('Submit your vocabulary practice? You cannot retake it after submitting.')
      if (!ok) return
    }

    submittingRef.current = true
    setSubmitting(true)

    clearInterval(timerRef.current)

    const res = calculateScore()
    const submissionTeacherIds = getSourceTeacherIds(test)

    try {
      await addDoc(collection(db, 'vocabularySubmissions'), {
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
        answers,
        result: res,
        submittedAt: new Date().toISOString(),
        archived: false,
        finishedLate: timeLeft <= 0,
        autoSubmitted: autoSubmit
      })

      setResult(res)
      setSubmitted(true)
    } catch (error) {
      console.error(error)
      alert('Could not submit your vocabulary practice. Please try again.')
      submittingRef.current = false
      setSubmitting(false)
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
      const selectedIndex = letters.indexOf(selected)
      const definition = matchingDefinitionOrder[selectedIndex]?.definition || ''
      return `${selected}. ${definition}`
    }

    if (type === 'word_bank' || type === 'grammar_form') {
      return selected || 'No answer'
    }

    return selected ? `${selected}. ${getOptionText(question, selected)}` : 'No answer'
  }

  const getCorrectAnswerText = (question, groupIndex = 0) => {
    const type = getQuestionType(question)

    if (type === 'match_definition') {
      const correctIndex = matchingDefinitionOrder.findIndex(
        item => item.id === question.id
      )

      const letter = correctIndex >= 0
        ? letters[correctIndex]
        : '?'

      return `${letter}. ${question.definition}`
    }

    if (type === 'word_bank' || type === 'grammar_form') {
      return question.answerText || question.answer
    }

    return `${question.answer}. ${getOptionText(question, question.answer)}`
  }

  const renderMatchingTask = () => {
    if (groupedQuestions.matching.length === 0) return null

    const heading = groupedQuestions.matching[0].taskTitle || 'Task A - Match the words with their definitions'
    const instruction = groupedQuestions.matching[0].instruction || `Match 1-${groupedQuestions.matching.length} with A-${letters[groupedQuestions.matching.length - 1]}.`

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
        <h2 className="text-xl font-bold text-gray-900 mb-2">{heading}</h2>
        <p className="text-sm text-gray-500 mb-6">{instruction}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="space-y-2">
            {groupedQuestions.matching.map((question, index) => (
              <p key={question.id} className="text-sm text-gray-800">
                <span className="font-semibold mr-2">{index + 1}.</span>
                {question.word || question.question}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            {matchingDefinitionOrder.map((question, index) => (
              <p key={question.id} className="text-sm text-gray-700">
                <span className="font-semibold mr-2">{letters[index]}.</span>
                {question.definition}
              </p>
            ))}
          </div>
        </div>

        <div className="space-y-3 border-t border-gray-100 pt-4">
          {groupedQuestions.matching.map((question, index) => (
            <div key={question.id} className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-3 items-center">
              <p className="text-sm text-gray-800">
                {index + 1}. {question.word || question.question}
              </p>

              <select
                value={answers[answerKey(question.id)] || ''}
                onChange={event => handleAnswer(question.id, event.target.value)}
                className="border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 bg-white"
              >
                <option value="">Choose</option>
                {groupedQuestions.matching.map((_, optionIndex) => (
                  <option key={optionIndex} value={letters[optionIndex]}>
                    {letters[optionIndex]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderWordBankTask = () => {
    if (wordBankGroups.length === 0) return null

    return (
      <>
        {wordBankGroups.map(group => {
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
        })}
      </>
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
                <span className="font-semibold mr-2">{grammarStartNumber + index}.</span>
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

  const renderMcqTask = () => {
    if (groupedQuestions.mcq.length === 0) return null

    return (
      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          Vocabulary Multiple Choice
        </h2>
        <p className="text-sm text-gray-500 mb-6">Choose the best answer.</p>

        <div className="flex flex-col gap-6">
          {groupedQuestions.mcq.map((question, index) => (
            <div key={question.id}>
              {question.sectionTitle?.trim() && (
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
                  <span className="text-xs font-medium text-gray-400">Q{mcqStartNumber + index}</span>
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

  const reviewGroups = () => {
    const groups = []

    if (groupedQuestions.matching.length > 0) {
      groups.push(['Task A - Matching', groupedQuestions.matching])
    }

    wordBankGroups.forEach(group => {
      const heading =
        group.questions[0]?.taskTitle ||
        'Task B - Complete the sentences'

      groups.push([heading, group.questions])
    })

    if (groupedQuestions.grammar.length > 0) {
      groups.push(['Task C - Grammar completion', groupedQuestions.grammar])
    }

    if (groupedQuestions.mcq.length > 0) {
      groups.push(['Vocabulary Multiple Choice', groupedQuestions.mcq])
    }

    return groups
  }

  if (!test) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
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
            {reviewGroups().map(([groupTitle, items]) => (
              <div key={groupTitle} className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                <h2 className="font-semibold text-gray-800 mb-5">{groupTitle}</h2>

                <div className="flex flex-col gap-4">
                  {items.map((question, index) => {
                    const correct = isCorrect(question)

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
                          {getQuestionPrompt(question)}
                        </p>

                        <p className="text-xs text-gray-500 mb-1">Your answer:</p>
                        <p className="text-sm text-gray-800 mb-3">
                          {getStudentAnswerText(question, index)}
                        </p>

                        {!correct && (
                          <>
                            <p className="text-xs text-gray-500 mb-1">Correct answer:</p>
                            <p className="text-sm font-medium text-green-700">
                              {getCorrectAnswerText(question, index)}
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
        </div>

        <div className="space-y-6">
          {renderMatchingTask()}
          {renderWordBankTask()}
          {renderGrammarTask()}
          {renderMcqTask()}
        </div>

        <button
          onClick={() => handleSubmit(false)}
          disabled={submitting}
          className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-8 disabled:opacity-60"
        >
          {submitting ? 'Submitting...' : 'Submit answers'}
        </button>
      </div>
    </div>
  )
}
