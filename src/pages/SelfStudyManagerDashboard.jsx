import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { auth, db } from '../firebase'
import SelfStudyMasterLibrary from './SelfStudyMasterLibrary'
import SelfStudyPackages from './SelfStudyPackages'

// P4B: Platform Self-Study Managers are not institution Teachers or Students.
// Their workspace uses only their own users/{uid} profile at this stage.
// Future content/package/account operations must use separately authorized
// backend functions and Firestore rules (P4C/P4D/P8A).
const PLATFORM_SCHOOL_ID = '__platform__'
const SELF_STUDY_MANAGER_ROLE = 'selfStudyManager'
const SELF_STUDY_SCOPE = 'selfStudy'

function isAuthorizedManager(profile) {
  return profile?.role === SELF_STUDY_MANAGER_ROLE &&
    profile?.accountType === 'platform' &&
    profile?.scope === SELF_STUDY_SCOPE &&
    profile?.schoolId === PLATFORM_SCHOOL_ID &&
    profile?.status === 'approved' &&
    profile?.deleted !== true
}

export default function SelfStudyManagerDashboard() {
  const navigate = useNavigate()
  const [authUser, setAuthUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [logoutLoading, setLogoutLoading] = useState(false)
  const [workspace, setWorkspace] = useState('library')

  useEffect(() => {
    let active = true
    let unsubscribeProfile = null
    let authGeneration = 0

    const unsubscribeAuth = onAuthStateChanged(
      auth,
      currentUser => {
        if (unsubscribeProfile) {
          unsubscribeProfile()
          unsubscribeProfile = null
        }

        const generation = ++authGeneration
        if (!active) return

        if (!currentUser) {
          navigate('/login', { replace: true })
          return
        }

        setAuthUser(currentUser)
        setProfile(null)
        setError('')
        setLoading(true)

        // A live listener immediately revokes access when an admin archives
        // or removes this manager. No school data or user lists are queried.
        unsubscribeProfile = onSnapshot(
          doc(db, 'users', currentUser.uid),
          snapshot => {
            if (!active || generation !== authGeneration) return

            if (!snapshot.exists()) {
              setProfile(null)
              setError('Your user profile could not be found. Contact the platform administrator.')
              setLoading(false)
              return
            }

            const nextProfile = snapshot.data() || {}

            if (nextProfile.deleted === true || nextProfile.status !== 'approved') {
              setProfile(null)
              setLoading(false)
              void signOut(auth)
                .catch(signOutError => {
                  console.error('Could not sign out inactive manager:', signOutError)
                })
                .finally(() => {
                  if (active) navigate('/login', { replace: true })
                })
              return
            }

            if (!isAuthorizedManager(nextProfile)) {
              setProfile(null)
              setError('This account is not configured for Self-Study Manager access. Ask the platform administrator to check the role, account type, scope and platform ID.')
              setLoading(false)
              return
            }

            setProfile(nextProfile)
            setError('')
            setLoading(false)
          },
          snapshotError => {
            if (!active || generation !== authGeneration) return
            console.error('Self-Study Manager profile verification failed:', snapshotError)
            setProfile(null)
            setError('Manager access could not be verified. Check your connection and try again. No management data has been loaded.')
            setLoading(false)
          }
        )
      },
      authError => {
        if (!active) return
        console.error('Self-Study Manager authentication check failed:', authError)
        setProfile(null)
        setError('Could not verify your sign-in session. Please return to login.')
        setLoading(false)
      }
    )

    return () => {
      active = false
      authGeneration += 1
      unsubscribeAuth()
      if (unsubscribeProfile) unsubscribeProfile()
    }
  }, [navigate])

  const handleLogout = async () => {
    if (logoutLoading) return
    setLogoutLoading(true)
    setError('')

    try {
      await signOut(auth)
      navigate('/login', { replace: true })
    } catch (signOutError) {
      console.error('Self-Study Manager logout failed:', signOutError)
      setError('Could not sign out. Please try again.')
      setLogoutLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
        <div className="bg-white border border-gray-100 rounded-2xl px-8 py-7 shadow-sm text-center">
          <div className="w-10 h-10 border-4 border-purple-100 border-t-purple-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm font-medium text-gray-700">Verifying manager access...</p>
          <p className="text-xs text-gray-400 mt-1">Checking your platform account</p>
        </div>
      </div>
    )
  }

  // Fail closed: never display the management workspace if the manager's
  // server-stored role/scope/account metadata cannot be verified.
  if (!profile) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-lg bg-white border border-gray-100 rounded-2xl p-7 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-purple-600 mb-2">Self-Study Manager</p>
          <h1 className="text-xl font-bold text-gray-900 mb-3">Access not available</h1>
          <p role="alert" className="text-sm leading-6 text-gray-600 mb-6">
            {error || 'Your platform account could not be verified.'}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700"
            >
              Retry verification
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={logoutLoading}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 disabled:opacity-60"
            >
              {logoutLoading ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const displayEmail = profile.email || authUser?.email || ''

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-5 sm:px-6 py-5 flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/1.png" alt="Maxima" className="h-11 max-w-28 object-contain" />
            <div>
              <p className="text-xs font-semibold tracking-wide uppercase text-purple-700">Platform workspace</p>
              <h1 className="text-xl font-bold text-gray-900">Self-Study Manager</h1>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => navigate('/')} className="rounded-xl px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">Home</button>
            <button type="button" onClick={handleLogout} disabled={logoutLoading} className="rounded-xl px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">{logoutLoading ? 'Signing out...' : 'Log out'}</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 sm:px-6 py-9">
        {error && <p role="alert" className="text-red-700 bg-red-50 border border-red-100 p-4 rounded-xl mb-5 text-sm">{error}</p>}

        <section className="rounded-2xl bg-white border border-gray-200 p-6 mb-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Content and package setup</h2>
              <p className="text-sm text-gray-600 leading-6 max-w-3xl">The independent learner practice screens are temporarily paused. You can prepare master content and package settings here without changing institution assignments. Payments and learner practice are not available yet.</p>
            </div>
            <span className="text-xs text-amber-800 rounded-full bg-amber-50 border border-amber-200 px-3 py-2 font-medium">Internal preparation</span>
          </div>
        </section>

        <div className="flex flex-wrap gap-2 mb-6" role="tablist" aria-label="Self-Study manager tools">
          <button type="button" role="tab" aria-selected={workspace === 'library'} onClick={() => setWorkspace('library')}
            className={`rounded-xl px-5 py-3 text-sm font-semibold ${workspace === 'library' ? 'bg-purple-700 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
            Master Library
          </button>
          <button type="button" role="tab" aria-selected={workspace === 'packages'} onClick={() => setWorkspace('packages')}
            className={`rounded-xl px-5 py-3 text-sm font-semibold ${workspace === 'packages' ? 'bg-purple-700 text-white' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
            Packages and access
          </button>
        </div>

        {workspace === 'library' ? <SelfStudyMasterLibrary /> : <SelfStudyPackages />}
        <p className="text-xs text-gray-400 mt-9 text-right break-all">Signed in: {displayEmail}</p>
      </main>
    </div>
  )
}
