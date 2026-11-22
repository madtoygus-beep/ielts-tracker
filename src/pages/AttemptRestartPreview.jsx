import { useCallback, useEffect, useRef, useState } from 'react'
import StudentAttemptBoundary from '../components/StudentAttemptBoundary'
import AttemptOptionsActions from '../components/AttemptOptionsActions'
import { generationSuffix, useAttemptGeneration } from '../hooks/useAttemptGeneration'

function DemoAttempt({ contentType }) {
  const generation = useAttemptGeneration()
  const key = `restart-preview-${contentType}${generationSuffix(generation)}`
  const [answer, setAnswer] = useState(() => localStorage.getItem(key) || '')
  const [remaining, setRemaining] = useState(1200)
  useEffect(() => { localStorage.setItem(key, answer) }, [key, answer])
  useEffect(() => {
    const interval = setInterval(() => setRemaining(value => Math.max(0, value - 1)), 1000)
    return () => clearInterval(interval)
  }, [])
  return <div className="rounded-2xl border border-gray-100 bg-white p-6">
    <div className="flex items-center justify-between"><h2 className="text-xl font-bold capitalize">{contentType} · Student view</h2><p className="font-mono text-purple-700">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</p></div>
    <label className="mt-6 block text-sm font-semibold">Your answer<textarea aria-label="Your answer" value={answer} onChange={event => setAnswer(event.target.value)} className="mt-2 block min-h-40 w-full rounded-xl border border-gray-200 p-4 font-normal" /></label>
    <p className="mt-4 text-xs text-gray-500">{generation ? 'Fresh session' : 'Original session'} · Saved locally for this demonstration</p>
  </div>
}

// DEV only. The production components receive synthetic events: no Firebase
// subscription, callable, student assignment or real microphone is touched.
export default function AttemptRestartPreview() {
  const [contentType, setContentType] = useState('mock')
  const [completed, setCompleted] = useState(false)
  const [notice, setNotice] = useState('')
  const generations = useRef({}), stream = useRef(null)
  const subscribe = useCallback(({ contentType: type }, receive) => {
    stream.current = { type, receive }
    receive({ status: 'ready', generation: generations.current[type] || '' })
    return () => { stream.current = null }
  }, [])
  const select = mode => {
    if (mode !== 'start_fresh') { setNotice('Previous submitted answers would be restored.'); return }
    if (!window.confirm('Start Fresh for Demo learner?\n\nBlank answers and a new timer. Saved results and recordings are kept.')) return
    const generation = crypto.randomUUID()
    generations.current[contentType] = generation
    stream.current?.receive({ status: 'ready', generation })
    setNotice('Fresh attempt is ready. The previous session has closed.')
  }
  return <main className="min-h-screen bg-[#faf9f6] p-6">
    <div className="mx-auto max-w-5xl">
      <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Local preview · Synthetic learner · No live student data</p>
      <div className="mb-6 flex flex-wrap gap-2">{['mock', 'reading', 'listening', 'writing', 'vocabulary'].map(type => <button type="button" key={type} onClick={() => { setContentType(type); setNotice('') }} className={`rounded-xl px-4 py-2 text-sm capitalize ${contentType === type ? 'bg-purple-600 text-white' : 'border border-gray-200 bg-white'}`}>{type}</button>)}</div>
      <section className="mb-6 rounded-2xl border border-gray-100 bg-white p-6">
        <h1 className="text-xl font-bold">Attempt Options · Demo learner</h1>
        <label className="my-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={completed} onChange={event => setCompleted(event.target.checked)} />Has a previous submitted attempt</label>
        <AttemptOptionsActions state={{ hasSubmission: completed }} saving={false} onSelect={select} reopenDescription="Restore the previous submitted answers for a teacher-approved retake." />
        {notice && <p role="status" className="mt-4 text-sm text-blue-700">{notice}</p>}
      </section>
      <StudentAttemptBoundary contentType={contentType} subscribe={subscribe}><DemoAttempt contentType={contentType} /></StudentAttemptBoundary>
    </div>
  </main>
}
