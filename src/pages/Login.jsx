import { useEffect, useState } from 'react'
import {
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { getDownloadURL, ref as storageRef } from 'firebase/storage'
import { auth, db, functions, storage } from '../firebase'
import { sendPasswordResetEmail } from '../services/authEmailService'
import { useNavigate } from 'react-router-dom'

const DEFAULT_SCHOOL_ID = 'maxima'
const DEFAULT_PRIMARY_COLOR = '#7c3aed'
const DEFAULT_ACCENT_COLOR = '#f97316'

const loginManagedUsernameCall = httpsCallable(functions, 'loginManagedUsername')
const getPublicSchoolBrandingCall = httpsCallable(functions, 'getPublicSchoolBranding')

const normalizeSchoolCode = value =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 63)

const initialSchoolCode = () => {
  if (typeof window === 'undefined') return DEFAULT_SCHOOL_ID
  const fromQuery = new URLSearchParams(window.location.search).get('school')
  return normalizeSchoolCode(fromQuery) || DEFAULT_SCHOOL_ID
}

const defaultBranding = schoolId => ({
  schoolId,
  name: schoolId === DEFAULT_SCHOOL_ID ? 'Maxima Eğitim' : 'Institution Login',
  logoPath: null,
  logoUrl: schoolId === DEFAULT_SCHOOL_ID ? '/1.png' : '',
  primaryColor: DEFAULT_PRIMARY_COLOR,
  accentColor: DEFAULT_ACCENT_COLOR,
  loginPreference: 'both'
})

export default function Login() {
  const [loginMode, setLoginMode] = useState('email')
  const [loginModeTouched, setLoginModeTouched] = useState(false)
  const [email, setEmail] = useState('')
  const [schoolId, setSchoolId] = useState(initialSchoolCode)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [brandingLoading, setBrandingLoading] = useState(false)
  const [branding, setBranding] = useState(() => defaultBranding(initialSchoolCode()))
  const navigate = useNavigate()

  const cleanEmail = email.trim().toLowerCase()
  const cleanSchoolId = normalizeSchoolCode(schoolId)
  const cleanUsername = username.trim().toLowerCase()

  useEffect(() => {
    const code = cleanSchoolId
    if (code.length < 2) {
      setBranding(defaultBranding(DEFAULT_SCHOOL_ID))
      return undefined
    }

    let active = true
    const timer = window.setTimeout(async () => {
      setBrandingLoading(true)

      try {
        const response = await getPublicSchoolBrandingCall({ schoolId: code })
        if (!active) return

        if (!response.data?.found || !response.data?.branding) {
          setBranding(defaultBranding(code))
          return
        }

        const next = response.data.branding
        let logoUrl = code === DEFAULT_SCHOOL_ID ? '/1.png' : ''

        if (next.logoPath) {
          try {
            logoUrl = await getDownloadURL(storageRef(storage, next.logoPath))
          } catch (logoError) {
            console.warn('Institution logo could not be loaded:', logoError)
          }
        }

        if (!active) return

        const nextBranding = {
          schoolId: code,
          name: next.name || code,
          logoPath: next.logoPath || null,
          logoUrl,
          primaryColor: /^#[0-9a-fA-F]{6}$/.test(next.primaryColor || '')
            ? next.primaryColor
            : DEFAULT_PRIMARY_COLOR,
          accentColor: /^#[0-9a-fA-F]{6}$/.test(next.accentColor || '')
            ? next.accentColor
            : DEFAULT_ACCENT_COLOR,
          loginPreference: ['email', 'username', 'both'].includes(next.loginPreference)
            ? next.loginPreference
            : 'both'
        }

        setBranding(nextBranding)

        if (!loginModeTouched && nextBranding.loginPreference !== 'both') {
          setLoginMode(nextBranding.loginPreference)
        }
      } catch (brandingError) {
        console.warn('Institution branding lookup failed:', brandingError)
        if (active) setBranding(defaultBranding(code))
      } finally {
        if (active) setBrandingLoading(false)
      }
    }, 350)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [cleanSchoolId, loginModeTouched])

  const safelySignOut = async () => {
    try {
      await signOut(auth)
    } catch (err) {
      console.warn('Could not sign out blocked account:', err)
    }
  }

  const finishAuthorizedLogin = async uid => {
    const snap = await getDoc(doc(db, 'users', uid))

    if (!snap.exists()) {
      await safelySignOut()
      setError('User profile not found. Please contact your institution administrator.')
      return false
    }

    const userData = snap.data()

    if (userData.deleted === true || userData.status === 'deleted') {
      await safelySignOut()
      setError('This account was removed by admin. Please contact your institution administrator.')
      return false
    }

    if (userData.status === 'pending') {
      await safelySignOut()
      setError('Your account is waiting for admin approval. Please contact your institution administrator.')
      return false
    }

    if (userData.status === 'rejected') {
      await safelySignOut()
      setError('This account request is not active. Please contact your institution administrator.')
      return false
    }

    if (userData.status !== 'approved') {
      await safelySignOut()
      setError('Your account is not approved yet. Please contact your institution administrator.')
      return false
    }

    if (userData.role === 'admin') {
      navigate('/admin')
    } else if (userData.role === 'student') {
      navigate('/student')
    } else if (userData.role === 'teacher') {
      navigate('/teacher')
    } else {
      await safelySignOut()
      setError('Your account role is not assigned. Please contact your institution administrator.')
      return false
    }

    return true
  }

  const handleResetPassword = async () => {
    setError('')
    setMessage('')

    if (!cleanEmail) {
      setError('Please enter your email first.')
      return
    }

    setResetLoading(true)

    try {
      await sendPasswordResetEmail(cleanEmail)
      setMessage('Account setup / password reset email sent. Please check your inbox.')
    } catch (err) {
      console.error('Password reset email failed:', err)
      setError('Could not send the account setup / password reset email. Please try again or contact your institution administrator.')
    } finally {
      setResetLoading(false)
    }
  }

  const handleLogin = async () => {
    setError('')
    setMessage('')

    if (!password) {
      setError('Please enter your password.')
      return
    }

    if (loginMode === 'email' && !cleanEmail) {
      setError('Please enter email and password.')
      return
    }

    if (loginMode === 'username' && (!cleanSchoolId || !cleanUsername)) {
      setError('Please enter school code, username and password.')
      return
    }

    setLoading(true)

    try {
      let result

      if (loginMode === 'username') {
        const response = await loginManagedUsernameCall({
          schoolId: cleanSchoolId,
          username: cleanUsername,
          password
        })

        const customToken = response.data?.customToken
        if (!customToken) {
          throw new Error('Username login token was not returned.')
        }

        result = await signInWithCustomToken(auth, customToken)
      } else {
        result = await signInWithEmailAndPassword(
          auth,
          cleanEmail,
          password
        )
      }

      await finishAuthorizedLogin(result.user.uid)
    } catch (err) {
      console.error('Login failed:', err)

      if (loginMode === 'username') {
        if (err.code === 'functions/resource-exhausted') {
          setError('Too many login attempts. Please try again later.')
        } else if (err.code === 'auth/user-disabled') {
          setError('This account is disabled. Please contact your institution administrator.')
        } else {
          setError('School code, username or password is incorrect.')
        }
      } else if (err.code === 'auth/user-not-found') {
        setError('No account found with this email. Please contact your institution administrator.')
      } else if (err.code === 'auth/wrong-password') {
        setError('Wrong password.')
      } else if (err.code === 'auth/invalid-credential') {
        setError('Email or password is incorrect.')
      } else if (err.code === 'auth/user-disabled') {
        setError('This account is disabled. Please contact your institution administrator.')
      } else {
        setError('Login failed. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  const switchMode = mode => {
    setLoginMode(mode)
    setLoginModeTouched(true)
    setError('')
    setMessage('')
    setPassword('')
  }

  const primaryColor = branding.primaryColor || DEFAULT_PRIMARY_COLOR
  const accentColor = branding.accentColor || DEFAULT_ACCENT_COLOR
  const primarySoft = `${primaryColor}12`
  const primaryBorder = `${primaryColor}30`

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4 py-8">
      <div className="bg-white border border-gray-100 rounded-2xl w-full max-w-md shadow-sm overflow-hidden">
        <div className="h-1.5" style={{ backgroundColor: accentColor }} />

        <div className="p-8">
          <div className="min-h-20 flex items-center mb-2">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.name} className="h-20 max-w-[240px] object-contain" />
            ) : (
              <div
                className="h-16 w-16 rounded-2xl flex items-center justify-center text-white text-xl font-bold"
                style={{ backgroundColor: primaryColor }}
              >
                {(branding.name || 'I').trim().charAt(0).toUpperCase()}
              </div>
            )}
          </div>

          <p className="text-xs font-semibold tracking-wide uppercase mb-1" style={{ color: accentColor }}>
            {brandingLoading ? 'Loading institution...' : branding.name}
          </p>

          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            Login to your account
          </h1>

          <p className="text-gray-400 text-sm mb-5">
            Use the account provided by your institution.
          </p>

          <div className="grid grid-cols-2 gap-2 bg-gray-50 rounded-xl p-1 mb-5">
            <button
              type="button"
              onClick={() => switchMode('email')}
              className={`rounded-lg py-2 text-sm font-medium transition ${loginMode === 'email' ? 'bg-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              style={loginMode === 'email' ? { color: primaryColor } : undefined}
            >
              Email
            </button>
            <button
              type="button"
              onClick={() => switchMode('username')}
              className={`rounded-lg py-2 text-sm font-medium transition ${loginMode === 'username' ? 'bg-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              style={loginMode === 'username' ? { color: primaryColor } : undefined}
            >
              School username
            </button>
          </div>

          {loginMode === 'username' && (
            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1 block">Institution code</label>
              <input
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none"
                style={{ '--tw-ring-color': primaryColor }}
                placeholder="School code (example: maxima)"
                type="text"
                value={schoolId}
                onChange={e => setSchoolId(normalizeSchoolCode(e.target.value))}
                autoCapitalize="none"
                autoCorrect="off"
                onKeyDown={e => {
                  if (e.key === 'Enter') handleLogin()
                }}
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Required only for school username login.
              </p>
            </div>
          )}

          <div
            className="rounded-xl p-3 mb-5 text-xs leading-5 border"
            style={{ backgroundColor: primarySoft, borderColor: primaryBorder, color: primaryColor }}
          >
            {loginMode === 'email'
              ? 'New account? Use the account setup email sent by your institution to choose your password. Existing accounts can continue signing in normally.'
              : 'Use your institution code and username if your school assigned one. Your real account email is not shown during username login.'}
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 text-sm rounded-xl p-3 mb-4 leading-6">
              {error}
            </div>
          )}

          {message && (
            <div className="bg-green-50 text-green-600 text-sm rounded-xl p-3 mb-4">
              {message}
            </div>
          )}

          <div className="flex flex-col gap-3">
            {loginMode === 'email' ? (
              <input
                className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none"
                placeholder="Email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleLogin()
                }}
              />
            ) : (
              <input
                className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none"
                placeholder="Username"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value.toLowerCase())}
                autoCapitalize="none"
                autoCorrect="off"
                onKeyDown={e => {
                  if (e.key === 'Enter') handleLogin()
                }}
              />
            )}

            <input
              className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none"
              placeholder="Password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              onKeyDown={e => {
                if (e.key === 'Enter') handleLogin()
              }}
            />

            <button
              onClick={handleLogin}
              disabled={loading || resetLoading}
              className="text-white rounded-xl py-3 text-sm font-medium mt-1 disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: primaryColor }}
            >
              {loading ? 'Logging in...' : 'Login'}
            </button>

            {loginMode === 'email' ? (
              <button
                type="button"
                onClick={handleResetPassword}
                disabled={loading || resetLoading}
                className="text-sm font-medium py-1 disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ color: primaryColor }}
              >
                {resetLoading ? 'Sending email...' : 'Send account setup / password reset email'}
              </button>
            ) : (
              <p className="text-xs text-center text-gray-400 leading-5 py-1">
                Forgot your password? Ask your institution administrator to set a new one, or switch to Email login if your registered email is reachable.
              </p>
            )}
          </div>

          <div className="border-t border-gray-100 mt-6 pt-5 text-center">
            <p className="text-sm text-gray-400">
              Need an account? Contact your institution administrator.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
