import { defaultSpeakingConfig, validateSpeakingConfig } from '../../services/speakingApi'
export default function SpeakingEditor({value,onChange,optional=false,full=false}) {
  const current=value||defaultSpeakingConfig()
  const change=(index,patch)=>onChange({...current,questions:current.questions.map((q,i)=>i===index?{...q,...patch}:q)})
  const error=validateSpeakingConfig(current,full)
  return <section className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 my-5">
    <label className="flex items-center gap-3 font-semibold text-slate-900"><input type="checkbox" checked={current.enabled} onChange={e=>onChange({...current,enabled:e.target.checked})}/>Speaking {optional?'(optional)':''}</label>
    <p className="mt-2 text-sm text-slate-600">{full?'Automatically paced Parts 1–3. One minute preparation and up to two minutes speaking for Part 2.':'Students start and stop each answer, then move on when ready.'}</p>
    {current.enabled&&<><div className="space-y-4 mt-4">{current.questions.map((q,i)=><div key={i} className="rounded-xl border bg-white p-4">
      <div className="flex items-center justify-between gap-2 mb-3"><label className="text-sm">Question {i+1} · <select aria-label={`Question ${i+1} part`} value={q.part} onChange={e=>change(i,{part:Number(e.target.value),seconds:Number(e.target.value)===2?120:40})}>{[1,2,3].map(p=><option key={p} value={p}>Part {p}</option>)}</select></label><button type="button" className="text-sm text-red-700" onClick={()=>onChange({...current,questions:current.questions.filter((_,n)=>n!==i)})}>Remove</button></div>
      <textarea aria-label={`Question ${i+1} text`} className="w-full rounded-lg border border-slate-300 p-3 text-sm min-h-24" maxLength={3000} value={q.text} onChange={e=>change(i,{text:e.target.value})}/>
      {q.part!==2&&<label className="block mt-2 text-xs text-slate-600">Recording limit (20–90 seconds) <input aria-label={`Question ${i+1} seconds`} type="number" min="20" max="90" className="border rounded p-1 w-20" value={q.seconds} onChange={e=>change(i,{seconds:Number(e.target.value)})}/></label>}
      {q.part===2&&<p className="text-xs text-slate-500 mt-2">60 seconds preparation · 120 seconds recording</p>}
    </div>)}</div><button type="button" className="mt-4 border border-indigo-300 rounded-lg px-4 py-2 text-indigo-800" disabled={current.questions.length>=20} onClick={()=>onChange({...current,questions:[...current.questions,{part:current.questions.at(-1)?.part||1,text:'',seconds:40}]})}>+ Add question</button>
    {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}</>}
  </section>
}
