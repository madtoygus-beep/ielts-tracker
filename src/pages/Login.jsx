import { useState } from 'react'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleLogin = async () => {
    // Admin hardcoded login
    if (email === 'admin' && password === '852943et') {
  sessionStorage.setItem('isAdmin', 'true')
  navigate('/admin')
  return
}

    try {
      const result = await signInWithEmailAndPassword(auth, email, password)
      const snap = await getDoc(doc(db, 'users', result.user.uid))
      const role = snap.data().role
      navigate(role === 'student' ? '/student' : '/teacher')
    } catch (err) {
      setError('Wrong email or password')
    }
  }

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 w-full max-w-md shadow-sm">
        <img src="/1.png" alt="Maxima" className="h-16 object-contain mb-1" />
        <p className="text-gray-400 text-sm mb-6">Welcome back</p>

        {error && <div className="bg-red-50 text-red-600 text-sm rounded-xl p-3 mb-4">{error}</div>}

        <div className="flex flex-col gap-3">
          <input
            className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            placeholder="Email or username"
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
            className="bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-1"
          >
            Login
          </button>
        </div>

        <p className="text-center text-sm text-gray-400 mt-4">
          No account? <span onClick={() => navigate('/signup')} className="text-purple-600 cursor-pointer">Sign up</span>
        </p>
      </div>
    </div>
  )
}