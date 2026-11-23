import StudentSpeakingProvider from '../components/speaking/StudentSpeakingProvider'
import SpeakingAnalytics from '../components/speaking/SpeakingAnalytics'
import SpeakingHomeworkSection from '../components/speaking/SpeakingHomeworkSection'
import { useCallback, useRef, useState } from 'react'
import SpeakingWorkspaceView from '../components/speaking/SpeakingWorkspaceView'
import MockSpeakingLibrarySelect from '../components/speaking/MockSpeakingLibrarySelect'
import SpeakingTestPreview from '../components/speaking/SpeakingTestPreview'
import SpeakingSession from '../components/speaking/SpeakingSession'
import SpeakingReport from '../components/speaking/SpeakingReport'
import { defaultMockSpeakingConfig, speakingLabels } from '../services/speakingPolicy'
import { wavFromBlob, wavHasSignal } from '../services/speakingAudio'

function AudioConversionPreview(){
  const [status,setStatus]=useState('Select a synthetic audio file. Processing stays on this device; nothing is played or uploaded.')
  const [busy,setBusy]=useState(false)
  const [fixtureUrl,setFixtureUrl]=useState('')
  const convert=async file=>{
    if(!file)return
    setBusy(true);setStatus('Converting audio offline…')
    try{
      const wav=await wavFromBlob(file),bytes=await wav.arrayBuffer(),view=new DataView(bytes)
      const rate=view.getUint32(24,true),channels=view.getUint16(22,true),bits=view.getUint16(34,true)
      const duration=view.getUint32(40,true)/(rate*channels*bits/8)
      if(rate!==16000||channels!==1||bits!==16||!await wavHasSignal(wav))throw Error('The WAV contract or audio signal did not pass.')
      setStatus(`${file.name}: passed · ${rate} Hz · mono · ${bits}-bit · ${duration.toFixed(2)} seconds · ${bytes.byteLength} bytes`)
    }catch(error){setStatus(`Failed: ${error.message}`)}finally{setBusy(false)}
  }
  const checkUrl=async()=>{
    try{
      const url=new URL(fixtureUrl,window.location.href)
      if(url.origin!==window.location.origin)throw Error('Use a fixture served by this local development server.')
      const response=await fetch(url);if(!response.ok)throw Error('Fixture could not be loaded.')
      await convert(new File([await response.blob()],url.pathname.split('/').at(-1)))
    }catch(error){setStatus(`Failed: ${error.message}`)}
  }
  return <section className="rounded-2xl border bg-white p-6"><h2 className="text-xl font-bold">Offline audio conversion</h2><p className="mt-3 text-sm text-slate-600">Development check: actual browser decoding and WAV conversion, without a microphone or speaker playback.</p><label className="mt-5 block text-sm font-semibold">Local audio fixture<input type="file" aria-label="Local audio fixture" accept="audio/*" disabled={busy} onChange={event=>convert(event.target.files?.[0])} className="mt-2 block w-full rounded-xl border p-3 font-normal"/></label><label className="mt-4 block text-sm">Local fixture URL<input aria-label="Local fixture URL" value={fixtureUrl} onChange={event=>setFixtureUrl(event.target.value)} className="mt-2 block w-full rounded-xl border p-3"/></label><button type="button" disabled={busy||!fixtureUrl} onClick={checkUrl} className="mt-3 rounded-xl bg-indigo-700 px-4 py-2 text-sm text-white disabled:opacity-50">Check local fixture</button><p role="status" className="mt-5 rounded-xl bg-slate-50 p-4 text-sm">{status}</p></section>
}

// Deliberately synthetic, DEV-only review screen. No microphone access or cloud calls.
let demoRecordedDuration=1
function tone(duration=1){
  const frames=Math.ceil(Math.max(0.25,Math.min(130,duration))*16000)
  const b=new ArrayBuffer(44+frames*2),v=new DataView(b),s=(p,t)=>[...t].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)))
  s(0,'RIFF');v.setUint32(4,b.byteLength-8,true);s(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,frames*2,true)
  for(let i=0;i<frames;i++)v.setInt16(44+i*2,Math.sin(i*2*Math.PI*440/16000)*2500,true)
  return new Blob([b],{type:'audio/wav'})
}
const demoRuntime={
  now:()=>Date.now()*20,available:()=>true,
  getUserMedia:async()=>{const track={readyState:'live',stop(){this.readyState='ended'},addEventListener(){}};return {getAudioTracks:()=>[track],getTracks:()=>[track]}},
  enumerateDevices:async()=>[{deviceId:'simulation',kind:'audioinput',label:'Simulated microphone · no device access'}],
  recorder:()=>({state:'inactive',mimeType:'audio/wav',start(){this.state='recording';this.startedAt=demoRuntime.now();this.onstart?.();this.timer=setInterval(()=>this.ondataavailable?.({data:tone()}),200)},stop(){if(this.state!=='recording')return;clearInterval(this.timer);demoRecordedDuration=(demoRuntime.now()-this.startedAt)/1000;this.ondataavailable?.({data:tone()});this.state='inactive';this.onstop?.()}})
}
const encodeDemo=async()=>tone(demoRecordedDuration)
function createDemo(){
  let attempt,failSave=false,failSubmit=false
  const questions=[{id:'q1',part:1,text:'What do you enjoy learning in your free time?',seconds:30,preparationSeconds:0},{id:'q2',part:2,text:'Describe a useful skill you learned.\nSay what it is, how you learned it and why it matters to you.',seconds:120,preparationSeconds:60},{id:'q3',part:3,text:'How could schools prepare students for lifelong learning?',seconds:45,preparationSeconds:0}]
  const sample={id:'sample',title:'Learning and practical skills',studentName:'Demo learner',mode:'practice',status:'submitted',nextIndex:3,questions,answers:questions.map((q,index)=>({questionId:q.id,index,duration:1})),startedAt:1795000000000,aiStatus:'completed',report:{estimatedBand:5.5,summary:'Sample report layout only. These scores and transcripts are illustrative and were not generated from a student recording.',criteria:Object.fromEntries(Object.keys(speakingLabels).map((k,i)=>[k,{band:[6,5,5,6][i],explanation:'Illustrative feedback: support this criterion with evidence from the actual recording after assessment.'}])),priorities:['Develop an answer with a reason and one concrete example.','Practise linking ideas naturally and checking verb endings.'],answers:questions.map(q=>({questionId:q.id,transcript:'I enjoy learning practical skills because they help me in everyday life.',feedback:'Sample feedback only; no AI assessment was performed.',corrections:[]}))}}
  const tasks=[{id:'teacher-set',title:'Learning and practical skills',schoolId:'maxima',teacherId:'T1',teacherName:'Demo teacher',assignedTo:['demo-student'],config:{enabled:true,questions},updatedAt:1},
    {id:'second-teacher-set',title:'Travel and culture',schoolId:'maxima',teacherId:'T2',teacherName:'Second demo teacher',assignedTo:[],config:{enabled:true,questions},updatedAt:1}]
  tasks.push({id:'demo-part2-practice',title:'Part 2 cue card practice',schoolId:'maxima',teacherId:'T1',teacherName:'Demo teacher',assignedTo:['demo-student'],config:{enabled:true,questions:questions.filter(q=>q.part===2)},updatedAt:1})
  tasks.push({id:'demo-full-speaking',title:'Full Speaking Mock',mode:'mock',schoolId:'maxima',teacherId:'T1',assignedTo:['demo-student'],config:{enabled:true,questions},updatedAt:1})
  let failed=true
  const api=async(op,data={})=>{
    if(op==='list'){
      const role=data.demoRole||'teacher',visible=tasks.filter(t=>role==='admin'||role==='teacher'&&t.teacherId==='T1'||role==='student'&&t.assignedTo.includes('demo-student')&&!t.archived)
      return {tasks:structuredClone(visible),attempts:[{...structuredClone(sample),teacherName:'Demo teacher'},...(role==='admin'?[{...structuredClone(sample),id:'failed-demo',title:'Audio assessment awaiting support',teacherName:'Second demo teacher',report:null,aiStatus:failed?'failed':'not_requested'}]:[])],cursors:{tasks:null,attempts:null},aiAvailable:false}
    }
    if(op==='saveTask'){if(data.id){const i=tasks.findIndex(t=>t.id===data.id);tasks[i]={...tasks[i],...structuredClone(data),updatedAt:tasks[i].updatedAt+1}}else tasks.push({...structuredClone(data),id:`demo-set-${tasks.length}`,teacherId:'T1',teacherName:'Demo teacher',schoolId:'maxima',updatedAt:1});return {id:data.id||tasks.at(-1).id}}
    if(op==='archiveTask'){const task=tasks.find(t=>t.id===data.taskId);task.archived=data.archived;task.updatedAt++;return {id:task.id,archived:task.archived}}
    if(op==='allowAiRetry'){failed=false;return {aiStatus:'not_requested'}}

    if(op==='start'){if(!data.mockId&&attempt?.status==='recording'&&attempt.taskId===data.taskId)return structuredClone(attempt);const source=tasks.find(t=>t.id===data.taskId);const selected=data.mockId?questions:(source?.config.questions||questions).map((q,i)=>({...q,id:`q${i+1}`,preparationSeconds:q.part===2?60:0}));attempt={id:'demo',title:source?.title||'Local recording demonstration',taskId:data.taskId||'',mockId:data.mockId||'',mode:data.mockId||source?.mode==='mock'?'mock':'practice',questions:selected,timedPart2:!data.mockId&&source?.mode!=='mock'&&selected.every(q=>q.part===2),answers:[],nextIndex:0,status:'recording',current:null,startedAt:demoRuntime.now(),serverNow:demoRuntime.now()};return structuredClone(attempt)}
    if(op==='beginQuestion'){const q=attempt.questions[attempt.nextIndex],startedAt=demoRuntime.now();attempt.current={startedAt,recordAt:startedAt+(attempt.timedPart2?0:8000)+q.preparationSeconds*1000,deadline:startedAt+(attempt.timedPart2?0:8000)+(q.preparationSeconds+q.seconds)*1000};return {...attempt.current,serverNow:demoRuntime.now()}}
    if(op==='saveAnswer'){if(failSave){failSave=false;throw Error('Simulated connection failure. Your recording is retained on this device.')}attempt.answers.push({questionId:attempt.questions[attempt.nextIndex].id,duration:data.audio?(atob(data.audio).length-44)/32000:0,finishedEarly:data.finishEarly===true});attempt.nextIndex++;attempt.current=null;return structuredClone(attempt)}
    if(op==='submit'){if(failSubmit){failSubmit=false;throw Error('Simulated final submission failure. Your saved answers are retained.')}attempt.status='submitted';return structuredClone(attempt)}
    if(op==='get')return data.attemptId===attempt?.id?{...structuredClone(attempt),studentName:'Demo learner',report:null,aiStatus:'not_requested',aiAvailable:false}:data.attemptId==='failed-demo'?{...structuredClone(sample),id:'failed-demo',title:'Audio assessment awaiting support',report:null,aiStatus:failed?'failed':'not_requested',aiRequestedAt:1700,aiRecoveryCount:0}:structuredClone(sample)
    if(op==='audio'){const bytes=new Uint8Array(await tone().arrayBuffer());return {audio:btoa(Array.from(bytes,c=>String.fromCharCode(c)).join('')),mimeType:'audio/wav'}}
    if(op==='review')return {...data,band:Math.round(Object.values(data.criteria).reduce((s,n)=>s+n,0)/4*2)/2}
    throw Error('This action is not enabled in the local demonstration.')
  }
  api.failNextSave=()=>{failSave=true}
  api.failNextSubmit=()=>{failSubmit=true}
  return api
}
function RolePreview({api,embedded=false}){
  const [role,setRole]=useState('teacher')
  const roleApi=useCallback((op,data={})=>api(op,{...data,demoRole:role}),[api,role])
  return <><div className="flex flex-wrap gap-3 mb-5">{['teacher','admin','student'].map(r=><button type="button" key={r} className={`rounded-xl px-5 py-2 ${r===role?'bg-indigo-700 text-white':'border bg-white'}`} onClick={()=>setRole(r)}>{r==='teacher'?'Öğretmen görünümü':r==='admin'?'Admin görünümü':'Öğrenci görünümü'}</button>)}</div><SpeakingWorkspaceView embedded={embedded} key={role} profile={{role,schoolId:'maxima'}} user={{uid:role==='student'?'demo-student':role==='teacher'?'T1':'A1'}} students={[{id:'demo-student',name:'Demo learner'},{id:'demo-student-two',name:'Second demo learner'}]} classes={[{id:'demo-class',name:'IELTS Demo Class',studentIds:['demo-student','demo-student-two']}]} api={roleApi} runtime={demoRuntime} encode={encodeDemo} onBack={()=>{}} onMock={()=>window.alert('This demo does not open a real Mock. Use the Automatic Mock preview tab.')}/></>
}
function LoadingPreview({api}){
  const [counts,setCounts]=useState({tasks:0,attempts:0,both:0,get:0})
  const [direct,setDirect]=useState(false)
  const measuredApi=useCallback(async(op,data={})=>{
    if(op==='get')setCounts(v=>({...v,get:v.get+1}))
    if(op==='list'){
      const kind=data.kind||'both'
      setCounts(v=>({...v,[kind]:v[kind]+1}))
      if(kind==='attempts')await new Promise(resolve=>setTimeout(resolve,800))
      const response=await api(op,data)
      return {...response,tasks:kind==='attempts'?[]:response.tasks,attempts:kind==='tasks'?[]:response.attempts}
    }
    return api(op,data)
  },[api])
  return <><p role="status" className="mb-3 text-sm">List requests · tasks: {counts.tasks} · attempts: {counts.attempts} · both: {counts.both} · report: {counts.get}</p><button type="button" className="mb-4 rounded-xl border bg-white px-4 py-2" onClick={()=>setDirect(v=>!v)}>{direct?'Return to list test':'Open direct report test'}</button><SpeakingWorkspaceView key={String(direct)} embedded profile={{role:'teacher',schoolId:'maxima'}} user={{uid:'T1'}} api={measuredApi} initialReportId={direct?'sample':''} students={[]} classes={[]} onBack={()=>{}} onMock={()=>{}}/></>
}
function HomeworkPreview({api}){
  const [task,setTask]=useState(null)
  const studentApi=useCallback((op,data={})=>api(op,{...data,demoRole:'student'}),[api])
  return task?<SpeakingWorkspaceView initialTaskId={task.id} profile={{role:'student',schoolId:'maxima'}} user={{uid:'demo-student'}} api={studentApi} runtime={demoRuntime} encode={encodeDemo} onBack={()=>setTask(null)} onMock={()=>{}}/>:<SpeakingHomeworkSection user={{uid:'demo-student'}} api={studentApi} onOpen={setTask}/>
}
function createRetakeDemo(base){
  const questions=[{id:'q1',part:1,text:'What do you enjoy learning in your free time?',seconds:30,preparationSeconds:0}]
  const task={id:'retake-set',title:'Teacher-approved retake demo',teacherId:'T1',teacherName:'Demo teacher',assignedTo:['demo-student'],config:{enabled:true,questions},updatedAt:1}
  let current={id:'retake-original',title:task.title,taskId:task.id,mockId:'',mode:'practice',questions,status:'submitted',nextIndex:1,answers:[{questionId:'q1',duration:1}],startedAt:demoRuntime.now(),aiStatus:'not_requested',attemptNumber:1},open=false
  const attempts=[current]
  return async(op,data={})=>{
    if(op==='list')return {tasks:[{...structuredClone(task),latestAttemptId:current.id,latestAttemptStatus:current.status,retakeAvailable:open,nextAttemptNumber:current.attemptNumber+1}],attempts:structuredClone(attempts),cursors:{tasks:null,attempts:null},aiAvailable:false}
    if(op==='get'){const a=attempts.find(a=>a.id===data.attemptId);if(!a)throw Error('Demo attempt not found');return {...structuredClone(a),isLatestAttempt:a.id===current.id,retakeAvailable:a.id===current.id&&open,report:null,review:null}}
    if(op==='allowRetake'){if(!['teacher','admin'].includes(data.demoRole)||data.attemptId!==current.id||current.status==='recording')throw Error('A teacher must open the latest submitted attempt.');open=true;return {retakeAvailable:true}}
    if(op==='start'){
      if(current.status==='recording')return structuredClone(current)
      if(!open)throw Error('Your teacher must allow a retake.')
      open=false;current={...current,id:`retake-${attempts.length+1}`,attemptNumber:current.attemptNumber+1,status:'recording',nextIndex:0,answers:[],current:null,startedAt:demoRuntime.now(),serverNow:demoRuntime.now()};attempts.push(current);return structuredClone(current)
    }
    if(op==='beginQuestion'){const startedAt=demoRuntime.now();current.current={startedAt,recordAt:startedAt,deadline:startedAt+30000};return {...current.current,serverNow:startedAt}}
    if(op==='saveAnswer'){current.answers=[{questionId:'q1',duration:1}];current.nextIndex=1;current.current=null;return structuredClone(current)}
    if(op==='submit'){current.status='submitted';return structuredClone(current)}
    return base(op,data)
  }
}
function RetakePreview({api}){
  const [retakeApi]=useState(()=>createRetakeDemo(api))
  return <RolePreview api={retakeApi}/>
}
function AssessmentScenario({api,scenario}){
  const [calls,setCalls]=useState(0)
  const simulated=useRef(null)
  const assessmentApi=useCallback(async(op,data={})=>{
    if(!simulated.current)simulated.current={status:scenario==='processing'?'processing':'not_requested',report:null,finishAt:scenario==='processing'?Date.now()+1000:0}
    const state=simulated.current
    const sample=await api('get',{attemptId:'sample'})
    if(op==='get'){
      if(state.status==='processing'&&state.finishAt&&Date.now()>=state.finishAt){state.status='completed';state.report=sample.report}
      return {...sample,id:'assessment-demo',aiStatus:state.status,report:state.report,aiAvailable:true}
    }
    if(op==='evaluate'){
      setCalls(v=>v+1);state.status='processing'
      await new Promise(resolve=>setTimeout(resolve,1800))
      if(scenario==='failure'){state.status='failed';throw Error('Simulated assessment failure. The saved recordings are retained.')}
      state.status='completed';state.report=sample.report;return state.report
    }
    return api(op,data)
  },[api,scenario])
  return <><p className="mb-4 text-sm text-slate-500">Simulated AI requests: {calls}. No real assessment or student recording is used.</p><SpeakingReport attemptId="assessment-demo" api={assessmentApi} aiAvailable/></>
}
function AssessmentPreview({api}){
  const [scenario,setScenario]=useState('success')
  return <><div className="mb-5 flex flex-wrap gap-2">{[['success','New assessment'],['processing','Resume saved processing'],['failure','Simulate assessment failure']].map(([id,label])=><button type="button" key={id} className="rounded-xl border bg-white px-4 py-2 text-sm" onClick={()=>setScenario(id)}>{label}</button>)}</div><AssessmentScenario key={scenario} api={api} scenario={scenario}/></>
}
export default function SpeakingPreview(){
  const [tab,setTab]=useState('roles'),[config,setConfig]=useState(defaultMockSpeakingConfig),[api]=useState(createDemo),[finished,setFinished]=useState(false)
  return <StudentSpeakingProvider accountId="demo-student"><div className="min-h-screen bg-slate-50 text-slate-900"><header className="bg-white border-b px-5 py-5"><div className="max-w-5xl mx-auto"><p className="text-sm font-bold text-indigo-700">MAXIMA · LOCAL SPEAKING PREVIEW</p><h1 className="text-2xl font-bold mt-2">Speaking çalışma alanı</h1><p className="text-sm text-slate-600 mt-3">Yalnız yerel demo. Mikrofon açılmaz, sunucuya veri gönderilmez, kredi harcanmaz. Rapor örnek veridir. Zamanlayıcı inceleme için 20 kat hızlıdır; ses sorusu okuma kapalıdır.</p><div className="flex flex-wrap gap-2 mt-5">{[['roles','Öğretmen / Admin / Öğrenci'],['loading','Yükleme performansı'],['audio','Ses işleme kontrolü'],['library','Content Library · Speaking'],['analytics','Speaking analizi'],['homework','Öğrenci · ödevler'],['editor','Öğretmen · Mock ayarı'],['test-preview','Öğretmen · sınav önizlemesi'],['practice','Öğrenci · pratik'],['part2','Tek Part 2 pratiği'],['full-speaking','Tam Speaking denemesi'],['mock','Otomatik Mock'],['retake','Öğretmen izinli retake'],['assessment','AI değerlendirme yüklemesi'],['report','Rapor / öğretmen notu']].map(([id,label])=><button key={id} onClick={()=>{setTab(id);setFinished(false)}} className={`rounded-xl px-4 py-2 text-sm ${id===tab?'bg-indigo-700 text-white':'border'}`}>{label}</button>)}</div></div></header><main className="max-w-5xl mx-auto p-5 sm:p-8">{tab==='audio'?<AudioConversionPreview/>:tab==='loading'?<LoadingPreview api={api}/>:tab==='analytics'?<SpeakingAnalytics data={{tasks:[{id:'analytics-set'}],attempts:[{id:'analytics-a',taskId:'analytics-set',title:'Daily routines · Part 1',status:'submitted',startedAt:Date.UTC(2026,10,20),review:{band:6},report:{estimatedBand:5.5}}]}} onOpen={()=>{}}/>:tab==='library'?<RolePreview api={api} embedded/>:tab==='retake'?<RetakePreview api={api}/>:tab==='assessment'?<AssessmentPreview api={api}/>:tab==='homework'?<HomeworkPreview api={api}/>:tab==='roles'?<RolePreview api={api}/>:tab==='editor'?<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"><div className="rounded-2xl border border-gray-100 bg-white p-6"><h2 className="mb-4 font-semibold text-gray-800">Select Test Parts</h2><div className="space-y-4"><div className="rounded-2xl border border-amber-100 bg-amber-50 p-4"><h3 className="text-sm font-semibold text-gray-800">Writing</h3><p className="mt-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm">Demo Writing · Full Writing</p></div><MockSpeakingLibrarySelect value={config} onChange={setConfig} api={api}/></div></div><aside className="rounded-2xl border border-gray-100 bg-white p-6"><h2 className="font-semibold text-gray-800">Assign Students (optional)</h2><p className="mt-3 text-sm text-gray-500">None selected.</p><p className="mt-4 text-xs text-gray-400">The Speaking test is selected with the other test parts.</p></aside></div>:tab==='test-preview'?<SpeakingTestPreview config={{...config,enabled:true}} title="Local mock preview"/>:tab==='report'?<SpeakingReport key="sample" attemptId="sample" staff api={api}/>:<><p className="rounded-xl bg-amber-50 text-amber-900 p-4 mb-4 text-sm">Bu ekrandaki “Test microphone” düğmesi yalnız sentetik bir ses üretir. Gerçek cihaz mikrofonuna erişmez.</p><button type="button" className="mb-4 border rounded-lg px-4 py-2 text-sm" onClick={()=>api.failNextSave()}>Sonraki kayıtta bağlantı hatası dene</button><button type="button" className="mb-4 ml-3 border rounded-lg px-4 py-2 text-sm" onClick={()=>api.failNextSubmit()}>Son gönderimde bağlantı hatası dene</button><SpeakingSession key={tab} taskId={tab==='part2'?'demo-part2-practice':tab==='full-speaking'?'demo-full-speaking':'demo-task'} mockId={tab==='mock'?'demo-mock':undefined} api={api} runtime={demoRuntime} encode={encodeDemo} onComplete={()=>setFinished(true)}/>{finished&&<p role="status" className="text-emerald-800 mt-4">Demo tamamlandı. Gerçek öğrenci kaydı oluşturulmadı.</p>}</>}</main></div></StudentSpeakingProvider>
}
