import { useNavigate } from 'react-router-dom'

export default function Landing() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-[#faf9f6] flex flex-col">
      <nav className="flex flex-col sm:flex-row gap-4 sm:gap-0 justify-between items-center px-5 sm:px-10 py-5 border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-14 sm:h-16 object-contain" />

        <div className="flex gap-3">
          <button
            onClick={() => navigate('/login')}
            className="px-5 py-2 rounded-full bg-white border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50"
          >
            Login
          </button>
          <button
            onClick={() => navigate('/signup')}
            className="px-5 py-2 rounded-full bg-purple-600 text-white text-sm font-medium hover:bg-purple-700"
          >
            Study independently
          </button>
        </div>
      </nav>

      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
        <div className="inline-flex items-center gap-2 bg-purple-50 text-purple-600 border border-purple-200 rounded-full px-4 py-1.5 text-xs font-medium mb-8">
          <span className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-pulse"></span>
          IELTS Score Tracker
        </div>

        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-gray-900 mb-6 leading-tight">
          Track every band.<br />Reach your <span className="text-purple-600">target score.</span>
        </h1>

        <p className="text-gray-500 text-base sm:text-lg max-w-xl mb-10">
          Use Maxima through your institution, or create an individual self-study account for your own IELTS program.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 items-center w-full sm:w-auto">
          <button
            onClick={() => navigate('/login')}
            className="w-full sm:w-auto px-8 py-4 bg-gray-900 text-white rounded-full text-base font-medium hover:bg-gray-800"
          >
            Institution / existing login
          </button>
          <button
            onClick={() => navigate('/signup')}
            className="w-full sm:w-auto px-8 py-4 bg-purple-600 text-white rounded-full text-base font-medium hover:bg-purple-700"
          >
            Create self-study account
          </button>
        </div>

        <p className="text-xs text-gray-400 mt-5 max-w-lg leading-5">
          Institution student and teacher accounts are still created by the institution administrator. Individual accounts use email and password only.
        </p>
      </div>
    </div>
  )
}
