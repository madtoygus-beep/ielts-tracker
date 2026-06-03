import { useEffect, useRef, useState } from 'react'
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

        const profile = profileSnap.data()

        if (
          profile.deleted === true ||
          profile.status !== 'approved' ||
          profile.role !== 'student'
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        setUser(currentUser)
        setProfile(profile)

        const testSnap = await getDoc(doc(db, 'vocabularyTests', id))

        if (!testSnap.exists()) {
          alert('Vocabulary test not found.')
          navigate('/student')
          return
        }

        const data = {
          id: testSnap.id,
          ...testSnap.data()
        }

        if (!isAssignedToCurrentUser(data, currentUser, profile)) {
          alert('This vocabulary test is not assigned to you.')
          navigate('/student')
          return
        }

        if (isHiddenForCurrentUser(data, currentUser, profile) || data.archived === true) {
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
    const m = Math.floor(secs / 60).toString().padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')

    return `${m}:${s}`
  }

  const handleAnswer = (questionId, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: value
    }))
  }

  const calculateScore = () => {
    const questions = test?.questions || []
    let correct = 0
    let total = 0

    questions.forEach(question => {
      total++

      if (answers[question.id] === question.answer) {
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
      const ok = window.confirm('Submit your vocabulary test? You cannot retake it after submitting.')
      if (!ok) return
    }

    submittingRef.current = true
    setSubmitting(true)

    clearInterval(timerRef.current)

    const res = calculateScore()

    try {
      await addDoc(collection(db, 'vocabularySubmissions'), {
        uid: user.uid,
        studentEmail: user.email || profile?.email || '',
        studentName: profile?.name || profile?.fullName || user.email || '',
        vocabularyTestId: id,
        vocabularyId: id,
        testId: id,
        homeworkId: id,
        vocabularyTitle: test.title || '',
        teacherId: test.teacherId || test.createdBy || '',
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
      alert('Could not submit your vocabulary test. Please try again.')
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const getOptionText = (question, letter) => {
    const index = letters.indexOf(letter)
    return question.options?.[index] || ''
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
            ← Back to dashboard
          </button>
        </nav>

        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center shadow-sm mb-8">
            <div className="text-5xl font-bold text-purple-600 mb-2">
              {result.percentage}%
            </div>

            <p className="text-gray-400 text-sm mb-1">
              Vocabulary Test Score
            </p>

            <p className="text-gray-600 text-sm mb-4">
              {result.correct} / {result.total} correct answers
            </p>

            <p className="text-green-600 text-sm bg-green-50 rounded-xl py-2 px-4 inline-block">
              {alreadyDone
                ? 'You already completed this vocabulary test. You can review your answers.'
                : 'Submitted successfully. Review your answers below.'}
            </p>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
            <h2 className="font-semibold text-gray-800 mb-5">
              Answer Review
            </h2>

            <div className="flex flex-col gap-4">
              {test.questions?.map((question, index) => {
                const selected = answers[question.id]
                const correct = selected === question.answer

                return (
                  <div
                    key={question.id}
                    className={`border rounded-xl p-5 ${
                      correct
                        ? 'bg-green-50 border-green-100'
                        : 'bg-red-50 border-red-100'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <p className="text-xs font-semibold text-gray-400">
                        Question {index + 1}
                      </p>

                      <span className={`text-xs font-semibold ${correct ? 'text-green-600' : 'text-red-600'}`}>
                        {correct ? 'Correct' : 'Wrong'}
                      </span>
                    </div>

                    <p className="text-sm font-medium text-gray-800 mb-4">
                      {question.question}
                    </p>

                    <p className="text-xs text-gray-500 mb-1">
                      Your answer:
                    </p>

                    <p className="text-sm text-gray-800 mb-3">
                      {selected ? `${selected}. ${getOptionText(question, selected)}` : 'No answer'}
                    </p>

                    {!correct && (
                      <>
                        <p className="text-xs text-gray-500 mb-1">
                          Correct answer:
                        </p>

                        <p className="text-sm font-medium text-green-700">
                          {question.answer}. {getOptionText(question, question.answer)}
                        </p>
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            <button
              onClick={() => navigate('/student')}
              className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-8"
            >
              Back to dashboard
            </button>
          </div>
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
            ⏱ {formatTime(timeLeft)}
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-6 shadow-sm">
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            {test.title}
          </h1>

          {test.instructions && (
            <p className="text-sm text-gray-500 whitespace-pre-wrap">
              {test.instructions}
            </p>
          )}

          <p className="text-xs text-purple-600 mt-3 font-medium">
            Choose the best answer for each question.
          </p>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
          <div className="flex flex-col gap-6">
            {test.questions?.map((question, index) => (
              <div
                key={question.id}
                className="border border-gray-100 rounded-2xl p-5"
              >
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-xs font-medium text-gray-400">
                    Q{index + 1}
                  </span>

                  <span className="text-xs px-2 py-1 rounded-full bg-purple-50 text-purple-600">
                    Vocabulary MCQ
                  </span>
                </div>

                <p className="text-sm text-gray-800 mb-4">
                  {question.question}
                </p>

                <div className="flex flex-col gap-2">
                  {question.options?.map((option, optionIndex) => {
                    const letter = letters[optionIndex]
                    const isSelected = answers[question.id] === letter

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
                        <span className="font-semibold mr-2">
                          {letter}.
                        </span>
                        {option}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
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
    </div>
  )
}
