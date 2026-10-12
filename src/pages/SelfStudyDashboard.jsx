import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { auth, db } from '../firebase'

// P4D interim checkpoint: account access remains operational, while individual
// practice and paid product delivery are deliberately postponed. No content or
// package records are deleted or modified by this screen.
const isIndividual = profile => (
  profile?.role === 'student' &&
  profile?.accountType === 'individual' &&
  profile?.schoolId === '__individual__' &&
  profile?.status === 'approved' &&
  profile?.deleted !== true
)

export default function SelfStudyDashboard() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [logoutLoading, setLogoutLoading] = useState(false)

  useEffect(() => {
    let active = true
    let unsubscribeProfile = null
    let generation = 0

    const unsubscribeAuth = onAuthStateChanged(auth, currentUser => {
      if (unsubscribeProfile) {
        unsubscribeProfile()
        unsubscribeProfile = null
      }
      const currentGeneration = ++generation
      if (!active) return

      setUser(currentUser)
      setProfile(null)
      setError('')
      setLoading(true)
      if (!currentUser) {
        navigate('/login', { replace: true })
        return
      }

      unsubscribeProfile = onSnapshot(
        doc(db, 'users', currentUser.uid),
        snapshot => {
          if (!active || currentGeneration !== generation) return
          const next = snapshot.exists() ? snapshot.data() : null
          if (!next || next.deleted === true || next.status !== 'approved') {
            setProfile(null)
            setLoading(false)
            void signOut(auth).catch(err => {
              console.error('Could not sign out inactive learner:', err)
            }).finally(() => {
              if (active && currentGeneration === generation) navigate('/login', { replace: true })
            })
            return
          }
          if (next.role === 'student' && next.accountType !== 'individual' && next.schoolId !== '__individual__') {
            navigate('/student', { replace: true })
            return
          }
          if (!isIndividual(next)) {
            setProfile(null)
            setError('This account is not configured as an individual learner.')
            setLoading(false)
            return
          }
          setProfile(next)
          setError('')
          setLoading(false)
        },
        err => {
          if (!active || currentGeneration !== generation) return
          console.error('Individual profile verification failed:', err)
          setProfile(null)
          setError('Your account could not be verified. Please sign in again.')
          setLoading(false)
        }
      )
    }, err => {
      if (!active) return
      console.error('Individual authentication failed:', err)
      setProfile(null)
      setError('Sign-in could not be verified.')
      setLoading(false)
    })

    return () => {
      active = false
      generation++
      unsubscribeAuth()
      if (unsubscribeProfile) unsubscribeProfile()
    }
  }, [navigate])

  const logout = async () => {
    if (logoutLoading) return
    setLogoutLoading(true)
    setError('')
    try {
      await signOut(auth)
      navigate('/', { replace: true })
    } catch (err) {
      console.error('Individual sign-out failed:', err)
      setError('Could not sign out. Please try again.')
      setLogoutLoading(false)
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-[#faf9f6] grid place-items-center px-6">
      <p className="text-gray-600 text-sm">Verifying your account...</p>
    </div>
  )

  if (!profile) return (
    <div className="min-h-screen bg-[#faf9f6] grid place-items-center px-6">
      <div className="bg-white rounded-2xl p-7 border border-gray-200 max-w-lg w-full">
        <h1 className="font-bold text-gray-900 text-xl mb-3">Account access unavailable</h1>
        <p role="alert" className="text-red-700 text-sm mb-5">{error || 'Could not verify your account.'}</p>
        <button type="button" onClick={() => navigate('/login')} className="bg-purple-700 text-white rounded-xl px-4 py-2 text-sm">Return to login</button>
      </div>
    </div>
  )

  const displayName = profile.name || user?.displayName || 'Learner'
  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-4xl mx-auto px-5 sm:px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/1.png" alt="Maxima" className="h-10 max-w-28 object-contain" />
            <div><p className="text-xs font-medium text-purple-700 uppercase">Independent learning</p><h1 className="text-lg font-bold text-gray-900">Self-Study</h1></div>
          </div>
          <button type="button" disabled={logoutLoading} onClick={logout} className="text-sm px-4 py-2 border border-gray-200 bg-white rounded-xl text-gray-700 disabled:opacity-50">{logoutLoading ? 'Signing out...' : 'Log out'}</button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 sm:px-6 py-16">
        <section className="bg-white border border-gray-200 rounded-3xl p-7 sm:p-10 shadow-sm">
          <p className="text-purple-700 uppercase text-xs tracking-wider font-semibold mb-3">Self-Study development update</p>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 mb-4">Your practice area is being improved</h2>
          <p className="text-gray-600 text-sm sm:text-base leading-7 mb-5">Hello {displayName}. We are bringing the individual IELTS practice experience in line with the main Maxima student exam screens. Practice is temporarily unavailable while this work is completed.</p>
          <p className="text-gray-600 text-sm leading-6">Your account is safe. Existing package assignments and previously saved attempts are preserved. You do not need to create another account.</p>
          {error && <p role="alert" className="text-red-700 text-sm mt-4">{error}</p>}
          <div className="pt-7 mt-7 border-t border-gray-100">
            <button type="button" onClick={() => navigate('/')} className="rounded-xl bg-purple-700 text-white px-5 py-3 font-semibold text-sm hover:bg-purple-800">Back to Maxima home</button>
          </div>
        </section>
      </main>
    </div>
  )
}
