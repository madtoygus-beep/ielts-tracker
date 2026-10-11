import { useState } from 'react'
import { createUserWithEmailAndPassword, deleteUser, signOut } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { doc, getDoc } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { auth, db, functions } from '../firebase'

const createIndividualProfileCall = httpsCallable(functions, 'createIndividualProfile')

export default function Signup() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [targetBand, setTargetBand] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSignup = async () => {
    const cleanName = name.trim()
    const cleanEmail = email.trim().toLowerCase()
    const cleanTargetBand = targetBand === '' ? null : Number(targetBand)

    setError('')

    if (cleanName.length < 2) {
      setError('Please enter your full name.')
      return
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Please enter a valid email address.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (
      targetBand !== '' &&
      (
        Number.isNaN(cleanTargetBand) ||
        cleanTargetBand < 0 ||
        cleanTargetBand > 9 ||
        Math.round(cleanTargetBand * 2) !== cleanTargetBand * 2
      )
    ) {
      setError('Target Band must be between 0 and 9 in 0.5 increments.')
      return
    }

    setLoading(true)
    let createdUser = null

    try {
      const credential = await createUserWithEmailAndPassword(auth, cleanEmail, password)
      createdUser = credential.user

      await createIndividualProfileCall({
        name: cleanName,
        targetBand: cleanTargetBand
      })

      navigate('/self-study', { replace: true })
    } catch (err) {
      console.error('Individual signup failed:', err)

      if (createdUser) {
        try {
          const profileSnap = await getDoc(doc(db, 'users', createdUser.uid))
          const existingProfile = profileSnap.exists() ? (profileSnap.data() || {}) : null
          if (
            existingProfile &&
            existingProfile.role === 'student' &&
            existingProfile.status === 'approved' &&
            existingProfile.deleted !== true &&
            (existingProfile.accountType === 'individual' || existingProfile.schoolId === '__individual__')
          ) {
            navigate('/self-study', { replace: true })
            return
          }
        } catch (profileCheckError) {
          console.warn('Could not verify self-study profile after signup error:', profileCheckError)
        }

        try {
          await deleteUser(createdUser)
        } catch (rollbackError) {
          console.error('Could not roll back Firebase Auth after profile creation failure:', rollbackError)
          await signOut(auth).catch(() => {})
        }
      }

      if (err.code === 'auth/email-already-in-use') {
        setError('An account already exists with this email. Use Login or reset your password instead.')
      } else if (err.code === 'auth/invalid-email') {
        setError('Please enter a valid email address.')
      } else if (err.code === 'auth/weak-password') {
        setError('Please choose a stronger password with at least 8 characters.')
      } else {
        setError(err?.message || 'Could not create your self-study account. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4 py-8">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 w-full max-w-md shadow-sm">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="text-xs font-medium text-gray-400 hover:text-gray-700 mb-4"
        >
          ← Back to home
        </button>

        <button
          type="button"
          onClick={() => navigate('/')}
          className="block"
          aria-label="Go to home page"
        >
          <img src="/1.png" alt="Maxima" className="h-20 object-contain mb-1" />
        </button>

        <p className="text-xs font-semibold uppercase tracking-wide text-purple-600 mb-1">Self-Study</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Create your individual account</h1>
        <p className="text-gray-400 text-sm mb-6">
          For learners studying independently. Institution students and teachers should use the account created by their institution.
        </p>

        <div className="bg-amber-50 border border-amber-100 text-amber-700 rounded-xl p-3 text-xs leading-5 mb-5">
          If your school already gave you an account, do not create a second account here.
        </div>

        {error && (
          <div className="bg-red-50 text-red-600 text-sm rounded-xl p-3 mb-4 leading-5">{error}</div>
        )}

        <div className="flex flex-col gap-3">
          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Full name"
            value={name}
            onChange={e => setName(e.target.value)}
            autoComplete="name"
          />
          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="email"
          />
          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Password (minimum 8 characters)"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Confirm password"
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            onKeyDown={e => {
              if (e.key === 'Enter') handleSignup()
            }}
          />
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Target Band (optional)</label>
            <input
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
              placeholder="Example: 6.5"
              type="number"
              min="0"
              max="9"
              step="0.5"
              value={targetBand}
              onChange={e => setTargetBand(e.target.value)}
            />
          </div>

          <button
            type="button"
            onClick={handleSignup}
            disabled={loading}
            className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Creating account...' : 'Create Self-Study Account'}
          </button>
        </div>

        <div className="border-t border-gray-100 mt-6 pt-5 flex flex-col sm:flex-row items-center justify-center gap-3 text-center">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="text-sm font-medium text-gray-500 hover:text-gray-800"
          >
            Home
          </button>
          <span className="hidden sm:inline text-gray-200">•</span>
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="text-sm font-medium text-purple-600 hover:text-purple-700"
          >
            Already have an account? Login
          </button>
        </div>
      </div>
    </div>
  )
}
