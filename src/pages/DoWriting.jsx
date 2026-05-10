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

function countWords(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')

  const s = (seconds % 60).toString().padStart(2, '0')

  return `${m}:${s}`
}

export default function DoWriting() {
  const { id } = useParams()
  const navigate = useNavigate()

  const timerRef = useRef(null)
  const autosaveTimeoutRef = useRef(null)
  const draftStatusTimeoutRef = useRef(null)
  const submittingRef = useRef(false)

  const [user, setUser] = useState(null)
  const [writing, setWriting] = useState(null)
  const [currentTask, setCurrentTask] = useState(1)
  const [task1Answer, setTask1Answer] = useState('')
  const [task2Answer, setTask2Answer] = useState('')
  const [timeLeft, setTimeLeft] = useState(60 * 60)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [alreadyDone, setAlreadyDone] = useState(false)
  const [loading, setLoading] = useState(true)
  const [imageZoomOpen, setImageZoomOpen] = useState(false)
  const [draftStatus, setDraftStatus] = useState('')
  const [draftLoaded, setDraftLoaded] = useState(false)

  const draftKey = user ? `writingDraft_${id}_${user.uid}` : null

  const showDraftStatus = message => {
    setDraftStatus(message)

    if (draftStatusTimeoutRef.current) {
      clearTimeout(draftStatusTimeoutRef.current)
    }

    draftStatusTimeoutRef.current = setTimeout(() => {
      setDraftStatus('')
    }, 2500)
  }

  const saveDraftToStorage = (statusMessage = 'Draft saved ✓') => {
    if (!draftKey) return false

    const hasContent =
      task1Answer.trim() ||
      task2Answer.trim()

    if (!hasContent) return false

    const draft = {
      writingId: id,
      task1Answer,
      task2Answer,
      currentTask,
      timeLeft,
      savedAt: new Date().toISOString()
    }

    localStorage.setItem(draftKey, JSON.stringify(draft))
    showDraftStatus(statusMessage)

    return true
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

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

      const snap = await getDoc(doc(db, 'writingHomeworks', id))

      if (!snap.exists()) {
        alert('Writing homework not found.')
        navigate('/student')
        return
      }

      const data = {
        id: snap.id,
        ...snap.data()
      }

      if (!data.assignTo?.includes(currentUser.uid)) {
        alert('This writing homework is not assigned to you.')
        navigate('/student')
        return
      }

      if (data.hiddenFor?.includes(currentUser.uid) || data.archived === true) {
        alert('This writing homework is no longer available.')
        navigate('/student')
        return
      }

      setWriting(data)
      setTimeLeft((data.timeLimit || 60) * 60)

      const q = query(
        collection(db, 'writingSubmissions'),
        where('uid', '==', currentUser.uid),
        where('writingId', '==', id)
      )

      const existing = await getDocs(q)

      if (!existing.empty) {
        const sub = existing.docs[0].data()

        setAlreadyDone(true)
        setSubmitted(true)
        setTask1Answer(sub.task1Answer || '')
        setTask2Answer(sub.task2Answer || '')
      }

      setLoading(false)
    })

    return unsub
  }, [id, navigate])

  useEffect(() => {
    if (!draftKey || submitted || alreadyDone || draftLoaded) return

    const savedDraft = localStorage.getItem(draftKey)

    if (savedDraft) {
      try {
        const draft = JSON.parse(savedDraft)

        const hasContent =
          draft.task1Answer?.trim() ||
          draft.task2Answer?.trim()

        if (hasContent) {
          const restore = window.confirm(
            'A saved writing draft was found. Do you want to restore it?'
          )

          if (restore) {
            setTask1Answer(draft.task1Answer || '')
            setTask2Answer(draft.task2Answer || '')
            setCurrentTask(draft.currentTask || 1)

            if (typeof draft.timeLeft === 'number' && draft.timeLeft > 0) {
              setTimeLeft(draft.timeLeft)
            }

            showDraftStatus('Draft restored ✓')
          }
        }
      } catch (error) {
        console.error('Could not restore writing draft:', error)
      }
    }

    setDraftLoaded(true)
  }, [draftKey, submitted, alreadyDone, draftLoaded])

  useEffect(() => {
    if (loading || submitted || timeLeft <= 0) return

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current)
          handleSubmit(true)
          return 0
        }

        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timerRef.current)
  }, [loading, submitted, timeLeft])

  useEffect(() => {
    if (!draftKey || loading || submitted || alreadyDone || !draftLoaded) return

    const hasContent =
      task1Answer.trim() ||
      task2Answer.trim()

    if (!hasContent) return

    setDraftStatus('Saving...')

    if (autosaveTimeoutRef.current) {
      clearTimeout(autosaveTimeoutRef.current)
    }

    autosaveTimeoutRef.current = setTimeout(() => {
      saveDraftToStorage('Draft saved ✓')
    }, 8000)

    return () => {
      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current)
      }
    }
  }, [
    draftKey,
    loading,
    submitted,
    alreadyDone,
    draftLoaded,
    task1Answer,
    task2Answer,
    currentTask,
    timeLeft
  ])

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') {
        setImageZoomOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  useEffect(() => {
    const handleBeforeUnload = event => {
      const hasContent =
        task1Answer.trim() ||
        task2Answer.trim()

      if (!submitted && hasContent) {
        saveDraftToStorage('Draft saved ✓')
        event.preventDefault()
        event.returnValue = ''
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [submitted, task1Answer, task2Answer, draftKey, currentTask, timeLeft])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }

      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current)
      }

      if (draftStatusTimeoutRef.current) {
        clearTimeout(draftStatusTimeoutRef.current)
      }
    }
  }, [])

  const saveDraftNow = () => {
    if (!draftKey) return

    const hasContent =
      task1Answer.trim() ||
      task2Answer.trim()

    if (!hasContent) {
      showDraftStatus('Nothing to save yet')
      return
    }

    saveDraftToStorage('Draft saved ✓')
  }

  const clearDraft = () => {
    if (!draftKey) return
    localStorage.removeItem(draftKey)
  }

  const handleSubmit = async (autoSubmit = false) => {
    if (submittingRef.current || submitted) return

    if (!autoSubmit) {
      if (!task1Answer.trim()) {
        alert('Please write your Task 1 answer.')
        setCurrentTask(1)
        return
      }

      if (!task2Answer.trim()) {
        alert('Please write your Task 2 answer.')
        setCurrentTask(2)
        return
      }

      const ok = window.confirm(
        'Submit your writing homework? You cannot retake it after submission.'
      )

      if (!ok) return
    }

    submittingRef.current = true
    setSubmitting(true)

    clearInterval(timerRef.current)

    if (autosaveTimeoutRef.current) {
      clearTimeout(autosaveTimeoutRef.current)
    }

    try {
      await addDoc(collection(db, 'writingSubmissions'), {
        uid: user.uid,
        writingId: id,
        task1Answer,
        task2Answer,
        task1WordCount: countWords(task1Answer),
        task2WordCount: countWords(task2Answer),
        submittedAt: new Date().toISOString(),
        finishedLate: timeLeft <= 0,
        autoSubmitted: autoSubmit,
        reviewed: false,
        review: null
      })

      clearDraft()
      setSubmitted(true)
    } catch (error) {
      console.error(error)
      alert('Could not submit your writing. Please try again.')
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  if (loading || !writing) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#faf9f6]">
        <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
          <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

          <button
            onClick={() => navigate('/student')}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            ← Back to dashboard
          </button>
        </nav>

        <div className="max-w-3xl mx-auto px-6 py-16">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">✅</div>

            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              Writing Submitted
            </h1>

            <p className="text-gray-500 text-sm mb-6">
              Your teacher will review your Task 1 and Task 2 answers.
            </p>

            {alreadyDone && (
              <p className="text-amber-600 text-sm bg-amber-50 rounded-xl py-2 px-4 mb-6">
                You already completed this writing homework. You can review your submitted answers, but you cannot retake it.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="bg-gray-50 rounded-xl p-4">
                <p className="text-xs text-gray-400 mb-1">Task 1 words</p>
                <p className="text-xl font-bold text-purple-600">
                  {countWords(task1Answer)}
                </p>
              </div>

              <div className="bg-gray-50 rounded-xl p-4">
                <p className="text-xs text-gray-400 mb-1">Task 2 words</p>
                <p className="text-xl font-bold text-purple-600">
                  {countWords(task2Answer)}
                </p>
              </div>
            </div>

            <button
              onClick={() => navigate('/student')}
              className="bg-purple-600 text-white rounded-xl px-6 py-3 text-sm font-medium"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }

  const task1Words = countWords(task1Answer)
  const task2Words = countWords(task2Answer)

  return (
    <div className="min-h-screen bg-[#faf9f6] flex flex-col">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100 sticky top-0 z-20">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 uppercase tracking-wide">
            {writing.title}
          </span>

          {draftStatus && (
            <span
              className={`text-xs px-3 py-1.5 rounded-full ${
                draftStatus === 'Saving...'
                  ? 'bg-amber-50 text-amber-600'
                  : 'bg-blue-50 text-blue-600'
              }`}
            >
              {draftStatus}
            </span>
          )}

          <button
            onClick={saveDraftNow}
            className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200"
          >
            Save draft
          </button>

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

      <div className="flex border-b border-gray-100 bg-white sticky top-[73px] z-10">
        <button
          onClick={() => setCurrentTask(1)}
          className={`flex-1 py-4 text-sm font-semibold ${
            currentTask === 1
              ? 'text-purple-600 border-b-2 border-purple-600'
              : 'text-gray-400'
          }`}
        >
          Task 1
          <span className="ml-2 text-xs font-normal">
            {task1Words} words
          </span>
        </button>

        <button
          onClick={() => setCurrentTask(2)}
          className={`flex-1 py-4 text-sm font-semibold ${
            currentTask === 2
              ? 'text-purple-600 border-b-2 border-purple-600'
              : 'text-gray-400'
          }`}
        >
          Task 2
          <span className="ml-2 text-xs font-normal">
            {task2Words} words
          </span>
        </button>
      </div>

      {currentTask === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 flex-1 overflow-hidden">
          <div className="overflow-y-auto p-8 border-r border-gray-100">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-900">
                  {writing.task1?.title || 'Writing Task 1'}
                </h2>

                <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                  Suggested 20 min
                </span>
              </div>

              <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap mb-6">
                {writing.task1?.prompt}
              </p>

              {writing.task1?.image && (
                <div>
                  <button
                    type="button"
                    onClick={() => setImageZoomOpen(true)}
                    className="group w-full block"
                  >
                    <img
                      src={writing.task1.image}
                      alt="Writing Task 1"
                      className="w-full max-h-[600px] object-contain bg-gray-50 rounded-xl border border-gray-100 cursor-zoom-in transition-all group-hover:border-purple-300"
                    />
                  </button>

                  <div className="flex items-center justify-between mt-3">
                    <p className="text-xs text-gray-400">
                      Click the image to enlarge.
                    </p>

                    <button
                      type="button"
                      onClick={() => setImageZoomOpen(true)}
                      className="text-xs bg-purple-50 text-purple-600 px-3 py-2 rounded-xl hover:bg-purple-100"
                    >
                      🔍 Open full size
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="overflow-y-auto p-8">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800">
                  Your Task 1 Answer
                </h3>

                <span
                  className={`text-xs px-3 py-1 rounded-full ${
                    task1Words >= 150
                      ? 'bg-green-50 text-green-600'
                      : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  {task1Words} / 150+ words
                </span>
              </div>

              <textarea
                value={task1Answer}
                onChange={e => setTask1Answer(e.target.value)}
                placeholder="Write your Task 1 response here..."
                className="w-full min-h-[520px] border border-gray-200 rounded-xl px-4 py-4 text-sm leading-7 outline-none focus:border-purple-400 resize-none"
              />

              <button
                onClick={() => setCurrentTask(2)}
                className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-5"
              >
                Next → Task 2
              </button>
            </div>
          </div>
        </div>
      )}

      {currentTask === 2 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 flex-1 overflow-hidden">
          <div className="overflow-y-auto p-8 border-r border-gray-100">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-900">
                  {writing.task2?.title || 'Writing Task 2'}
                </h2>

                <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                  Suggested 40 min
                </span>
              </div>

              <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                {writing.task2?.prompt}
              </p>
            </div>
          </div>

          <div className="overflow-y-auto p-8">
            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800">
                  Your Task 2 Answer
                </h3>

                <span
                  className={`text-xs px-3 py-1 rounded-full ${
                    task2Words >= 250
                      ? 'bg-green-50 text-green-600'
                      : 'bg-amber-50 text-amber-600'
                  }`}
                >
                  {task2Words} / 250+ words
                </span>
              </div>

              <textarea
                value={task2Answer}
                onChange={e => setTask2Answer(e.target.value)}
                placeholder="Write your Task 2 essay here..."
                className="w-full min-h-[520px] border border-gray-200 rounded-xl px-4 py-4 text-sm leading-7 outline-none focus:border-purple-400 resize-none"
              />

              <div className="grid grid-cols-2 gap-3 mt-5">
                <button
                  onClick={() => setCurrentTask(1)}
                  className="w-full bg-gray-100 text-gray-600 rounded-xl py-4 text-sm font-medium hover:bg-gray-200"
                >
                  ← Back to Task 1
                </button>

                <button
                  onClick={() => handleSubmit(false)}
                  disabled={submitting}
                  className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
                >
                  {submitting ? 'Submitting...' : 'Submit Writing'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {imageZoomOpen && writing.task1?.image && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 bg-black/40 text-white">
            <div>
              <p className="text-sm font-semibold">
                {writing.task1?.title || 'Writing Task 1 Image'}
              </p>

              <p className="text-xs text-white/60">
                Press ESC or click close to return.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setImageZoomOpen(false)}
              className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-xl text-sm"
            >
              Close ✕
            </button>
          </div>

          <div
            className="flex-1 overflow-auto p-6 flex items-center justify-center"
            onClick={() => setImageZoomOpen(false)}
          >
            <img
              src={writing.task1.image}
              alt="Writing Task 1 enlarged"
              onClick={event => event.stopPropagation()}
              className="max-w-none max-h-none object-contain bg-white rounded-xl shadow-2xl"
              style={{ maxWidth: '95vw', maxHeight: '85vh' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}