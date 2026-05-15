import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  getDoc,
  arrayUnion,
  arrayRemove
} from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

const DEFAULT_SCHOOL_ID = 'maxima'

const COLOR_OPTIONS = [
  { id: 'purple', label: 'Purple', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-500' },
  { id: 'blue', label: 'Blue', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500' },
  { id: 'green', label: 'Green', bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', dot: 'bg-green-500' },
  { id: 'amber', label: 'Amber', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-500' },
  { id: 'rose', label: 'Rose', bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', dot: 'bg-rose-500' },
  { id: 'cyan', label: 'Cyan', bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200', dot: 'bg-cyan-500' },
  { id: 'indigo', label: 'Indigo', bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', dot: 'bg-indigo-500' },
  { id: 'fuchsia', label: 'Fuchsia', bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', border: 'border-fuchsia-200', dot: 'bg-fuchsia-500' }
]

function getColorStyle(colorId) {
  return COLOR_OPTIONS.find(c => c.id === colorId) || COLOR_OPTIONS[0]
}

export default function ManageClasses() {
  const [user, setUser] = useState(null)
  const [userRole, setUserRole] = useState('')
  const [userProfile, setUserProfile] = useState(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [classes, setClasses] = useState([])
  const [students, setStudents] = useState([])
  const [teachers, setTeachers] = useState([])
  const [loading, setLoading] = useState(true)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingClass, setEditingClass] = useState(null)

  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formColor, setFormColor] = useState('purple')
  const [formStudentIds, setFormStudentIds] = useState([])
  const [formTeacherId, setFormTeacherId] = useState('')
  const [formSearch, setFormSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const navigate = useNavigate()

  // ============================================================
  // Auth check (admin or teacher only)
  // ============================================================
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async currentUser => {
      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid))

        if (!userSnap.exists()) {
          alert('User profile not found.')
          navigate('/login')
          return
        }

        const userData = userSnap.data()

        if (userData.role !== 'admin' && userData.role !== 'teacher') {
          alert('Access denied. Only admins and teachers can manage classes.')
          navigate('/student')
          return
        }

        if (userData.status !== 'approved' || userData.deleted === true) {
          alert('Your account is not active.')
          navigate('/login')
          return
        }

        setUser(currentUser)
        setUserRole(userData.role)
        setUserProfile(userData)
        setAuthChecking(false)
      } catch (error) {
        console.error(error)
        alert('Could not verify your access.')
        navigate('/login')
      }
    })

    return unsub
  }, [navigate])

  // ============================================================
  // Subscribe to classes (live)
  // ============================================================
  useEffect(() => {
    if (authChecking || !user) return

    const q = userRole === 'admin'
      ? query(collection(db, 'classes'))
      : query(
          collection(db, 'classes'),
          where('teacherId', '==', user.uid)
        )
    const schoolId = userProfile?.schoolId || DEFAULT_SCHOOL_ID

    const unsub = onSnapshot(
      q,
      snap => {
        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(c => {
            if (c.archived) return false
            if (userRole === 'admin') return true

            return (
              (c.schoolId || DEFAULT_SCHOOL_ID) === schoolId &&
              (c.teacherId === user.uid || c.createdBy === user.uid)
            )
          })
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

        setClasses(list)
        setLoading(false)
      },
      error => {
        console.error('Classes snapshot error:', error)
        setLoading(false)
      }
    )

    return unsub
  }, [authChecking, user, userRole, userProfile])

  // ============================================================
  // Subscribe to students
  // ============================================================
  useEffect(() => {
    if (authChecking || !user) return

    const q = userRole === 'admin'
      ? query(collection(db, 'users'), where('role', '==', 'student'))
      : query(
          collection(db, 'users'),
          where('role', '==', 'student'),
          where('teacherIds', 'array-contains', user.uid)
        )

    return onSnapshot(q, snap => {
      const schoolId = userProfile?.schoolId || DEFAULT_SCHOOL_ID

      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(s => {
          if (s.status !== 'approved' || s.deleted === true) return false
          if (userRole === 'admin') return true

          return (s.schoolId || DEFAULT_SCHOOL_ID) === schoolId
        })
        .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))

      setStudents(list)
    })
  }, [authChecking, user, userRole, userProfile])

  // ============================================================
  // Subscribe to teachers (admin only)
  // ============================================================
  useEffect(() => {
    if (authChecking || !user || userRole !== 'admin') {
      setTeachers([])
      return
    }

    const q = query(collection(db, 'users'), where('role', '==', 'teacher'))

    return onSnapshot(q, snap => {
      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.status === 'approved' && t.deleted !== true)
        .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))

      setTeachers(list)
    })
  }, [authChecking, user, userRole])

  // ============================================================
  // Form helpers
  // ============================================================
  const openCreateModal = () => {
    setEditingClass(null)
    setFormName('')
    setFormDescription('')
    setFormColor('purple')
    setFormStudentIds([])
    setFormTeacherId(userRole === 'teacher' ? user?.uid || '' : '')
    setFormSearch('')
    setShowCreateModal(true)
  }

  const openEditModal = classItem => {
    setEditingClass(classItem)
    setFormName(classItem.name || '')
    setFormDescription(classItem.description || '')
    setFormColor(classItem.color || 'purple')
    setFormStudentIds(classItem.studentIds || [])
    setFormTeacherId(classItem.teacherId || (userRole === 'teacher' ? user?.uid || '' : ''))
    setFormSearch('')
    setShowCreateModal(true)
  }

  const closeModal = () => {
    setShowCreateModal(false)
    setEditingClass(null)
    setFormName('')
    setFormDescription('')
    setFormColor('purple')
    setFormStudentIds([])
    setFormTeacherId('')
    setFormSearch('')
  }

  const toggleStudent = studentId => {
    setFormStudentIds(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    )
  }

  const handleSave = async () => {
    if (saving) return

    if (!formName.trim()) {
      alert('Please enter a class name.')
      return
    }

    setSaving(true)

    try {
      const now = new Date().toISOString()
      const schoolId = userProfile?.schoolId || DEFAULT_SCHOOL_ID
      const teacherId = userRole === 'admin'
        ? formTeacherId || ''
        : user.uid

      if (userRole === 'admin' && !teacherId) {
        alert('Please select a teacher for this class.')
        setSaving(false)
        return
      }

      const previousStudentIds = editingClass?.studentIds || []
      const removedStudentIds = previousStudentIds.filter(id => !formStudentIds.includes(id))
      const addedStudentIds = formStudentIds.filter(id => !previousStudentIds.includes(id))

      if (editingClass) {
        await updateDoc(doc(db, 'classes', editingClass.id), {
          name: formName.trim(),
          description: formDescription.trim(),
          color: formColor,
          studentIds: formStudentIds,
          teacherId,
          schoolId,
          updatedBy: user.uid,
          updatedAt: now
        })
      } else {
        await addDoc(collection(db, 'classes'), {
          name: formName.trim(),
          description: formDescription.trim(),
          color: formColor,
          studentIds: formStudentIds,
          teacherId,
          schoolId,
          createdBy: user.uid,
          createdAt: now,
          updatedAt: now,
          archived: false
        })
      }

      for (const studentId of addedStudentIds) {
        await updateDoc(doc(db, 'users', studentId), {
          teacherIds: arrayUnion(teacherId),
          schoolId,
          updatedAt: now
        })
      }

      if (editingClass && editingClass.teacherId === teacherId) {
        for (const studentId of removedStudentIds) {
          await updateDoc(doc(db, 'users', studentId), {
            teacherIds: arrayRemove(teacherId),
            updatedAt: now
          })
        }
      }

      closeModal()
    } catch (error) {
      console.error(error)
      alert('Could not save class. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async classItem => {
    const confirmed = window.confirm(
      `Delete class "${classItem.name}"?\n\nThis will only remove the class group. Students themselves and their existing homework assignments will not be affected.`
    )

    if (!confirmed) return

    try {
      const teacherId = classItem.teacherId || classItem.createdBy || ''

      if (teacherId) {
        for (const studentId of classItem.studentIds || []) {
          await updateDoc(doc(db, 'users', studentId), {
            teacherIds: arrayRemove(teacherId),
            updatedAt: new Date().toISOString()
          })
        }
      }

      await deleteDoc(doc(db, 'classes', classItem.id))
    } catch (error) {
      console.error(error)
      alert('Could not delete class.')
    }
  }

  // ============================================================
  // Search filter for students inside modal
  // ============================================================
  const filteredStudents = students.filter(student => {
    if (!formSearch.trim()) return true
    const query = formSearch.toLowerCase()
    return (
      (student.name || '').toLowerCase().includes(query) ||
      (student.email || '').toLowerCase().includes(query)
    )
  })

  const getStudentName = studentId => {
    const student = students.find(s => s.id === studentId)
    return student?.name || student?.email || 'Unknown student'
  }

  // ============================================================
  // Loading state
  // ============================================================
  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Checking access...</p>
      </div>
    )
  }

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />
        <button
          onClick={() => navigate(userRole === 'admin' ? '/admin' : '/teacher')}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Back to dashboard
        </button>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">
              Manage Classes
            </h1>
            <p className="text-gray-400 text-sm">
              Group students into classes to assign homework faster.
            </p>
          </div>

          <button
            onClick={openCreateModal}
            className="bg-purple-600 text-white rounded-xl px-6 py-3 text-sm font-medium hover:bg-purple-700"
          >
            + Create Class
          </button>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm text-center py-12">
            Loading classes...
          </p>
        ) : classes.length === 0 ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-12 text-center">
            <div className="text-5xl mb-4">📚</div>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">
              No classes yet
            </h2>
            <p className="text-sm text-gray-500 mb-6">
              Create your first class to start grouping students.
            </p>
            <button
              onClick={openCreateModal}
              className="bg-purple-600 text-white rounded-xl px-6 py-3 text-sm font-medium hover:bg-purple-700"
            >
              + Create First Class
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {classes.map(classItem => {
              const colorStyle = getColorStyle(classItem.color)
              const studentCount = (classItem.studentIds || []).length

              return (
                <div
                  key={classItem.id}
                  className={`bg-white border-2 rounded-2xl p-5 ${colorStyle.border}`}
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-3 h-3 rounded-full flex-shrink-0 ${colorStyle.dot}`} />
                      <h3 className="font-semibold text-gray-900 truncate">
                        {classItem.name}
                      </h3>
                    </div>

                    <span
                      className={`text-xs font-medium px-2 py-1 rounded-full flex-shrink-0 ${colorStyle.bg} ${colorStyle.text}`}
                    >
                      {studentCount} {studentCount === 1 ? 'student' : 'students'}
                    </span>
                  </div>

                  {classItem.description && (
                    <p className="text-xs text-gray-500 mb-4 line-clamp-2">
                      {classItem.description}
                    </p>
                  )}

                  {userRole === 'admin' && classItem.teacherId && (
                    <p className="text-xs text-gray-400 mb-4">
                      Teacher: {teachers.find(t => t.id === classItem.teacherId)?.name || teachers.find(t => t.id === classItem.teacherId)?.email || 'Assigned teacher'}
                    </p>
                  )}

                  {studentCount > 0 && (
                    <div className="bg-gray-50 rounded-xl p-3 mb-4 max-h-32 overflow-y-auto">
                      <div className="flex flex-col gap-1">
                        {(classItem.studentIds || []).slice(0, 5).map(studentId => (
                          <p key={studentId} className="text-xs text-gray-600 truncate">
                            • {getStudentName(studentId)}
                          </p>
                        ))}
                        {studentCount > 5 && (
                          <p className="text-xs text-gray-400 italic">
                            + {studentCount - 5} more
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => openEditModal(classItem)}
                      className="flex-1 bg-gray-100 text-gray-700 rounded-xl py-2 text-xs font-medium hover:bg-gray-200"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(classItem)}
                      className="bg-red-50 text-red-600 rounded-xl px-3 py-2 text-xs font-medium hover:bg-red-100"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* CREATE / EDIT MODAL */}
      {/* ============================================================ */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingClass ? 'Edit Class' : 'Create New Class'}
              </h2>
              <button
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-600 text-xl"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {userRole === 'admin' && (
                <div className="mb-4">
                  <label className="text-xs text-gray-400 mb-1 block">
                    Teacher *
                  </label>

                  <select
                    value={formTeacherId}
                    onChange={e => setFormTeacherId(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 bg-white"
                  >
                    <option value="">Select teacher</option>

                    {teachers.map(teacher => (
                      <option key={teacher.id} value={teacher.id}>
                        {teacher.name || teacher.email}
                      </option>
                    ))}
                  </select>

                  <p className="text-[11px] text-gray-400 mt-1">
                    This teacher will be able to see and manage this class.
                  </p>
                </div>
              )}

              {/* Name */}
              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Class name *
                </label>
                <input
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g. 9-A IELTS Hazırlık"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                  autoFocus
                />
              </div>

              {/* Description */}
              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1 block">
                  Description (optional)
                </label>
                <textarea
                  rows={2}
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  placeholder="e.g. Hafta içi 18:00, Ekim grubu"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-none"
                />
              </div>

              {/* Color */}
              <div className="mb-5">
                <label className="text-xs text-gray-400 mb-2 block">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {COLOR_OPTIONS.map(color => (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() => setFormColor(color.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border-2 text-xs font-medium ${
                        formColor === color.id
                          ? `${color.bg} ${color.text} ${color.border}`
                          : 'bg-white border-gray-200 text-gray-500'
                      }`}
                    >
                      <span className={`w-3 h-3 rounded-full ${color.dot}`} />
                      {color.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Students */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-400">
                    Students ({formStudentIds.length} selected)
                  </label>
                  {formStudentIds.length > 0 && (
                    <button
                      onClick={() => setFormStudentIds([])}
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      Clear all
                    </button>
                  )}
                </div>

                <input
                  value={formSearch}
                  onChange={e => setFormSearch(e.target.value)}
                  placeholder="Search students by name or email..."
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 mb-3"
                />

                {students.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl">
                    No students found.
                  </p>
                ) : filteredStudents.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6 bg-gray-50 rounded-xl">
                    No students match "{formSearch}".
                  </p>
                ) : (
                  <div className="border border-gray-100 rounded-xl max-h-72 overflow-y-auto">
                    {filteredStudents.map(student => {
                      const checked = formStudentIds.includes(student.id)

                      return (
                        <label
                          key={student.id}
                          className={`flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${
                            checked ? 'bg-purple-50/40' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleStudent(student.id)}
                            className="accent-purple-600 w-4 h-4"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {student.name || 'No name'}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                              {student.email}
                            </p>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button
                onClick={closeModal}
                className="flex-1 bg-gray-100 text-gray-700 rounded-xl py-3 text-sm font-medium hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
              >
                {saving
                  ? 'Saving...'
                  : editingClass
                    ? 'Save Changes'
                    : 'Create Class'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}