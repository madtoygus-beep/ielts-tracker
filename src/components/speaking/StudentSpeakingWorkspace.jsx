import { useMemo, useState } from 'react'
import { useStudentSpeakingLibrary } from '../../hooks/useStudentSpeakingLibrary'
import { studentSpeakingAssignments } from '../../services/speakingHomework'
import { speakingRecordingRows } from '../../services/speakingLibraryPresentation'
import StudentSpeakingAssignments from './StudentSpeakingAssignments'
import SpeakingSession from './SpeakingSession'
import SpeakingReport from './SpeakingReport'

export default function StudentSpeakingWorkspace({ user, api, onBack, onMock, runtime, encode, initialTaskId = '', initialReportId = '', embedded = false }) {
  const [session, setSession] = useState(initialTaskId ? { id: initialTaskId } : null)
  const [report, setReport] = useState(initialReportId || null)
  const data = useStudentSpeakingLibrary(user.uid, api, !session && !report)
  const { tab, reportSearch: search } = data.view
  const assignments = useMemo(() => studentSpeakingAssignments({ tasks: data.tasks, attempts: data.attempts }), [data.tasks, data.attempts])
  const attempts = useMemo(() => speakingRecordingRows(data.attempts, search), [data.attempts, search])
  const start = task => {
    if (task.isRetake) sessionStorage.removeItem(`speaking-active-${user.uid}-${task.id}`)
    else if (task.attemptId) sessionStorage.setItem(`speaking-active-${user.uid}-${task.id}`, task.attemptId)
    setSession(task); setReport(null)
  }
  const leave = action => {
    if (!session || window.confirm('Leave Speaking? Saved answers are retained; an active recording may be interrupted.')) action()
  }
  const openAttempt = attempt => {
    const task = assignments.find(item => item.id === attempt.taskId && item.attemptId === attempt.id)
    if (attempt.status === 'recording' && attempt.mockId) onMock(attempt.mockId)
    else if (attempt.status === 'recording' && task) start(task)
    else setReport(attempt.id)
  }
  return <div className={embedded ? 'text-slate-900' : 'min-h-screen bg-[#faf9f6] text-slate-900'}>
    {!embedded && <header className="border-b border-gray-100 bg-white px-5 py-5"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4"><div className="flex items-center gap-4"><img src="/1.png" alt="MAXIMA" className="h-9 max-w-28 object-contain"/><div><h1 className="text-xl font-semibold">Speaking</h1><p className="text-xs text-slate-500">Student workspace</p></div></div><button type="button" className="text-sm text-slate-600" onClick={() => leave(onBack)}>← Dashboard</button></div></header>}
    <main className={embedded ? '' : 'mx-auto max-w-6xl p-4 sm:p-8'}>
      {session ? <><button type="button" className="mb-5 text-sm text-indigo-700" onClick={() => leave(() => setSession(null))}>← Speaking homework</button><SpeakingSession key={session.id} taskId={session.id} title={session.title} config={session.config} mode={session.mode} api={data.api} runtime={runtime} encode={encode} onComplete={attempt => { setSession(null); setReport(attempt.id) }}/></>
        : report ? <><button type="button" className="mb-5 text-sm text-indigo-700" onClick={() => setReport(null)}>← Speaking homework</button><SpeakingReport key={report} attemptId={report} api={data.api} aiAvailable={data.aiAvailable} onRetake={attempt => start({ id: attempt.taskId, isRetake: true })}/></>
          : <>
            <nav aria-label="Student Speaking views" className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">{[['tasks', 'My Homework'], ['reports', 'My Reports']].map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? 'page' : undefined} className={`whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium ${tab === value ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`} onClick={() => data.setView({ tab: value })}>{label}</button>)}</nav>
            {tab === 'tasks' ? <StudentSpeakingAssignments data={data} onStart={start} onReport={setReport}/> : <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
              <div className="mb-4 flex items-center justify-between gap-4"><h2 className="font-semibold text-slate-900">Speaking Feedback</h2><button type="button" disabled={data.loading} className="text-xs text-indigo-700 disabled:opacity-50" onClick={data.refresh}>Refresh</button></div>
              <input aria-label="Search all Speaking reports" placeholder="Search all Speaking reports…" value={search} onChange={event => data.setView({ reportSearch: event.target.value })} className="mb-5 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-200"/>
              {data.attemptsError && <p role="alert" className="mb-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{data.attemptsError}</p>}
              {!data.attemptsLoaded && data.attemptsLoading && <p role="status" className="text-sm text-slate-500">Loading all Speaking reports…</p>}
              <div className="flex flex-col gap-3">{attempts.map(attempt => <article key={attempt.id} className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center"><div className="min-w-0"><h3 className="break-words text-sm font-medium text-gray-800">{attempt.title}</h3><p className="mt-1 text-xs text-gray-400">{attempt.mockId ? 'Mock Speaking' : 'Speaking practice'} · {new Date(attempt.startedAt).toLocaleDateString()} · {attempt.status}</p><div className="mt-2 flex flex-wrap gap-2">{attempt.review?.band != null && <span className="rounded-full bg-green-50 px-3 py-1 text-xs text-green-700">Teacher band {attempt.review.band.toFixed(1)}</span>}{attempt.report?.estimatedBand != null && <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs text-indigo-700">AI estimate {attempt.report.estimatedBand.toFixed(1)}</span>}</div></div><button type="button" aria-label={`Open Speaking report ${attempt.title}`} className="shrink-0 self-start rounded-xl bg-green-50 px-4 py-2.5 text-xs font-medium text-green-700 hover:bg-green-100 sm:self-auto" onClick={() => openAttempt(attempt)}>{attempt.status === 'recording' && (attempt.mockId || assignments.some(task => task.attemptId === attempt.id)) ? 'Continue →' : 'View feedback →'}</button></article>)}</div>
              {data.attemptsLoaded && !data.attemptsError && !attempts.length && <p className="text-sm text-slate-500">No Speaking reports match your search.</p>}
              {data.attemptsLoaded && <p role="status" className="mt-4 text-xs text-slate-400">Search covers all {data.attempts.length} Speaking reports.</p>}
            </section>}
          </>}
    </main>
  </div>
}
