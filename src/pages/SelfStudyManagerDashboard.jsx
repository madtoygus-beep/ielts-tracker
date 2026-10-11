import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { auth, db } from '../firebase'

// P4B: Platform Self-Study Managers are not institution Teachers or Students.
// Their workspace uses only their own users/{uid} profile at this stage.
// Future content/package/account operations must use separately authorized
// backend functions and Firestore rules (P4C/P4D/P8A).
const PLATFORM_SCHOOL_ID = '__platform__'
const SELF_STUDY_MANAGER_ROLE = 'selfStudyManager'
const SELF_STUDY_SCOPE = 'selfStudy'

const UPCOMING_SECTIONS = [
  {
    title: 'Master Content Library',
    phase: 'P4C',
    description: 'Independent IELTS content and controlled copies published from institution libraries.'
  },
  {
    title: 'Packages',
    phase: 'P4D',
    description: 'Build and organize self-study packages using content in the Master Library.'
  },
  {
    title: 'Free Samples',
    phase: 'P4D',
    description: 'Choose sample activities learners may access without purchasing a package.'
  },
  {
    title: 'Entitlements',
    phase: 'P4D',
    description: 'Manage which independent learners can access which published packages.'
  },
  {
    title: 'Self-Study Accounts',
    phase: 'Future phase',
    description: 'View and manage independent learner accounts without accessing institution users.'
  },
  {
    title: 'Sales',
    phase: 'P8A',
    description: 'Track purchases and package access after the payment integration is launched.'
  }
]

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

  const displayName = profile.name || authUser?.displayName || 'Self-Study Manager'
  const displayEmail = profile.email || authUser?.email || ''

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-5 sm:px-6 py-5 flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <img src="/1.png" alt="Maxima" className="h-12 max-w-32 object-contain" />
            <div>
              <p className="text-xs font-semibold tracking-wide uppercase text-purple-600">Platform workspace</p>
              <h1 className="text-xl font-bold text-gray-900">Self-Study Manager</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="px-3 py-2 text-sm font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-50 rounded-lg"
            >
              Home
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={logoutLoading}
              className="px-3 py-2 text-sm font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-50 rounded-lg disabled:opacity-60"
            >
              {logoutLoading ? 'Signing out...' : 'Logout'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 sm:px-6 py-9 sm:py-11">
        {error && (
          <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3 mb-6">
            {error}
          </p>
        )}

        <section className="bg-gradient-to-br from-purple-700 to-indigo-800 text-white rounded-3xl p-7 sm:p-9 mb-7 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
            <p className="text-xs font-semibold tracking-wide uppercase text-purple-100">MAXIMA IELTS TRACKER</p>
            <span className="text-xs font-medium px-3 py-1 rounded-full bg-white/15 border border-white/20">P4B · Manager access active</span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold mb-3">Welcome, {displayName}.</h2>
          <p className="text-sm sm:text-base leading-7 text-purple-100 max-w-3xl">
            This is the dedicated platform workspace for Self-Study content and packages. It is independent from institution teachers, students, classes and seat limits.
          </p>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-9" aria-label="Manager account information">
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">Account type</p>
            <p className="font-semibold text-gray-900">Platform manager</p>
            <p className="text-xs text-gray-500 mt-1">Email login only</p>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">Access scope</p>
            <p className="font-semibold text-gray-900">Self-Study</p>
            <p className="text-xs text-gray-500 mt-1">Separate from institutions</p>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">Institution seats</p>
            <p className="font-semibold text-gray-900">Not used</p>
            <p className="text-xs text-gray-500 mt-1">No school assignment</p>
          </div>
        </section>

        <section aria-labelledby="modules-heading">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-5">
            <div>
              <h2 id="modules-heading" className="text-lg font-bold text-gray-900">Self-Study management modules</h2>
              <p className="text-sm text-gray-500 mt-1">
                Your manager access is active. The modules below will be enabled in later packages.
              </p>
            </div>
            <span className="text-xs text-gray-500">Module actions not active yet</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {UPCOMING_SECTIONS.map(section => (
              <article key={section.title} className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="w-10 h-10 bg-purple-50 text-purple-700 rounded-xl flex items-center justify-center font-bold text-sm">
                    {section.title.charAt(0)}
                  </div>
                  <span className="text-[11px] font-medium text-gray-500 border border-gray-200 bg-gray-50 rounded-full px-2.5 py-1">
                    {section.phase}
                  </span>
                </div>
                <h3 className="font-semibold text-gray-900 mb-2">{section.title}</h3>
                <p className="text-sm text-gray-500 leading-6 min-h-20">{section.description}</p>
                <p className="text-xs font-medium text-purple-600 mt-3">Coming in a later package</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-8 bg-white border border-gray-100 rounded-2xl p-6">
          <h2 className="font-semibold text-gray-900">Signed-in manager</h2>
          <p className="text-sm text-gray-500 mt-2 break-all">{displayEmail}</p>
          <p className="text-xs leading-5 text-gray-400 mt-3">
            Account creation, password changes, archiving and restoration remain with the Platform Admin. Institution content and learner records are not accessible from this page.
          </p>
        </section>
      </main>
    </div>
  )
}
