import { useEffect, useRef, useState } from 'react'
import { auth, db } from '../firebase'
import {
  setDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
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


function normalizeId(value) {
  return value === undefined || value === null
    ? ''
    : value.toString().trim().toLowerCase()
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

function getCurrentUserAssignmentValues(user, profile) {
  if (!user) return []

  return uniqueCleanValues([
    user.uid,
    user.email,
    user.email?.toLowerCase(),
    profile?.uid,
    profile?.id,
    profile?.email,
    profile?.email?.toLowerCase()
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

function isAssignedToCurrentUser(item, user, profile) {
  const assignedValues = getAssignmentValues(item).map(normalizeId).filter(Boolean)
  const currentUserValues = getCurrentUserAssignmentValues(user, profile)
    .map(normalizeId)
    .filter(Boolean)

  if (assignedValues.length === 0) return false

  return currentUserValues.some(value => assignedValues.includes(value))
}

function isHiddenForCurrentUser(item, user, profile) {
  if (!Array.isArray(item?.hiddenFor)) return false

  const hiddenValues = item.hiddenFor.map(normalizeId).filter(Boolean)
  const currentUserValues = getCurrentUserAssignmentValues(user, profile)
    .map(normalizeId)
    .filter(Boolean)

  return currentUserValues.some(value => hiddenValues.includes(value))
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
  const autosaveIntervalRef = useRef(null)
  const draftStatusTimeoutRef = useRef(null)
  const submittingRef = useRef(false)
  // Repair 06: timer ticks and typing must not restart the autosave schedule.
  const latestDraftRef = useRef(null)
  const saveDraftRef = useRef(null)
  const handleSubmitRef = useRef(null)
  const loadedDraftKeyRef = useRef(null)
  const savedDraftKeyRef = useRef(null)
  const autoSubmitAttemptedRef = useRef(false)
  const loadVersionRef = useRef(0)
  const mountedRef = useRef(false)

  const [user, setUser] = useState(null)
  const [writing, setWriting] = useState(null)
  const [currentTask, setCurrentTask] = useState(1)
  const [task1Answer, setTask1Answer] = useState('')
  const [task2Answer, setTask2Answer] = useState('')
  const [timeLeft, setTimeLeft] = useState(60 * 60)
  const [submitted, setSubmitted] = useState(false)
  const [completedSubmission, setCompletedSubmission] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [alreadyDone, setAlreadyDone] = useState(false)
  const [loading, setLoading] = useState(true)
  const [imageZoomOpen, setImageZoomOpen] = useState(false)
  const [draftStatus, setDraftStatus] = useState('')
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [reloadCount, setReloadCount] = useState(0)

  const draftKey = user ? `writingDraft_${id}_${user.uid}` : null

  const writingMode = writing?.contentType || writing?.writingMode || 'full_writing'
  const hasTask1 = writingMode !== 'task2_only'
  const hasTask2 = writingMode !== 'task1_only'
  const isFullWriting = hasTask1 && hasTask2
  const activeTaskLabel = hasTask1 && !hasTask2
    ? 'Task 1'
    : hasTask2 && !hasTask1
      ? 'Task 2'
      : `Task ${currentTask}`

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const showDraftStatus = message => {
    if (!mountedRef.current) return

    setDraftStatus(message)

    if (draftStatusTimeoutRef.current) {
      clearTimeout(draftStatusTimeoutRef.current)
    }

    draftStatusTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setDraftStatus('')
    }, 2500)
  }

  // Updated after every relevant commit, independently of the save interval.
  useEffect(() => {
    latestDraftRef.current = {
      key: draftKey,
      uid: user?.uid,
      writingId: id,
      ready:
        !loading &&
        draftLoaded &&
        writing?.id === id &&
        loadedDraftKeyRef.current === draftKey,
      completed: submitted || alreadyDone,
      task1Answer,
      task2Answer,
      currentTask,
      timeLeft
    }
  }, [
    draftKey, user?.uid, id, loading, draftLoaded, writing?.id,
    submitted, alreadyDone, task1Answer, task2Answer, currentTask, timeLeft
  ])

  const saveDraftToStorage = (statusMessage = 'Draft saved ✓', silent = false) => {
    const snapshot = latestDraftRef.current

    if (
      !snapshot?.key ||
      !snapshot.ready ||
      snapshot.completed ||
      submittingRef.current ||
      auth.currentUser?.uid !== snapshot.uid
    ) return false

    const hasContent =
      snapshot.task1Answer.trim() ||
      snapshot.task2Answer.trim()

    // Save cleared text too, so a previously saved answer cannot reappear.
    if (!hasContent && savedDraftKeyRef.current !== snapshot.key) {
      if (!silent) showDraftStatus('Nothing to save yet')
      return false
    }

    const draft = {
      writingId: snapshot.writingId,
      task1Answer: snapshot.task1Answer,
      task2Answer: snapshot.task2Answer,
      currentTask: snapshot.currentTask,
      timeLeft: Math.max(Number(snapshot.timeLeft) || 0, 0),
      savedAt: new Date().toISOString()
    }

    try {
      localStorage.setItem(snapshot.key, JSON.stringify(draft))
      savedDraftKeyRef.current = snapshot.key

      if (!silent && mountedRef.current) {
        setDraftError('')
        if (statusMessage) showDraftStatus(statusMessage)
      }

      return true
    } catch (error) {
      console.warn('Could not save writing draft:', error)

      if (!silent && mountedRef.current) {
        setDraftStatus('')
        setDraftError(
          'Draft could not be saved on this browser. Keep this page open and copy your text before leaving.'
        )
      }

      return false
    }
  }

  useEffect(() => {
    saveDraftRef.current = saveDraftToStorage
  })

  useEffect(() => {
    let active = true

    const unsub = onAuthStateChanged(auth, async currentUser => {
      const loadVersion = ++loadVersionRef.current
      const isCurrentLoad = () => active && loadVersionRef.current === loadVersion

      loadedDraftKeyRef.current = null
      savedDraftKeyRef.current = null
      autoSubmitAttemptedRef.current = false
      submittingRef.current = false
      setLoading(true)
      setDraftLoaded(false)
      setSubmitted(false)
      setSubmitting(false)
      setAlreadyDone(false)
      setTask1Answer('')
      setTask2Answer('')
      setDraftStatus('')
      setDraftError('')
      setLoadError('')
      setImageZoomOpen(false)
      setWriting(null)

      if (!currentUser) {
        setUser(null)
        navigate('/login')
        return
      }

      try {
      const profileSnap = await getDoc(doc(db, 'users', currentUser.uid))
      if (!isCurrentLoad()) return

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
      if (!isCurrentLoad()) return

      if (!snap.exists()) {
        setLoadError('Writing homework was not found. It may have been removed or archived by your teacher.')
        setLoading(false)
        return
      }

      const data = {
        id: snap.id,
        ...snap.data()
      }

      if (!isAssignedToCurrentUser(data, currentUser, profile)) {
        setLoadError('This Writing homework is not assigned to you.')
        setLoading(false)
        return
      }

      if (isHiddenForCurrentUser(data, currentUser, profile) || data.archived === true) {
        setLoadError('This Writing homework is hidden, archived, or no longer available.')
        setLoading(false)
        return
      }

      const mode = data.contentType || data.writingMode || 'full_writing'
      const defaultMinutes = mode === 'task1_only'
        ? 20
        : mode === 'task2_only'
          ? 40
          : 60

      setWriting(data)
      setCurrentTask(mode === 'task2_only' ? 2 : 1)
      setTimeLeft((data.timeLimit || defaultMinutes) * 60)

      const q = query(
        collection(db, 'writingSubmissions'),
        where('uid', '==', currentUser.uid),
        where('writingId', '==', id)
      )

      const existing = await getDocs(q)
      if (!isCurrentLoad()) return

      if (!existing.empty) {
        const existingDoc = existing.docs[0]
        const sub = { id: existingDoc.id, ...existingDoc.data() }

        setAlreadyDone(true)
        setSubmitted(true)
        setCompletedSubmission(sub)
        setTask1Answer(sub.task1Answer || '')
        setTask2Answer(sub.task2Answer || '')
      }

      setLoading(false)
      } catch (error) {
        console.error('Could not load writing homework:', error)
        if (isCurrentLoad()) {
          setLoadError(
            error?.code === 'permission-denied'
              ? 'Writing access was denied. This homework may no longer be assigned to you.'
              : 'Writing homework could not be loaded. Check your connection and retry.'
          )
          setLoading(false)
        }
      }
    })

    return () => {
      active = false
      loadVersionRef.current++
      unsub()
    }
  }, [id, navigate, reloadCount])

  useEffect(() => {
    if (!draftKey || loading || submitted || alreadyDone || draftLoaded) return
    if (writing?.id !== id || loadedDraftKeyRef.current === draftKey) return

    // Protect restoration from duplicate effects and from saving a blank form.
    loadedDraftKeyRef.current = draftKey

    try {
      const savedDraft = localStorage.getItem(draftKey)

      if (savedDraft) {
        const draft = JSON.parse(savedDraft)

        if (
          !draft ||
          typeof draft !== 'object' ||
          Array.isArray(draft) ||
          (draft.writingId && draft.writingId !== id) ||
          (draft.task1Answer !== undefined && typeof draft.task1Answer !== 'string') ||
          (draft.task2Answer !== undefined && typeof draft.task2Answer !== 'string')
        ) {
          throw new Error('Invalid writing draft format.')
        }

        const hasContent = draft.task1Answer?.trim() || draft.task2Answer?.trim()
        const hasSavedTime =
          typeof draft.timeLeft === 'number' &&
          Number.isFinite(draft.timeLeft) &&
          draft.timeLeft >= 0

        if (hasContent || hasSavedTime) {
          const restore = window.confirm(
            'A saved writing draft was found. Do you want to restore it?'
          )

          if (restore) {
            setTask1Answer(draft.task1Answer || '')
            setTask2Answer(draft.task2Answer || '')
            const restoredTask = Number(draft.currentTask) === 2 ? 2 : 1
            setCurrentTask(
              writingMode === 'task2_only'
                ? 2
                : writingMode === 'task1_only'
                  ? 1
                  : restoredTask
            )

            if (hasSavedTime) {
              // A saved zero must not grant a fresh timer on reopening.
              const defaultMinutes = writingMode === 'task1_only'
                ? 20
                : writingMode === 'task2_only' ? 40 : 60
              const maximumSeconds = (Number(writing.timeLimit) || defaultMinutes) * 60
              setTimeLeft(Math.min(Math.floor(draft.timeLeft), maximumSeconds))
            }

            savedDraftKeyRef.current = draftKey
            showDraftStatus('Draft restored ✓')
          }
        }
      }
    } catch (error) {
      console.warn('Could not restore writing draft:', error)
      setDraftError(
        'The saved draft could not be read on this browser. Your writing page is still available; keep a separate copy of your text.'
      )
    } finally {
      setDraftLoaded(true)
    }
  }, [draftKey, loading, submitted, alreadyDone, draftLoaded, writingMode, writing, id])

  useEffect(() => {
    handleSubmitRef.current = handleSubmit
  })

  const timerActive =
    !loading && draftLoaded && !submitted && !alreadyDone &&
    !submitting && writing?.id === id && timeLeft > 0

  useEffect(() => {
    if (!timerActive) return

    const intervalId = setInterval(() => {
      if (submittingRef.current) return
      // No submission or other side effect inside a state updater.
      setTimeLeft(prev => Math.max(prev - 1, 0))
    }, 1000)
    timerRef.current = intervalId

    return () => {
      clearInterval(intervalId)
      if (timerRef.current === intervalId) timerRef.current = null
    }
  }, [timerActive, draftKey])

  useEffect(() => {
    if (
      loading || !draftLoaded || submitted || alreadyDone || submitting ||
      writing?.id !== id || timeLeft > 0 || autoSubmitAttemptedRef.current
    ) return

    autoSubmitAttemptedRef.current = true
    // The ref is refreshed every commit, so the last typed words are included.
    handleSubmitRef.current?.(true)
  }, [loading, draftLoaded, submitted, alreadyDone, submitting, writing?.id, id, timeLeft])

  useEffect(() => {
    if (
      !draftKey || loading || submitted || alreadyDone ||
      submitting || !draftLoaded || writing?.id !== id
    ) return

    // Fixed cadence: neither typing nor timer updates reset this interval.
    const intervalId = setInterval(() => {
      saveDraftRef.current?.('Draft saved ✓')
    }, 8000)
    autosaveIntervalRef.current = intervalId

    return () => {
      clearInterval(intervalId)
      if (autosaveIntervalRef.current === intervalId) autosaveIntervalRef.current = null
    }
  }, [draftKey, loading, submitted, alreadyDone, submitting, draftLoaded, writing?.id, id])

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
    const saveLatestSilently = () => {
      if (latestDraftRef.current?.key !== draftKey) return
      saveDraftRef.current?.('', true)
    }

    const handleBeforeUnload = event => {
      const snapshot = latestDraftRef.current
      if (!snapshot?.ready || snapshot.completed || snapshot.key !== draftKey) return
      if (auth.currentUser?.uid !== snapshot.uid) return

      saveLatestSilently()
      const hasContent = snapshot.task1Answer.trim() || snapshot.task2Answer.trim()

      if (hasContent || submittingRef.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') saveLatestSilently()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pagehide', saveLatestSilently)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', saveLatestSilently)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      // Also cover navigation inside the app, which has no beforeunload event.
      saveLatestSilently()
    }
  }, [draftKey])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (autosaveIntervalRef.current) clearInterval(autosaveIntervalRef.current)
      if (draftStatusTimeoutRef.current) clearTimeout(draftStatusTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!user || !submitted || !completedSubmission?.id) return undefined

    const submissionRef = doc(db, 'writingSubmissions', completedSubmission.id)

    return onSnapshot(
      submissionRef,
      snapshot => {
        if (!snapshot.exists()) return

        const data = { id: snapshot.id, ...snapshot.data() }
        setCompletedSubmission(data)
        setAlreadyDone(true)
        setTask1Answer(data.task1Answer || '')
        setTask2Answer(data.task2Answer || '')
      },
      error => {
        console.warn('Could not refresh writing review:', error)
      }
    )
  }, [user, submitted, completedSubmission?.id])

  const saveDraftNow = () => {
    saveDraftToStorage('Draft saved ✓')
  }

  const clearDraft = (key = draftKey) => {
    if (!key) return

    try {
      localStorage.removeItem(key)
      if (savedDraftKeyRef.current === key) savedDraftKeyRef.current = null
    } catch (error) {
      // A successful Firestore submission must not become a failed submit
      // just because this browser refused to remove its local draft.
      console.warn('Writing submitted; local draft cleanup failed:', error)
    }
  }

  const handleSubmit = async (autoSubmit = false) => {
    if (
      submittingRef.current || submitted || alreadyDone || loading ||
      !draftLoaded || !user || !writing || writing.id !== id ||
      auth.currentUser?.uid !== user.uid
    ) return

    const expired = timeLeft <= 0

    if (!autoSubmit && !expired) {
      if (hasTask1 && !task1Answer.trim()) {
        alert('Please write your Task 1 answer.')
        setCurrentTask(1)
        return
      }

      if (hasTask2 && !task2Answer.trim()) {
        alert('Please write your Task 2 answer.')
        setCurrentTask(2)
        return
      }

      const ok = window.confirm(
        'Submit your writing homework? You cannot retake it after submission.'
      )

      if (!ok) return
    }

    // Keep a recovery copy before the network request; do not delete on failure.
    saveDraftToStorage('', true)
    const submittedDraftKey = draftKey
    const submissionVersion = loadVersionRef.current
    submittingRef.current = true
    setSubmitting(true)

    // Effects stop intervals while submitting. Do not cancel them manually:
    // an immediately rejected request may batch true -> false in one render.
    const submissionTeacherIds = getSourceTeacherIds(writing)

    const submissionRef = doc(db, 'writingSubmissions', `${user.uid}_${id}`)
    const submissionData = {
      uid: user.uid,
      studentId: user.uid,
      studentEmail: user.email || '',
      writingId: id,
      schoolId: writing.schoolId || 'maxima',
      teacherId: submissionTeacherIds[0] || '',
      teacherIds: submissionTeacherIds,
      contentType: writingMode,
      writingMode,
      task1Enabled: hasTask1,
      task2Enabled: hasTask2,
      task1Answer: hasTask1 ? task1Answer : '',
      task2Answer: hasTask2 ? task2Answer : '',
      task1WordCount: hasTask1 ? countWords(task1Answer) : 0,
      task2WordCount: hasTask2 ? countWords(task2Answer) : 0,
      submittedAt: new Date().toISOString(),
      finishedLate: timeLeft <= 0,
      autoSubmitted: autoSubmit || expired,
      reviewed: false,
      review: null
    }

    try {
      // Repair 08C: the first create is immutable for the student.
      await setDoc(submissionRef, submissionData)

      if (latestDraftRef.current?.key === submittedDraftKey) {
        latestDraftRef.current.completed = true
      }
      clearDraft(submittedDraftKey)

      if (mountedRef.current && loadVersionRef.current === submissionVersion) {
        setCompletedSubmission({ id: submissionRef.id, ...submissionData })
        setSubmitted(true)
      }
    } catch (error) {
      console.error(error)

      // If another tab already submitted, show the durable result instead of
      // inviting the student to create a second attempt.
      try {
        const existingSnap = await getDoc(submissionRef)
        if (existingSnap.exists()) {
          if (latestDraftRef.current?.key === submittedDraftKey) {
            latestDraftRef.current.completed = true
          }
          clearDraft(submittedDraftKey)

          if (mountedRef.current && loadVersionRef.current === submissionVersion) {
            const data = { id: existingSnap.id, ...existingSnap.data() }
            setCompletedSubmission(data)
            setTask1Answer(data.task1Answer || '')
            setTask2Answer(data.task2Answer || '')
            setAlreadyDone(true)
            setSubmitted(true)
            setSubmitting(false)
          }
          return
        }
      } catch (lookupError) {
        console.warn('Could not verify an existing writing submission:', lookupError)
      }

      if (mountedRef.current && loadVersionRef.current === submissionVersion) {
        alert('Could not submit your writing. Please try again.')
        submittingRef.current = false
        setSubmitting(false)
        // Submitting=false restarts autosave and, if time remains, the timer.
        // At zero the retry is manual, avoiding repeated automatic requests.
      }
    }
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
        <div className="bg-white border border-red-100 rounded-2xl p-7 max-w-lg w-full text-center shadow-sm">
          <h1 className="text-xl font-semibold text-gray-900 mb-3">Writing could not be opened</h1>
          <p role="alert" className="text-sm text-red-600 leading-6 mb-5">{loadError}</p>
          <div className="flex flex-col sm:flex-row justify-center gap-3">
            <button
              type="button"
              onClick={() => setReloadCount(count => count + 1)}
              className="bg-purple-600 text-white rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-purple-700"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => navigate('/student')}
              className="bg-gray-100 text-gray-700 rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-gray-200"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (loading || !writing || writing.id !== id) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  if (submitted) {
    const review = completedSubmission?.review || null
    const reviewed = Boolean(completedSubmission?.reviewed && review)

    return (
      <div className="min-h-screen bg-[#faf9f6]">
        <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
          <img src="/1.png" alt="Maxima" className="h-14 object-contain" />

          <button
            onClick={() => navigate('/student')}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            ← Back to dashboard
          </button>
        </nav>

        <div className="max-w-3xl mx-auto px-6 py-16">
          <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">{reviewed ? '📝' : '✅'}</div>

            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {reviewed ? 'Writing Reviewed' : 'Writing Submitted'}
            </h1>

            <p className="text-gray-500 text-sm mb-6">
              {reviewed
                ? `Your teacher has reviewed this ${isFullWriting ? 'Writing test' : activeTaskLabel}.`
                : 'Your teacher will review your writing answer.'}
            </p>

            {alreadyDone && (
              <p className="text-amber-600 text-sm bg-amber-50 rounded-xl py-2 px-4 mb-6">
                You already completed this writing homework. You can review your submitted answers, but you cannot retake it.
              </p>
            )}

            {reviewed ? (
              <div className={`grid grid-cols-1 ${isFullWriting ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-3 mb-6`}>
                {hasTask1 && (
                  <div className="bg-purple-50 rounded-xl p-4">
                    <p className="text-xs text-gray-500 mb-1">Task 1 Band</p>
                    <p className="text-2xl font-bold text-purple-600">
                      {review?.task1Band || '-'}
                    </p>
                  </div>
                )}

                {hasTask2 && (
                  <div className="bg-indigo-50 rounded-xl p-4">
                    <p className="text-xs text-gray-500 mb-1">Task 2 Band</p>
                    <p className="text-2xl font-bold text-indigo-600">
                      {review?.task2Band || '-'}
                    </p>
                  </div>
                )}

                <div className="bg-green-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Overall Band</p>
                  <p className="text-2xl font-bold text-green-600">
                    {review?.overall || '-'}
                  </p>
                </div>
              </div>
            ) : (
              <div className={`grid ${isFullWriting ? 'grid-cols-2' : 'grid-cols-1'} gap-3 mb-6`}>
                {hasTask1 && (
                  <div className="bg-gray-50 rounded-xl p-4">
                    <p className="text-xs text-gray-400 mb-1">Task 1 words</p>
                    <p className="text-xl font-bold text-purple-600">
                      {countWords(task1Answer)}
                    </p>
                  </div>
                )}

                {hasTask2 && (
                  <div className="bg-gray-50 rounded-xl p-4">
                    <p className="text-xs text-gray-400 mb-1">Task 2 words</p>
                    <p className="text-xl font-bold text-purple-600">
                      {countWords(task2Answer)}
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className={`grid grid-cols-1 ${isFullWriting ? 'lg:grid-cols-2' : ''} gap-4 mb-6 text-left`}>
              {hasTask1 && (
                <div className="border border-gray-100 rounded-xl p-4">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="font-semibold text-gray-800">Task 1</p>
                    <span className="text-xs text-gray-400">{countWords(task1Answer)} words</span>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap max-h-56 overflow-y-auto">
                    {task1Answer || 'No Task 1 answer submitted.'}
                  </div>
                  {reviewed && (
                    <div className="bg-green-50 rounded-lg p-3 mt-3">
                      <p className="text-xs font-semibold text-green-700 mb-1">Teacher feedback</p>
                      <p className="text-sm text-green-900 whitespace-pre-wrap">
                        {review?.task1Feedback || 'No feedback.'}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {hasTask2 && (
                <div className="border border-gray-100 rounded-xl p-4">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="font-semibold text-gray-800">Task 2</p>
                    <span className="text-xs text-gray-400">{countWords(task2Answer)} words</span>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap max-h-56 overflow-y-auto">
                    {task2Answer || 'No Task 2 answer submitted.'}
                  </div>
                  {reviewed && (
                    <div className="bg-green-50 rounded-lg p-3 mt-3">
                      <p className="text-xs font-semibold text-green-700 mb-1">Teacher feedback</p>
                      <p className="text-sm text-green-900 whitespace-pre-wrap">
                        {review?.task2Feedback || 'No feedback.'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {reviewed && (
              <div className="bg-purple-50 rounded-xl p-4 mb-6 text-left">
                <p className="text-xs font-semibold text-purple-700 mb-1">General Feedback</p>
                <p className="text-sm text-purple-900 whitespace-pre-wrap">
                  {review?.generalFeedback || 'No general feedback.'}
                </p>
              </div>
            )}

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
            disabled={!draftLoaded || submitting}
            className="text-xs bg-gray-100 text-gray-600 px-3 py-2 rounded-xl hover:bg-gray-200 disabled:opacity-60"
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

      {draftError && (
        <div role="alert" className="mx-6 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {draftError}
        </div>
      )}

      {isFullWriting ? (
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
      ) : (
        <div className="border-b border-gray-100 bg-white sticky top-[73px] z-10 px-8 py-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-purple-600 bg-purple-50 px-4 py-2 rounded-xl">
            {activeTaskLabel} only · {hasTask1 ? task1Words : task2Words} words
          </span>
        </div>
      )}

      {hasTask1 && currentTask === 1 && (
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
                disabled={!draftLoaded || submitting || timeLeft <= 0}
                onChange={e => setTask1Answer(e.target.value)}
                placeholder="Write your Task 1 response here..."
                className="w-full min-h-[520px] border border-gray-200 rounded-xl px-4 py-4 text-sm leading-7 outline-none focus:border-purple-400 resize-none"
              />

              {hasTask2 ? (
                <button
                  onClick={() => setCurrentTask(2)}
                  className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-5"
                >
                  Next → Task 2
                </button>
              ) : (
                <button
                  onClick={() => handleSubmit(false)}
                  disabled={submitting}
                  className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 mt-5 disabled:opacity-60"
                >
                  {submitting ? 'Submitting...' : 'Submit Task 1'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {hasTask2 && currentTask === 2 && (
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
                disabled={!draftLoaded || submitting || timeLeft <= 0}
                onChange={e => setTask2Answer(e.target.value)}
                placeholder="Write your Task 2 essay here..."
                className="w-full min-h-[520px] border border-gray-200 rounded-xl px-4 py-4 text-sm leading-7 outline-none focus:border-purple-400 resize-none"
              />

              <div className={`${hasTask1 ? 'grid grid-cols-2' : 'grid grid-cols-1'} gap-3 mt-5`}>
                {hasTask1 && (
                  <button
                    onClick={() => setCurrentTask(1)}
                    className="w-full bg-gray-100 text-gray-600 rounded-xl py-4 text-sm font-medium hover:bg-gray-200"
                  >
                    ← Back to Task 1
                  </button>
                )}

                <button
                  onClick={() => handleSubmit(false)}
                  disabled={submitting}
                  className="w-full bg-purple-600 text-white rounded-xl py-4 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
                >
                  {submitting ? 'Submitting...' : hasTask1 ? 'Submit Writing' : 'Submit Task 2'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {hasTask1 && imageZoomOpen && writing.task1?.image && (
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