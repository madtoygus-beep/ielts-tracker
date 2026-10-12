import { useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { useNavigate, useParams } from 'react-router-dom'
import { functions } from '../firebase'

const openActivity = httpsCallable(functions, 'getSelfStudyActivity')
const submitPractice = httpsCallable(functions, 'submitSelfStudyPractice', { timeout: 120000 })
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const input = 'min-w-0 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-200'
const block = 'bg-white border border-gray-100 rounded-2xl p-5 sm:p-6 shadow-sm'
const typed = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : ''
function Options({ options = [], value = '', onChange, title = 'Choose an answer', values }) {
  return <label className="block text-sm text-gray-600">{title}
    <select className={`${input} mt-2`} value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">Select an answer</option>
      {options.map((option, i) => <option key={i} value={values?.[i] ?? letters[i]}>{values?.[i] ?? letters[i]}. {typeof option === 'string' ? option : String(option?.text || option?.label || '')}</option>)}
    </select>
  </label>
}
function AnswerField({ value, onChange, placeholder = 'Type your answer' }) {
  return <input className={input} value={value || ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} maxLength={250} />
}
function QuestionCard({ question: q, activity, answers, onValue, onNested, onToggle, startNumber = 1 }) {
  const type = q.type || 'mcq'
  const id = q.id
  const scalar = value => onValue(id, value)
  const text = typed(q.question || q.statement || q.sentence || '', 3000)
  const options = Array.isArray(q.options) ? q.options : []
  const nested = (itemId, value) => onNested(id, itemId, value)
  const tableKey = (rowId, cellIndex) => `${id}_${rowId}_${cellIndex}`
  const blank = (key, value) => <AnswerField value={answers[key]} onChange={v => onValue(key, v)} />
  const choice = (value, onChange, list = options, values) => <Options options={list} value={value} onChange={onChange} values={values} />

  return <article className={`${block} space-y-4`}>
    <div><p className="text-[11px] font-semibold text-purple-700 mb-1">{`Question${countQuestionUnits(q) === 1 ? '' : 's'} ${startNumber}${countQuestionUnits(q) === 1 ? '' : `-${startNumber + countQuestionUnits(q) - 1}`}`}</p><p className="text-xs font-bold text-purple-700 uppercase mb-1">{q.taskTitle || q.title || type}</p>
      {q.instruction && <p className="text-sm text-gray-500 whitespace-pre-wrap">{q.instruction}</p>}
      {text && text !== q.instruction && <p className="text-sm font-medium text-gray-900 mt-2 whitespace-pre-wrap">{text}</p>}</div>

    {type === 'mcq' && (q.mode === 'multi' ? <div className="grid sm:grid-cols-2 gap-2">
      {options.map((o, i) => <label key={i} className="flex items-start gap-2 border border-gray-100 bg-gray-50 rounded-xl p-3 text-sm">
        <input type="checkbox" checked={(answers[id] || []).includes(letters[i])} onChange={() => onToggle(id, letters[i], q.answerCount || 2)} />
        <span><strong>{letters[i]}.</strong> {o}</span></label>)}
    </div> : <div className="grid sm:grid-cols-2 gap-2">{options.map((o, i) => <label key={i} className="flex items-start gap-2 bg-gray-50 rounded-xl p-3 text-sm">
      <input type="radio" name={`choice-${id}`} checked={answers[id] === letters[i]} onChange={() => scalar(letters[i])} />
      <span><strong>{letters[i]}.</strong> {o}</span></label>)}</div>)}

    {type === 'tfng' && <div className="flex flex-wrap gap-2">{['True', 'False', 'Not Given'].map(v => <button type="button" key={v} onClick={() => scalar(v)}
      className={`rounded-xl border px-4 py-2 text-sm ${answers[id] === v ? 'bg-purple-700 text-white border-purple-700' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>{v}</button>)}</div>}
    {type === 'fitb' && <AnswerField value={answers[id]} onChange={scalar} />}

    {type === 'matching' && Array.isArray(q.paragraphs) && <div className="space-y-3">
      {(activity.headings || []).length > 0 && <div className="bg-white border border-purple-100 rounded-xl p-4 space-y-1">
        <p className="text-xs font-semibold text-purple-700 uppercase mb-2">Available headings</p>
        {(activity.headings || []).filter(Boolean).map((h, i) => <p key={i} className="text-sm text-gray-700"><strong className="mr-2">{i + 1}.</strong>{h}</p>)}
      </div>}{q.paragraphs.map((p, i) => <div key={p.letter || i} className="rounded-xl bg-gray-50 p-3">
      <p className="font-medium text-sm mb-2">Paragraph {p.letter || i + 1}{p.title ? ` · ${p.title}` : ''}</p>
      {choice(answers[id]?.[p.letter], v => nested(p.letter, v), activity.headings || [], (activity.headings || []).map((_, n) => String(n + 1)))}
    </div>)}</div>}
    {type === 'matching' && Array.isArray(q.matchingItems) && <div className="space-y-3">
      {options.length > 0 && <div className="text-xs text-gray-500">{options.map((o, i) => `${letters[i]}. ${o}`).join(' · ')}</div>}
      {q.matchingItems.map((item, i) => <div className="rounded-xl bg-gray-50 p-3" key={item.id || i}>
        <p className="text-sm text-gray-700 mb-2"><strong className="text-purple-700 mr-2">{startNumber + i}.</strong>{item.prompt || item.text || `Item ${i + 1}`}</p>
        {choice(answers[`${id}_${item.id}`], v => onValue(`${id}_${item.id}`, v))}
      </div>)}
    </div>}

    {['matchingInformation', 'sentenceEndings', 'shortAnswer', 'summaryOptions'].includes(type) && <div className="space-y-3">
      {type === 'sentenceEndings' && q.endings?.length > 0 && <div className="border border-purple-100 rounded-xl bg-white p-4 space-y-2">
        <p className="text-xs font-semibold text-purple-700 uppercase">Available endings</p>
        {q.endings.map((ending, i) => ending ? <p key={i} className="text-sm text-gray-700"><strong className="text-gray-500 mr-2">{letters[i]}.</strong>{ending}</p> : null)}
      </div>}
      {q.items?.map((item, i) => {
        const stem = item.sentence || item.statement || item.question || item.prompt ||
          ((item.beforeText || item.afterText) ? `${item.beforeText || ''} ____ ${item.afterText || ''}` : `Question ${startNumber + i}`)
        const sections = (q.sectionLetters?.length ? q.sectionLetters : (activity.paragraphs || []).map(p => p.letter)).filter(Boolean)
        const endingOptions = (q.endings || []).map((text, n) => ({ text, letter: letters[n] })).filter(x => typeof x.text === 'string' && x.text.trim())
        const choices = type === 'sentenceEndings' ? endingOptions.map(x => x.text) : type === 'matchingInformation' ? sections.map(letter => `Section ${letter}`) : options
        const values = type === 'sentenceEndings' ? endingOptions.map(x => x.letter) : type === 'matchingInformation' ? sections : undefined
        return <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_170px] gap-3 items-center bg-gray-50 border border-gray-100 p-3 rounded-xl" key={item.id || i}>
          <p className="text-sm text-gray-800 whitespace-pre-wrap min-w-0"><span className="font-semibold text-purple-700 mr-2">{startNumber + i}.</span>{stem}</p>
          {type === 'shortAnswer' ? <AnswerField value={answers[id]?.[item.id]} onChange={v => nested(item.id, v)} />
            : <Options options={choices} value={answers[id]?.[item.id] || ''} onChange={v => nested(item.id, v)} values={values} title="Choose" />}
        </div>
      })}
    </div>}

    {type === 'noteCompletion' && <div className="space-y-3">{(q.paragraphs || []).map((p, i) => <div key={p.id || i} className="bg-gray-50 rounded-xl p-3">
      <div className="flex flex-wrap gap-2 items-center text-sm text-gray-700">{(p.parts || []).map((part, j) => part.type === 'blank' ? <span key={part.id || j} className="inline-flex min-w-36 max-w-64">
        {q.mode === 'choose' ? choice(answers[`${id}_${p.id}_${part.id}`], v => onValue(`${id}_${p.id}_${part.id}`, v))
          : blank(`${id}_${p.id}_${part.id}`)}
      </span> : <span key={part.id || j} className="whitespace-pre-wrap">{part.content || part.text}</span>)}</div>
    </div>)}</div>}

    {['table', 'summary', 'note'].includes(type) && <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-sm border-collapse">
      {Array.isArray(q.columns) && q.columns.length > 0 && <thead><tr>{q.columns.map((c, i) => <th key={i} className="bg-gray-100 p-3 border border-gray-200 text-left">{c}</th>)}</tr></thead>}
      <tbody>{q.rows?.map((row, i) => <tr key={row.id || i}>{row.cells?.map((cell, j) => <td key={j} className="p-2 border border-gray-200 bg-gray-50 align-top min-w-40">
        {cell.type === 'blank' ? blank(tableKey(row.id, j)) : <span className="whitespace-pre-wrap">{cell.text || cell.content || ''}</span>}
      </td>)}</tr>)}</tbody></table></div>}

    {type === 'listeningCompletion' && <div className="space-y-3">{(q.sections || []).map((s, i) => <div key={s.id || i} className="bg-gray-50 p-3 rounded-xl">
      <p className="font-medium text-sm mb-2">{s.title || `Section ${i + 1}`}</p>
      <div className="flex flex-wrap gap-2 items-center text-sm">{(s.parts || []).map((p, j) => p.type === 'blank' ? <span key={p.id || j} className="inline-flex min-w-36 max-w-64">
        {q.completionMode === 'choose' ? choice(answers[`${id}_${s.id}_${p.id}`], v => onValue(`${id}_${s.id}_${p.id}`, v)) : blank(`${id}_${s.id}_${p.id}`)}
      </span> : <span key={p.id || j} className="whitespace-pre-wrap">{p.content || p.text}</span>)}</div></div>)}
    </div>}

    {type === 'map' && <div className="space-y-3">
      {(q.mapImageUrl || q.imageUrl) && <img alt="Listening map" className="max-w-full max-h-96 object-contain rounded-xl" src={q.mapImageUrl || q.imageUrl} />}
      <p className="text-xs text-gray-600">{(q.mapLocations || []).map(x => `${x.label}. ${x.text || ''}`).join(' · ')}</p>
      {(q.mapItems || []).map((item, i) => <div className="bg-gray-50 p-3 rounded-xl" key={item.id || i}>
        <p className="text-sm text-gray-700 mb-2">{item.prompt || `Location ${i + 1}`}</p>
        {choice(answers[`${id}_${item.id}`], v => onValue(`${id}_${item.id}`, v),
          (q.mapLocations || []).map(x => x.text || x.label), (q.mapLocations || []).map(x => x.label))}
      </div>)}
    </div>}

    {type === 'match_definition' && <div>
      <p className="text-sm text-gray-800 mb-2">{q.word || q.question}</p>
      {choice(answers[id], scalar, activity.matchingDefinitions || [])}
    </div>}
    {type === 'word_bank' && <div><p className="text-sm whitespace-pre-wrap mb-2">{q.sentence || q.question}</p>
      {q.wordBank && <p className="text-xs text-gray-500 mb-2">Word bank: {q.wordBank}</p>}<AnswerField value={answers[id]} onChange={scalar} /></div>}
    {type === 'grammar_form' && <div><p className="text-sm whitespace-pre-wrap mb-2">{q.sentence || q.question}</p>
      {q.baseWord && <p className="text-xs text-gray-500 mb-2">Base word: {q.baseWord}</p>}<AnswerField value={answers[id]} onChange={scalar} /></div>}

    {!['mcq', 'tfng', 'fitb', 'matching', 'matchingInformation', 'sentenceEndings', 'shortAnswer', 'summaryOptions', 'noteCompletion', 'table', 'summary', 'note', 'listeningCompletion', 'map', 'match_definition', 'word_bank', 'grammar_form'].includes(type) &&
      <p role="alert" className="text-sm text-amber-700 bg-amber-50 p-3 rounded-lg">Unsupported question type: {type}. This exercise cannot be graded until its format is supported.</p>}
  </article>
}

function countQuestionUnits(q) {
  const type = q.type || 'mcq'
  if (type === 'matching') return Math.max(1, q.paragraphs?.length || q.matchingItems?.length || 1)
  if (['matchingInformation', 'sentenceEndings', 'shortAnswer', 'summaryOptions'].includes(type)) return Math.max(1, q.items?.length || 1)
  if (type === 'noteCompletion') return Math.max(1, (q.paragraphs || []).reduce((n, p) => n + (p.parts || []).filter(x => x.type === 'blank').length, 0))
  if (['table', 'summary', 'note'].includes(type)) return Math.max(1, (q.rows || []).reduce((n, r) => n + (r.cells || []).filter(x => x.type === 'blank').length, 0))
  if (type === 'listeningCompletion') return Math.max(1, (q.sections || []).reduce((n, s) => n + (s.parts || []).filter(x => x.type === 'blank').length, 0))
  if (type === 'map') return Math.max(1, q.mapItems?.length || 1)
  if (type === 'mcq' && q.mode === 'multi') return Math.max(1, Number(q.answerCount) || 2)
  return 1
}
function answeredQuestionUnits(q, answers) {
  const type = q.type || 'mcq'
  const has = value => typeof value === 'string' ? !!value.trim() : Array.isArray(value) ? value.length > 0 : !!value
  if (type === 'matching') {
    if (Array.isArray(q.paragraphs)) return q.paragraphs.filter(p => has(answers[q.id]?.[p.letter])).length
    return (q.matchingItems || []).filter(item => has(answers[`${q.id}_${item.id}`])).length
  }
  if (['matchingInformation', 'sentenceEndings', 'shortAnswer', 'summaryOptions'].includes(type)) return (q.items || []).filter(item => has(answers[q.id]?.[item.id])).length
  if (type === 'noteCompletion') return (q.paragraphs || []).reduce((n,p) => n + (p.parts || []).filter(x => x.type === 'blank' && has(answers[`${q.id}_${p.id}_${x.id}`])).length, 0)
  if (['table', 'summary', 'note'].includes(type)) return (q.rows || []).reduce((n,r) => n + (r.cells || []).filter((x,i) => x.type === 'blank' && has(answers[`${q.id}_${r.id}_${i}`])).length, 0)
  if (type === 'listeningCompletion') return (q.sections || []).reduce((n,s) => n + (s.parts || []).filter(x => x.type === 'blank' && has(answers[`${q.id}_${s.id}_${x.id}`])).length, 0)
  if (type === 'map') return (q.mapItems || []).filter(x => has(answers[`${q.id}_${x.id}`])).length
  if (type === 'mcq' && q.mode === 'multi') return Array.isArray(answers[q.id]) ? answers[q.id].length : 0
  return has(answers[q.id]) ? 1 : 0
}

export default function SelfStudyPractice() {
  const { masterId } = useParams()
  const navigate = useNavigate()
  const [activity, setActivity] = useState(null)
  const [answers, setAnswers] = useState({})
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showQuestionMap, setShowQuestionMap] = useState(false)
  const [flagged, setFlagged] = useState([])

  const reload = async (preserveAnswers = false) => {
    setLoading(true); setError('')
    try {
      const loaded = await openActivity({ masterId })
      setActivity(loaded.data || null)
      if (!preserveAnswers) { setAnswers({}); setResult(null); setFlagged([]) }
    } catch (err) {
      setActivity(null); setError(String(err?.message || 'Activity could not be opened.').replace(/^FirebaseError:\s*/, ''))
    } finally { setLoading(false) }
  }
  useEffect(() => { void reload() }, [masterId])
  const onValue = (key, value) => setAnswers(old => ({ ...old, [key]: value }))
  const onNested = (key, subkey, value) => setAnswers(old => ({ ...old, [key]: { ...(old[key] || {}), [subkey]: value } }))
  const onToggle = (key, value, max = 2) => setAnswers(old => {
    const arr = Array.isArray(old[key]) ? old[key] : []
    const next = arr.includes(value) ? arr.filter(x => x !== value) : arr.length < Math.max(1, max) ? [...arr, value] : arr
    return { ...old, [key]: next }
  })
  const content = activity?.content || {}
  const questions = useMemo(() => {
    if (!activity) return []
    if (activity.master.contentType === 'listening') {
      const parts = Array.isArray(content.parts) ? content.parts : []
      return parts.length ? parts.flatMap(part => (part.questions || []).map(q => ({ ...q, partLabel: part.title || 'Listening Part' }))) : (content.questions || [])
    }
    return content.questions || []
  }, [activity, content])
  const unknownTypes = questions.filter(q => !['mcq', 'tfng', 'fitb', 'matching', 'matchingInformation', 'sentenceEndings', 'shortAnswer', 'summaryOptions', 'noteCompletion', 'table', 'summary', 'note', 'listeningCompletion', 'map', 'match_definition', 'word_bank', 'grammar_form'].includes(q.type || 'mcq'))
  const submit = async () => {
    if (!activity || busy || unknownTypes.length || !window.confirm('Submit this attempt? Your answers will be scored on the server.')) return
    setBusy(true); setError('')
    try {
      const data = await submitPractice({ masterId, answers })
      setResult(data.data?.result || null)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) { setError(String(err?.message || 'Submission failed.').replace(/^FirebaseError:\s*/, '')) }
    finally { setBusy(false) }
  }
  const questionGroups = (() => {
    let nextNumber = 1
    return questions.map((q, index) => {
      const requested = Number(q.startNumber)
      const startNumber = Number.isInteger(requested) && requested > 0 ? requested : nextNumber
      const count = countQuestionUnits(q)
      nextNumber = Math.max(nextNumber, startNumber + count)
      return { question: q, index, startNumber, count, answered: answeredQuestionUnits(q, answers) }
    })
  })()
  const questionTotal = questionGroups.reduce((n, item) => n + item.count, 0)
  const answeredTotal = questionGroups.reduce((n, item) => n + item.answered, 0)
  const contentType = activity?.master?.contentType
  const isObjective = ['reading', 'listening', 'vocabulary'].includes(contentType)
  const isMock = contentType === 'mock'
  const isWriting = contentType === 'writing'
  const leftPanelTitle = contentType === 'reading' ? 'Reading Passage' : contentType === 'listening' ? 'Listening Audio' : contentType === 'writing' ? 'Writing Tasks' : 'Instructions'
  const panelStyle = 'bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden flex flex-col min-w-0 lg:min-h-0 lg:h-[calc(100vh-10rem)]'
  const jumpTo = id => document.getElementById(`practice-question-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const toggleFlag = id => setFlagged(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id])

  return <div className="min-h-screen bg-[#faf9f6]">
    <header className="bg-white border-b border-gray-100 sticky top-0 z-20">
      <div className="max-w-[1500px] mx-auto px-5 py-4 flex justify-between items-center gap-3">
        <div className="flex gap-3 items-center"><img src="/1.png" alt="Maxima" className="h-10 object-contain" />
          <div><p className="text-xs uppercase font-semibold text-purple-700">Independent Practice</p><p className="text-sm font-semibold text-gray-900">Self-Study</p></div>
        </div>
        <button type="button" onClick={() => navigate('/self-study')} className="text-sm font-medium text-gray-600 hover:text-purple-700">Back to my library</button>
      </div>
    </header>
    <main className="max-w-[1500px] mx-auto px-4 md:px-6 py-6 space-y-5">
      {loading && <div className={block}><p className="text-gray-500 text-sm">Verifying entitlement and loading activity...</p></div>}
      {error && <div role="alert" className="border border-red-200 rounded-xl bg-red-50 text-red-700 p-4 text-sm">{error}
        <button type="button" onClick={() => void reload(true)} className="ml-3 underline">Retry</button>
      </div>}
      {activity && !loading && <>
        <section className={`${block} flex flex-wrap gap-3 justify-between items-center`}>
          <div><p className="text-xs text-purple-700 uppercase font-semibold">{contentType} · Self-Study</p>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900 mt-1">{activity.master.title}</h1>
            <p className="text-xs text-gray-500 mt-2">Independent master copy · Your access is checked by the server</p></div>
          <span className="text-xs text-green-700 bg-green-50 rounded-full px-3 py-1.5 h-fit">{activity.access.source === 'free_sample' ? 'Free sample' : 'Access verified'}</span>
        </section>

        {result ? <section className="bg-white border border-green-200 rounded-2xl shadow-sm p-7 max-w-3xl mx-auto" role="status">
          <div className="rounded-full bg-green-50 text-green-700 w-12 h-12 flex items-center justify-center text-2xl mb-4" aria-hidden="true">✓</div>
          <h2 className="text-2xl font-bold text-gray-900">Attempt saved</h2>
          {result.status === 'pending_review' ? <p className="text-sm text-gray-700 mt-3">Writing response saved for review. Task 1: {result.task1Words} words · Task 2: {result.task2Words} words. AI scoring will be developed in P5.</p>
            : <p className="text-lg text-gray-800 mt-3">Score: <strong>{result.correct} / {result.total}</strong>{result.band !== undefined ? ` · Estimated band ${result.band}` : ''}</p>}
          <p className="text-sm text-gray-500 mt-3">This attempt is complete. Start a new attempt to work through the questions again.</p>
          <div className="flex flex-wrap gap-3 mt-6">
            <button type="button" className="px-5 py-3 rounded-xl bg-purple-700 text-white font-semibold text-sm" onClick={() => { setResult(null); setAnswers({}); setFlagged([]); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Start another attempt</button>
            <button type="button" className="px-5 py-3 rounded-xl bg-gray-100 text-gray-700 font-semibold text-sm" onClick={() => navigate('/self-study')}>Back to my library</button>
          </div>
        </section> : isMock ? <section className={`${block} max-w-4xl`}>
          <h2 className="font-bold text-lg text-gray-900 mb-3">Mock Test components</h2>
          <p className="text-sm text-gray-500 mb-4">Open the independent Listening, Reading and Writing parts below. P4D offers separate practice; the combined timed Mock experience remains in a later development stage.</p>
          <div className="space-y-3">{(activity.parts || []).map(part => <div className="bg-gray-50 p-4 rounded-xl flex gap-3 justify-between items-center" key={part.id}>
            <div><p className="font-medium text-gray-900">{part.title}</p><p className="text-xs text-gray-500">{part.contentType}</p></div>
            <button type="button" onClick={() => navigate(`/self-study/practice/${encodeURIComponent(part.id)}`)} className="rounded-lg bg-purple-700 text-white text-xs font-semibold px-3 py-2">Open part</button>
          </div>)}</div>
        </section> : <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6 min-w-0">
          <section className={`${panelStyle} lg:sticky lg:top-24`}>
            <div className="px-5 py-4 border-b border-gray-100 shrink-0"><h2 className="font-semibold text-gray-800">{leftPanelTitle}</h2>
              <p className="text-xs text-gray-400 mt-1">{contentType === 'reading' ? 'Keep the passage open while you answer questions on the right.' : contentType === 'listening' ? 'Listen while answering the questions on the right.' : 'Read the instructions while working on the right.'}</p></div>
            <div className="p-5 md:p-7 lg:flex-1 lg:min-h-0 lg:overflow-y-auto overscroll-contain text-sm leading-8 text-gray-800">
              {contentType === 'reading' && <>
                {content.passageMode === 'sections' && (content.paragraphs || []).length > 0 ? <div className="space-y-7">
                  {content.paragraphs.map((p,i) => <div key={p.id || i}><h3 className="font-semibold mb-2">Paragraph {p.letter || letters[i]}</h3>
                    <p className="whitespace-pre-wrap">{p.text || p.content || p.paragraph || ''}</p></div>)}
                </div> : <>
                  {content.passage && <p className="whitespace-pre-wrap">{content.passage}</p>}
                  {!content.passage && (content.paragraphs || []).map((p,i) => <p key={p.id || i} className="whitespace-pre-wrap mb-5"><strong>{p.letter || letters[i]}.</strong> {p.text || p.content || p.paragraph || ''}</p>)}
                </>}
                <p className="border-t border-gray-100 text-gray-400 text-center text-xs mt-8 pt-5">End of passage</p>
              </>}
              {contentType === 'listening' && <>
                <p className="text-gray-500 text-xs leading-5 mb-4">The audio link is temporary and is provided only after access is verified.</p>
                {content.audioUrl ? <audio controls className="w-full" src={content.audioUrl} /> : <p className="text-sm text-amber-700">No protected audio file is attached to this content.</p>}
                <button type="button" onClick={() => void reload(true)} className="block mt-3 text-xs text-purple-700 underline">Refresh temporary audio link</button>
                {(content.parts || []).map((p,i) => <div key={p.id || i} className="mt-6"><p className="font-semibold">{p.title || `Part ${i+1}`}</p><p className="whitespace-pre-wrap text-gray-600">{p.instructions || ''}</p></div>)}
              </>}
              {contentType === 'writing' && <div className="space-y-8">
                {content.task1Enabled !== false && <div><h3 className="font-semibold text-purple-700 mb-2">Writing Task 1</h3><p className="whitespace-pre-wrap leading-7">{content.task1?.prompt || 'Task 1 prompt was not provided.'}</p>
                  {content.task1?.image && <img alt="Writing Task 1 visual" src={content.task1.image} className="max-w-full max-h-[520px] object-contain mt-4" />}</div>}
                {content.task2Enabled !== false && <div><h3 className="font-semibold text-purple-700 mb-2">Writing Task 2</h3><p className="whitespace-pre-wrap leading-7">{content.task2?.prompt || 'Task 2 prompt was not provided.'}</p></div>}
              </div>}
              {contentType === 'vocabulary' && <><h3 className="font-semibold mb-3">Vocabulary Practice</h3>
                {content.instructions ? <p className="whitespace-pre-wrap">{content.instructions}</p> : <p className="text-gray-500">Answer the vocabulary exercises on the right.</p>}</>}
            </div>
          </section>

          <section className={panelStyle}>
            <div className="px-5 py-4 border-b border-gray-100 shrink-0 flex items-center justify-between gap-3">
              <div><h2 className="font-semibold text-gray-800">{isWriting ? 'Your Responses' : `Questions (${questionTotal})`}</h2>
                {isObjective && <p className="text-xs text-gray-400 mt-1">{answeredTotal} answered · {Math.max(0, questionTotal - answeredTotal)} remaining</p>}</div>
              {isObjective && <button type="button" className="text-xs rounded-full px-3 py-2 bg-purple-50 text-purple-700" onClick={() => setShowQuestionMap(v => !v)}>{showQuestionMap ? 'Hide map' : 'Show map'}</button>}
            </div>
            <div className="p-5 md:p-7 lg:flex-1 lg:min-h-0 lg:overflow-y-auto overscroll-contain space-y-5 lg:pb-20">
              {isObjective && showQuestionMap && <div className="rounded-xl border border-purple-100 p-4 bg-purple-50">
                <p className="text-sm font-semibold text-gray-900 mb-3">Question map</p>
                <div className="flex flex-wrap gap-2">{questionGroups.map(({question:q,startNumber,count,answered}) => <button type="button" key={q.id}
                  onClick={() => jumpTo(q.id)} className={`px-3 py-2 rounded-lg border text-xs font-semibold ${flagged.includes(q.id) ? 'bg-amber-50 text-amber-700 border-amber-200' : answered >= count ? 'bg-green-50 text-green-700 border-green-200' : 'bg-white text-gray-600 border-gray-200'}`}>
                  {startNumber}{count > 1 ? `-${startNumber + count - 1}` : ''}{flagged.includes(q.id) ? ' ★' : ''}</button>)}</div>
              </div>}
              {isObjective && questionGroups.map(({question:q, index, startNumber, count}) => <div key={`${q.id || index}-${index}`} id={`practice-question-${q.id || index}`} className="scroll-mt-28">
                {q.partLabel && (index === 0 || questions[index - 1].partLabel !== q.partLabel) && <h3 className="text-lg font-bold text-gray-800 mb-3">{q.partLabel}</h3>}
                <div className="flex justify-end mb-2"><button type="button" onClick={() => toggleFlag(q.id)}
                  className={`rounded-lg text-xs px-3 py-1.5 border ${flagged.includes(q.id) ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-500'}`}>
                  {flagged.includes(q.id) ? '★ Flagged' : '☆ Flag for review'}</button></div>
                <QuestionCard question={q} startNumber={startNumber} activity={content} answers={answers} onValue={onValue} onNested={onNested} onToggle={onToggle} />
              </div>)}
              {isObjective && !questions.length && <p className="text-sm text-amber-700">This content does not contain questions.</p>}
              {isWriting && <div className="space-y-7">
                {content.task1Enabled !== false && <div className="space-y-2"><label htmlFor="ss-task1" className="font-semibold text-purple-700">Task 1 response</label>
                  <textarea id="ss-task1" className={`${input} min-h-64`} placeholder="Write Task 1 response" value={answers.task1 || ''} onChange={e => onValue('task1', e.target.value)} maxLength={18000} />
                  <p className="text-xs text-gray-500">{(answers.task1 || '').trim().split(/\s+/).filter(Boolean).length} words</p></div>}
                {content.task2Enabled !== false && <div className="space-y-2"><label htmlFor="ss-task2" className="font-semibold text-purple-700">Task 2 response</label>
                  <textarea id="ss-task2" className={`${input} min-h-72`} placeholder="Write Task 2 essay" value={answers.task2 || ''} onChange={e => onValue('task2', e.target.value)} maxLength={30000} />
                  <p className="text-xs text-gray-500">{(answers.task2 || '').trim().split(/\s+/).filter(Boolean).length} words</p></div>}
                <p className="text-xs text-amber-700">Writing will be saved for review. Automated scoring is planned for P5.</p>
              </div>}
              <div className="pt-4 border-t border-gray-100 space-y-3">
                <button type="button" disabled={busy || (isObjective && (!questions.length || unknownTypes.length > 0))}
                  className="rounded-xl bg-purple-700 text-white px-6 py-3 text-sm font-semibold disabled:opacity-50 w-full md:w-auto" onClick={() => void submit()}>{busy ? 'Submitting...' : 'Submit answers'}</button>
                {unknownTypes.length > 0 && <p className="text-xs text-amber-700">Some questions have unsupported types; submission is disabled until these are fixed.</p>}
                <p className="text-xs text-gray-500">Answers are scored on the server. Answer keys are never sent to this page.</p>
              </div>
            </div>
          </section>
        </div>}
      </>}
    </main>
  </div>
}
