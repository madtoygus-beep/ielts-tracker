import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

function HomeworkSection({ user }) {
  const [readings, setReadings] = useState([])
  const [submissions, setSubmissions] = useState([])
  const navigate = useNavigate()

  useEffect(() => {
    if (!user) return
    const q = query(collection(db, 'readings'))
    const unsub = onSnapshot(q, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      setReadings(all.filter(r => r.assignTo?.includes(user.uid)))
    })
    return unsub
  }, [user])

  useEffect(() => {
    if (!user) return
    const q = query(collection(db, 'readingSubmissions'), where('uid', '==', user.uid))
    const unsub = onSnapshot(q, snap => {
      setSubmissions(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [user])

  const isDone = (readingId) => submissions.some(s => s.readingId === readingId)
  const getResult = (readingId) => submissions.find(s => s.readingId === readingId)?.result

  if (readings.length === 0) return null

  return (
    <div className="mb-8">
      <h2 className="font-semibold text-gray-800 mb-4">📖 Reading Homework</h2>
      <div className="flex flex-col gap-3">
        {readings.map(r => (
          <div key={r.id} className="bg-white border border-gray-100 rounded-2xl p-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">{r.title}</p>
              <p className="text-xs text-gray-400 mt-0.5">⏱ {r.timeLimit} min · {r.questions.length} questions</p>
              {isDone(r.id) && (
                <p className="text-xs text-green-600 mt-1 font-medium">✓ Completed — Band {getResult(r.id)?.band}</p>
              )}
            </div>
            {isDone(r.id) ? (
              <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">Done</span>
            ) : (
              <button
                onClick={() => navigate(`/do-reading/${r.id}`)}
                className="bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-medium hover:bg-purple-700"
              >
                Start →
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function StudentDashboard() {
  const [scores, setScores] = useState([])
  const [user, setUser] = useState(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) { navigate('/login'); return }
      setUser(currentUser)
      const q = query(collection(db, 'scores'), where('uid', '==', currentUser.uid))
      const unsubSnap = onSnapshot(q, snap => {
        const data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        data.sort((a, b) => new Date(b.date) - new Date(a.date))
        setScores(data)
      })
      return unsubSnap
    })
    return unsubAuth
  }, [])

  const latest = scores[0]

  const skillColor = {
    listening: 'text-green-600',
    reading: 'text-purple-600',
    writing: 'text-amber-600',
    speaking: 'text-orange-500'
  }

  const handleChangePassword = async () => {
    if (newPassword.length < 6) { setPasswordMsg('Password must be at least 6 characters'); return }
    try {
      await updatePassword(auth.currentUser, newPassword)
      setPasswordMsg('Password changed successfully!')
      setNewPassword('')
    } catch (err) {
      setPasswordMsg('Error: Please log out and log back in first, then try again.')
    }
  }

  return (
    <div className="min-h-screen bg-[#faf9f6]">
      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">
        <img src="/1.png" alt="Maxima" className="h-10 object-contain" />
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-400">{user?.email}</span>
          <button onClick={() => setShowPasswordModal(true)} className="text-sm text-gray-400 hover:text-gray-600">Change Password</button>
          <button onClick={() => { signOut(auth); navigate('/') }} className="text-sm text-gray-400 hover:text-gray-600">Logout</button>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">My Dashboard</h1>
        <p className="text-gray-400 text-sm mb-8">Your IELTS results and homework</p>

        <HomeworkSection user={user} />

        {scores.length === 0 ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-12 text-center">
            <div className="text-4xl mb-4">📋</div>
            <p className="text-gray-700 font-medium mb-2">No scores yet</p>
            <p className="text-gray-400 text-sm">Your teacher will log your IELTS scores here. Check back after your next test!</p>
          </div>
        ) : (
          <>
            {latest && (
              <div className="bg-gray-900 text-white rounded-2xl p-6 mb-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Latest test</p>
                    <p className="text-gray-300 text-sm">{latest.date}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-gray-400 text-xs mb-1">Overall band</p>
                    <p className="text-4xl font-bold">{latest.overall}</p>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  {['listening','reading','writing','speaking'].map(s => (
                    <div key={s} className="bg-white/10 rounded-xl p-3 text-center">
                      <p className="text-gray-400 text-xs capitalize mb-1">{s}</p>
                      <p className="text-xl font-bold">{latest[s]}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white border border-gray-100 rounded-2xl p-6">
              <h2 className="font-semibold text-gray-800 mb-4">Score history</h2>
              <div className="flex flex-col gap-0">
                {scores.map((s, i) => (
                  <div key={s.id} className={`py-4 ${i !== scores.length - 1 ? 'border-b border-gray-50' : ''}`}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-gray-700">{s.date}</p>
                      <p className="text-xl font-bold text-purple-600">{s.overall}</p>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {['listening','reading','writing','speaking'].map(skill => (
                        <div key={skill} className="bg-gray-50 rounded-lg p-2 text-center">
                          <p className="text-xs text-gray-400 capitalize mb-0.5">{skill.slice(0,3)}</p>
                          <p className={`text-sm font-semibold ${skillColor[skill]}`}>{s[skill]}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h2 className="font-semibold text-gray-800 mb-4">Change Password</h2>
            {passwordMsg && (
              <div className={`text-sm rounded-xl p-3 mb-4 ${passwordMsg.includes('Error') ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
                {passwordMsg}
              </div>
            )}
            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1 block">New password</label>
              <input
                type="password"
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                placeholder="At least 6 characters"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setShowPasswordModal(false); setPasswordMsg(''); setNewPassword('') }} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500">Cancel</button>
              <button onClick={handleChangePassword} className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-medium">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}