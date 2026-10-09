import { useNavigate } from 'react-router-dom'

export default function Signup() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-4">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 w-full max-w-md shadow-sm">
        <img src="/1.png" alt="Maxima" className="h-20 object-contain mb-1" />

        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Account access
        </h1>

        <p className="text-gray-400 text-sm mb-6">
          Maxima IELTS Tracker accounts are created by your institution administrator.
        </p>

        <div className="bg-purple-50 border border-purple-100 text-purple-700 rounded-xl p-4 text-sm leading-6 mb-5">
          Students and teachers should not create a second account. If your institution has added you, use the email address registered by your administrator and follow the password setup email you received.
        </div>

        <div className="bg-amber-50 border border-amber-100 text-amber-700 rounded-xl p-4 text-xs leading-5 mb-6">
          Need an account or did not receive your password setup email? Contact your institution administrator.
        </div>

        <button
          type="button"
          onClick={() => navigate('/login')}
          className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700"
        >
          Go to Login
        </button>
      </div>
    </div>
  )
}
