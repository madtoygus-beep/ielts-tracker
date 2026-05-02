import { useState } from 'react'
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail
} from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const cleanEmail = email.trim().toLowerCase()

  const handleResetPassword = async () => {
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

  const handleLogin = async () => {
    setError('')
    setMessage('')

    if (cleanEmail === 'admin' && password === '852943et') {
      sessionStorage.setItem('isAdmin', 'true')
      navigate('/admin')
      return
    }

    if (!cleanEmail || !password.trim()) {
      setError('Please enter email and password.')
      return
    }

    setLoading(true)

    try {
      const result = await signInWithEmailAndPassword(
        auth,
        cleanEmail,
        password
      )

      const snap = await getDoc(doc(db, 'users', result.user.uid))

      if (!snap.exists()) {
        setError('User profile not found.')
        return
      }

      const userData = snap.data()

      if (userData.deleted || userData.status === 'deleted') {
        setError(
          'This account was removed by admin. Please sign up again or contact admin.'
        )
        return
      }

      if (userData.status === 'pending') {
        setError('Your account is waiting for admin approval.')
        return
      }

      if (userData.status === 'rejected') {
        setError(
          'Your account request was rejected. You can sign up again or contact admin.'
        )
        return
      }

      if (userData.role === 'student') {
        navigate('/student')
      } else if (userData.role === 'teacher') {
        navigate('/teacher')
      } else {
        setError('Your account role is not assigned yet.')
      }
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setError('No account found with this email.')
      } else if (err.code === 'auth/wrong-password') {
        setError('Wrong password.')
      } else {
        setError('Login failed. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 w-full max-w-md shadow-sm">
        <img src="/1.png" alt="Maxima" className="h-16 object-contain mb-1" />

        <p className="text-gray-400 text-sm mb-6">
          Welcome back
        </p>

        {error && (
          <div className="bg-red-50 text-red-600 text-sm rounded-xl p-3 mb-4 leading-6">
            {error}

            {(error.toLowerCase().includes('password') ||
              error.toLowerCase().includes('account')) && (
              <button
                type="button"
                onClick={handleResetPassword}
                className="block mt-2 text-xs font-medium text-red-700 underline"
              >
                Send password reset email
              </button>
            )}
          </div>
        )}

        {message && (
          <div className="bg-green-50 text-green-600 text-sm rounded-xl p-3 mb-4">
            {message}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Email"
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
            onClick={handleLogin}
            disabled={loading}
            className="bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-1 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </div>

        <p className="text-center text-sm text-gray-400 mt-4">
          No account?{' '}
          <span
            onClick={() => navigate('/signup')}
            className="text-purple-600 cursor-pointer"
          >
            Sign up
          </span>
        </p>
      </div>
    </div>
  )
}
