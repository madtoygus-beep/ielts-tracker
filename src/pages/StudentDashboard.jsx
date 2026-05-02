import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import { collection, query, where, onSnapshot, doc, getDoc } from 'firebase/firestore'
import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

const isHiddenForCurrentUser = (item, uid) =>
  Array.isArray(item.hiddenFor) && item.hiddenFor.includes(uid)


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

function ReadingHomeworkSection({ user }) {
  const [readings, setReadings] = useState([])
  const [submissions, setSubmissions] = useState([])
  const navigate = useNavigate()

  useEffect(() => {
    if (!user) return

    const q = query(collection(db, 'readings'))

    const unsub = onSnapshot(q, snap => {
      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r =>
          !r.archived &&
          r.assignTo?.includes(user.uid) &&
          !isHiddenForCurrentUser(r, user.uid)
        )

      all.sort((a, b) => {
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return new Date(a.dueDate) - new Date(b.dueDate)
      })

      setReadings(all)
    })

    return unsub
  }, [user])

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
            {todoReadings.map(r => {
              const badge = dueLabel(r)

              return (
                <div
                  key={r.id}
                  className="bg-white border border-red-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {r.title}
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
            {completedReadings.map(r => {
              const result = getResult(r.id)

              return (
                <div
                  key={r.id}
                  className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {r.title}
                    </p>

                    <p className="text-xs text-gray-400 mt-0.5">
                      ⏱ {r.timeLimit} min · {r.questions?.length || 0} question sets
                    </p>

                    <p className="text-xs text-green-600 mt-1 font-medium">
                      ✓ Completed — Band {result?.band}
                    </p>
                  </div>

                  <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                    Done
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}


function ListeningHomeworkSection({ user }) {
  const [listenings, setListenings] = useState([])
  const [submissions, setSubmissions] = useState([])
  const navigate = useNavigate()

  useEffect(() => {
    if (!user) return

    const q = query(collection(db, 'listenings'))

    const unsub = onSnapshot(q, snap => {
      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(l =>
          !l.archived &&
          l.assignTo?.includes(user.uid) &&
          !isHiddenForCurrentUser(l, user.uid)
        )

      all.sort((a, b) => {
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return new Date(a.dueDate) - new Date(b.dueDate)
      })

      setListenings(all)
    })

    return unsub
  }, [user])

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
            {todoListenings.map(l => {
              const badge = dueLabel(l)

              return (
                <div
                  key={l.id}
                  className="bg-white border border-red-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {l.title}
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
            {completedListenings.map(l => {
              const result = getResult(l.id)

              return (
                <div
                  key={l.id}
                  className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {l.title}
                    </p>

                    <p className="text-xs text-gray-400 mt-0.5">
                      ⏱ {l.timeLimit || 30} min · {l.questions?.length || 0} questions
                    </p>

                    <p className="text-xs text-green-600 mt-1 font-medium">
                      ✓ Completed — Band {result?.band}
                    </p>
                  </div>

                  <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                    Done
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}


function MockTestSection({ user }) {
  const [mocks, setMocks] = useState([])
  const [submissions, setSubmissions] = useState([])
  const navigate = useNavigate()

  useEffect(() => {
    if (!user) return

    const q = query(collection(db, 'mockTests'))

    const unsub = onSnapshot(q, snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m =>
          !m.archived &&
          m.assignTo?.includes(user.uid) &&
          !isHiddenForCurrentUser(m, user.uid)
        )

      list.sort((a, b) => {
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return new Date(a.dueDate) - new Date(b.dueDate)
      })

      setMocks(list)
    })

    return unsub
  }, [user])

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
        🧠 Full Mock Tests
      </h2>

      {todoMocks.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-3">
            To Do
          </p>

          <div className="flex flex-col gap-3">
            {todoMocks.map(mock => {
              const badge = dueLabel(mock)

              return (
                <div
                  key={mock.id}
                  className="bg-white border border-purple-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {mock.title}
                    </p>

                    <p className="text-xs text-gray-400 mt-0.5">
                      Listening + Reading Passage 1, 2, 3 + Writing
                    </p>

                    <div className="flex gap-2 mt-2 flex-wrap">
                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                        Full IELTS Mock
                      </span>

                      <span className={`text-xs px-3 py-1 rounded-full ${badge.style}`}>
                        {badge.text}
                      </span>

                      <span className="text-xs bg-red-50 text-red-500 px-3 py-1 rounded-full">
                        Not completed
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => navigate(`/do-mock/${mock.id}`)}
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

      {completedMocks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-3">
            Completed
          </p>

          <div className="flex flex-col gap-3">
            {completedMocks.map(mock => {
              const submission = getSubmission(mock.id)
              const result = submission?.result

              return (
                <div
                  key={mock.id}
                  className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {mock.title}
                    </p>

                    <p className="text-xs text-gray-400 mt-0.5">
                      Submitted {submission?.submittedAt ? new Date(submission.submittedAt).toLocaleDateString() : ''}
                    </p>

                    <div className="flex gap-2 mt-2 flex-wrap">
                      <span className="text-xs bg-green-50 text-green-600 px-3 py-1 rounded-full">
                        Completed
                      </span>

                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                        Overall {result?.overallEstimate || '-'}
                      </span>

                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1 rounded-full">
                        Writing pending review
                      </span>
                    </div>
                  </div>

                  <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                    Done
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}


function WritingProgressAnalytics({ user }) {
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

    const q = query(collection(db, 'writingHomeworks'))

    const unsub = onSnapshot(q, snap => {
      const map = {}

      snap.docs.forEach(d => {
        const item = {
          id: d.id,
          ...d.data()
        }

        if (isHiddenForCurrentUser(item, user.uid)) return

        map[d.id] = item
      })

      setWritingMap(map)
    })

    return unsub
  }, [user])

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

function WritingHomeworkSection({ user }) {
  const [writings, setWritings] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [selectedReview, setSelectedReview] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!user) return

    const q = query(collection(db, 'writingHomeworks'))

    const unsub = onSnapshot(q, snap => {
      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(w =>
          !w.archived &&
          w.assignTo?.includes(user.uid) &&
          !isHiddenForCurrentUser(w, user.uid)
        )

      all.sort((a, b) => {
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return new Date(a.dueDate) - new Date(b.dueDate)
      })

      setWritings(all)
    })

    return unsub
  }, [user])

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
            {todoWritings.map(w => {
              const badge = dueLabel(w)

              return (
                <div
                  key={w.id}
                  className="bg-white border border-red-100 rounded-2xl p-5 flex items-center justify-between shadow-sm"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {w.title}
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
            {completedWritings.map(w => {
              const submission = getSubmission(w.id)
              const reviewed = Boolean(submission?.reviewed)

              return (
                <div
                  key={w.id}
                  className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {w.title}
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
                    {reviewed && (
                      <button
                        onClick={() =>
                          setSelectedReview({
                            writing: w,
                            submission
                          })
                        }
                        className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                      >
                        Review
                      </button>
                    )}

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
                  Overall Band {selectedReview.submission.review?.overall}
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

export default function StudentDashboard() {
  const [scores, setScores] = useState([])
  const [user, setUser] = useState(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState('')
  const navigate = useNavigate()

  const targetBand = 7.0

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

  const manualScores = scores.filter(score => score.source !== 'mock_test')
  const latest = manualScores[0]
  const previous = manualScores[1]

  const currentBand = latest ? Number(latest.overall) : 0

  const progress = latest
    ? Math.min(Math.round((currentBand / targetBand) * 100), 100)
    : 0

  const overallChange =
    latest && previous
      ? (Number(latest.overall) - Number(previous.overall)).toFixed(1)
      : null

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
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img
          src="/1.png"
          alt="Maxima"
          className="h-10 object-contain"
        />

        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">
            {user?.email}
          </span>

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

      <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          My Dashboard
        </h1>

        <p className="text-gray-400 text-sm mb-8">
          Your IELTS results and homework
        </p>

        {manualScores.length === 0 ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-12 text-center mb-8">
            <div className="text-4xl mb-4">
              📋
            </div>

            <p className="text-gray-700 font-medium mb-2">
              No scores yet
            </p>

            <p className="text-gray-400 text-sm">
              Your teacher will log your IELTS scores here.
            </p>
          </div>
        ) : (
          <>
            {latest && (
              <>
                <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">
                        Target progress
                      </p>

                      <p className="text-lg font-semibold text-gray-900">
                        Target Band {targetBand}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs text-gray-400 mb-1">
                        Current
                      </p>

                      <p className={`text-2xl font-bold ${getBandColor(currentBand)}`}>
                        {currentBand.toFixed(1)}
                      </p>
                    </div>
                  </div>

                  <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
                    <div
                      className="bg-purple-600 h-3 rounded-full"
                      style={{ width: `${progress}%` }}
                    />
                  </div>

                  <div className="flex justify-between mt-2">
                    <p className="text-xs text-gray-400">
                      Progress {progress}%
                    </p>

                    {overallChange !== null && (
                      <p
                        className={`text-xs font-medium ${
                          Number(overallChange) >= 0
                            ? 'text-green-600'
                            : 'text-red-500'
                        }`}
                      >
                        {Number(overallChange) >= 0 ? '+' : ''}
                        {overallChange}
                      </p>
                    )}
                  </div>
                </div>

                <div className="bg-gray-900 text-white rounded-2xl p-6 mb-6">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">
                        Latest test
                      </p>

                      <p className="text-gray-300 text-sm">
                        {latest.date}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-gray-400 text-xs mb-1">
                        Overall
                      </p>

                      <p className="text-4xl font-bold">
                        {latest.overall}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-3">
                    {['listening', 'reading', 'writing', 'speaking'].map(skill => (
                      <div
                        key={skill}
                        className="bg-white/10 rounded-xl p-3 text-center"
                      >
                        <p className="text-gray-400 text-xs capitalize mb-1">
                          {skill}
                        </p>

                        <p className="text-xl font-bold">
                          {latest[skill]}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
              <h2 className="font-semibold text-gray-800 mb-4">
                Score history
              </h2>

              <div className="flex flex-col gap-0">
                {manualScores.map((score, i) => (
                  <div
                    key={score.id}
                    className={`py-4 ${
                      i !== manualScores.length - 1
                        ? 'border-b border-gray-50'
                        : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-gray-700">
                        {score.date}
                      </p>

                      <p className={`text-xl font-bold ${getBandColor(score.overall)}`}>
                        {score.overall}
                      </p>
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                      {['listening', 'reading', 'writing', 'speaking'].map(skill => (
                        <div
                          key={skill}
                          className={`rounded-lg p-2 text-center ${getBandBg(score[skill])}`}
                        >
                          <p className="text-xs text-gray-400 capitalize mb-0.5">
                            {skill.slice(0, 3)}
                          </p>

                          <p className={`text-sm font-semibold ${getBandColor(score[skill])}`}>
                            {score[skill]}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <WritingProgressAnalytics user={user} />

        <MockTestSection user={user} />

        <ListeningHomeworkSection user={user} />

        <ReadingHomeworkSection user={user} />

        <WritingHomeworkSection user={user} />
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