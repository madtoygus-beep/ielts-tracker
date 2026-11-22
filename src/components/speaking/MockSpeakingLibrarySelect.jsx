import { useEffect, useState } from 'react'
import { speakingApi, validateSpeakingConfig } from '../../services/speakingApi'
import { speakingExamMinutes, speakingParts } from '../../services/speakingExam'
import SpeakingEditor from './SpeakingEditor'

export default function MockSpeakingLibrarySelect({ value, onChange, api = speakingApi }) {
  const [sets, setSets] = useState(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    async function load() {
      setError('')
      const available = new Map()
      const seen = new Set()
      let cursor
      do {
        const page = await api('list', { staff: true, kind: 'tasks', cursors: { tasks: cursor || null } })
        if (!active) return
        for (const set of page.tasks) {
          if (!set.archived && set.mode === 'mock' && set.config?.enabled && !validateSpeakingConfig(set.config, true)) {
            available.set(set.id, set)
          }
        }
        cursor = page.cursors?.tasks
        if (cursor && seen.has(cursor)) throw Error('Could not load the complete Speaking library.')
        seen.add(cursor)
      } while (cursor)
      setSets([...available.values()].sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true })))
    }
    load().catch(e => { if (active) setError(e.message || 'Could not load the Speaking library.') })
    return () => { active = false }
  }, [reload, api])

  const signature = questions => JSON.stringify(questions.map(({part, text, seconds}) => [part, text, seconds]))
  const current = signature(value.questions)
  const selected = sets?.find(set => signature(set.config.questions) === current)
  const problem = validateSpeakingConfig(value, true)

  return <section aria-label="Speaking resource" className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">Speaking</h3>
        <p className="mt-1 text-xs text-gray-500">Select a full Speaking mock from your library. Parts 1–3 run automatically after the other sections.</p>
      </div>
      <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs text-emerald-700">{value.enabled ? '1/1 selected' : 'Optional'}</span>
    </div>

    <label className="mb-1 block text-xs text-gray-500" htmlFor="mock-speaking-resource">Speaking test / optional</label>
    <select id="mock-speaking-resource" className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-400" value={!value.enabled ? '' : selected?.id || 'custom'} onChange={event => {
      if (!event.target.value) { onChange({ ...value, enabled: false }); return }
      const set = sets?.find(item => item.id === event.target.value)
      if (set) onChange({ ...structuredClone(set.config), enabled: true })
    }}>
      <option value="">Do not include Speaking</option>
      {value.enabled && !selected && <option value="custom">{sets ? 'Saved custom Speaking questions' : 'Loading selected Speaking test…'}</option>}
      {sets?.map(set => <option key={set.id} value={set.id}>{set.title}</option>)}
    </select>

    {!sets && !error && <p role="status" className="mt-2 text-xs text-gray-500">Loading Speaking mocks…</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error} <button type="button" className="font-medium underline" onClick={() => setReload(n => n + 1)}>Retry</button></p>}
    {sets?.length === 0 && <p className="mt-3 text-xs text-gray-500">No full Speaking mocks in your library yet. Create one in Content Library → Speaking.</p>}

    {value.enabled && <>
      <div className="mt-3 rounded-xl border border-emerald-100 bg-white p-4">
        <p className="text-sm font-semibold text-gray-800">{selected?.title || 'Custom Speaking test'}</p>
        <p className="mt-1 text-xs text-gray-500">{value.questions.length} questions · Parts {speakingParts(value.questions).join(', ')} · About {speakingExamMinutes(value)} min</p>
        <p className="mt-2 text-xs leading-5 text-gray-500">Part 2 includes 1 minute preparation and up to 2 minutes speaking. The selected questions are saved with this mock.</p>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer py-2 font-medium text-emerald-800">Review / edit Speaking questions</summary>
        <SpeakingEditor full value={value} onChange={onChange} />
      </details>
      {problem && <p role="alert" className="mt-2 text-sm text-red-700">{problem}</p>}
    </>}
  </section>
}
