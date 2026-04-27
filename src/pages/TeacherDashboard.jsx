import { useState, useEffect } from 'react'
import { auth, db } from '../firebase'
import { collection, addDoc, query, where, onSnapshot } from 'firebase/firestore'
import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'

export default function TeacherDashboard() {
  const [students, setStudents] = useState([])
  const [scores, setScores] = useState({})
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState({ listening: '', reading: '', writing: '', speaking: '', date: '' })
  const [user, setUser] = useState(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) { navigate('/login'); return }
      setUser(currentUser)
      const q = query(collection(db, 'users'), where('role', '==', 'student'))
      onSnapshot(q, snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        setStudents(list)
        list.forEach(student => {
          const sq = query(collection(db, 'scores'), where('uid', '==', student.id))
          onSnapshot(sq, ssnap => {
            const data = ssnap.docs.map(d => ({ id: d.id, ...d.data() }))
            data.sort((a, b) => new Date(b.date) - new Date(a.date))
            setScores(prev => ({ ...prev, [student.id]: data }))
          })
        })
      })
    })
    return unsub
  }, [])

  const overall = (s) => {
    const avg = (+s.listening + +s.reading + +s.writing + +s.speaking) / 4
    return (Math.round(avg * 2) / 2).toFixed(1)
  }

  const handleAddScore = async () => {
    if (!form.listening || !form.reading || !form.writing || !form.speaking || !form.date) return
    await addDoc(collection(db, 'scores'), {
      ...form,
      uid: selected.id,
      overall: overall(form),
      addedBy: user.uid
    })
    setForm({ listening: '', reading: '', writing: '', speaking: '', date: '' })
  }

  const latestScore = (studentId) => scores[studentId]?.[0]

  const handlePrint = (student) => {
    const studentScores = scores[student.id] || []
    const printWindow = window.open('', '_blank')
    printWindow.document.write(`
      <html>
        <head>
          <title>${student.name} - IELTS Scores</title>
          <style>
            body { font-family: sans-serif; padding: 40px; color: #111; }
            h1 { font-size: 24px; margin-bottom: 4px; }
            p { color: #666; font-size: 14px; margin-bottom: 30px; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #7c3aed; color: white; padding: 10px 14px; text-align: left; font-size: 13px; }
            td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #eee; }
            .overall { font-weight: bold; color: #7c3aed; }
            img { height: 50px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <img src="${window.location.origin}/1.png" />
          <h1>${student.name}</h1>
          <p>${student.email} — IELTS Score Report</p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Listening</th>
                <th>Reading</th>
                <th>Writing</th>
                <th>Speaking</th>
                <th>Overall</th>
              </tr>
            </thead>
            <tbody>
              ${studentScores.map(s => `
                <tr>
                  <td>${s.date}</td>
                  <td>${s.listening}</td>
                  <td>${s.reading}</td>
                  <td>${s.writing}</td>
                  <td>${s.speaking}</td>
                  <td class="overall">${s.overall}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </body>
      </html>
    `)
    printWindow.document.close()
    printWindow.print()
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

      <div className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Teacher Dashboard</h1>
        <p className="text-gray-400 text-sm mb-4">Manage your students and log their scores</p>

        <div className="flex gap-3 mb-8">
          <button onClick={() => navigate('/create-reading')} className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-700">📖 Create Reading Homework</button>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {students.length === 0 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">
              No students signed up yet.
            </div>
          )}

          {students.map(student => (
            <div key={student.id} className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between p-5 cursor-pointer hover:bg-gray-50"
                onClick={() => setSelected(selected?.id === student.id ? null : student)}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-semibold text-sm">
                    {student.name?.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-800">{student.name}</p>
                    <p className="text-xs text-gray-400">{student.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {latestScore(student.id) && (
                    <div className="text-right">
                      <p className="text-xs text-gray-400">Latest band</p>
                      <p className="text-lg font-bold text-purple-600">{latestScore(student.id).overall}</p>
                    </div>
                  )}
                  <div className="text-gray-300 text-lg">{selected?.id === student.id ? '▲' : '▼'}</div>
                </div>
              </div>

              {selected?.id === student.id && (
                <div className="border-t border-gray-100 p-5">
                  <div className="mb-5">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">Log a new score for {student.name}</h3>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      {['listening','reading','writing','speaking'].map(s => (
                        <div key={s}>
                          <label className="text-xs text-gray-400 capitalize mb-1 block">{s}</label>
                          <input
                            type="number" min="0" max="9" step="0.5"
                            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                            placeholder="e.g. 7.5"
                            value={form[s]}
                            onChange={e => setForm(p => ({ ...p, [s]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mb-3">
                      <label className="text-xs text-gray-400 mb-1 block">Test date</label>
                      <input
                        type="date"
                        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                        value={form.date}
                        onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                      />
                    </div>
                    <button
                      onClick={handleAddScore}
                      className="w-full bg-purple-600 text-white rounded-xl py-2.5 text-sm font-medium hover:bg-purple-700"
                    >
                      Save score for {student.name}
                    </button>
                  </div>

                  {scores[student.id]?.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-gray-700">Score history</h3>
                        <button onClick={() => handlePrint(student)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg">🖨️ Print scores</button>
                      </div>
                      <div className="flex flex-col gap-2">
                        {scores[student.id].map(s => (
                          <div key={s.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                            <div>
                              <p className="text-sm text-gray-700">{s.date}</p>
                              <p className="text-xs text-gray-400">L:{s.listening} R:{s.reading} W:{s.writing} S:{s.speaking}</p>
                            </div>
                            <div className="text-lg font-bold text-purple-600">{s.overall}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
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