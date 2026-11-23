import { useMemo, useState } from 'react'
import { studentSpeakingAssignments } from '../../services/speakingHomework'
import { speakingPracticeKind, speakingPracticeLabel } from '../../services/speakingPolicy'

export default function StudentSpeakingAssignments({ data, onStart, onReport, mode = 'all', children }) {
  const [localView, setLocalView] = useState({ assignmentSearch: '', part: 'all' })
  const view = data.view || localView, search = view.assignmentSearch, part = view.part
  const changeView = patch => data.setView ? data.setView(patch) : setLocalView(current => ({ ...current, ...patch }))
  const assignments = useMemo(() => studentSpeakingAssignments({ tasks: data.tasks, attempts: data.attempts }), [data.tasks, data.attempts])
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visible = assignments.filter(task => {
    if (part !== 'all' && speakingPracticeKind(task.config) !== part) return false
    const text = [task.title, ...(task.config?.questions || []).map(question => question.text)].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  }).sort((a, b) => (a.title || '').localeCompare(b.title || '', 'en', { numeric: true }))
  const pending = visible.filter(task => !task.done), completed = visible.filter(task => task.done)
  const renderRow = (task, index) => <article key={task.id} className={`flex flex-col justify-between gap-4 rounded-2xl border bg-white p-5 shadow-sm sm:flex-row sm:items-center ${task.done ? 'border-green-100' : 'border-red-100'}`}>
    <div className="min-w-0"><h3 className="break-words text-sm font-medium text-gray-800">{index + 1}. {task.title}</h3>
      <p className="mt-1 text-xs text-gray-400">{speakingPracticeLabel(task.config)} · {task.config?.questions?.length || 0} questions</p>
      <div className="mt-2 flex flex-wrap gap-2"><span className={`rounded-full px-3 py-1 text-xs ${task.done ? 'bg-green-50 text-green-700' : task.isRetake ? 'bg-amber-50 text-amber-700' : task.attemptId ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-500'}`}>{task.done ? 'Completed' : task.isRetake ? `Attempt ${task.retakeState.nextAttemptNumber} reopened` : task.attemptId ? 'In progress' : 'Not completed'}</span>
        {task.attempt?.review?.band != null && <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">Teacher band {task.attempt.review.band.toFixed(1)}</span>}
        {task.attempt?.report?.estimatedBand != null && <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs text-indigo-700">AI estimate {task.attempt.report.estimatedBand.toFixed(1)}</span>}
      </div>
    </div>
    {task.done ? <button type="button" disabled={!task.reportId} aria-label={`View feedback ${task.title}`} onClick={() => onReport(task.reportId)} className="shrink-0 self-start rounded-xl bg-green-50 px-4 py-2.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50 sm:self-auto">View feedback →</button>
      : <button type="button" aria-label={`${task.isRetake ? 'Start retake' : task.attemptId ? 'Continue' : 'Start'} ${task.title}`} onClick={() => onStart(task)} className="shrink-0 self-start rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-medium text-white hover:bg-purple-700 sm:self-auto">{task.isRetake ? 'Start retake →' : task.attemptId ? 'Continue →' : 'Start →'}</button>}
  </article>
  return <section className="mb-8 mt-8" aria-label="Speaking assignments">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-gray-800">🎙️ {mode === 'completed' ? 'Speaking Feedback' : 'Speaking Homework'}</h2><p className="mt-1 text-xs text-gray-400">{data.completed} / {data.total} completed</p></div><div className="flex flex-wrap items-center gap-3">{children}<button type="button" disabled={data.tasksLoading || data.attemptsLoading} onClick={data.refresh} className="text-xs text-indigo-700 disabled:opacity-50">Refresh</button></div></div>
    <div className="mb-5 flex flex-wrap gap-3"><input aria-label="Search all Speaking assignments" value={search} onChange={event => changeView({ assignmentSearch: event.target.value })} placeholder="Search all Speaking assignments…" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-200"/><select aria-label="Student Speaking part filter" value={part} onChange={event => changeView({ part: event.target.value })} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600"><option value="all">All Speaking Parts</option><option value="part1">Part 1 only</option><option value="part2">Part 2 only</option><option value="part3">Part 3 only</option><option value="mixed">Mixed parts</option></select></div>
    {data.tasksError && <p role="alert" className="mb-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{data.tasksError} Your last loaded assignments are still shown.</p>}
    {data.tasksLoading && <p role="status" className="mb-4 text-sm text-slate-500">{data.tasksLoaded ? 'Refreshing Speaking assignments…' : 'Loading all Speaking assignments…'}</p>}
    {data.tasksLoaded && <>
      {mode !== 'completed' && pending.length > 0 && <div className="mb-6"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-red-500">To Do · {pending.length}</h3><div className="flex flex-col gap-3">{pending.map(renderRow)}</div></div>}
      {completed.length > 0 && <div><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-green-600">Completed · {completed.length}</h3><div className="flex flex-col gap-3">{completed.map(renderRow)}</div></div>}
      {!completed.length && (mode === 'completed' || !pending.length) && <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">{search || part !== 'all' ? 'No Speaking assignments match your search and filters.' : mode === 'completed' ? 'No completed Speaking work yet.' : 'No Speaking assignments right now.'}</p>}
      <p role="status" className="mt-4 text-xs text-slate-400">Search covers all {assignments.length} assigned Speaking sets.</p>
    </>}
  </section>
}
