import { BrowserRouter, Routes, Route } from 'react-router-dom'

import Landing from './pages/Landing'
import Login from './pages/Login'
import Signup from './pages/Signup'

import StudentDashboard from './pages/StudentDashboard'
import TeacherDashboard from './pages/TeacherDashboard'
import AdminDashboard from './pages/AdminDashboard'

import CreateReading from './pages/CreateReading'
import DoReading from './pages/DoReading'

import CreateWriting from './pages/CreateWriting'
import DoWriting from './pages/DoWriting'

import CreateListening from './pages/CreateListening'
import DoListening from './pages/DoListening'

import CreateMockTest from './pages/CreateMockTest'
import DoMockTest from './pages/DoMockTest'

import CreateVocabulary from './pages/CreateVocabulary'
import DoVocabulary from './pages/DoVocabulary'

import ManageClasses from './pages/ManageClasses'

function App() {
  return (
    <BrowserRouter>
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
        <Route path="/do-mock/:id" element={<DoMockTest />} />

        <Route path="/create-vocabulary" element={<CreateVocabulary />} />
        <Route path="/edit-vocabulary/:id" element={<CreateVocabulary />} />
        <Route path="/do-vocabulary/:id" element={<DoVocabulary />} />

        <Route path="/teacher/classes" element={<ManageClasses />} />
        <Route path="/admin/classes" element={<ManageClasses />} />

      </Routes>
    </BrowserRouter>
  )
}

export default App
