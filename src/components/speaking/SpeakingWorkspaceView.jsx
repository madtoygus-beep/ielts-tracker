import { useCallback, useEffect, useRef, useState } from 'react'
import { defaultSpeakingConfig, validateSpeakingConfig, speakingPracticeKind, speakingPracticeLabel } from '../../services/speakingPolicy'
import SpeakingEditor from './SpeakingEditor'
import SpeakingSession from './SpeakingSession'
import SpeakingReport from './SpeakingReport'

const unique=items=>[...new Map(items.map(item=>[item.id,item])).values()]
const emptyData=()=>({tasks:[],attempts:[],cursors:{tasks:null,attempts:null},aiAvailable:false})
export default function SpeakingWorkspaceView({profile,user,students=[],classes=[],api,onBack,onMock,runtime,encode,initialTaskId='',initialReportId='',embedded=false}) {
  const admin=profile.role==='admin',teacher=profile.role==='teacher',staff=admin||teacher
  const [data,setData]=useState(emptyData),[loading,setLoading]=useState(true),[error,setError]=useState('')
  const [tab,setTab]=useState('tasks'),[editor,setEditor]=useState(null),[session,setSession]=useState(()=>!staff&&/^[a-zA-Z0-9_-]{1,180}$/.test(initialTaskId)?{id:initialTaskId}:null),[report,setReport]=useState(()=>/^[a-zA-Z0-9_-]{1,180}$/.test(initialReportId)?initialReportId:null)
  const [busy,setBusy]=useState(false),[search,setSearch]=useState(''),[showArchived,setShowArchived]=useState(false),[partFilter,setPartFilter]=useState('all')
  const generation=useRef(0),alive=useRef(false)
  const fetchData=useCallback(async(kind='both',cursor=null)=>{
    const run=++generation.current
    setLoading(true);setError('')
    try{
      const next=await api('list',{staff,kind,cursors:cursor?{[kind]:cursor}:{}})
      if(run!==generation.current||!alive.current)return
      setData(old=>({
        tasks:kind==='attempts'?old.tasks:cursor?unique([...old.tasks,...next.tasks]):next.tasks,
        attempts:kind==='tasks'?old.attempts:cursor?unique([...old.attempts,...next.attempts]):next.attempts,
        cursors:{...old.cursors,...(kind!=='attempts'?{tasks:next.cursors?.tasks}:{}),...(kind!=='tasks'?{attempts:next.cursors?.attempts}:{})},
        aiAvailable:next.aiAvailable
      }))
    }catch(e){if(run===generation.current&&alive.current)setError(e.message||'Speaking could not be loaded.')}
    finally{if(run===generation.current&&alive.current)setLoading(false)}
  },[api,staff])
  useEffect(()=>{let active=true;alive.current=true;const run=++generation.current;api('list',{staff}).then(next=>{if(active&&run===generation.current){setData(next);setLoading(false)}}).catch(e=>{if(active){setError(e.message);setLoading(false)}});return()=>{active=false;alive.current=false}},[api,staff])
  const action=async fn=>{if(busy)return;setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}
  const openEditor=task=>{setEditor(task?{...task,assignedTo:[...task.assignedTo],expectedUpdatedAt:task.updatedAt}:{title:'',mode:'practice',config:{...defaultSpeakingConfig(),enabled:true},assignedTo:[]});setError('')}
  const save=()=>action(async()=>{const problem=validateSpeakingConfig(editor.config);if(problem)throw Error(problem);const saved=await api('saveTask',editor);setEditor(null);setShowArchived(false);setSearch('');setPartFilter('all');await fetchData();setData(old=>{const task=saved.task||old.tasks.find(t=>t.id===saved.id);return task?{...old,tasks:[task,...old.tasks.filter(t=>t.id!==saved.id)]}:old})})
  const setArchive=task=>action(async()=>{
    const message=task.archived?'Restore access to this Speaking set?':'Archive this set? Students lose access; saved recordings remain available to staff.'
    if(!window.confirm(message))return
    await api('archiveTask',{taskId:task.id,archived:!task.archived,expectedUpdatedAt:task.updatedAt});await fetchData()
  })
  const resume=attempt=>{
    if(attempt.status==='recording'&&!staff){
      if(attempt.mockId){onMock(attempt.mockId);return}
      sessionStorage.setItem(`speaking-active-${user.uid}-${attempt.taskId}`,attempt.id);setSession({id:attempt.taskId})
    }else setReport(attempt.id)
  }
  const startTask=task=>{
    if(task.latestAttemptId&&task.latestAttemptStatus!=='recording'&&!task.retakeAvailable){setReport(task.latestAttemptId);return}
    const storageKey=`speaking-active-${user.uid}-${task.id}`
    if(task.retakeAvailable)sessionStorage.removeItem(storageKey)
    else if(task.latestAttemptId)sessionStorage.setItem(storageKey,task.latestAttemptId)
    setSession(task)
  }
  const visible=data[tab==='tasks'?'tasks':'attempts'].filter(item=>(tab!=='tasks'||Boolean(item.archived)===showArchived)&&(tab!=='tasks'||partFilter==='all'||speakingPracticeKind(item.config)===partFilter)&&`${item.title} ${item.studentName||''} ${item.teacherName||''} ${item.status||''} ${item.aiStatus||''}`.toLowerCase().includes(search.toLowerCase()))
  const hiddenAssignments=editor?.assignedTo.filter(id=>!students.some(s=>s.id===id)).length||0
  return <div className={embedded?"text-slate-900":"min-h-screen bg-[#f6f7fb] text-slate-900"}>
    {!embedded&&<header className="border-b bg-white px-4 sm:px-7 py-4"><div className="max-w-6xl mx-auto flex flex-wrap justify-between items-center gap-4">
      <div className="flex items-center gap-4"><img src="/1.png" alt="MAXIMA" className="h-9 w-auto max-w-28 object-contain"/><div><h1 className="font-bold text-xl">Speaking</h1><p className="text-xs text-slate-500">{admin?'Institution monitoring':teacher?'Teacher workspace':'Student workspace'}</p></div><span className="rounded-md bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700">{profile.role.toUpperCase()}</span></div>
      <div className="flex flex-wrap gap-3"><button className="text-sm text-slate-600 px-3 py-2" onClick={onBack}>← Workspace</button>{teacher&&<button disabled={busy} className="bg-indigo-700 text-white rounded-xl px-4 py-2 text-sm disabled:opacity-50" onClick={()=>{openEditor(null);setReport(null);setSession(null)}}>+ Create Speaking</button>}</div>
    </div></header>}
    <main className={embedded?"rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-6":"max-w-6xl mx-auto p-4 sm:p-8"}>
      {embedded&&teacher&&<div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Speaking Library</h2><button disabled={busy} type="button" className="rounded-xl bg-indigo-700 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={()=>{openEditor(null);setReport(null);setSession(null)}}>+ Create Speaking</button></div>}
      {admin&&<p className="mb-5 rounded-xl bg-indigo-50 p-4 text-sm text-indigo-900">Teachers prepare and assign Speaking sets. You can monitor this institution’s sets, recordings and AI failures, and provide support.</p>}
      {error&&<p role="alert" className="mb-5 rounded-xl bg-red-50 border border-red-200 text-red-800 p-4">{error}</p>}
      {editor?<div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-8">
        <h2 className="font-semibold text-lg">{editor.id?'Edit Speaking':'Create Speaking'}</h2>
        <label className="block text-sm mt-5">Title<input aria-label="Speaking title" maxLength={180} className="block border rounded-xl p-3 w-full mt-2" value={editor.title} onChange={e=>setEditor(v=>({...v,title:e.target.value}))}/></label>
        <label className="block text-sm mt-5">Session type<select aria-label="Speaking session type" className="block border rounded-xl p-3 w-full mt-2" value={editor.mode||'practice'} onChange={e=>setEditor(v=>({...v,mode:e.target.value}))}><option value="practice">Practice · student controls recording</option><option value="mock">Full Speaking Mock · automatic progression</option></select></label>
        <SpeakingEditor full={editor.mode==='mock'} value={editor.config} onChange={config=>setEditor(v=>({...v,config}))}/>
        <h3 className="font-semibold">Assign students (optional)</h3><p className="text-sm text-slate-500 mt-1">Save to your library first, or assign to your current students.</p>
        {hiddenAssignments>0&&<p className="text-sm text-amber-900 rounded-lg bg-amber-50 p-3 mt-3">{hiddenAssignments} previous assignment(s) are outside your current roster and will be preserved.</p>}
        <div className="flex flex-wrap gap-2 mt-4">{classes.map(c=>{
          const members=students.filter(s=>(c.studentIds||[]).includes(s.id)).map(s=>s.id),all=members.length>0&&members.every(id=>editor.assignedTo.includes(id))
          return <button type="button" key={c.id} disabled={!members.length} className="rounded-lg border border-indigo-200 px-3 py-2 text-sm text-indigo-800 disabled:opacity-50" onClick={()=>setEditor(v=>({...v,assignedTo:all?v.assignedTo.filter(id=>!members.includes(id)):[...new Set([...v.assignedTo,...members])]}))}>{all?'Remove':'Add'} class: {c.name} ({members.length})</button>
        })}</div>
        <div className="grid sm:grid-cols-2 gap-2 max-h-64 overflow-auto mt-4">{students.map(s=><label key={s.id} className="flex items-center gap-2 rounded-lg border p-3 text-sm"><input type="checkbox" checked={editor.assignedTo.includes(s.id)} onChange={e=>setEditor(v=>({...v,assignedTo:e.target.checked?[...v.assignedTo,s.id]:v.assignedTo.filter(id=>id!==s.id)}))}/>{s.name||s.displayName||s.email}</label>)}</div>
        {!students.length&&<p className="text-sm text-slate-500 mt-3">No current students available. You can still save the set without assignments.</p>}
        <div className="flex gap-3 mt-6"><button disabled={busy||!editor.title.trim()} onClick={save} className="bg-indigo-700 text-white rounded-xl px-5 py-3 disabled:opacity-50">Save Speaking</button><button disabled={busy} onClick={()=>setEditor(null)} className="border rounded-xl px-5 py-3">Cancel</button></div>
      </div>:session?<><button className="text-sm text-indigo-700 mb-4" onClick={()=>{if(window.confirm('Leave Speaking? Saved answers are retained; an active recording may be interrupted.')){setSession(null);fetchData()}}}>← Speaking library</button><SpeakingSession taskId={session.id} api={api} runtime={runtime} encode={encode} onComplete={a=>{setSession(null);setReport(a.id);fetchData()}}/></>
      :report?<><button className="text-sm text-indigo-700 mb-4" onClick={()=>{setReport(null);fetchData()}}>← Speaking library</button><SpeakingReport key={report} attemptId={report} staff={staff} admin={admin} aiAvailable={data.aiAvailable} api={api} onRetake={a=>{sessionStorage.removeItem(`speaking-active-${user.uid}-${a.taskId}`);setReport(null);setSession({id:a.taskId})}}/></>
      :<>
        <div className="flex flex-wrap gap-3 mb-5"><button className={`rounded-xl px-4 py-2 ${tab==='tasks'?'bg-indigo-700 text-white':'bg-white border'}`} onClick={()=>{setTab('tasks');setSearch('')}}>{admin?'Institution sets':teacher?'Question library':'My Speaking tasks'}</button><button className={`rounded-xl px-4 py-2 ${tab==='reports'?'bg-indigo-700 text-white':'bg-white border'}`} onClick={()=>{setTab('reports');setSearch('')}}>{staff?'Student recordings':'My reports'}</button><button disabled={loading} onClick={()=>fetchData()} className="ml-auto text-sm text-indigo-700 disabled:opacity-50">Refresh</button></div>
        {tab==='tasks'&&<div className="flex flex-wrap gap-2 mb-4" aria-label="Speaking part filter">{[['all','All parts'],['part1','Part 1 only'],['part2','Part 2 only'],['part3','Part 3 only'],['mixed','Mixed parts']].map(([value,label])=><button type="button" key={value} aria-pressed={partFilter===value} className={`rounded-lg px-4 py-2 text-sm ${partFilter===value?'bg-indigo-100 text-indigo-900 border border-indigo-200':'border border-slate-200 bg-white text-slate-600'}`} onClick={()=>setPartFilter(value)}>{label}</button>)}</div>}
        <div className="flex flex-wrap items-center gap-4 mb-6"><input aria-label="Search Speaking" placeholder="Search loaded sets / recordings" value={search} onChange={e=>setSearch(e.target.value)} className="bg-white border border-slate-200 rounded-xl p-3 text-sm flex-1 min-w-0"/>{staff&&tab==='tasks'&&<label className="text-sm flex gap-2"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>Archived sets</label>}</div>
        {loading&&<p role="status" className="text-sm mb-4">Loading Speaking…</p>}
        {tab==='tasks'?<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">{visible.map(t=><article key={t.id} className="rounded-2xl border border-slate-200 bg-white p-6"><span className="text-xs font-semibold text-indigo-700">{t.archived?'ARCHIVED':speakingPracticeLabel(t.config).toUpperCase()}</span><h2 className="font-semibold text-lg mt-3 break-words">{t.title}</h2>{admin&&<p className="mt-2 text-sm text-slate-500">Teacher: {t.teacherName}</p>}<p className="text-sm text-slate-500 mt-2">{t.config.questions.length} questions · Part {[...new Set(t.config.questions.map(q=>q.part))].join(', ')}</p>{staff&&<p className="mt-2 text-sm text-slate-500">{t.assignedTo?.length||0} assigned</p>}<div className="flex flex-wrap gap-2 mt-5">{teacher&&!t.archived&&<button className="rounded-xl border border-indigo-300 px-4 py-2 text-sm text-indigo-800" onClick={()=>openEditor(t)}>Edit / assign</button>}{!staff&&<button className="rounded-xl bg-indigo-700 text-white px-4 py-2 text-sm" onClick={()=>startTask(t)}>{t.retakeAvailable?'Start retake':t.latestAttemptStatus==='recording'?'Continue practice':t.latestAttemptId?'View feedback':'Start practice'}</button>}{admin&&<details className="w-full text-sm"><summary className="cursor-pointer text-indigo-800 py-2">View questions</summary>{t.config.questions.map((q,i)=><p key={i} className="mt-3 whitespace-pre-wrap text-slate-600">Part {q.part}: {q.text}</p>)}</details>}{staff&&<button disabled={busy} className="rounded-xl border px-3 py-2 text-sm text-slate-600 disabled:opacity-50" onClick={()=>setArchive(t)}>{t.archived?'Restore set':'Archive set'}</button>}</div></article>)}</div>
        :<div className="space-y-3">{visible.map(a=><button key={a.id} onClick={()=>resume(a)} className="w-full text-left bg-white rounded-xl border border-slate-200 p-5 flex flex-wrap justify-between gap-4"><span className="min-w-0"><span className="block font-semibold break-words">{a.title}</span><span className="block text-sm text-slate-500 mt-1">{staff?`${a.studentName} · `:''}{a.mode==='mock'?'Mock':'Practice'} · {new Date(a.startedAt).toLocaleDateString()} · {a.status}</span>{admin&&<span className="block text-sm text-slate-500 mt-1">Teacher: {a.teacherName}</span>}<span className={`block text-xs mt-2 ${a.aiStatus==='failed'?'text-red-700':'text-slate-500'}`}>AI: {a.aiStatus||'not_requested'}</span></span><span className="text-indigo-800 text-sm">{a.status==='recording'&&!staff?'Resume →':a.review?.band!=null?`Teacher ${a.review.band.toFixed(1)}`:a.report?.estimatedBand!=null?`AI estimate ${a.report.estimatedBand.toFixed(1)}`:'Open report →'}</span></button>)}</div>}
        {!loading&&!visible.length&&<p className="text-slate-500 mt-5">{tab==='tasks'?'No Speaking sets to display.':'No recordings to display.'}</p>}
        {data.cursors?.[tab==='tasks'?'tasks':'attempts']&&<button disabled={loading} className="mt-6 border rounded-xl bg-white px-5 py-3 text-sm text-indigo-800 disabled:opacity-50" onClick={()=>{const kind=tab==='tasks'?'tasks':'attempts';fetchData(kind,data.cursors[kind])}}>Load more</button>}
      </>}
    </main>
  </div>
}
