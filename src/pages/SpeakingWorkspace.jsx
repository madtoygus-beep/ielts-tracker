import { useCallback, useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { auth, db } from '../firebase'
import { speakingApi, defaultSpeakingConfig, validateSpeakingConfig } from '../services/speakingApi'
import { subscribeCurrentTeacherAcademicRoster } from '../services/teacherCurrentAcademicRoster'
import SpeakingEditor from '../components/speaking/SpeakingEditor'
import SpeakingSession from '../components/speaking/SpeakingSession'
import SpeakingReport from '../components/speaking/SpeakingReport'
export default function SpeakingWorkspace() {
  const navigate=useNavigate(),[profile,setProfile]=useState(null),[user,setUser]=useState(null)
  const [data,setData]=useState({tasks:[],attempts:[]}),[students,setStudents]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(true)
  const [editor,setEditor]=useState(null),[session,setSession]=useState(null),[report,setReport]=useState(null),[busy,setBusy]=useState(false),[tab,setTab]=useState('tasks')
  const staff=profile?.role==='teacher'||profile?.role==='admin'
  useEffect(()=>{let generation=0,active=true;const unsubscribe=onAuthStateChanged(auth,async u=>{
    const run=++generation
    if(!u){navigate('/login');return}
    try{const snap=await getDoc(doc(db,'users',u.uid));const p=snap.data();if(!p||p.status!=='approved'||!['student','teacher','admin'].includes(p.role))throw Error('An approved institution account is required.');if(!active||run!==generation)return;setProfile(p);setUser(u)}catch(e){if(active&&run===generation){setError(e.message);setLoading(false)}}
  });return()=>{active=false;unsubscribe()}},[navigate])
  const refresh=useCallback(async()=>{if(!profile)return;setError('');setLoading(true);try{setData(await speakingApi('list',{staff:profile.role!=='student'}))}catch(e){setError(e.message||'Speaking is not available.');}finally{setLoading(false)}},[profile])
  useEffect(()=>{let active=true;if(profile)speakingApi('list',{staff:profile.role!=='student'}).then(v=>{if(active){setData(v);setLoading(false)}}).catch(e=>{if(active){setError(e.message);setLoading(false)}});return()=>{active=false}},[profile])
  useEffect(()=>{
    if(!staff||!user)return
    if(profile.role==='teacher')return subscribeCurrentTeacherAcademicRoster(db,profile.schoolId||'maxima',user.uid,setStudents,status=>{if(status==='error')setError('Student roster could not be loaded.')})
    let active=true;getDocs(query(collection(db,'users'),where('schoolId','==',profile.schoolId||'maxima'),where('role','==','student'))).then(s=>{if(active)setStudents(s.docs.map(d=>({id:d.id,...d.data()})).filter(v=>v.status==='approved'&&!v.archived&&!v.deleted))}).catch(()=>setError('Student roster could not be loaded.'));return()=>{active=false}
  },[staff,user,profile])
  const save=async()=>{
    const problem=validateSpeakingConfig(editor.config)
    if(problem){setError(problem);return}
    setBusy(true);setError('');try{await speakingApi('saveTask',editor);setEditor(null);await refresh()}catch(e){setError(e.message)}finally{setBusy(false)}
  }
  return <div className="min-h-screen bg-[#f6f7fb] text-slate-900"><header className="border-b bg-white px-5 py-4"><div className="max-w-6xl mx-auto flex justify-between items-center gap-4"><div className="flex items-center gap-4"><button className="text-sm text-slate-600" onClick={()=>navigate(staff?'/teacher':'/student')}>← Workspace</button><h1 className="font-bold text-xl">Speaking</h1></div>{staff&&<button className="bg-indigo-700 text-white rounded-xl px-4 py-2 text-sm" onClick={()=>{setEditor({title:'',config:{...defaultSpeakingConfig(),enabled:true},assignedTo:[]});setReport(null);setSession(null)}}>+ Create Speaking</button>}</div></header>
    <main className="max-w-6xl mx-auto p-4 sm:p-8">{error&&<p role="alert" className="mb-5 rounded-xl bg-red-50 border border-red-200 text-red-800 p-4">{error}</p>}
      {editor?<div className="bg-white rounded-2xl border p-5 sm:p-8"><h2 className="font-semibold text-lg">{editor.id?'Edit Speaking':'Create Speaking'}</h2><label className="block text-sm mt-5">Title<input maxLength={180} className="block border rounded-xl p-3 w-full mt-2" value={editor.title} onChange={e=>setEditor(v=>({...v,title:e.target.value}))}/></label><SpeakingEditor value={editor.config} onChange={config=>setEditor(v=>({...v,config}))}/><h3 className="font-semibold">Assign students (optional)</h3><p className="text-sm text-slate-500 mt-1">Save to your library first, or select students now.</p><div className="grid sm:grid-cols-2 gap-2 max-h-64 overflow-auto mt-4">{students.map(s=><label key={s.id} className="flex items-center gap-2 rounded-lg border p-3 text-sm"><input type="checkbox" checked={editor.assignedTo.includes(s.id)} onChange={e=>setEditor(v=>({...v,assignedTo:e.target.checked?[...v.assignedTo,s.id]:v.assignedTo.filter(id=>id!==s.id)}))}/>{s.name||s.displayName||s.email}</label>)}</div><div className="flex gap-3 mt-6"><button disabled={busy||!editor.title.trim()} onClick={save} className="bg-indigo-700 text-white rounded-xl px-5 py-3 disabled:opacity-50">Save Speaking</button><button onClick={()=>setEditor(null)} className="border rounded-xl px-5 py-3">Cancel</button></div></div>
      :session?<><button className="text-sm text-indigo-700 mb-4" onClick={()=>{if(window.confirm('Leave Speaking? Saved answers are retained; an active recording may be interrupted.')){setSession(null);refresh()}}}>← Speaking library</button><SpeakingSession taskId={session.id} onComplete={a=>{setSession(null);setReport(a.id);refresh()}}/></>
      :report?<><button className="text-sm text-indigo-700 mb-4" onClick={()=>setReport(null)}>← Speaking library</button><SpeakingReport key={report} attemptId={report} staff={staff} aiAvailable={data.aiAvailable}/></>
      :<><div className="flex gap-3 mb-6"><button className={`rounded-xl px-5 py-2 ${tab==='tasks'?'bg-indigo-700 text-white':'bg-white border'}`} onClick={()=>setTab('tasks')}>{staff?'Question library':'My Speaking tasks'}</button><button className={`rounded-xl px-5 py-2 ${tab==='reports'?'bg-indigo-700 text-white':'bg-white border'}`} onClick={()=>setTab('reports')}>{staff?'Student recordings':'My reports'}</button><button onClick={refresh} className="ml-auto text-sm text-indigo-700">Refresh</button></div>
        {loading?<p role="status">Loading Speaking…</p>:tab==='tasks'?<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">{data.tasks.map(t=><article key={t.id} className="rounded-2xl border bg-white p-6"><span className="text-xs font-semibold text-indigo-700">SPEAKING PRACTICE</span><h2 className="font-semibold text-lg mt-3">{t.title}</h2><p className="text-sm text-slate-500 mt-2">{t.config.questions.length} questions · Part {[...new Set(t.config.questions.map(q=>q.part))].join(', ')}</p><button className="mt-6 rounded-xl border border-indigo-300 px-4 py-2 text-indigo-800" onClick={()=>staff?setEditor(t):setSession(t)}>{staff?'Edit / assign':'Start practice'}</button></article>)}{!data.tasks.length&&<p className="text-slate-500">{staff?'No Speaking tasks yet. Create one to get started.':'No Speaking tasks assigned yet.'}</p>}</div>:<div className="space-y-3">{data.attempts.map(a=><button key={a.id} onClick={()=>a.status==='recording'&&!staff&&!a.mockId?(()=>{sessionStorage.setItem(`speaking-active-${user.uid}-${a.taskId}`,a.id);setSession({id:a.taskId})})():setReport(a.id)} className="w-full text-left bg-white rounded-xl border p-5 flex justify-between gap-4"><span><span className="block font-semibold">{a.title}</span><span className="text-sm text-slate-500">{staff?`${a.studentName} · `:''}{a.mode==='mock'?'Mock':'Practice'} · {new Date(a.startedAt).toLocaleDateString()} · {a.status}</span></span><span className="text-indigo-800">{a.review?.band?.toFixed(1)||a.report?.estimatedBand?.toFixed(1)||'Open →'}</span></button>)}{!data.attempts.length&&<p className="text-slate-500">No recordings yet.</p>}</div>}
        {data.hasMore&&<p className="text-sm text-amber-800 mt-4">Showing the first 100 records. More records are available; contact the administrator for older entries.</p>}
      </>}
    </main></div>
}
