import { useState } from 'react'
import {
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  sendPasswordResetEmail
} from 'firebase/auth'
import {
  doc,
  setDoc
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import { useNavigate } from 'react-router-dom'

export default function Signup() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('student')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const cleanEmail = email.trim().toLowerCase()
  const cleanName = name.trim()

  const sendResetEmail = async () => {
    setError('')
    setMessage('')

    if (!cleanEmail) {
      setError('Please enter your email first.')
      return
    }

    try {
      await sendPasswordResetEmail(auth, cleanEmail)
      setMessage('Password reset email sent. Please check your inbox.')
    } catch (err) {
      setError('Could not send password reset email.')
    }
  }

  const handleSignup = async () => {
    setError('')
    setMessage('')

    if (!cleanName || !cleanEmail || !password.trim()) {
      setError('Please fill in all fields.')
      return
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }

    setLoading(true)

    try {
      const signInMethods = await fetchSignInMethodsForEmail(auth, cleanEmail)

      if (signInMethods.length > 0) {
        setError(
          'This email is already registered. Please login or use password reset.'
        )
        return
      }

      const result = await createUserWithEmailAndPassword(
        auth,
        cleanEmail,
        password
      )

      await setDoc(doc(db, 'users', result.user.uid), {
        name: cleanName,
        email: cleanEmail,
        role: null,
        requestedRole: role,
        status: 'pending',
        deleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      setMessage('Account request created. Please wait for admin approval.')

      setTimeout(() => {
        navigate('/login')
      }, 1200)
    } catch (err) {
      console.error(err)

      if (err.code === 'auth/email-already-in-use') {
        setError(
          'This email is already in use. Please login or use password reset.'
        )
        return
      }

      if (err.code === 'auth/invalid-email') {
        setError('Please enter a valid email address.')
        return
      }

      if (err.code === 'auth/weak-password') {
        setError('Password must be at least 6 characters.')
        return
      }

      if (err.code === 'permission-denied') {
        setError(
          'Account was created, but the profile could not be saved because of Firestore permissions. Please contact admin.'
        )
        return
      }

      setError(err.message || 'Could not create account.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 w-full max-w-md shadow-sm">
        <img src="/1.png" alt="Maxima" className="h-16 object-contain mb-1" />

        <p className="text-gray-400 text-sm mb-6">
          Create your account
        </p>

        {error && (
          <div className="bg-red-50 text-red-600 text-sm rounded-xl p-3 mb-4 leading-6">
            {error}

            {(error.toLowerCase().includes('already') ||
              error.toLowerCase().includes('login')) && (
              <button
                type="button"
                onClick={sendResetEmail}
                className="block mt-2 text-xs font-medium text-red-700 underline"
              >
                Send password reset email
              </button>
            )}
          </div>
        )}

        {message && (
          <div className="bg-green-50 text-green-600 text-sm rounded-xl p-3 mb-4 leading-6">
            {message}
          </div>
        )}

        <div className="flex gap-2 mb-5">
          <button
            type="button"
            onClick={() => setRole('student')}
            className={`flex-1 py-2 rounded-full text-sm font-medium border transition-all ${
              role === 'student'
                ? 'bg-purple-600 text-white border-purple-600'
                : 'border-gray-200 text-gray-500'
            }`}
          >
            Student
          </button>

          <button
            type="button"
            onClick={() => setRole('teacher')}
            className={`flex-1 py-2 rounded-full text-sm font-medium border transition-all ${
              role === 'teacher'
                ? 'bg-purple-600 text-white border-purple-600'
                : 'border-gray-200 text-gray-500'
            }`}
          >
            Teacher
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Full name"
            value={name}
            onChange={e => setName(e.target.value)}
          />

          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />

          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />

          <button
            onClick={handleSignup}
            disabled={loading}
            className="bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-1 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Creating...' : 'Create account'}
          </button>
        </div>

        <p className="text-center text-sm text-gray-400 mt-4">
          Already have an account?{' '}
          <span
            onClick={() => navigate('/login')}
            className="text-purple-600 cursor-pointer"
          >
            Login
          </span>
        </p>
      </div>
    </div>
  )
}
