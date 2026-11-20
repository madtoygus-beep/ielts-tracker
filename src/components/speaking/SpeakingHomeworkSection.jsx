import { useNavigate } from 'react-router-dom'
import { useSpeakingHomework } from '../../hooks/useSpeakingHomework'
import { openSpeakingHomework } from '../../services/speakingHomework'

export default function SpeakingHomeworkSection({ user, api, onOpen }) {
  const navigate = useNavigate()
  const { pending, total, completed, loading, error } = useSpeakingHomework(user?.uid, api)
  return <section className="rounded-2xl border border-slate-200 bg-white p-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold text-slate-900">Speaking Homework</h2>
        <p className="mt-1 text-sm text-slate-500">Your teacher’s assigned practice sets. {completed} / {total} completed.</p></div>
      <button type="button" onClick={() => navigate('/speaking')} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm text-indigo-700">Speaking library &amp; feedback →</button>
    </div>
    {loading && <p role="status" className="text-sm text-slate-500">Loading Speaking homework…</p>}
    {error && <p role="alert" className="mb-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{error}</p>}
    {!loading && !error && !pending.length && <p className="rounded-xl bg-green-50 p-4 text-sm text-green-800">No remaining Speaking homework right now.</p>}
    <div className="flex flex-col gap-3">{pending.map(item => <article key={item.id} className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center">
      <div><span className="text-xs font-medium text-indigo-700">🎙️ Speaking</span><h3 className="mt-1 font-semibold text-slate-900">{item.title}</h3><p className="mt-1 text-xs text-slate-500">{item.isRetake ? 'Retake allowed by your teacher' : item.attemptId ? 'Practice in progress' : 'Not completed yet'}</p></div>
      <button type="button" onClick={() => onOpen ? onOpen(item) : openSpeakingHomework(item, user.uid, navigate)} className="self-start rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white sm:self-auto">{item.isRetake ? 'Start retake →' : item.attemptId ? 'Continue →' : 'Start →'}</button>
    </article>)}</div>
  </section>
}
