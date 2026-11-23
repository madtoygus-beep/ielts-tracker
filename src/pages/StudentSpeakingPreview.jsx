import { useState } from 'react'
import StudentSpeakingProvider from '../components/speaking/StudentSpeakingProvider'
import StudentSpeakingWorkspace from '../components/speaking/StudentSpeakingWorkspace'
import SpeakingHomeworkSection from '../components/speaking/SpeakingHomeworkSection'
import StudentSpeakingAnalytics from '../components/speaking/StudentSpeakingAnalytics'
import { useSpeakingHomework } from '../hooks/useSpeakingHomework'
import { speakingLabels } from '../services/speakingPolicy'

// Entirely local, synthetic data. No account changes, real microphone, cloud uploads or paid assessment.
function audio() {
  const buffer = new ArrayBuffer(32044), view = new DataView(buffer)
  const word = (offset, text) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)))
  word(0, 'RIFF'); view.setUint32(4, 32036, true); word(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  word(36, 'data'); view.setUint32(40, 32000, true)
  for (let i = 0; i < 16000; i++) view.setInt16(44 + i * 2, Math.sin(i * Math.PI * 440 / 8000) * 2500, true)
  return new Blob([buffer], { type: 'audio/wav' })
}
const runtime = {
  now: () => Date.now() * 20, available: () => true,
  getUserMedia: async () => {
    const track = { readyState: 'live', stop() { this.readyState = 'ended' }, addEventListener() {} }
    return { getAudioTracks: () => [track], getTracks: () => [track] }
  },
  enumerateDevices: async () => [{ deviceId: 'synthetic', kind: 'audioinput', label: 'Synthetic microphone · no device access' }],
  recorder: () => ({ state: 'inactive', mimeType: 'audio/wav', start() { this.state = 'recording'; this.onstart?.(); this.timer = setInterval(() => this.ondataavailable?.({ data: audio() }), 100) }, stop() { if (this.state !== 'recording') return; this.state = 'inactive'; clearInterval(this.timer); this.ondataavailable?.({ data: audio() }); this.onstop?.() } })
}
const encode = async () => audio()

function createDemo(count) {
  const tasks = Array.from({ length: 36 }, (_, index) => ({ id: `set-${String(index).padStart(3, '0')}`,
    title: index < 4 ? ['C12 Speaking · Daily routines', 'C12 Speaking · A useful skill', 'C12 Speaking · Learning skills', 'C12 Speaking · Future plans'][index] : index === 35 ? 'Last page · Astronomy' : `Practice ${index + 1} · Travel and culture`,
    latestAttemptId: '', latestAttemptStatus: '', retakeAvailable: index === 3, nextAttemptNumber: 2,
    config: { enabled: true, questions: [{ part: index % 3 + 1, seconds: index % 3 === 1 ? 120 : 30,
      text: index === 35 ? 'How could astronomy change the way people live?' : index % 3 === 1 ? 'Describe a useful skill you learned.\nYou should say what it was, how you learned it and why it was useful.' : 'What do you enjoy learning in your daily life?' }] }
  }))
  const attempts = []
  const makeAttempt = (task, extra = {}) => ({ id: `attempt-${attempts.length}`, taskId: task.id, title: task.title, mode: 'practice', status: 'submitted',
    nextIndex: 1, current: null, startedAt: 1795000000000 + attempts.length * 1000, aiStatus: 'completed', studentName: 'Demo learner',
    questions: task.config.questions.map((question, index) => ({ ...question, id: `q${index + 1}`, preparationSeconds: question.part === 2 ? 60 : 0 })), answers: [],
    review: { band: 6.5, feedback: 'Illustrative teacher feedback for this local preview.' },
    report: { estimatedBand: 6, summary: 'Illustrative report only. No AI assessment was performed.', criteria: Object.fromEntries(Object.keys(speakingLabels).map(key => [key, { band: 6, explanation: 'Example feedback based on synthetic data.' }])), answers: [], priorities: ['Give a reason and a concrete example.'] }, ...extra })
  for (let index = 0; index < tasks.length; index++) {
    if (index % 3 === 1 || index === 2 || index === 3) {
      const value = makeAttempt(tasks[index], index === 2 ? { status: 'recording', nextIndex: 0, aiStatus: 'not_requested', report: null, review: null } : {})
      attempts.push(value); tasks[index].latestAttemptId = value.id; tasks[index].latestAttemptStatus = value.status
    }
  }
  for (let index = 0; index < 32; index++) attempts.push(makeAttempt(tasks[1], { title: `Past review ${index + 1} · A useful skill`, startedAt: 1794000000000 + index }))
  const api = async (op, data = {}) => {
    count(op === 'list' ? data.kind : op)
    if (op === 'list') {
      await new Promise(resolve => setTimeout(resolve, 150))
      const rows = data.kind === 'tasks' ? tasks : attempts
      const from = data.cursors?.[data.kind] ? rows.findIndex(row => row.id === data.cursors[data.kind]) + 1 : 0
      const page = rows.slice(from, from + 25)
      return { [data.kind]: structuredClone(page), cursors: { [data.kind]: from + 25 < rows.length ? page.at(-1).id : null }, aiAvailable: false }
    }
    if (op === 'get') { await new Promise(resolve => setTimeout(resolve, 100)); return structuredClone(attempts.find(value => value.id === data.attemptId)) }
    if (op === 'start') {
      const task = tasks.find(value => value.id === data.taskId), current = attempts.find(value => value.id === task.latestAttemptId)
      if (current && !task.retakeAvailable) return { ...structuredClone(current), serverNow: runtime.now() }
      const value = makeAttempt(task, { status: 'recording', nextIndex: 0, startedAt: runtime.now(), aiStatus: 'not_requested', report: null, review: null })
      attempts.push(value); task.latestAttemptId = value.id; task.latestAttemptStatus = value.status; task.retakeAvailable = false
      return { ...structuredClone(value), serverNow: runtime.now() }
    }
    const attempt = attempts.find(value => value.id === data.attemptId)
    if (op === 'beginQuestion') {
      const question = attempt.questions[attempt.nextIndex], startedAt = runtime.now()
      attempt.current = { startedAt, recordAt: startedAt + question.preparationSeconds * 1000, deadline: startedAt + (question.preparationSeconds + question.seconds) * 1000 }
      return { ...attempt.current, serverNow: runtime.now() }
    }
    if (op === 'saveAnswer') {
      if (data.index !== attempt.nextIndex) throw Error('This answer is already saved.')
      attempt.answers.push({ questionId: attempt.questions[attempt.nextIndex].id, duration: 1 }); attempt.nextIndex++; attempt.current = null
      return { ...structuredClone(attempt), serverNow: runtime.now() }
    }
    if (op === 'submit') {
      attempt.status = 'submitted'; tasks.find(task => task.id === attempt.taskId).latestAttemptStatus = 'submitted'
      return { ...structuredClone(attempt), serverNow: runtime.now() }
    }
    throw Error('This action is unavailable in the synthetic student preview.')
  }
  return api
}

function DemoDashboard({ api, open }) {
  const data = useSpeakingHomework('demo-student', api)
  return <section className="rounded-2xl border border-slate-200 bg-white p-6"><h2 className="text-lg font-semibold">My Dashboard</h2><p role="status" className="mt-3 text-sm">Speaking homework · {data.completed} / {data.total} completed · {data.pending.length} to do</p><button type="button" className="mt-5 rounded-xl bg-indigo-600 px-4 py-3 text-sm text-white" onClick={() => open('homework')}>Open My Homework</button></section>
}
function PreviewContent({ api, requests }) {
  const [page, setPage] = useState('homework'), [target, setTarget] = useState({})
  const open = (value, next = {}) => { setTarget(next); setPage(value) }
  return <div className="min-h-screen bg-[#faf9f6] text-slate-900"><div className="border-b border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Local student Speaking check</strong> · Synthetic data. No real microphone, uploads or paid AI.<p role="status" className="mt-2">Requests · tasks: {requests.tasks} · history: {requests.attempts} · reports: {requests.get} · starts: {requests.start} · submissions: {requests.submit}</p></div><div className="mx-auto max-w-6xl p-5 sm:p-8"><header className="mb-6 flex items-center gap-4"><img src="/1.png" alt="MAXIMA" className="h-9 max-w-28 object-contain"/><div><p className="text-xs uppercase tracking-wider text-indigo-700">Maxima / Student</p><h1 className="mt-2 text-2xl font-semibold">My Homework</h1></div></header><nav aria-label="Student preview navigation" className="mb-6 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2">{[['dashboard', 'My Dashboard'], ['homework', 'My Homework'], ['progress', 'My Progress'], ['speaking', 'Speaking']].map(([value, label]) => <button key={value} type="button" className={`whitespace-nowrap rounded-xl px-4 py-2.5 text-sm ${page === value ? 'bg-indigo-600 text-white' : 'text-slate-600'}`} onClick={() => open(value)}>{label}</button>)}</nav>{page === 'dashboard' ? <DemoDashboard api={api} open={open}/> : page === 'progress' ? <StudentSpeakingAnalytics user={{ uid: 'demo-student' }} api={api}/> : page === 'homework' ? <SpeakingHomeworkSection user={{ uid: 'demo-student' }} api={api} onOpen={task => open('speaking', { initialTaskId: task.id })} onReport={id => open('speaking', { initialReportId: id })} onLibrary={() => open('speaking')}/> : <StudentSpeakingWorkspace key={`${target.initialTaskId || ''}:${target.initialReportId || ''}`} user={{ uid: 'demo-student' }} api={api} {...target} runtime={runtime} encode={encode} onBack={() => open('dashboard')} onMock={() => {}}/>}</div></div>
}
export default function StudentSpeakingPreview() {
  const [requests, setRequests] = useState({ tasks: 0, attempts: 0, get: 0, start: 0, submit: 0 })
  const [api] = useState(() => createDemo(op => setRequests(current => ({ ...current, [op]: (current[op] || 0) + 1 }))))
  return <StudentSpeakingProvider accountId="demo-student"><PreviewContent api={api} requests={requests}/></StudentSpeakingProvider>
}
