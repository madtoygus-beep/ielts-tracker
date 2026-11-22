import { useEffect, useState } from 'react'
import { speakingApi, validateSpeakingConfig } from '../../services/speakingApi'

export default function MockSpeakingLibrarySelect({ value, onChange }) {
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
        const page = await speakingApi('list', { staff: true, kind: 'tasks', cursors: { tasks: cursor || null } })
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
  }, [reload])

  if (error) return <p role="alert" className="my-3 text-sm text-red-800">{error} <button type="button" className="underline" onClick={() => setReload(n => n + 1)}>Retry</button></p>
  if (!sets) return <p role="status" className="my-3 text-sm">Loading Speaking mocks…</p>
  if (!sets.length) return <p className="my-3 text-sm">No full Speaking mocks in your library yet.</p>

  const signature = questions => JSON.stringify(questions.map(({part, text, seconds}) => [part, text, seconds]))
  const current = signature(value.questions)
  const selected = sets.find(set => signature(set.config.questions) === current)
  return <label className="mt-4 block text-sm font-semibold">
    Speaking mock from library
    <select className="mt-2 block w-full rounded-xl border bg-white p-3 font-normal" value={selected?.id || ''} onChange={event => {
      const set = sets.find(item => item.id === event.target.value)
      if (set) onChange(structuredClone(set.config))
    }}>
      <option value="" disabled>Select a Speaking mock to replace the questions below</option>
      {sets.map(set => <option key={set.id} value={set.id}>{set.title}</option>)}
    </select>
  </label>
}
