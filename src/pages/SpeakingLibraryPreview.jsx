import { useState } from 'react'
import { useTeacherSpeakingHomework } from '../hooks/useTeacherSpeakingHomework'
import SpeakingWorkspaceView from '../components/speaking/SpeakingWorkspaceView'

// DEV-only fixture. Every read/write below stays in memory; no account, microphone or AI call.
function createLibraryDemo(onRequest) {
  const tasks = Array.from({ length: 92 }, (_, index) => ({
    id: `set-${String(index).padStart(3, '0')}`, teacherId: 'preview-teacher', schoolId: 'maxima', teacherName: 'Demo teacher',
    title: index === 88 ? 'C12 Speaking · Future cities' : `${index % 4 === 0 ? 'Speaking Mock' : 'Part ' + (index % 3 + 1)} ${String(index + 1).padStart(2, '0')} · ${['Morning routines', 'Learning new skills', 'Travel and culture', 'Your neighbourhood'][index % 4]}`,
    updatedAt: 1000 - index, archived: index >= 89, mode: index % 4 === 0 ? 'mock' : 'practice',
    assignedTo: index === 0 ? ['demo-student', 'previous-student'] : [],
    config: { enabled: true, questions: (index % 4 === 0 ? [1, 1, 2, 3] : [index % 3 + 1]).map((part, question) => ({
      part, seconds: part === 2 ? 120 : 40,
      text: index === 88 ? 'How could astronomy change future cities?' : part === 2 ? 'Describe a useful skill you learned.\nYou should say:\n• what it was\n• how you learned it\nand explain why it was useful.' : `Question ${question + 1}: What do you enjoy learning about your neighbourhood?`
    })) }
  }))
  const attempts = Array.from({ length: 38 }, (_, index) => ({ id: `attempt-${index}`, taskId: tasks[index].id,
    title: tasks[index].title, studentId: 'demo-student', studentName: `Demo learner ${index + 1}`, mode: 'practice',
    status: 'submitted', startedAt: 1795000000000 + index, aiStatus: 'not_requested' }))
  let failNext = false
  const api = async (op, data = {}) => {
    onRequest(op === 'list' ? data.kind || 'both' : op)
    if (op === 'list') {
      await new Promise(resolve => setTimeout(resolve, data.kind === 'attempts' ? 900 : 120))
      if (failNext && data.kind === 'tasks') { failNext = false; throw Error('Simulated offline request') }
      const kind = data.kind || 'tasks', rows = kind === 'tasks' ? tasks : attempts
      const from = data.cursors?.[kind] ? rows.findIndex(row => row.id === data.cursors[kind]) + 1 : 0
      const page = rows.slice(from, from + 25)
      return { [kind]: structuredClone(page), cursors: { [kind]: from + 25 < rows.length ? page.at(-1).id : null }, aiAvailable: false }
    }
    if (op === 'saveTask') {
      const existing = tasks.find(task => task.id === data.id)
      const saved = { ...existing, ...structuredClone(data), id: data.id || `set-new-${tasks.length}`, updatedAt: Date.now(), teacherId: 'preview-teacher', schoolId: 'maxima', teacherName: 'Demo teacher', archived: false }
      if (existing) tasks.splice(tasks.indexOf(existing), 1, saved); else tasks.push(saved)
      return { id: saved.id, task: structuredClone(saved) }
    }
    if (op === 'archiveTask') {
      const task = tasks.find(row => row.id === data.taskId)
      task.archived = data.archived; task.updatedAt = Date.now()
      return { id: task.id, archived: task.archived }
    }
    if (op === 'get') {
      const attempt = attempts.find(row => row.id === data.attemptId)
      return { ...attempt, questions: tasks.find(task => task.id === attempt.taskId).config.questions.map((question, index) => ({ ...question, id: `q${index + 1}` })), answers: [], report: null, review: null, aiAvailable: false }
    }
    throw Error('This action is unavailable in the local library fixture.')
  }
  api.failNext = () => { failNext = true }
  return api
}

export default function SpeakingLibraryPreview() {
  const [requests, setRequests] = useState({ tasks: 0, attempts: 0, writes: 0, reports: 0 })
  const [api] = useState(() => createLibraryDemo(kind => {
    const key = kind === 'tasks' || kind === 'attempts' ? kind : kind === 'get' ? 'reports' : 'writes'
    setRequests(value => ({ ...value, [key]: value[key] + 1 }))
  }))
  const library = useTeacherSpeakingHomework('preview-teacher', api)
  const [tab, setTab] = useState('speaking'), [search, setSearch] = useState('')
  const [speakingLibraryView, setSpeakingLibraryView] = useState({ tab: 'tasks', status: 'active', part: 'all', mode: 'all' })
  return <div className="min-h-screen bg-[#f6f7fb] text-slate-900">
    <div className="border-b border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Local library check</strong> · Synthetic data only. No Firebase writes, microphone or AI.
      <p role="status" className="mt-1">Requests · tasks: {requests.tasks} · recordings: {requests.attempts} · writes: {requests.writes} · reports: {requests.reports}</p>
      <button type="button" className="mt-2 rounded-lg border border-amber-300 px-3 py-1" onClick={() => api.failNext()}>Fail next library refresh</button>
    </div>
    <div className="mx-auto max-w-[1480px] px-4 py-7 sm:px-7 lg:px-9">
      <header className="mb-7 flex items-center gap-4"><img src="/1.png" alt="MAXIMA" className="h-9 max-w-28 object-contain"/><div><p className="text-xs uppercase tracking-wider text-indigo-700">Maxima / Teaching</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Content Library</h1><p className="mt-2 text-sm text-slate-500">Create, preview, assign and reuse your IELTS content</p></div></header>
      <nav aria-label="Content types" className="mb-4 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">{['reading', 'writing', 'vocabulary', 'speaking'].map(value => <button key={value} type="button" className={`whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium ${tab === value ? 'bg-indigo-600 text-white' : 'text-slate-600'}`} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)} {value === 'speaking' ? library.tasks.filter(task => !task.archived).length : ''}</button>)}</nav>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-slate-500">Preview, Edit and Assign remain available.</p><input aria-label="Search all Speaking records" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search all Speaking records…" className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-200 sm:w-72"/></div>
      {tab === 'speaking' ? <SpeakingWorkspaceView embedded profile={{ role: 'teacher' }} user={{ uid: 'preview-teacher' }} api={api} library={library} viewState={speakingLibraryView} onViewChange={setSpeakingLibraryView} search={search} onSearchChange={setSearch} onBack={() => {}} students={[{ id: 'demo-student', name: 'Demo learner' }, { id: 'demo-student-two', name: 'Second demo learner' }]} classes={[{ id: 'demo-class', name: 'IELTS Demo Class', studentIds: ['demo-student', 'demo-student-two'] }]}/> : <section className="rounded-2xl border border-gray-100 bg-white p-6"><h2 className="font-semibold">{tab[0].toUpperCase() + tab.slice(1)} library placeholder</h2><p className="mt-3 text-sm text-slate-500">Return to Speaking. The existing library must appear without another list request.</p></section>}
    </div>
  </div>
}
