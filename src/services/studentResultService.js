// Q2C-2: A trusted read boundary for student submission heads and Mock scores.
// Firestore browser subscriptions to these private collections are intentionally
// replaced; submissions and content projections keep their existing write paths.
import { auth, functions } from '../firebase'
import { httpsCallable } from 'firebase/functions'

const getStudentVisibleResultsCall = httpsCallable(functions, 'getStudentVisibleResults')
const summarySubscriptions = new Map()
const REFRESH_MS = 90000

function asSnapshot(items) {
  const ordered = [...(Array.isArray(items) ? items : [])].sort((a, b) =>
    (Number(b.attemptNumber || 1) - Number(a.attemptNumber || 1)) ||
    (recordMillis(b.submittedAt || b.createdAt || b.date) -
      recordMillis(a.submittedAt || a.createdAt || a.date))
  )
  const docs = ordered.map(item => {
    const data = { ...item }
    const id = data.id
    delete data.id
    return { id, data: () => ({ ...data }) }
  })
  return { empty: docs.length === 0, size: docs.length, docs }
}

function recordMillis(value) {
  if (typeof value === 'string') return Date.parse(value) || 0
  if (typeof value === 'number') return value
  if (value && typeof value.seconds === 'number') return value.seconds * 1000
  return 0
}

export async function getStudentVisibleResultSnapshot(contentType, contentId) {
  const response = await getStudentVisibleResultsCall({
    mode: 'detail', contentType, contentId
  })
  return asSnapshot(response?.data?.items)
}

export async function getStudentVisibleResultDoc(contentType, contentId) {
  const snapshot = await getStudentVisibleResultSnapshot(contentType, contentId)
  const uid = auth.currentUser?.uid
  const deterministic = uid ? `${uid}_${contentId}` : ''
  const selected = snapshot.docs.find(item => item.id === deterministic) ||
    [...snapshot.docs].sort((a, b) => {
      const av = a.data()
      const bv = b.data()
      return (Number(bv.attemptNumber || 1) - Number(av.attemptNumber || 1)) ||
        (recordMillis(bv.submittedAt) - recordMillis(av.submittedAt))
    })[0]
  return {
    id: selected?.id || '',
    exists: () => Boolean(selected),
    data: () => selected?.data() || undefined
  }
}

// Shared between StudentDashboard cards: one summary RPC per student, rather
// than 20+ parallel listeners for five categories and the Mock scores.
export function subscribeStudentVisibleResultSummaries(uid, collectionName, onItems, onError) {
  if (!uid) return () => {}
  let entry = summarySubscriptions.get(uid)
  if (!entry) {
    entry = {
      callbacks: new Set(),
      last: null,
      running: false,
      disposed: false,
      refresh: null,
      interval: null,
      detach: null
    }
    const current = entry
    current.refresh = async () => {
      if (current.running || current.disposed || auth.currentUser?.uid !== uid) return
      current.running = true
      try {
        const response = await getStudentVisibleResultsCall({ mode: 'summary' })
        if (current.disposed || auth.currentUser?.uid !== uid) return
        const next = response?.data?.byCollection
        if (!next || typeof next !== 'object') {
          throw new Error('The result summary service returned an invalid response.')
        }
        current.last = next
        current.callbacks.forEach(subscription => {
          subscription.onItems(Array.isArray(next[subscription.collectionName])
            ? next[subscription.collectionName] : [])
        })
      } catch (error) {
        if (!current.disposed) {
          current.callbacks.forEach(subscription => subscription.onError?.(error))
        }
      } finally {
        current.running = false
      }
    }
    const onFocus = () => current.refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') current.refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    current.interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') current.refresh()
    }, REFRESH_MS)
    current.detach = () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(current.interval)
    }
    summarySubscriptions.set(uid, current)
  }

  const subscription = { collectionName, onItems, onError }
  entry.callbacks.add(subscription)
  if (entry.last) {
    onItems(Array.isArray(entry.last[collectionName]) ? entry.last[collectionName] : [])
  } else {
    // Do not keep stale results while authorization checks are incomplete.
    onItems([])
  }
  if (!entry.running && !entry.last) void entry.refresh()
  return () => {
    const current = summarySubscriptions.get(uid)
    if (!current) return
    current.callbacks.delete(subscription)
    if (current.callbacks.size === 0) {
      current.disposed = true
      current.detach?.()
      summarySubscriptions.delete(uid)
    }
  }
}

// Writing feedback can be edited by a teacher while the student's review page
// remains open. Revalidate without any raw Firestore document listener.
export function watchStudentVisibleResultDetail(contentType, contentId, onChange, onError) {
  let active = true
  let running = false
  const refresh = async () => {
    if (!active || running) return
    running = true
    try {
      const response = await getStudentVisibleResultSnapshot(contentType, contentId)
      if (active) onChange(response)
    } catch (error) {
      if (active) onError?.(error)
    } finally {
      running = false
    }
  }
  const onFocus = () => void refresh()
  const onVisible = () => {
    if (document.visibilityState === 'visible') void refresh()
  }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisible)
  const interval = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, REFRESH_MS)
  void refresh()
  return () => {
    active = false
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisible)
    window.clearInterval(interval)
  }
}
