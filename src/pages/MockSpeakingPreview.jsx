import { useMemo, useState } from 'react'
import { AttemptGenerationContext } from '../hooks/useAttemptGeneration'
import StudentSpeakingProvider from '../components/speaking/StudentSpeakingProvider'
import MockSpeakingSection from '../components/speaking/MockSpeakingSection'
import MockSpeakingReviewCard from '../components/speaking/MockSpeakingReviewCard'
import MockSpeakingFeedback from '../components/speaking/MockSpeakingFeedback'

// DEV-only integration fixture. No real account, microphone, Firebase request or paid AI.
let encodedSeconds = 1
function wav(seconds = 1) {
  const frames = Math.ceil(Math.max(1, Math.min(130, seconds)) * 16000), buffer = new ArrayBuffer(44 + frames * 2), view = new DataView(buffer)
  const word = (offset, text) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)))
  word(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); word(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, frames * 2, true)
  for (let index = 0; index < frames; index++) view.setInt16(44 + index * 2, Math.sin(index * Math.PI * 440 / 8000) * 2500, true)
  return new Blob([buffer], { type: 'audio/wav' })
}
const runtime = {
  now: () => Date.now() * 10, available: () => true,
  getUserMedia: async () => { const track = { readyState: 'live', stop() { this.readyState = 'ended' }, addEventListener() {} }; return { getAudioTracks: () => [track], getTracks: () => [track] } },
  enumerateDevices: async () => [{ deviceId: 'synthetic', kind: 'audioinput', label: 'Synthetic microphone · no device access' }],
  recorder: () => ({ state: 'inactive', mimeType: 'audio/wav', start() { this.started = runtime.now(); this.state = 'recording'; this.onstart?.(); this.timer = setInterval(() => this.ondataavailable?.({ data: wav() }), 100) }, stop() { if (this.state !== 'recording') return; clearInterval(this.timer); encodedSeconds = (runtime.now() - this.started) / 1000; this.state = 'inactive'; this.ondataavailable?.({ data: wav() }); this.onstop?.() } })
}
const encode = async () => wav(encodedSeconds)
const questions = [
  { id: 'q1', part: 1, text: 'What do you enjoy about the place where you live?', seconds: 20, preparationSeconds: 0 },
  { id: 'q2', part: 2, text: 'Describe a useful skill you learned.\nYou should say:\n• what the skill is\n• how you learned it\nand explain why it has been useful.', seconds: 120, preparationSeconds: 60 },
  { id: 'q3', part: 3, text: 'How could schools help people learn useful practical skills?', seconds: 20, preparationSeconds: 0 }
]
function createDemo(count) {
  const attempts = new Map()
  const api = async (op, data = {}) => {
    count(op)
    if (op === 'list') throw Error('A Mock must not load the Speaking homework list.')
    if (op === 'start') {
      const id = `${data.mockId}-${data.attemptGeneration || 'original'}`
      if (!attempts.has(id)) attempts.set(id, { id, mockId: data.mockId, taskId: '', mode: 'mock', attemptGeneration: data.attemptGeneration || '', title: data.mockId === 'mini-demo' ? 'C12 Mini Mock' : 'C12 Full Mock', questions, status: 'recording', nextIndex: 0, answers: [], current: null, startedAt: Date.now(), aiStatus: 'not_requested', report: null, review: null })
      return { ...structuredClone(attempts.get(id)), serverNow: runtime.now() }
    }
    const attempt = attempts.get(data.attemptId)
    if (!attempt) throw Error('The synthetic attempt was not found.')
    if (op === 'beginQuestion') {
      if (attempt.current) return { ...attempt.current, serverNow: runtime.now() }
      const question = attempt.questions[attempt.nextIndex], startedAt = runtime.now()
      attempt.current = { startedAt, recordAt: startedAt + 8000 + question.preparationSeconds * 1000, deadline: startedAt + 8000 + (question.preparationSeconds + question.seconds) * 1000 }
      return { ...attempt.current, serverNow: runtime.now() }
    }
    if (op === 'saveAnswer') {
      if (data.index !== attempt.nextIndex) throw Error('A saved answer cannot be recorded again.')
      const question = attempt.questions[attempt.nextIndex], duration = data.audio ? (atob(data.audio).length - 44) / 32000 : 0
      if (data.finishEarly && duration < (question.part === 2 ? 60 : 1)) throw Error('The minimum recording time has not elapsed.')
      attempt.answers.push({ questionId: question.id, duration, interrupted: data.interrupted === true, finishedEarly: data.finishEarly === true })
      attempt.nextIndex++; attempt.current = null
    } else if (op === 'submit') {
      if (attempt.nextIndex !== questions.length) throw Error('Finish all Speaking questions first.')
      attempt.status = 'submitted'
    } else if (op !== 'get') throw Error('This synthetic action is unavailable.')
    return { ...structuredClone(attempt), serverNow: runtime.now(), aiAvailable: false }
  }
  return api
}
function PreviewFlow({ api, counts }) {
  const [type, setType] = useState('full'), [generation, setGeneration] = useState('')
  const [stage, setStage] = useState('speaking'), [attempt, setAttempt] = useState(null), [rerenders, setRerenders] = useState(0)
  const mockId = `${type}-demo`, title = `C12 ${type === 'full' ? 'Full' : 'Mini'} Mock`
  const config = useMemo(() => ({ enabled: true, questions }), [])
  const choose = value => { setType(value); setGeneration(''); setAttempt(null); setStage('speaking') }
  return <div className="min-h-screen bg-[#faf9f6] text-gray-900"><div className="border-b border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Local Mock Speaking check</strong> · Synthetic audio only. Timers run 10× faster. No real microphone, cloud calls or paid AI.<p role="status" className="mt-2">Calls · start: {counts.start} · questions: {counts.beginQuestion} · saves: {counts.saveAnswer} · submit: {counts.submit} · reports: {counts.get} · lists: {counts.list}</p><div className="mt-3 flex flex-wrap gap-2">{['full', 'mini'].map(value => <button key={value} type="button" className="rounded-lg border border-amber-300 px-3 py-1" onClick={() => choose(value)}>{value === 'full' ? 'Full Mock' : 'Mini Mock'}</button>)}<button type="button" className="rounded-lg border border-amber-300 px-3 py-1" onClick={() => setRerenders(value => value + 1)}>Update parent display ({rerenders})</button><button type="button" className="rounded-lg border border-amber-300 px-3 py-1" onClick={() => { setGeneration(crypto.randomUUID()); setAttempt(null); setStage('speaking') }}>Simulate teacher Start Fresh</button></div></div>
    <header className="border-b border-gray-100 bg-white px-6 py-5"><div className="mx-auto flex max-w-7xl items-center justify-between"><img src="/1.png" alt="MAXIMA" className="h-9 max-w-28 object-contain"/><p className="text-sm font-medium text-gray-700">{title}</p></div></header>
    <main className="mx-auto max-w-7xl px-6 py-8"><nav aria-label="Mock sections" className="mb-6 flex gap-2 overflow-x-auto rounded-2xl border border-gray-100 bg-white p-4">{['Reading', 'Writing T1', 'Writing T2', 'Speaking', 'Review', 'Results'].map(label => <span key={label} className={`whitespace-nowrap rounded-full px-4 py-2 text-xs ${label.toLowerCase() === stage ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-400'}`}>{label}</span>)}</nav>
      <AttemptGenerationContext.Provider value={generation}>{stage === 'speaking' ? <MockSpeakingSection user={{ uid: 'mock-student' }} mockId={mockId} title={title} config={config} api={api} runtime={runtime} encode={encode} onComplete={value => { setAttempt(value); setStage('review') }}/>
        : stage === 'review' ? <section className="rounded-2xl border border-gray-100 bg-white p-6 sm:p-8"><h1 className="mb-3 text-2xl font-bold">Review &amp; Submit</h1><p className="mb-6 text-sm text-gray-500">Synthetic Reading and Writing are already saved. Speaking is summarized from saved receipts.</p><div className="grid gap-4 md:grid-cols-3"><div className="rounded-2xl bg-blue-50 p-5"><p className="text-xs text-gray-500">Reading</p><p className="mt-2 font-semibold text-blue-700">Saved</p></div><div className="rounded-2xl bg-amber-50 p-5"><p className="text-xs text-gray-500">Writing</p><p className="mt-2 font-semibold text-amber-700">Saved</p></div><MockSpeakingReviewCard attempt={attempt} config={config}/></div><button type="button" className="mt-6 w-full rounded-xl bg-purple-600 px-5 py-3 text-sm font-semibold text-white" onClick={() => setStage('results')}>Submit mock preview</button></section>
          : <section><h1 className="text-2xl font-bold">{title} · Results</h1><p className="mt-3 text-sm text-gray-500">Mock submission is simulated. The Speaking report loads only when opened.</p><MockSpeakingFeedback key={attempt.id} user={{ uid: 'mock-student' }} attemptId={attempt.id} api={api}/></section>}
      </AttemptGenerationContext.Provider>
    </main>
  </div>
}
export default function MockSpeakingPreview() {
  const [counts, setCounts] = useState({ start: 0, beginQuestion: 0, saveAnswer: 0, submit: 0, get: 0, list: 0 })
  const [api] = useState(() => createDemo(op => setCounts(value => ({ ...value, [op]: (value[op] || 0) + 1 }))))
  return <StudentSpeakingProvider accountId="mock-student"><PreviewFlow api={api} counts={counts}/></StudentSpeakingProvider>
}
