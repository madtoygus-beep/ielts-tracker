import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'

const Landing = lazy(() => import('./pages/Landing'))
const Login = lazy(() => import('./pages/Login'))
const Signup = lazy(() => import('./pages/Signup'))

const StudentDashboard = lazy(() => import('./pages/StudentDashboard'))
const TeacherDashboard = lazy(() => import('./pages/TeacherDashboard'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))

const CreateReading = lazy(() => import('./pages/CreateReading'))
const DoReading = lazy(() => import('./pages/DoReading'))

const CreateWriting = lazy(() => import('./pages/CreateWriting'))
const DoWriting = lazy(() => import('./pages/DoWriting'))

const CreateListening = lazy(() => import('./pages/CreateListening'))
const DoListening = lazy(() => import('./pages/DoListening'))

const CreateMockTest = lazy(() => import('./pages/CreateMockTest'))
const DoMockTest = lazy(() => import('./pages/DoMockTest'))

const CreateVocabulary = lazy(() => import('./pages/CreateVocabulary'))
const DoVocabulary = lazy(() => import('./pages/DoVocabulary'))

const ManageClasses = lazy(() => import('./pages/ManageClasses'))
const TeacherPreview = lazy(() => import('./pages/TeacherPreview'))

function PageLoader() {
  return (
    <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center px-6">
      <div className="bg-white border border-gray-100 rounded-2xl px-8 py-7 shadow-sm text-center">
        <div className="w-10 h-10 border-4 border-purple-100 border-t-purple-600 rounded-full animate-spin mx-auto mb-4" />

        <p className="text-sm font-medium text-gray-700">
          Loading page...
        </p>

        <p className="text-xs text-gray-400 mt-1">
          Please wait a moment.
        </p>
      </div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />

          <Route path="/student" element={<StudentDashboard />} />
          <Route path="/teacher" element={<TeacherDashboard />} />
          <Route path="/admin" element={<AdminDashboard />} />

          <Route path="/create-reading" element={<CreateReading />} />
          <Route path="/edit-reading/:id" element={<CreateReading />} />
          <Route path="/do-reading/:id" element={<DoReading />} />

          <Route path="/create-writing" element={<CreateWriting />} />
          <Route path="/edit-writing/:id" element={<CreateWriting />} />
          <Route path="/do-writing/:id" element={<DoWriting />} />

          <Route path="/create-listening" element={<CreateListening />} />
          <Route path="/edit-listening/:id" element={<CreateListening />} />
          <Route path="/do-listening/:id" element={<DoListening />} />

          <Route path="/create-mock" element={<CreateMockTest />} />
          <Route path="/edit-mock/:id" element={<CreateMockTest />} />
          <Route path="/do-mock/:id" element={<DoMockTest />} />

          <Route path="/create-vocabulary" element={<CreateVocabulary />} />
          <Route path="/edit-vocabulary/:id" element={<CreateVocabulary />} />
          <Route path="/do-vocabulary/:id" element={<DoVocabulary />} />

          <Route path="/teacher/classes" element={<ManageClasses />} />
          <Route path="/admin/classes" element={<ManageClasses />} />

          <Route
            path="/preview/:type/:id"
            element={<TeacherPreview />}
          />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

export default App
