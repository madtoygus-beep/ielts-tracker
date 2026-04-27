import { useState } from 'react'
import { createUserWithEmailAndPassword } from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { useNavigate } from 'react-router-dom'

export default function Signup() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('student')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleSignup = async () => {
    try {
      const result = await createUserWithEmailAndPassword(auth, email, password)
      await setDoc(doc(db, 'users', result.user.uid), {
        name, email, role,
        createdAt: new Date().toISOString()
      })
      navigate(role === 'student' ? '/student' : '/teacher')
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 w-full max-w-md shadow-sm">
        <img src="/1.png" alt="Maxima" className="h-16 object-contain mb-1" />
        <p className="text-gray-400 text-sm mb-6">Create your account</p>

        {error && <div className="bg-red-50 text-red-600 text-sm rounded-xl p-3 mb-4">{error}</div>}

        <div className="flex gap-2 mb-5">
          <button onClick={() => setRole('student')} className={`flex-1 py-2 rounded-full text-sm font-medium border transition-all ${role === 'student' ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-500'}`}>Student</button>
          <button onClick={() => setRole('teacher')} className={`flex-1 py-2 rounded-full text-sm font-medium border transition-all ${role === 'teacher' ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-500'}`}>Teacher</button>
        </div>

        <div className="flex flex-col gap-3">
          <input className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400" placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />
          <input className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400" placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
          <input className="border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400" placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
          <button onClick={handleSignup} className="bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 mt-1">Create account</button>
        </div>

        <p className="text-center text-sm text-gray-400 mt-4">Already have an account? <span onClick={() => navigate('/login')} className="text-purple-600 cursor-pointer">Login</span></p>
      </div>
    </div>
  )
}