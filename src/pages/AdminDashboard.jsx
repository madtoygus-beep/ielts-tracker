import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import {
  collection,
  onSnapshot,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  arrayUnion,
  arrayRemove
} from 'firebase/firestore'
import { signOut, onAuthStateChanged } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

export default function AdminDashboard() {
  const [users, setUsers] = useState([])
  const [scores, setScores] = useState({})
  const [search, setSearch] = useState('')
  const [editUser, setEditUser] = useState(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState('')
  const [editTargetBand, setEditTargetBand] = useState('')
  const [editScore, setEditScore] = useState(null)
  const [editScoreForm, setEditScoreForm] = useState({})
  const [selectedStudent, setSelectedStudent] = useState(null)
  const [authChecking, setAuthChecking] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    let unsubUsers = null
    let unsubScores = null
    let active = true

    const cleanup = () => {
      if (unsubUsers) {
        unsubUsers()
        unsubUsers = null
      }
      if (unsubScores) {
        unsubScores()
        unsubScores = null
      }
    }

    const unsubAuth = onAuthStateChanged(auth, async currentUser => {
      cleanup()

      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        const userSnap = await getDoc(doc(db, 'users', currentUser.uid))

        if (!active) return

        if (!userSnap.exists()) {
          await signOut(auth)
          navigate('/login')
          return
        }

        const profile = userSnap.data()

        if (
          profile.deleted ||
          profile.status !== 'approved' ||
          profile.role !== 'admin'
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        setAuthChecking(false)

        unsubUsers = onSnapshot(collection(db, 'users'), snap => {
          const list = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(u => !u.deleted && u.status !== 'deleted')

          setUsers(list)
        })

        unsubScores = onSnapshot(collection(db, 'scores'), snap => {
          const groupedScores = {}

          snap.docs.forEach(scoreDoc => {
            const score = {
              id: scoreDoc.id,
              ...scoreDoc.data()
            }

            if (!score.uid || score.archived === true) return

            if (!groupedScores[score.uid]) {
              groupedScores[score.uid] = []
            }

            groupedScores[score.uid].push(score)
          })

          Object.keys(groupedScores).forEach(studentId => {
            groupedScores[studentId].sort(
              (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
            )
          })

          setScores(groupedScores)
        })
      } catch (error) {
        console.error(error)

        if (active) {
          await signOut(auth)
          navigate('/login')
        }
      }
    })

    return () => {
      active = false
      unsubAuth()
      cleanup()
    }
  }, [navigate])

  const approveUser = async (userId, roleType) => {
    await updateDoc(doc(db, 'users', userId), {
      status: 'approved',
      role: roleType,
      deleted: false,
      approvedAt: new Date().toISOString()
    })
  }

  const rejectUser = async (userId) => {
    if (!window.confirm('Reject this request?')) return
    await updateDoc(doc(db, 'users', userId), {
      status: 'rejected',
      role: null,
      rejectedAt: new Date().toISOString()
    })
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to remove this account from the panel?')) return

    await updateDoc(doc(db, 'users', id), {
      deleted: true,
      status: 'deleted',
      deletedAt: new Date().toISOString()
    })
  }

  const handleDeleteScore = async (scoreId) => {
    if (!window.confirm('Delete this score?')) return
    await deleteDoc(doc(db, 'scores', scoreId))
  }

  const updateResultDocumentsByStudent = async (collectionName, uid, data, shouldInclude = () => true) => {
    const possibleFields = ['uid', 'userId', 'studentId']
    const updatedDocumentIds = new Set()

    for (const field of possibleFields) {
      const q = query(
        collection(db, collectionName),
        where(field, '==', uid)
      )

      const snap = await getDocs(q)

      for (const item of snap.docs) {
        if (updatedDocumentIds.has(item.id)) continue

        const itemData = {
          id: item.id,
          ...item.data()
        }

        if (!shouldInclude(itemData)) continue

        await updateDoc(doc(db, collectionName, item.id), {
          ...data,
          updatedAt: new Date().toISOString()
        })

        updatedDocumentIds.add(item.id)
      }
    }

    return updatedDocumentIds.size
  }

  const deleteResultDocumentsByStudent = async (collectionName, uid, shouldInclude = () => true) => {
    const possibleFields = ['uid', 'userId', 'studentId']
    const deletedDocumentIds = new Set()

    for (const field of possibleFields) {
      const q = query(
        collection(db, collectionName),
        where(field, '==', uid)
      )

      const snap = await getDocs(q)

      for (const item of snap.docs) {
        if (deletedDocumentIds.has(item.id)) continue

        const itemData = {
          id: item.id,
          ...item.data()
        }

        if (!shouldInclude(itemData)) continue

        await deleteDoc(doc(db, collectionName, item.id))
        deletedDocumentIds.add(item.id)
      }
    }

    return deletedDocumentIds.size
  }

  const isMockScore = item =>
    item.source === 'mock_test' ||
    item.source === 'mock' ||
    Boolean(item.mockTestId) ||
    Boolean(item.mockId)

  const updateHomeworkAssignmentsVisibility = async (uid, hidden) => {
    const assignmentCollections = [
      'readings',
      'listenings',
      'writingHomeworks'
    ]

    let updatedCount = 0

    for (const collectionName of assignmentCollections) {
      const q = query(
        collection(db, collectionName),
        where('assignTo', 'array-contains', uid)
      )

      const snap = await getDocs(q)

      for (const item of snap.docs) {
        await updateDoc(doc(db, collectionName, item.id), {
          hiddenFor: hidden ? arrayUnion(uid) : arrayRemove(uid),
          updatedAt: new Date().toISOString()
        })

        updatedCount++
      }
    }

    return updatedCount
  }

  const updateMockAssignmentsVisibility = async (uid, hidden) => {
    const q = query(
      collection(db, 'mockTests'),
      where('assignTo', 'array-contains', uid)
    )

    const snap = await getDocs(q)

    for (const item of snap.docs) {
      await updateDoc(doc(db, 'mockTests', item.id), {
        hiddenFor: hidden ? arrayUnion(uid) : arrayRemove(uid),
        updatedAt: new Date().toISOString()
      })
    }

    return snap.docs.length
  }

  const hideStudentRecords = async (student, type) => {
    const isMock = type === 'mock'
    const label = isMock ? 'mock test results' : 'homework results'

    const ok = window.confirm(
      `Hide ${label} for ${student.name || student.email}?\n\nThis will NOT permanently delete data.\nYou can restore it later.`
    )

    if (!ok) return

    try {
      let archivedCount = 0

      if (isMock) {
        archivedCount += await updateResultDocumentsByStudent(
          'mockSubmissions',
          student.id,
          {
            archived: true,
            archivedAt: new Date().toISOString()
          }
        )

        archivedCount += await updateResultDocumentsByStudent(
          'scores',
          student.id,
          {
            archived: true,
            archivedAt: new Date().toISOString()
          },
          isMockScore
        )

        archivedCount += await updateMockAssignmentsVisibility(student.id, true)
      } else {
        const homeworkCollections = [
          'readingSubmissions',
          'listeningSubmissions',
          'writingSubmissions'
        ]

        for (const collectionName of homeworkCollections) {
          archivedCount += await updateResultDocumentsByStudent(collectionName, student.id, {
            archived: true,
            archivedAt: new Date().toISOString()
          })
        }

        archivedCount += await updateHomeworkAssignmentsVisibility(student.id, true)
      }

      alert(`${student.name || student.email}'s ${label} were hidden. Updated ${archivedCount} record(s).`)
    } catch (error) {
      console.error(error)
      alert(`Could not hide ${label}.`)
    }
  }

  const restoreStudentRecords = async (student, type) => {
    const isMock = type === 'mock'
    const label = isMock ? 'mock test results' : 'homework results'

    const ok = window.confirm(
      `Restore hidden ${label} for ${student.name || student.email}?`
    )

    if (!ok) return

    try {
      let restoredCount = 0

      if (isMock) {
        restoredCount += await updateResultDocumentsByStudent(
          'mockSubmissions',
          student.id,
          {
            archived: false,
            restoredAt: new Date().toISOString()
          }
        )

        restoredCount += await updateResultDocumentsByStudent(
          'scores',
          student.id,
          {
            archived: false,
            restoredAt: new Date().toISOString()
          },
          isMockScore
        )

        restoredCount += await updateMockAssignmentsVisibility(student.id, false)
      } else {
        const homeworkCollections = [
          'readingSubmissions',
          'listeningSubmissions',
          'writingSubmissions'
        ]

        for (const collectionName of homeworkCollections) {
          restoredCount += await updateResultDocumentsByStudent(collectionName, student.id, {
            archived: false,
            restoredAt: new Date().toISOString()
          })
        }

        restoredCount += await updateHomeworkAssignmentsVisibility(student.id, false)
      }

      alert(`${student.name || student.email}'s ${label} were restored. Restored/updated ${restoredCount} record(s).`)
    } catch (error) {
      console.error(error)
      alert(`Could not restore ${label}.`)
    }
  }

  const hardDeleteStudentRecords = async (student, type) => {
    const isMock = type === 'mock'
    const label = isMock ? 'mock test results' : 'homework results'

    const ok = window.confirm(
      `PERMANENTLY DELETE ${label} for ${student.name || student.email}?\n\nThis cannot be undone.`
    )

    if (!ok) return

    try {
      let deletedCount = 0

      if (isMock) {
        deletedCount += await deleteResultDocumentsByStudent('mockSubmissions', student.id)
        deletedCount += await deleteResultDocumentsByStudent('scores', student.id, isMockScore)
      } else {
        const homeworkCollections = [
          'readingSubmissions',
          'listeningSubmissions',
          'writingSubmissions'
        ]

        for (const collectionName of homeworkCollections) {
          deletedCount += await deleteResultDocumentsByStudent(collectionName, student.id)
        }
      }

      alert(`${student.name || student.email}'s ${label} were permanently deleted. Deleted ${deletedCount} record(s).`)
    } catch (error) {
      console.error(error)
      alert(`Could not permanently delete ${label}.`)
    }
  }

  const handleEdit = (u) => {
    setEditUser(u)
    setEditName(u.name || '')
    setEditRole(u.role || 'student')
    setEditTargetBand(
      u.targetBand !== undefined && u.targetBand !== null
        ? String(u.targetBand)
        : ''
    )
  }

  const handleSaveEdit = async () => {
    const cleanTargetBand = editTargetBand === ''
      ? null
      : Number(editTargetBand)

    if (
      editTargetBand !== '' &&
      (
        Number.isNaN(cleanTargetBand) ||
        cleanTargetBand < 0 ||
        cleanTargetBand > 9
      )
    ) {
      alert('Target Band must be between 0 and 9.')
      return
    }

    await updateDoc(doc(db, 'users', editUser.id), {
      name: editName,
      role: editRole,
      targetBand: cleanTargetBand,
      status: 'approved',
      deleted: false
    })
    setEditUser(null)
    setEditTargetBand('')
  }

  const handleEditScore = (s) => {
    setEditScore(s)
    setEditScoreForm({
      listening: s.listening,
      reading: s.reading,
      writing: s.writing,
      speaking: s.speaking,
      date: s.date
    })
  }

  const handleSaveScore = async () => {
    const avg = (+editScoreForm.listening + +editScoreForm.reading + +editScoreForm.writing + +editScoreForm.speaking) / 4
    const overall = (Math.round(avg * 2) / 2).toFixed(1)
    await updateDoc(doc(db, 'scores', editScore.id), { ...editScoreForm, overall })
    setEditScore(null)
  }

  const handleLogout = async () => {
    await signOut(auth)
    navigate('/')
  }

  const filtered = users.filter(u =>
    u.name?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  )

  const pendingUsers = filtered.filter(u => u.status === 'pending')
  const rejectedUsers = filtered.filter(u => u.status === 'rejected')

  const students = filtered.filter(
    u => u.role === 'student' && (u.status === 'approved' || !u.status)
  )

  const teachers = filtered.filter(
    u => u.role === 'teacher' && (u.status === 'approved' || !u.status)
  )

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">
        <p className="text-gray-400">Checking permissions...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <div className="flex items-center gap-3">
          <img src="/1.png" alt="Maxima" className="h-10 object-contain" />
          <span className="text-xs bg-purple-100 text-purple-600 px-2 py-1 rounded-full font-medium">Admin</span>
        </div>
        <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-gray-600">Logout</button>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Admin Panel</h1>
        <p className="text-gray-400 text-sm mb-6">Manage all accounts and scores</p>

        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">
            <p className="text-3xl font-bold text-gray-900">{users.length}</p>
            <p className="text-sm text-gray-400 mt-1">Total users</p>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">
            <p className="text-3xl font-bold text-orange-500">{pendingUsers.length}</p>
            <p className="text-sm text-gray-400 mt-1">Pending</p>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">
            <p className="text-3xl font-bold text-purple-600">{students.length}</p>
            <p className="text-sm text-gray-400 mt-1">Students</p>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">
            <p className="text-3xl font-bold text-green-600">{teachers.length}</p>
            <p className="text-sm text-gray-400 mt-1">Teachers</p>
          </div>
        </div>

        <div className="mb-6">
          <input
            type="text"
            placeholder="Search by name or email..."
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="mb-8">
          <h2 className="font-semibold text-orange-600 mb-3">Pending Approvals ({pendingUsers.length})</h2>
          <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
            {pendingUsers.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">No pending approvals.</p>
            ) : pendingUsers.map(u => (
              <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-800">{u.name}</p>
                  <p className="text-xs text-gray-400">{u.email}</p>
                  {u.role === 'student' && (
                    <p className="text-xs text-blue-500 mt-0.5">
                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}
                    </p>
                  )}
                  <p className="text-xs text-orange-500 mt-1">Requested role: {u.requestedRole}</p>
                </div>

                <div className="flex gap-2">
                  <button onClick={() => approveUser(u.id, 'student')} className="text-xs bg-purple-100 hover:bg-purple-200 text-purple-700 px-3 py-1.5 rounded-lg">Approve Student</button>
                  <button onClick={() => approveUser(u.id, 'teacher')} className="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-3 py-1.5 rounded-lg">Approve Teacher</button>
                  <button onClick={() => rejectUser(u.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-3 py-1.5 rounded-lg">Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {rejectedUsers.length > 0 && (
          <div className="mb-8">
            <h2 className="font-semibold text-red-500 mb-3">Rejected Users ({rejectedUsers.length})</h2>
            <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
              {rejectedUsers.map(u => (
                <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{u.name}</p>
                    <p className="text-xs text-gray-400">{u.email}</p>
                  {u.role === 'student' && (
                    <p className="text-xs text-blue-500 mt-0.5">
                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}
                    </p>
                  )}
                  </div>

                  <div className="flex gap-2">
                    <button onClick={() => approveUser(u.id, 'student')} className="text-xs bg-purple-100 hover:bg-purple-200 text-purple-700 px-3 py-1.5 rounded-lg">Approve Student</button>
                    <button onClick={() => approveUser(u.id, 'teacher')} className="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-3 py-1.5 rounded-lg">Approve Teacher</button>
                    <button onClick={() => handleDelete(u.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-3 py-1.5 rounded-lg">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-8">
          <h2 className="font-semibold text-gray-700 mb-3">Teachers ({teachers.length})</h2>
          <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
            {teachers.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">No teachers found.</p>
            ) : teachers.map(u => (
              <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-semibold text-sm">
                    {u.name?.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-800">{u.name}</p>
                    <p className="text-xs text-gray-400">{u.email}</p>
                  {u.role === 'student' && (
                    <p className="text-xs text-blue-500 mt-0.5">
                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}
                    </p>
                  )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleEdit(u)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg">Edit</button>
                  <button onClick={() => handleDelete(u.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-3 py-1.5 rounded-lg">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="font-semibold text-gray-700 mb-3">Students ({students.length})</h2>
          <div className="flex flex-col gap-3">
            {students.length === 0 ? (
              <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">No students found.</div>
            ) : students.map(u => (
              <div key={u.id} className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
                <div
                  className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => setSelectedStudent(selectedStudent === u.id ? null : u.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-semibold text-sm">
                      {u.name?.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-800">{u.name}</p>
                      <p className="text-xs text-gray-400">{u.email}</p>
                  {u.role === 'student' && (
                    <p className="text-xs text-blue-500 mt-0.5">
                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}
                    </p>
                  )}
                    </div>
                  </div>
                  <div className="flex gap-2 items-center flex-wrap justify-end">
                    <button onClick={e => { e.stopPropagation(); handleEdit(u) }} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg">Edit</button>

                    <button onClick={e => { e.stopPropagation(); hideStudentRecords(u, 'mock') }} className="text-xs bg-purple-50 hover:bg-purple-100 text-purple-600 px-3 py-1.5 rounded-lg">Hide Mock</button>
                    <button onClick={e => { e.stopPropagation(); restoreStudentRecords(u, 'mock') }} className="text-xs bg-green-50 hover:bg-green-100 text-green-600 px-3 py-1.5 rounded-lg">Restore Mock</button>
                    <button onClick={e => { e.stopPropagation(); hardDeleteStudentRecords(u, 'mock') }} className="text-xs bg-red-50 hover:bg-red-100 text-red-600 px-3 py-1.5 rounded-lg">Delete Mock</button>

                    <button onClick={e => { e.stopPropagation(); hideStudentRecords(u, 'homework') }} className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-600 px-3 py-1.5 rounded-lg">Hide Homework</button>
                    <button onClick={e => { e.stopPropagation(); restoreStudentRecords(u, 'homework') }} className="text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-600 px-3 py-1.5 rounded-lg">Restore Homework</button>
                    <button onClick={e => { e.stopPropagation(); hardDeleteStudentRecords(u, 'homework') }} className="text-xs bg-rose-50 hover:bg-rose-100 text-rose-600 px-3 py-1.5 rounded-lg">Delete Homework</button>

                    <button onClick={e => { e.stopPropagation(); handleDelete(u.id) }} className="text-xs bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1.5 rounded-lg">Delete User</button>
                    <div className="text-gray-300">{selectedStudent === u.id ? '▲' : '▼'}</div>
                  </div>
                </div>

                {selectedStudent === u.id && (
                  <div className="border-t border-gray-100 px-5 py-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">Score history</h3>
                    {!scores[u.id] || scores[u.id].length === 0 ? (
                      <p className="text-xs text-gray-400">No visible scores yet. Hidden results can be restored with the Restore button.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {scores[u.id].map(s => (
                          <div key={s.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                            <div>
                              <p className="text-sm text-gray-700">{s.date}</p>
                              <p className="text-xs text-gray-400">L:{s.listening} R:{s.reading} W:{s.writing} S:{s.speaking}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <p className="text-lg font-bold text-purple-600">{s.overall}</p>
                              <button onClick={() => handleEditScore(s)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-1 rounded-lg">Edit</button>
                              <button onClick={() => handleDeleteScore(s.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-2 py-1 rounded-lg">Delete</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {editUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h2 className="font-semibold text-gray-800 mb-4">Edit account</h2>
            <div className="flex flex-col gap-3 mb-4">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Full name</label>
                <input className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400" value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Role</label>
                <div className="flex gap-2">
                  <button onClick={() => setEditRole('student')} className={`flex-1 py-2 rounded-full text-sm font-medium border transition-all ${editRole === 'student' ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-500'}`}>Student</button>
                  <button onClick={() => setEditRole('teacher')} className={`flex-1 py-2 rounded-full text-sm font-medium border transition-all ${editRole === 'teacher' ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-200 text-gray-500'}`}>Teacher</button>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 mb-1 block">Target Band</label>
                <input
                  type="number"
                  min="0"
                  max="9"
                  step="0.5"
                  placeholder="Example: 6.5"
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                  value={editTargetBand}
                  onChange={e => setEditTargetBand(e.target.value)}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Leave empty if no target band is set.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditUser(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500">Cancel</button>
              <button onClick={handleSaveEdit} className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-medium">Save</button>
            </div>
          </div>
        </div>
      )}

      {editScore && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h2 className="font-semibold text-gray-800 mb-4">Edit score</h2>
            <div className="grid grid-cols-2 gap-3 mb-3">
              {['listening', 'reading', 'writing', 'speaking'].map(s => (
                <div key={s}>
                  <label className="text-xs text-gray-400 capitalize mb-1 block">{s}</label>
                  <input
                    type="number"
                    min="0"
                    max="9"
                    step="0.5"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                    value={editScoreForm[s]}
                    onChange={e => setEditScoreForm(p => ({ ...p, [s]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1 block">Date</label>
              <input
                type="date"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                value={editScoreForm.date}
                onChange={e => setEditScoreForm(p => ({ ...p, date: e.target.value }))}
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditScore(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500">Cancel</button>
              <button onClick={handleSaveScore} className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-medium">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}