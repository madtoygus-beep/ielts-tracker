import { useEffect, useMemo, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import {
  PILOT_SCHOOL_ID,
  eligiblePilotStudents,
  nextPendingOperation,
  parseCreditDelta,
  preparePilotChange
} from '../services/aiWritingPilotPolicy'

const getStudentAccessCall = httpsCallable(functions, 'getAdminAiWritingStudentAccess')
const setSchoolPilotCall = httpsCallable(functions, 'setAiWritingSchoolPilot')
const setStudentAccessCall = httpsCallable(functions, 'setAiWritingStudentAccess')

function explainError(error) {
  const message = String(error?.message || 'The request could not be completed.')
  return message.length > 320 ? `${message.slice(0, 320)}...` : message
}

function newRequestId() {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('A secure browser connection is required to change AI credits.')
  }
  return `aiw_${crypto.randomUUID()}`
}

export default function AiWritingPilotPanel({ users, adminSchoolId, schoolActive }) {
  const [search, setSearch] = useState('')
  const [studentId, setStudentId] = useState('')
  const [access, setAccess] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [desiredEnabled, setDesiredEnabled] = useState(false)
  const [creditDelta, setCreditDelta] = useState('0')
  const [reloadKey, setReloadKey] = useState(0)
  const pendingOperationRef = useRef(null)
  const students = useMemo(() => eligiblePilotStudents(users), [users])
  const student = students.find(item => item.id === studentId) || null
  const inPilotSchool = adminSchoolId === PILOT_SCHOOL_ID
  const canManage = inPilotSchool && schoolActive === true
  const visibleStudents = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    if (!term) return students
    return students.filter(item =>
      `${item.name || ''} ${item.email || ''} ${item.username || ''}`.toLocaleLowerCase().includes(term))
  }, [students, search])

  useEffect(() => {
    if (!studentId || !students.some(item => item.id === studentId)) {
      setStudentId('')
      setAccess(null)
      return
    }
    if (!canManage) return
    let active = true
    setLoading(true)
    setAccess(null)
    setError('')
    getStudentAccessCall({ studentId }).then(({ data }) => {
      if (!active) return
      if (!data || data.studentId !== studentId || data.schoolId !== PILOT_SCHOOL_ID) {
        throw new Error('The server returned an unexpected institution or student.')
      }
      setAccess(data)
      setDesiredEnabled(data.studentEnabled === true)
      setCreditDelta('0')
    }).catch(err => {
      if (active) setError(explainError(err))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [studentId, reloadKey, canManage, students])

  const pickStudent = id => {
    if (saving) return
    setStudentId(id)
    setAccess(null)
    setNotice('')
    setError('')
    setCreditDelta('0')
    pendingOperationRef.current = null
  }

  const refresh = () => {
    if (loading || saving || !studentId) return
    setNotice('')
    setError('')
    setReloadKey(current => current + 1)
  }

  const toggleSchool = async () => {
    if (!canManage || saving || loading || !access) return
    const target = access.pilotEnabled !== true
    const accepted = window.confirm(target
      ? 'Enable the Maxima AI Writing pilot? Only individually authorised students with credits will have access.'
      : 'Disable the Maxima AI Writing pilot for all students? Their remaining credits will be preserved.')
    if (!accepted) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const { data } = await setSchoolPilotCall({ enabled: target })
      if (!data?.ok || data.schoolId !== PILOT_SCHOOL_ID || data.pilotEnabled !== target) {
        throw new Error('The server did not confirm the pilot change.')
      }
      setNotice(`School pilot ${target ? 'enabled' : 'disabled'}. Student credits were not modified.`)
      setReloadKey(current => current + 1)
    } catch (err) {
      setError(`School pilot update: ${explainError(err)} Refresh status before attempting again.`)
    } finally {
      setSaving(false)
    }
  }

  const updateStudent = async () => {
    if (!canManage || !access || !student || saving || loading) return
    let payload
    try {
      const delta = parseCreditDelta(creditDelta)
      // Signature is scoped to the student and exact desired change.
      const signature = `${studentId}:${access.studentEnabled}:${access.creditsRemaining}:${desiredEnabled}:${delta}`
      const pending = nextPendingOperation(pendingOperationRef.current, signature, newRequestId)
      payload = preparePilotChange({
        studentId, creditsRemaining: access.creditsRemaining,
        previousEnabled: access.studentEnabled === true,
        enabled: desiredEnabled, delta: creditDelta, requestId: pending.requestId
      })
      pendingOperationRef.current = pending
    } catch (err) {
      setError(explainError(err))
      return
    }
    const description = `${desiredEnabled ? 'Enable' : 'Disable'} AI for ${student.name || student.email || student.id}, ` +
      `${payload.creditDelta >= 0 ? '+' : ''}${payload.creditDelta} credits? ` +
      `The server will record this change permanently.`
    if (!window.confirm(description)) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const { data } = await setStudentAccessCall(payload)
      if (!data?.ok || data.studentId !== studentId || data.schoolId !== PILOT_SCHOOL_ID) {
        throw new Error('The server did not confirm the student change.')
      }
      pendingOperationRef.current = null
      setNotice(data.alreadyApplied
        ? 'This exact change was already recorded. No duplicate credits were added.'
        : 'Student permission and credit balance updated.')
      setReloadKey(current => current + 1)
    } catch (err) {
      setError(`${explainError(err)} If the connection failed, reload the status before retrying. An unchanged retry uses the same request ID.`)
    } finally {
      setSaving(false)
    }
  }

  const pendingChange = access && (
    desiredEnabled !== (access.studentEnabled === true) || creditDelta !== '0'
  )
  const balanceAfterChange = access && parseCreditDelta(creditDelta) !== null
    ? access.creditsRemaining + Number(creditDelta) : null

  return (
    <div className="space-y-5" aria-label="AI Writing pilot administration">
      <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 px-5 py-4 text-sm text-indigo-900">
        <p className="font-semibold">Maxima institution pilot · Initially disabled</p>
        <p className="mt-1 text-indigo-800">Only approved institution students can be selected. Changing a school or student permission does not run GPT or spend an API credit. Activate the pilot only when the AI evaluation service and student experience have passed testing.</p>
      </div>
      {!inPilotSchool && (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">This pilot can only be managed by a Maxima institution administrator.</p>
      )}
      {inPilotSchool && !schoolActive && (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">The Maxima institution is not active. AI permissions cannot be changed.</p>
      )}
      {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p>}
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.15fr)]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold">Eligible institution students</h2>
          <p className="mt-1 text-xs text-slate-500">Choose one of your 5–6 pilot testers. Other-school and individual accounts are excluded.</p>
          <label className="mt-4 block text-xs font-semibold text-slate-600" htmlFor="ai-pilot-student-search">Search students</label>
          <input id="ai-pilot-student-search" type="search" value={search} onChange={event => setSearch(event.target.value)}
            disabled={!canManage || saving} placeholder="Name, email or username"
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-indigo-500" />
          <div className="mt-3 max-h-[420px] space-y-1 overflow-y-auto" role="list" aria-label="Eligible student accounts">
            {visibleStudents.map(item => (
              <button key={item.id} type="button" role="listitem" onClick={() => pickStudent(item.id)}
                disabled={!canManage || saving}
                aria-pressed={studentId === item.id}
                className={`block w-full rounded-xl border px-3 py-3 text-left text-sm disabled:opacity-50 ${studentId === item.id ? 'border-indigo-300 bg-indigo-50 text-indigo-900' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                <span className="block truncate font-semibold">{item.name || item.username || item.id}</span>
                <span className="mt-0.5 block truncate text-xs text-slate-500">{item.email || item.username || 'Approved student'}</span>
              </button>
            ))}
            {visibleStudents.length === 0 && <p className="p-3 text-sm text-slate-500">No eligible approved students found.</p>}
          </div>
        </section>
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">AI access and credits</h2>
              <p className="mt-1 text-sm text-slate-500">{student ? (student.name || student.email || student.id) : 'Select a student to inspect permissions'}</p>
            </div>
            <button type="button" onClick={refresh} disabled={!canManage || !student || loading || saving}
              className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40">{loading ? 'Loading...' : 'Reload status'}</button>
          </div>
          {loading && <p role="status" className="mt-6 text-sm text-slate-500">Checking Firebase permissions...</p>}
          {!loading && student && access && (
            <div className="mt-5 space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">School pilot</p><p className="mt-1 font-semibold">{access.pilotEnabled ? 'On' : 'Off'}</p></div>
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Student access</p><p className="mt-1 font-semibold">{access.studentEnabled ? 'Enabled' : 'Disabled'}</p></div>
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Credits remaining</p><p className="mt-1 text-2xl font-semibold tabular-nums">{access.creditsRemaining}</p></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm text-amber-900"><span className="font-semibold">School-wide master switch:</span> {access.pilotEnabled ? 'Enabled' : 'Disabled'}. All student permissions stop working while disabled.</p>
                <button type="button" disabled={!canManage || saving} onClick={toggleSchool}
                  className="rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-900 disabled:opacity-40">
                  {access.pilotEnabled ? 'Disable school pilot' : 'Enable school pilot'}
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm font-medium">
                  <input type="checkbox" checked={desiredEnabled} onChange={event => setDesiredEnabled(event.target.checked)} disabled={saving || !canManage}
                    className="h-4 w-4 accent-indigo-600" /> Enable this student
                </label>
                <label className="block text-sm font-medium" htmlFor="ai-pilot-credit-delta">
                  Add / remove credits
                  <input id="ai-pilot-credit-delta" type="number" step="1" min="-100" max="100"
                    value={creditDelta} onChange={event => setCreditDelta(event.target.value)} disabled={saving || !canManage}
                    className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
                </label>
              </div>
              <p className="text-xs text-slate-600">New balance if saved: <strong>{balanceAfterChange === null ? 'invalid amount' : balanceAfterChange}</strong>. Initial pilot recommendation: 5 credits per selected student. Negative adjustment removes unused credits.</p>
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => { setDesiredEnabled(true); setCreditDelta('5') }} disabled={saving || !canManage}
                  className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-semibold text-indigo-700 disabled:opacity-40">Prepare 5-credit pilot grant</button>
                <button type="button" onClick={updateStudent} disabled={saving || !canManage || !pendingChange}
                  className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{saving ? 'Saving...' : 'Review and save change'}</button>
              </div>
              <p className="text-xs text-slate-500">A confirmation appears before each write. Reload after a network error before retrying; identical retries reuse the same operation ID. No API calls are initiated from this panel.</p>
            </div>
          )}
          {!loading && (!student || !access) && <p className="mt-6 text-sm text-slate-500">{student ? 'Permission details could not be loaded. Use Reload status.' : 'Choose an institution student from the list.'}</p>}
        </section>
      </div>
    </div>
  )
}
