import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
const listJobs = httpsCallable(functions, 'getExpiredSponsoredAiWritingJobs')
const repairJobs = httpsCallable(functions, 'reconcileExpiredSponsoredAiWriting')
export default function AiWritingRecoveryPanel({ users = [] }) {
  const [items, setItems] = useState([])
  const [selected, setSelected] = useState([])
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [more, setMore] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function refresh() {
    setBusy(true); setError('')
    try { const { data } = await listJobs({}); setItems(data.items || []); setMore(data.moreAvailable === true); setSelected([]); setLoaded(true) }
    catch { setError('The expired Writing jobs could not be loaded. Please try again.') }
    finally { setBusy(false) }
  }
  async function repair() {
    if (!selected.length || busy || !window.confirm('Close the selected expired institution-funded Writing jobs? This does not generate a new AI report, refund a provider charge or change student credits.')) return
    setBusy(true); setError(''); setMessage('')
    try { const { data } = await repairJobs({ jobIds: selected }); const repaired = data.results.filter(item => item.status === 'reconciled').length; const review = data.results.filter(item => !['reconciled','completed','failed'].includes(item.status)).length; setMessage(`${repaired} expired job(s) closed.${review ? ` ${review} job(s) need further review or are still active.` : ''}`); await refresh() }
    catch { setError('The repair could not be confirmed. Reload the list before trying again; completed repairs will not be counted twice.') }
    finally { setBusy(false) }
  }
  return <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-label="Expired AI Writing job recovery">
    <h3 className="text-lg font-semibold text-slate-900">Recover interrupted AI Writing jobs</h3>
    <p className="mt-2 text-sm text-slate-600">Close institution-funded jobs whose processing time has expired and release their pending reservation. This does not start a new evaluation or change student credits.</p>
    <button type="button" disabled={busy} onClick={refresh} className="mt-4 rounded-xl border border-slate-300 px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Please wait…' : 'Check interrupted jobs'}</button>
    {loaded && !items.length && <p role="status" className="mt-3 text-sm text-emerald-800">No expired institution-funded Writing jobs were found in this scan.</p>}
    <div className="mt-3 space-y-2">{items.map(job => <label key={job.jobId} className="flex gap-3 rounded-xl border border-slate-200 p-3 text-sm"><input type="checkbox" disabled={busy} checked={selected.includes(job.jobId)} onChange={event => setSelected(current => event.target.checked ? [...current,job.jobId] : current.filter(id => id !== job.jobId))} /><span>{users.find(user => user.id === job.studentId)?.name || 'Student'} · {job.context === 'mock' ? 'Mock Writing' : 'Writing homework'} · Attempt {job.attemptNumber}<span className="block text-xs text-slate-500">Expired {new Date(job.expiredAtMs).toLocaleString()}</span></span></label>)}</div>
    {items.length > 0 && <button type="button" disabled={busy || !selected.length} onClick={repair} className="mt-3 rounded-xl bg-indigo-700 px-4 py-2 text-sm text-white disabled:opacity-50">Close selected expired jobs ({selected.length})</button>}
    {more && <p className="mt-3 text-sm text-amber-800">More records require review. Refresh after closing this group; contact support if the scan remains incomplete.</p>}
    {message && <p role="status" className="mt-3 text-sm text-emerald-800">{message}</p>}{error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
  </section>
}
