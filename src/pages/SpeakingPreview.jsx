import { useState } from 'react'
import SpeakingEditor from '../components/speaking/SpeakingEditor'
import SpeakingSession from '../components/speaking/SpeakingSession'
import SpeakingReport from '../components/speaking/SpeakingReport'
import { defaultMockSpeakingConfig, speakingLabels } from '../services/speakingPolicy'

// Deliberately synthetic, DEV-only review screen. No microphone access or cloud calls.
function tone(){
  const b=new ArrayBuffer(32044),v=new DataView(b),s=(p,t)=>[...t].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)))
  s(0,'RIFF');v.setUint32(4,32036,true);s(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,32000,true)
  for(let i=0;i<16000;i++)v.setInt16(44+i*2,Math.sin(i*2*Math.PI*440/16000)*2500,true)
  return new Blob([b],{type:'audio/wav'})
}
const demoRuntime={
  now:()=>Date.now()*20,available:()=>true,
  getUserMedia:async()=>{const track={readyState:'live',stop(){this.readyState='ended'},addEventListener(){}};return {getAudioTracks:()=>[track],getTracks:()=>[track]}},
  enumerateDevices:async()=>[{deviceId:'simulation',kind:'audioinput',label:'Simulated microphone · no device access'}],
  recorder:()=>({state:'inactive',mimeType:'audio/wav',start(){this.state='recording';this.timer=setInterval(()=>this.ondataavailable?.({data:tone()}),200)},stop(){if(this.state!=='recording')return;clearInterval(this.timer);this.ondataavailable?.({data:tone()});this.state='inactive';this.onstop?.()}})
}
const encodeDemo=async()=>tone()
function createDemo(){
  let attempt,failSave=false
  const questions=[{id:'q1',part:1,text:'What do you enjoy learning in your free time?',seconds:30,preparationSeconds:0},{id:'q2',part:2,text:'Describe a useful skill you learned.\nSay what it is, how you learned it and why it matters to you.',seconds:120,preparationSeconds:60},{id:'q3',part:3,text:'How could schools prepare students for lifelong learning?',seconds:45,preparationSeconds:0}]
  const sample={id:'sample',title:'Learning and practical skills',studentName:'Demo learner',mode:'practice',status:'submitted',nextIndex:3,questions,answers:questions.map((q,index)=>({questionId:q.id,index,duration:1})),startedAt:1795000000000,aiStatus:'completed',report:{estimatedBand:5.5,summary:'Sample report layout only. These scores and transcripts are illustrative and were not generated from a student recording.',criteria:Object.fromEntries(Object.keys(speakingLabels).map((k,i)=>[k,{band:[6,5,5,6][i],explanation:'Illustrative feedback: support this criterion with evidence from the actual recording after assessment.'}])),priorities:['Develop an answer with a reason and one concrete example.','Practise linking ideas naturally and checking verb endings.'],answers:questions.map(q=>({questionId:q.id,transcript:'I enjoy learning practical skills because they help me in everyday life.',feedback:'Sample feedback only; no AI assessment was performed.',corrections:[]}))}}
  const api=async(op,data={})=>{
    if(op==='start'){attempt={id:'demo',title:'Local recording demonstration',mode:data.mockId?'mock':'practice',questions,answers:[],nextIndex:0,status:'recording',current:null,startedAt:demoRuntime.now(),serverNow:demoRuntime.now()};return structuredClone(attempt)}
    if(op==='beginQuestion'){const q=attempt.questions[attempt.nextIndex],startedAt=demoRuntime.now();attempt.current={startedAt,recordAt:startedAt+8000+q.preparationSeconds*1000,deadline:startedAt+8000+(q.preparationSeconds+q.seconds)*1000};return {...attempt.current,serverNow:demoRuntime.now()}}
    if(op==='saveAnswer'){if(failSave){failSave=false;throw Error('Simulated connection failure. Your recording is retained on this device.')}attempt.answers.push({questionId:questions[attempt.nextIndex].id,duration:1});attempt.nextIndex++;attempt.current=null;return structuredClone(attempt)}
    if(op==='submit'){attempt.status='submitted';return structuredClone(attempt)}
    if(op==='get')return structuredClone(sample)
    if(op==='audio'){const bytes=new Uint8Array(await tone().arrayBuffer());return {audio:btoa(Array.from(bytes,c=>String.fromCharCode(c)).join('')),mimeType:'audio/wav'}}
    if(op==='review')return {...data,band:Math.round(Object.values(data.criteria).reduce((s,n)=>s+n,0)/4*2)/2}
    throw Error('This action is not enabled in the local demonstration.')
  }
  api.failNextSave=()=>{failSave=true}
  return api
}
export default function SpeakingPreview(){
  const [tab,setTab]=useState('editor'),[config,setConfig]=useState(defaultMockSpeakingConfig),[api]=useState(createDemo),[finished,setFinished]=useState(false)
  return <div className="min-h-screen bg-slate-50 text-slate-900"><header className="bg-white border-b px-5 py-5"><div className="max-w-5xl mx-auto"><p className="text-sm font-bold text-indigo-700">MAXIMA · LOCAL SPEAKING PREVIEW</p><h1 className="text-2xl font-bold mt-2">Speaking çalışma alanı</h1><p className="text-sm text-slate-600 mt-3">Yalnız yerel demo. Mikrofon açılmaz, sunucuya veri gönderilmez, kredi harcanmaz. Rapor örnek veridir. Zamanlayıcı inceleme için 20 kat hızlıdır; ses sorusu okuma kapalıdır.</p><div className="flex flex-wrap gap-2 mt-5">{[['editor','Öğretmen · Mock ayarı'],['practice','Öğrenci · pratik'],['mock','Otomatik Mock'],['report','Rapor / öğretmen notu']].map(([id,label])=><button key={id} onClick={()=>{setTab(id);setFinished(false)}} className={`rounded-xl px-4 py-2 text-sm ${id===tab?'bg-indigo-700 text-white':'border'}`}>{label}</button>)}</div></div></header><main className="max-w-5xl mx-auto p-5 sm:p-8">{tab==='editor'?<div className="rounded-2xl bg-white border p-5"><h2 className="text-lg font-semibold">Mock’a isteğe bağlı Speaking ekle</h2><p className="mt-2 text-sm text-slate-500">Kapalı bırakılan Mock’lar mevcut akışla çalışır. Soruları düzenleyebilir, ekleyebilir ve sürelerini belirleyebilirsin.</p><SpeakingEditor value={config} onChange={setConfig} optional full/></div>:tab==='report'?<SpeakingReport key="sample" attemptId="sample" staff api={api}/>:<><p className="rounded-xl bg-amber-50 text-amber-900 p-4 mb-4 text-sm">Bu ekrandaki “Test microphone” düğmesi yalnız sentetik bir ses üretir. Gerçek cihaz mikrofonuna erişmez.</p><button type="button" className="mb-4 border rounded-lg px-4 py-2 text-sm" onClick={()=>api.failNextSave()}>Sonraki kayıtta bağlantı hatası dene</button><SpeakingSession key={tab} taskId="demo-task" mockId={tab==='mock'?'demo-mock':undefined} api={api} runtime={demoRuntime} encode={encodeDemo} onComplete={()=>setFinished(true)}/>{finished&&<p role="status" className="text-emerald-800 mt-4">Demo tamamlandı. Gerçek öğrenci kaydı oluşturulmadı.</p>}</>}</main></div>
}
