import { speakingAnalytics } from '../../services/speakingAnalytics'
const displayBand = value => value == null ? '—' : value.toFixed(1)
export default function SpeakingAnalytics({ data, staff = false, studentId = '', allowedStudentIds = [], onOpen }) {
  const summary = speakingAnalytics(data, { staff, studentId, allowedStudentIds })
  return <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-label="Speaking analytics">
    <h2 className="text-lg font-semibold text-slate-900">Speaking Progress</h2>
    <p className="mt-2 text-xs leading-5 text-slate-500">Teacher bands and unofficial AI practice estimates are shown separately. Averages use the latest submitted attempt per assignment and do not change your IELTS Overall.</p>
    {data.loading ? <p role="status" className="mt-4 text-sm text-slate-500">Loading Speaking analytics…</p> : data.error ? <p role="alert" className="mt-4 text-sm text-amber-800">{data.error}</p> : <>
      <div className="my-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">Speaking homework completed</p><p className="mt-2 text-2xl font-bold text-indigo-800">{summary.completed} / {summary.assigned}</p></div>
        <div className="rounded-xl bg-emerald-50 p-4"><p className="text-xs text-slate-500">Teacher band average · {summary.teacherCount} graded</p><p className="mt-2 text-2xl font-bold text-emerald-800">{displayBand(summary.teacherAverage)}</p></div>
        <div className="rounded-xl bg-indigo-50 p-4"><p className="text-xs text-slate-500">AI estimate average · {summary.aiCount} assessed</p><p className="mt-2 text-2xl font-bold text-indigo-800">{displayBand(summary.aiAverage)}</p></div>
      </div>
      {!summary.history.length ? <p className="text-sm text-slate-500">No submitted Speaking attempts yet.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-3 text-left font-semibold text-slate-700">Recent Speaking results</caption><thead><tr className="border-b text-xs text-slate-500"><th className="p-2">Assignment</th><th className="p-2">Date</th><th className="p-2">Teacher</th><th className="p-2">AI estimate</th><th className="p-2">Feedback</th></tr></thead><tbody>{summary.history.slice(0,10).map(attempt => <tr key={attempt.id} className="border-b border-slate-100"><td className="p-2"><span className="block font-medium">{attempt.title}</span><span className="text-xs text-slate-500">{staff ? `${attempt.studentName || 'Student'} · ` : ''}{attempt.mockId ? 'Mock Speaking' : 'Speaking practice'}</span></td><td className="whitespace-nowrap p-2">{new Date(attempt.startedAt).toLocaleDateString()}</td><td className="p-2">{displayBand(attempt.review?.band)}</td><td className="p-2">{displayBand(attempt.report?.estimatedBand)}</td><td className="p-2"><button type="button" onClick={() => onOpen(attempt)} className="whitespace-nowrap rounded-lg px-3 py-2 text-indigo-700 hover:bg-indigo-50">View feedback</button></td></tr>)}</tbody></table></div>}
    </>}
  </section>
}
