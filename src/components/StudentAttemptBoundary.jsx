import { useEffect, useState } from 'react'
import { AttemptGenerationContext } from '../hooks/useAttemptGeneration'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { Navigate, useParams } from 'react-router-dom'
import { auth, db } from '../firebase'

export function AttemptRestartNotice({ onStart }) {
  return <div role="alert" className="min-h-screen bg-[#faf9f6] flex items-center justify-center p-6">
    <div className="max-w-lg rounded-2xl border border-purple-100 bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold text-purple-600">New attempt ready</p>
      <h1 className="mt-2 text-2xl font-bold text-gray-900">Your teacher restarted this attempt</h1>
      <p className="mt-3 text-sm leading-6 text-gray-600">Start again with blank answers and a new timer. Your previous session is closed and cannot submit answers.</p>
      <button type="button" onClick={onStart} className="mt-6 rounded-xl bg-purple-600 px-5 py-3 text-sm font-semibold text-white hover:bg-purple-700">Start fresh attempt</button>
    </div>
  </div>
}

// Wait for the server's generation before restoring device drafts. A reset
// unmounts the whole exam, including its timers, audio player and recorder.
function subscribeStudentAttempt({ contentType, id }, receive) {
  let unsubscribe = () => {}
  let active = true
  receive({ status: 'loading' })
  const stopAuth = onAuthStateChanged(auth, user => {
    unsubscribe()
    if (!active) return
    if (!user) { receive({ status: 'signed_out' }); return }
    receive({ status: 'loading' })
    unsubscribe = onSnapshot(doc(db, 'studentAccess', `${user.uid}_${contentType}_${id}`),
      { includeMetadataChanges: true }, snapshot => {
        if (!active || auth.currentUser?.uid !== user.uid || snapshot.metadata.fromCache) return
        const access = snapshot.data()
        if (access && (access.status !== 'active' || access.adminHidden === true)) {
          receive({ status: 'unavailable' }); return
        }
        const generation = typeof access?.attemptGeneration === 'string' ? access.attemptGeneration : ''
        receive({ status: 'ready', generation, uid: user.uid })
      }, async () => {
        // Existing pages own their role/access redirects; a teacher opening a
        // student route must still reach that guard instead of a dead end.
        const profile = await getDoc(doc(db, 'users', user.uid)).catch(() => null)
        if (!active || auth.currentUser?.uid !== user.uid) return
        if (profile?.exists() && ['teacher', 'admin'].includes(profile.data().role)) {
          receive({ status: 'ready', generation: '' })
        } else receive({ status: 'error' })
      })
  })
  return () => { active = false; unsubscribe(); stopAuth() }

}

export default function StudentAttemptBoundary({ contentType, children, subscribe = subscribeStudentAttempt }) {
  const { id } = useParams()
  const identity = `${contentType}:${id}`
  const [storedState, setState] = useState({ status: 'loading' })
  const [retry, setRetry] = useState(0)
  const state = storedState.identity === identity ? storedState : { status: 'loading' }
  useEffect(() => subscribe({ contentType, id }, incoming => {
    setState(previous => {
      if (incoming.status === 'ready' && previous.identity === identity &&
        ((previous.status === 'ready' && previous.generation !== incoming.generation) || previous.status === 'restarted')) {
        return { ...incoming, identity, status: 'restarted' }
      }
      return { ...incoming, identity }
    })
  }), [contentType, id, identity, retry, subscribe])
  const retryCheck = () => { setState({ identity, status: 'loading' }); setRetry(value => value + 1) }

  if (state.status === 'signed_out') return <Navigate to="/login" replace />
  if (state.status === 'restarted') return <AttemptRestartNotice onStart={() => setState({ ...state, identity, status: 'ready' })} />
  if (state.status === 'unavailable') return <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center p-6"><div className="rounded-2xl bg-white p-8 text-center"><h1 className="text-xl font-bold">This assignment is no longer available</h1><a href="/student" className="mt-4 inline-block text-purple-600">Return to dashboard</a></div></div>
  if (state.status === 'error') return <div role="alert" className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[#faf9f6] p-6"><p>Could not check your latest attempt. Your saved answers have not been changed.</p><button type="button" onClick={retryCheck} className="text-purple-600">Retry</button><a href="/student" className="text-sm text-gray-500">Return to dashboard</a></div>
  if (state.status !== 'ready') return <div role="status" className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[#faf9f6] p-6"><p>Checking your attempt…</p><p className="text-sm text-gray-500">Connect to the internet to load your latest saved attempt.</p><button type="button" onClick={retryCheck} className="text-sm text-purple-600">Retry</button></div>
  return <AttemptGenerationContext.Provider key={`${identity}:${state.uid || ''}:${state.generation}`} value={state.generation}>{children}</AttemptGenerationContext.Provider>
}
