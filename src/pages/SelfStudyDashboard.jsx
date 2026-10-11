import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { auth, db } from '../firebase'

const INDIVIDUAL_SCHOOL_ID = '__individual__'

function isIndividualAccount(profile) {
  return profile?.accountType === 'individual' || profile?.schoolId === INDIVIDUAL_SCHOOL_ID
}

export default function SelfStudyDashboard() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let unsubProfile = null
    let active = true

    const unsubAuth = onAuthStateChanged(auth, currentUser => {
      if (unsubProfile) {
        unsubProfile()
        unsubProfile = null
      }

      if (!currentUser) {
        navigate('/login', { replace: true })
        return
      }

      setUser(currentUser)
      unsubProfile = onSnapshot(
        doc(db, 'users', currentUser.uid),
        async snap => {
          if (!active) return

          if (!snap.exists()) {
            await signOut(auth).catch(() => {})
            navigate('/login', { replace: true })
            return
          }

          const nextProfile = snap.data() || {}
          if (
            nextProfile.deleted === true ||
            nextProfile.status !== 'approved' ||
            nextProfile.role !== 'student'
          ) {
            await signOut(auth).catch(() => {})
            navigate('/login', { replace: true })
            return
          }

          if (!isIndividualAccount(nextProfile)) {
            navigate('/student', { replace: true })
            return
          }

          setProfile(nextProfile)
          setError('')
          setLoading(false)
        },
        snapshotError => {
          console.error('Self-study profile snapshot failed:', snapshotError)
          if (active) {
            setError('We could not refresh your self-study profile. Please check your connection and try again.')
            setLoading(false)
          }
        }
      )
    })

    return () => {
      active = false
      unsubAuth()
      if (unsubProfile) unsubProfile()
    }
  }, [navigate])

  const handleLogout = async () => {
    await signOut(auth)
    navigate('/', { replace: true })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
        <div className="bg-white border border-gray-100 rounded-2xl px-8 py-7 shadow-sm text-center">
          <div className="w-10 h-10 border-4 border-purple-100 border-t-purple-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm font-medium text-gray-700">Loading your IELTS program...</p>
        </div>
      </div>
    )
  }

  const displayName = profile?.name || user?.displayName || user?.email || 'Student'
  const targetBand = profile?.targetBand !== undefined && profile?.targetBand !== null
    ? Number(profile.targetBand).toFixed(1)
    : 'Not set'

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-6 py-5 flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="shrink-0"
              aria-label="Go to home page"
            >
              <img src="/1.png" alt="Maxima" className="h-12 object-contain" />
            </button>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-purple-600">Self-Study</p>
              <h1 className="text-xl font-bold text-gray-900">My IELTS Program</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="text-sm font-medium text-gray-500 hover:text-gray-800 px-3 py-2 rounded-lg hover:bg-gray-50"
            >
              Home
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="text-sm font-medium text-gray-500 hover:text-gray-800 px-3 py-2 rounded-lg hover:bg-gray-50"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {error && (
          <div className="bg-red-50 border border-red-100 text-red-600 rounded-xl p-4 text-sm mb-6">{error}</div>
        )}

        <div className="bg-gradient-to-br from-purple-600 to-purple-800 rounded-3xl p-7 sm:p-9 text-white mb-8 shadow-sm">
          <p className="text-purple-100 text-sm mb-2">Welcome, {displayName}</p>
          <h2 className="text-3xl sm:text-4xl font-bold mb-3">Your independent IELTS workspace is ready.</h2>
          <p className="text-purple-100 max-w-2xl leading-7">
            This account is separate from institution classes and teacher assignments. Your personal practice access will appear here.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Account</p>
            <p className="text-lg font-semibold text-gray-900">Individual</p>
            <p className="text-sm text-gray-400 mt-1">Email login only</p>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Target Band</p>
            <p className="text-lg font-semibold text-gray-900">{targetBand}</p>
            <p className="text-sm text-gray-400 mt-1">Your IELTS goal</p>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Institution seats</p>
            <p className="text-lg font-semibold text-gray-900">Not used</p>
            <p className="text-sm text-gray-400 mt-1">Independent account</p>
          </div>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">Practice & Mock Library</h3>
              <p className="text-sm text-gray-500 leading-6 max-w-2xl">
                Your self-study account is active. Free sample and entitled IELTS practice content will appear in this workspace as access becomes available.
              </p>
            </div>
            <span className="text-xs bg-purple-50 text-purple-600 border border-purple-100 rounded-full px-3 py-1.5">
              Self-Study ready
            </span>
          </div>
        </div>
      </main>
    </div>
  )
}
