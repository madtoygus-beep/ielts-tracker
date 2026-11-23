import { useMemo, useRef, useState } from 'react'
import { useTeacherSpeakingHomework } from '../../hooks/useTeacherSpeakingHomework'
import { useEscapeDismiss } from '../../hooks/useEscapeDismiss'
import { defaultSpeakingConfig, speakingPracticeLabel, validateSpeakingConfig } from '../../services/speakingPolicy'
import { speakingLibraryRows, speakingRecordingRows } from '../../services/speakingLibraryPresentation'
import SpeakingEditor from './SpeakingEditor'
import SpeakingReport from './SpeakingReport'
import SpeakingTestPreview from './SpeakingTestPreview'

const buttonClass = 'shrink-0 rounded-xl px-4 py-2.5 text-xs font-medium disabled:opacity-50'
const selectClass = 'border border-gray-200 rounded-xl px-3 py-2 text-xs bg-white text-gray-600 outline-none focus:border-purple-400'

export default function TeacherSpeakingLibrary({
  user, students = [], classes = [], api, onBack, embedded = false,
  library: sharedLibrary, search, onSearchChange, viewState, onViewChange, initialReportId = ''
}) {
  const [report, setReport] = useState(initialReportId || null)
  const ownLibrary = useTeacherSpeakingHomework(user.uid, api, !sharedLibrary && !report)
  const library = sharedLibrary || ownLibrary
  const [localSearch, setLocalSearch] = useState('')
  const [localView, setLocalView] = useState({ tab: 'tasks', status: 'active', part: 'all', mode: 'all' })
  const { tab, status, part, mode } = viewState || localView
  const changeView = patch => (onViewChange || setLocalView)(current => ({ ...current, ...patch }))
  const [editor, setEditor] = useState(null), [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const actionLock = useRef(false)
  const query = search ?? localSearch, changeSearch = onSearchChange || setLocalSearch
  const tasks = useMemo(() => speakingLibraryRows(library.tasks, { search: query, status, part, mode }), [library.tasks, query, status, part, mode])
  const recordings = useMemo(() => speakingRecordingRows(library.attempts, query), [library.attempts, query])
  const activeCount = library.tasks.filter(task => !task.archived).length
  const loading = tab === 'tasks' ? library.tasksLoading : library.attemptsLoading
  const listError = tab === 'tasks' ? library.tasksError : library.attemptsError
  const loaded = tab === 'tasks' ? library.tasksLoaded : library.attemptsLoaded
  const count = tab === 'tasks' ? library.tasks.length : library.attempts.length
  const shownCount = tab === 'tasks' ? tasks.length : recordings.length
  const hiddenAssignments = editor?.assignedTo.filter(id => !students.some(student => student.id === id)).length || 0

  useEscapeDismiss(() => {
    if (!preview && !editor) return false
    if (!actionLock.current) { setPreview(null); setEditor(null) }
    return true
  }, 20)

  const action = async fn => {
    if (actionLock.current) return
    actionLock.current = true; setBusy(true); setError('')
    try { await fn() } catch (problem) { setError(problem.message || 'Speaking could not be saved.') }
    finally { actionLock.current = false; setBusy(false) }
  }
  const openEditor = (task, intent = 'edit') => {
    setError('')
    setEditor(task
      ? { ...task, assignedTo: [...(task.assignedTo || [])], expectedUpdatedAt: task.updatedAt, intent }
      : { title: '', mode: 'practice', config: { ...defaultSpeakingConfig(), enabled: true }, assignedTo: [], intent })
  }
  const save = () => action(async () => {
    const problem = validateSpeakingConfig(editor.config, editor.mode === 'mock')
    if (problem) throw Error(problem)
    const { intent, ...draft } = editor
    const saved = await api('saveTask', draft)
    if (saved.task) library.upsertTask(saved.task)
    else await library.refresh('tasks')
    setEditor(null)
    if (intent !== 'assign') { changeView({ status: 'active', part: 'all', mode: 'all' }); changeSearch('') }
  })
  const archive = task => action(async () => {
    if (!window.confirm(task.archived ? 'Restore access to this Speaking set?' : 'Archive this set? Students lose access; saved recordings remain available to staff.')) return
    await api('archiveTask', { taskId: task.id, archived: !task.archived, expectedUpdatedAt: task.updatedAt })
    library.upsertTask({ ...task, archived: !task.archived })
    // Archive returns no updatedAt. Explicitly reload after this write to obtain the next edit version.
    await library.refresh('tasks')
  })
  const toggleStudent = (id, checked) => setEditor(draft => ({
    ...draft, assignedTo: checked ? [...new Set([...draft.assignedTo, id])] : draft.assignedTo.filter(value => value !== id)
  }))

  return <div className={embedded ? 'text-slate-900' : 'min-h-screen bg-[#faf9f6] text-slate-900'}>
    {!embedded && <header className="border-b border-gray-100 bg-white px-5 py-5"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
      <div className="flex items-center gap-4"><img src="/1.png" alt="MAXIMA" className="h-9 max-w-28 object-contain"/><div><h1 className="text-xl font-semibold">Speaking</h1><p className="text-xs text-slate-500">Teacher workspace</p></div></div>
      <button type="button" className="text-sm text-slate-600" onClick={onBack}>← Workspace</button>
    </div></header>}
    <main className={embedded ? '' : 'mx-auto max-w-6xl p-4 sm:p-8'}>
      {error && <p role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
      {preview ? <>
        <button type="button" className="mb-5 text-sm text-indigo-700" onClick={() => setPreview(null)}>← Speaking library</button>
        <SpeakingTestPreview key={preview.id} title={preview.title} config={preview.config} mode={preview.mode || 'practice'}/>
      </> : report ? <>
        <button type="button" className="mb-5 text-sm text-indigo-700" onClick={() => setReport(null)}>← Speaking library</button>
        <SpeakingReport key={report} attemptId={report} staff api={api} aiAvailable={library.aiAvailable}/>
      </> : editor ? <section className="mb-8 rounded-2xl border border-gray-100 bg-white p-6">
        <h2 className="font-semibold text-gray-800">{editor.intent === 'assign' ? 'Assign Speaking' : editor.id ? 'Edit Speaking' : 'Create Speaking'}</h2>
        {editor.intent === 'assign' ? <p className="mt-2 text-sm text-slate-600">{editor.title}</p> : <>
          <label className="mt-5 block text-sm">Title<input aria-label="Speaking title" maxLength={180} className="mt-2 block w-full rounded-xl border border-gray-200 p-3" value={editor.title} onChange={event => setEditor(draft => ({ ...draft, title: event.target.value }))}/></label>
          <label className="mt-5 block text-sm">Session type<select aria-label="Speaking session type" className="mt-2 block w-full rounded-xl border border-gray-200 bg-white p-3" value={editor.mode || 'practice'} onChange={event => setEditor(draft => ({ ...draft, mode: event.target.value }))}><option value="practice">Practice · student controls recording</option><option value="mock">Full Speaking Mock · automatic progression</option></select></label>
          <SpeakingEditor full={editor.mode === 'mock'} value={editor.config} onChange={config => setEditor(draft => ({ ...draft, config }))}/>
        </>}
        <h3 className="mt-5 font-semibold">Assign students (optional)</h3>
        <p className="mt-1 text-sm text-slate-500">Save to your library first, or assign to your current students.</p>
        {hiddenAssignments > 0 && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{hiddenAssignments} previous assignment(s) are outside your current roster and will be preserved.</p>}
        <div className="mt-4 flex flex-wrap gap-2">{classes.map(group => {
          const members = students.filter(student => (group.studentIds || []).includes(student.id)).map(student => student.id)
          const all = members.length > 0 && members.every(id => editor.assignedTo.includes(id))
          return <button key={group.id} type="button" disabled={busy || !members.length} className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-indigo-700 disabled:opacity-50" onClick={() => setEditor(draft => ({ ...draft, assignedTo: all ? draft.assignedTo.filter(id => !members.includes(id)) : [...new Set([...draft.assignedTo, ...members])] }))}>{all ? 'Remove' : 'Add'} class: {group.name} ({members.length})</button>
        })}</div>
        <div className="mt-4 grid max-h-64 gap-2 overflow-auto sm:grid-cols-2">{students.map(student => <label key={student.id} className="flex items-center gap-2 rounded-xl border border-gray-200 p-3 text-sm"><input type="checkbox" disabled={busy} checked={editor.assignedTo.includes(student.id)} onChange={event => toggleStudent(student.id, event.target.checked)}/>{student.name || student.displayName || student.email}</label>)}</div>
        {!students.length && <p className="mt-3 text-sm text-slate-500">No current students available. You can still save the set without assignments.</p>}
        <div className="mt-6 flex gap-3"><button type="button" disabled={busy || !editor.title.trim()} className={`${buttonClass} bg-indigo-600 text-white hover:bg-indigo-700`} onClick={save}>{busy ? 'Saving…' : editor.intent === 'assign' ? 'Save assignments' : 'Save Speaking'}</button><button type="button" disabled={busy} className={`${buttonClass} border border-gray-200 text-slate-600`} onClick={() => setEditor(null)}>Cancel</button></div>
      </section> : <section className="mb-8 rounded-2xl border border-gray-100 bg-white p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div><h2 className="font-semibold text-gray-800">Speaking Library</h2><p className="mt-1 text-xs text-gray-400">Preview questions, manage assignments and review student recordings.</p></div>
          <button type="button" className={`${buttonClass} bg-indigo-600 text-white hover:bg-indigo-700`} onClick={() => openEditor(null)}>+ Create Speaking</button>
        </div>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <nav aria-label="Speaking library views" className="inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
            {[['tasks', 'Question library'], ['attempts', 'Student recordings']].map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? 'page' : undefined} className={`rounded-lg px-3 py-2 text-xs font-medium ${tab === value ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`} onClick={() => { changeView({ tab: value }); changeSearch('') }}>{label}</button>)}
          </nav>
          <button type="button" disabled={loading} className="ml-auto px-3 py-2 text-xs text-indigo-700 disabled:opacity-50" onClick={() => library.refresh(tab)}>Refresh</button>
        </div>
        {!embedded && <input aria-label="Search Speaking" placeholder="Search all Speaking sets and questions…" value={query} onChange={event => changeSearch(event.target.value)} className="mb-5 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200"/>}
        {tab === 'tasks' && <>
          <nav aria-label="Speaking archive filter" className="mb-4 flex flex-wrap gap-2">
            {[['active', `Active (${activeCount})`], ['archived', `Archived (${library.tasks.length - activeCount})`], ['all', `All (${library.tasks.length})`]].map(([value, label]) => <button key={value} type="button" aria-pressed={status === value} className={`rounded-full px-3 py-1.5 text-xs ${status === value ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`} onClick={() => changeView({ status: value })}>{label}</button>)}
          </nav>
          <div className="mb-4 flex flex-wrap gap-3">
            <select aria-label="Speaking part filter" value={part} onChange={event => changeView({ part: event.target.value })} className={selectClass}><option value="all">All Speaking Parts</option><option value="part1">Part 1 only</option><option value="part2">Part 2 only</option><option value="part3">Part 3 only</option><option value="mixed">Mixed parts</option></select>
            <select aria-label="Speaking session filter" value={mode} onChange={event => changeView({ mode: event.target.value })} className={selectClass}><option value="all">All Speaking Types</option><option value="practice">Practice</option><option value="mock">Full Speaking Mock</option></select>
          </div>
        </>}
        {listError && <p role="alert" className="mb-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{listError}</p>}
        <p role="status" className="mb-4 text-xs text-slate-500">{loading ? `Loading all ${tab === 'tasks' ? 'Speaking sets' : 'student recordings'}… ${count} loaded.` : loaded && !listError ? `Showing ${shownCount} of ${count} ${tab === 'tasks' ? 'Speaking sets' : 'student recordings'}. Search covers all records.` : 'Refresh to load Speaking.'}</p>
        {tab === 'tasks' ? <div className="flex flex-col gap-3">{tasks.map((task, index) => <article key={task.id} className="flex flex-col justify-between gap-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm xl:flex-row xl:items-center">
          <div className="min-w-0"><h3 className="break-words text-sm font-semibold text-gray-900">{index + 1}. {task.title}</h3>
            <div className="mt-2 flex flex-wrap gap-2"><span className="rounded-md bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700">{task.mode === 'mock' ? 'Full Speaking Mock' : speakingPracticeLabel(task.config)}</span><span className="rounded-md bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">My Library</span>{task.archived && <span className="rounded-md bg-gray-100 px-2.5 py-1 text-[11px] text-gray-500">Archived</span>}</div>
            <p className="mt-3 text-xs text-gray-500">Assigned to {task.assignedTo?.length || 0} students · {task.config?.questions?.length || 0} questions · Part {[...new Set((task.config?.questions || []).map(question => question.part))].join(', ')}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button type="button" aria-label={`Preview ${task.title}`} className={`${buttonClass} border border-gray-200 bg-white text-slate-600 hover:bg-slate-50`} onClick={() => setPreview(task)}>Preview</button>
            <button type="button" aria-label={`Assign ${task.title}`} disabled={task.archived || busy} className={`${buttonClass} bg-indigo-600 text-white hover:bg-indigo-700`} onClick={() => openEditor(task, 'assign')}>Assign</button>
            <button type="button" aria-label={`Edit ${task.title}`} disabled={task.archived || busy} className={`${buttonClass} bg-indigo-50 text-indigo-700 hover:bg-indigo-100`} onClick={() => openEditor(task)}>Edit</button>
            <details className="relative"><summary className={`${buttonClass} cursor-pointer list-none border border-gray-200 text-slate-600`}>More⌄</summary><div className="absolute right-0 z-10 mt-2 min-w-40 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg"><button type="button" disabled={busy || library.tasksLoading || Boolean(library.tasksError)} className="w-full rounded-lg px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50" onClick={() => archive(task)}>{task.archived ? 'Restore set' : 'Archive set'}</button></div></details>
          </div>
        </article>)}</div> : <div className="flex flex-col gap-3">{recordings.map(attempt => <article key={attempt.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="min-w-0"><h3 className="break-words text-sm font-semibold text-gray-900">{attempt.title}</h3><p className="mt-2 text-xs text-slate-500">{attempt.studentName} · {new Date(attempt.startedAt).toLocaleDateString()} · {attempt.status}</p><p className="mt-2 text-xs text-slate-500">{attempt.review?.band != null ? `Teacher ${attempt.review.band.toFixed(1)}` : attempt.report?.estimatedBand != null ? `AI estimate ${attempt.report.estimatedBand.toFixed(1)}` : `AI: ${attempt.aiStatus || 'not_requested'}`}</p></div>
          <button type="button" aria-label={`Open report ${attempt.studentName} ${attempt.title}`} className={`${buttonClass} border border-gray-200 text-indigo-700`} onClick={() => setReport(attempt.id)}>Open report →</button>
        </article>)}</div>}
        {!loading && !listError && loaded && !shownCount && <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">{tab === 'tasks' ? 'No Speaking sets match your search and filters.' : 'No student recordings match your search.'}</p>}
      </section>}
    </main>
  </div>
}
