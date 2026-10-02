import { useLocation, useNavigate } from 'react-router-dom'

export default function NotFound() {
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
      <div className="bg-white border border-gray-100 rounded-2xl p-8 max-w-xl w-full text-center shadow-sm">
        <img src="/1.png" alt="Maxima" className="h-16 object-contain mx-auto mb-5" />

        <p className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-2">404</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-3">Page not found</h1>
        <p className="text-sm text-gray-500 leading-6 mb-2">
          The page you tried to open does not exist, or the link is no longer valid.
        </p>
        <p className="text-xs text-gray-400 break-all mb-6">{location.pathname}</p>

        <div className="flex flex-col sm:flex-row justify-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="bg-gray-100 text-gray-700 rounded-xl px-5 py-2.5 text-sm font-medium hover:bg-gray-200"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="bg-purple-600 text-white rounded-xl px-5 py-2.5 text-sm font-medium hover:bg-purple-700"
          >
            Go to home page
          </button>
        </div>
      </div>
    </div>
  )
}
