import { useAttemptGeneration } from '../../hooks/useAttemptGeneration'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { auth } from '../../firebase'
import { speakingApi, speakingTime } from '../../services/speakingApi'
import { browserSpeakingRuntime } from '../../services/speakingRecorderRuntime'
import { wavFromBlob, wavHasSignal, blobBase64, outbox } from '../../services/speakingAudio'
import SpeakingTestLayout from './SpeakingTestLayout'

export default function SpeakingSession({taskId,mockId,title,config,mode,onComplete,api=speakingApi,runtime=browserSpeakingRuntime,encode=wavFromBlob}) {
  const attemptGeneration = useAttemptGeneration()
  const [attempt,setAttempt]=useState(null),[phase,updatePhase]=useState('check'),[error,setError]=useState('')
  const [devices,setDevices]=useState([]),[deviceId,setDeviceId]=useState(''),[checked,setChecked]=useState(false)
  const [blob,setBlob]=useState(null),[url,setUrl]=useState(''),[seconds,setSeconds]=useState(0),[recordedSeconds,setRecordedSeconds]=useState(0)
  const [current,setCurrent]=useState(null),[readQuestions,setReadQuestions]=useState(runtime===browserSpeakingRuntime),[notice,setNotice]=useState('')
  const recorder=useRef(null),stream=useRef(null),chunks=useRef([]),recordingStarted=useRef(0)
  const live=useRef(true),busy=useRef(false),offset=useRef(0),phaseRef=useRef(phase),attemptRef=useRef(attempt)
  const currentRef=useRef(current),rawKey=useRef(null),interrupted=useRef(false),finishedEarly=useRef(false)
  const setPhase=value=>{phaseRef.current=value;updatePhase(value)}
  useEffect(()=>{phaseRef.current=phase;attemptRef.current=attempt;currentRef.current=current},[phase,attempt,current])
  const key=a=>`${auth.currentUser?.uid||'local-demo'}:${a.id}:${a.nextIndex}`
  const clock=()=>runtime.now()+offset.current
  useEffect(()=>{live.current=true;return()=>{
    live.current=false;if(recorder.current?.state==='recording')recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());window.speechSynthesis?.cancel()
  }},[])
  // Object URLs are external browser resources, created and revoked with the Blob lifecycle.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{if(!blob){setUrl('');return}const value=URL.createObjectURL(blob);setUrl(value);return()=>URL.revokeObjectURL(value)},[blob])
  const getMic=async()=>{
    if(!runtime.available())throw Error('This browser does not support microphone recording. Try a current Safari or Chrome browser.')
    if(stream.current?.getAudioTracks().some(t=>t.readyState==='live'))return stream.current
    stream.current=await runtime.getUserMedia({audio:deviceId?{deviceId:{exact:deviceId}}:true})
    if(!live.current){stream.current.getTracks().forEach(t=>t.stop());throw Error('Recording screen was closed.')}
    stream.current.getAudioTracks().forEach(t=>t.addEventListener('ended',()=>{interrupted.current=true;if(recorder.current?.state==='recording')recorder.current.stop()}))
    setDevices((await runtime.enumerateDevices()).filter(d=>d.kind==='audioinput'))
    return stream.current
  }
  const stop=()=>{if(recorder.current?.state==='recording')recorder.current.stop()}
  const handleTeacherRestart=error=>{
    if(!/teacher restarted|newer Speaking attempt/i.test(error?.message||''))return false
    // Preserve old outbox blobs under their old attempt ID; the next start
    // resolves the server's new head instead of retrying that closed session.
    if(recorder.current){recorder.current.onstop=null;stop()}
    stream.current?.getTracks().forEach(track=>track.stop());window.speechSynthesis?.cancel()
    if(!mockId)sessionStorage.removeItem(`speaking-active-${auth.currentUser?.uid}-${taskId}`)
    rawKey.current=null;attemptRef.current=null;currentRef.current=null
    setAttempt(null);setCurrent(null);setBlob(null);setChecked(false);setPhase('check')
    setError('Your teacher restarted this attempt. Check your microphone, then start the fresh attempt.')
    return true
  }
  const micStarting=useRef(false)
  const record=async(test=false)=>{
    if(micStarting.current||recorder.current?.state==='recording')return
    micStarting.current=true
    let mic
    try{mic=await getMic()}finally{micStarting.current=false}
    if(!live.current)return
    chunks.current=[];recordingStarted.current=runtime.now();interrupted.current=false;finishedEarly.current=false;setRecordedSeconds(0)
    const instance=runtime.recorder(mic);recorder.current=instance
    const a=attemptRef.current;rawKey.current=!test&&a?key(a):null
    instance.onstart=()=>{recordingStarted.current=runtime.now()}
    instance.ondataavailable=e=>{
      if(e.data.size)chunks.current.push(e.data)
      if(rawKey.current&&chunks.current.length)outbox(rawKey.current,{kind:'raw',blob:new Blob(chunks.current,{type:instance.mimeType}),interrupted:true,finishEarly:finishedEarly.current}).catch(()=>{if(live.current)setNotice('Recovery storage is unavailable. Keep this page open until the recording is saved.')})
    }
    instance.onerror=()=>{interrupted.current=true;setError('Microphone recording was interrupted. The recorded portion will be preserved.');stop()}
    instance.onstop=async()=>{
      const raw=new Blob(chunks.current,{type:instance.mimeType})
      if(!live.current)return
      try{
        if(raw.size===0)throw Error('No audio was captured. Check the microphone and try again.')
        const wav=await encode(raw)
        if(!live.current)return
        setBlob(wav)
        if(test){if(!await wavHasSignal(wav)){setChecked(false);throw Error('No audible sound was captured. Speak during the microphone test and check the selected input.')}setChecked(true);setPhase('check');return}
        if(attemptRef.current.mode==='mock')await upload(wav,interrupted.current,finishedEarly.current)
        else setPhase('preview')
      }catch(e){if(live.current){setError(e.message);setPhase(test?'check':'recovery')}}
    }
    setBlob(null);setPhase(test?'testing':'recording');instance.start(1000)
  }
  const finish=async a=>{
    const result=await api('submit',{attemptId:a.id});if(!mockId)sessionStorage.removeItem(`speaking-active-${auth.currentUser?.uid}-${taskId}`);setAttempt(result);setPhase('done');onComplete?.(result)
    stream.current?.getTracks().forEach(t=>t.stop())
  }
  const next=async a=>{
    setAttempt(a);attemptRef.current=a;setBlob(null);currentRef.current=null;setCurrent(null)
    if(a.nextIndex>=a.questions.length){await finish(a);return}
    if(a.mode==='mock')await begin(a)
    else setPhase('ready')
  }
  const upload=async(wav,wasInterrupted=false,finishEarly=false)=>{
    if(busy.current)return
    busy.current=true;setError('');setPhase('uploading')
    const a=attemptRef.current
    try {
      const body={attemptId:a.id,index:a.nextIndex,audio:wav?await blobBase64(wav):'',interrupted:wasInterrupted,finishEarly}
      await outbox(key(a),{kind:'ready',body}).catch(()=>setNotice('Local recovery storage is unavailable; keep this page open while saving.'))
      const result=await api('saveAnswer',body)
      await outbox(key(a),null).catch(()=>{})
      busy.current=false;await next(result)
    } catch(e){busy.current=false;if(live.current&&!handleTeacherRestart(e)){setError(e.message||'Could not save. Your recording is retained on this device.');setPhase('recovery')}}
  }
  const begin=async(a,restartPreparation=false)=>{
    const value=await api('beginQuestion',{attemptId:a.id,restartPreparation})
    if(!live.current)return
    if(value.serverNow)offset.current=value.serverNow-runtime.now()
    currentRef.current=value;setCurrent(value);setAttempt({...a,current:value});attemptRef.current={...a,current:value};setPhase(a.mode==='mock'?'prompt':a.timedPart2?'preparing':'ready')
    if(a.mode==='mock'&&readQuestions&&window.speechSynthesis){
      window.speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(a.questions[a.nextIndex].text)
      utterance.lang='en-GB';utterance.rate=1;window.speechSynthesis.speak(utterance)
    }
  }
  const recover=async a=>{
    const saved=await outbox(key(a)).catch(()=>null)
    if(saved?.kind==='ready'){
      setPhase('uploading');const result=await api('saveAnswer',saved.body);await outbox(key(a),null);await next(result);return true
    }
    if(saved?.kind==='raw'){
      const wav=await encode(saved.blob);finishedEarly.current=saved.finishEarly===true;setBlob(wav);setPhase('recovery');setNotice('Recovered a recording from this device. Save it before continuing.');return true
    }
    return false
  }
  const start=async()=>{
    if(busy.current||micStarting.current)return;busy.current=true;setError('')
    try{
      await getMic()
      const a=await api('start',mockId?{mockId,attemptGeneration}:{taskId,attemptId:sessionStorage.getItem(`speaking-active-${auth.currentUser?.uid}-${taskId}`)||null});setAttempt(a);attemptRef.current=a
      // Remove local copies already acknowledged by the server, including a lost save response.
      for(let index=0;index<a.nextIndex;index++)await outbox(`${auth.currentUser?.uid||'local-demo'}:${a.id}:${index}`,null).catch(()=>{})
      if(a.serverNow)offset.current=a.serverNow-runtime.now()
      if(!mockId) sessionStorage.setItem(`speaking-active-${auth.currentUser?.uid}-${taskId}`,a.id)
      if(a.status!=='recording'){setPhase('done');onComplete?.(a);busy.current=false;return}
      if(await recover(a)){busy.current=false;return}
      setBlob(null) // The microphone check is not an answer recording.
      if(a.current){currentRef.current=a.current;setCurrent(a.current);setPhase(a.mode==='mock'?'prompt':a.timedPart2?'preparing':'ready')}
      else if(a.mode==='mock')await begin(a)
      else setPhase('ready')
    }catch(e){if(!handleTeacherRestart(e)){setError(e.message||'Could not start Speaking.');setPhase('check')}}
    finally{busy.current=false}
  }
  const retry=async()=>{setError('');try{if(attempt?.nextIndex>=attempt?.questions.length){if(busy.current)return;busy.current=true;setPhase('uploading');try{await finish(attempt)}finally{busy.current=false}return}if(blob)await upload(blob,true,finishedEarly.current);else if(attempt){if(!await recover(attempt))await upload(null,true)}}catch(e){setError(e.message);setPhase('recovery')}}
  const startPractice=async()=>{
    try{setError('');if(attempt.timedPart2){await outbox(key(attempt),null).catch(()=>{});finishedEarly.current=false;setBlob(null);await begin(attempt,true);return}if(!current)await begin(attempt);await record(false)}catch(e){setError(e.message)}
  }
  const tick=useEffectEvent(async()=>{
    if(busy.current)return
    const a=attemptRef.current,c=currentRef.current,p=phaseRef.current
    if(p==='testing'){setSeconds(Math.floor((runtime.now()-recordingStarted.current)/1000));if(runtime.now()-recordingStarted.current>3000)stop();return}
    if(!a)return
    if((a.mode==='mock'||a.timedPart2)&&c&&p==='recovery'){setSeconds(Math.ceil(Math.max(0,c.deadline-clock())/1000));return}
    if((a.mode==='mock'||a.timedPart2)&&c&&['prompt','preparing','recording'].includes(p)){
      const t=clock()
      if(p==='recording')setRecordedSeconds(Math.max(0,Math.floor((runtime.now()-recordingStarted.current)/1000)))
      if(t>=c.deadline){
        window.speechSynthesis?.cancel()
        if(p==='recording'&&recorder.current?.state==='recording'){setPhase('processing');stop()}
        else if(p!=='recording')await upload(null,true)
      } else if(t>=c.recordAt&&p!=='recording'){
        window.speechSynthesis?.cancel()
        busy.current=true;try{await record()}catch(e){setError(e.message);setPhase('recovery')}finally{busy.current=false}
      } else if(t>=c.startedAt+8000&&p==='prompt'){window.speechSynthesis?.cancel();setPhase('preparing')}
      setSeconds(Math.ceil(Math.max(0,(p==='prompt'?c.startedAt+8000:p==='preparing'?c.recordAt:c.deadline)-t)/1000))
    }else if(a.mode==='practice'&&p==='recording'){
      const elapsed=(runtime.now()-recordingStarted.current)/1000,limit=a.questions[a.nextIndex].seconds
      setSeconds(Math.max(0,Math.ceil(limit-elapsed)));if(elapsed>=limit){setPhase('processing');stop()}
    }
  })
  useEffect(()=>{const timer=setInterval(()=>{Promise.resolve(tick()).catch(e=>{if(live.current){setError(e.message);setPhase('recovery')}})},200);return()=>clearInterval(timer)},[])
  useEffect(()=>{
    const offline=()=>setNotice('You are offline. The recording continues on this device. Reconnect to save it; Mock time continues.')
    const unload=e=>{if(attemptRef.current?.status==='recording'&&phaseRef.current!=='done'){e.preventDefault();e.returnValue=''}}
    window.addEventListener('offline',offline);window.addEventListener('beforeunload',unload)
    return()=>{window.removeEventListener('offline',offline);window.removeEventListener('beforeunload',unload)}
  },[])
  const isMock=Boolean(mockId)||mode==='mock'||attempt?.mode==='mock'
  const q=attempt?.questions[attempt.nextIndex]
  const minimumRecording=q?.part===2?60:1
  const finishAnswer=()=>{
    if(phaseRef.current!=='recording'||recorder.current?.state!=='recording'||runtime.now()-recordingStarted.current<minimumRecording*1000)return
    finishedEarly.current=true;setPhase('processing');stop()
  }
  const checking=['check','testing'].includes(phase)
  const status={check:'Microphone check',testing:'Recording microphone test…',ready:attempt?.timedPart2?'Ready to prepare':'Ready to record',prompt:'Listen / read the question',preparing:'Preparation time',recording:'Recording…',processing:'Preparing recording…',uploading:'Saving your answer…',preview:'Listen to your answer',recovery:'Recording needs attention',done:'Speaking submitted'}[phase]
  return <SpeakingTestLayout
    title={title||attempt?.title} questions={attempt?.questions||config?.questions||[]}
    question={checking?null:q} questionIndex={attempt?.nextIndex||0} isMock={isMock}
    status={status} recording={phase==='recording'} complete={phase==='done'}
    timedPart2={attempt?.timedPart2}
    timer={['recording','preparing','prompt','testing'].includes(phase)?speakingTime(seconds):undefined}
    rightTitle={checking?'Microphone check':phase==='done'?'Submission':'Your answer'}
  >
    {notice&&<p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{notice}</p>}
    {error&&<p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {['check','testing'].includes(phase)?<div className="mt-6 space-y-5">
      <p className="text-slate-600">Record a short microphone test and listen back before starting. Your test recording stays on this device.</p>
      <label className="block text-sm">Microphone<select aria-label="Microphone" className="block w-full border rounded-xl p-3 mt-2" value={deviceId} onChange={e=>{stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;setDeviceId(e.target.value);setChecked(false)}}><option value="">Default microphone</option>{devices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.label||'Microphone'}</option>)}</select></label>
      <button type="button" disabled={phase==='testing'} className="rounded-xl bg-purple-600 text-white px-5 py-3 disabled:opacity-50" onClick={()=>record(true).catch(e=>setError(e.message))}>{phase==='testing'?'Recording microphone test…':'Test microphone'}</button>
      {url&&<audio className="w-full" aria-label="Microphone test playback" controls src={url}/>}
      {isMock&&<><p className="text-sm text-slate-600">Finish your answer to save it and continue, or let the question timer move you on. Saved answers cannot be recorded again. Part 2 includes one minute preparation and up to two minutes recording; you can finish after 60 seconds of speaking. Your recordings are private to you and authorised staff.</p><label className="flex gap-2 text-sm"><input type="checkbox" checked={readQuestions} onChange={e=>setReadQuestions(e.target.checked)}/>Read questions aloud using the browser voice</label></>}
      <button type="button" disabled={!checked||phase==='testing'} onClick={start} className="block w-full bg-purple-600 text-white rounded-xl px-5 py-3 disabled:bg-slate-200 disabled:text-slate-500">{isMock?'Start / resume Mock Speaking':'Continue to questions'}</button>
    </div>:phase==='done'?<div className="mt-8 rounded-xl bg-emerald-50 p-6 text-emerald-900"><h3 className="font-semibold">Speaking submitted</h3><p className="mt-2 text-sm">Your recordings have been saved. Open the Speaking report to listen back or view teacher feedback.</p></div>:<>
      {attempt?.timedPart2&&<p className="mt-4 rounded-xl bg-purple-50 p-3 text-sm text-purple-900">Start when ready. You get one minute to prepare, then 60–120 seconds to record. You can listen back or start a fresh preparation before saving.</p>}
      <div className={`my-6 rounded-xl border px-5 py-10 text-center ${phase==='recording'?'border-red-100 bg-red-50':'border-gray-100 bg-gray-50'}`}>
        <span aria-hidden="true" className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${phase==='recording'?'bg-red-100 text-red-600':'bg-purple-100 text-purple-600'}`}>
          <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>
        </span>
        <p className="mt-4 text-lg font-semibold text-gray-800">{status}</p>
        <p className="mt-2 text-sm leading-6 text-gray-500">{phase==='recording'?'Speak clearly. Keep this page open while your answer is recorded.':phase==='preparing'?'Use this time to plan your answer. Recording will start automatically.':phase==='prompt'?'Read or listen to the question. Recording will start automatically.':phase==='uploading'?'Your recording is being saved before the next question opens.':phase==='preview'?'Listen back, then save your answer or record it again.':isMock?'Your recording controls follow the question timer.':'Start when you are ready to answer.'}</p>
      </div>
      {url&&<audio className="w-full" aria-label="Answer playback" controls src={url}/>}
      {!isMock&&phase==='ready'&&<div className="flex flex-col items-center gap-3 py-4">
        <button type="button" onClick={startPractice} className="inline-flex min-h-14 items-center justify-center gap-3 rounded-xl bg-purple-600 px-8 py-4 font-semibold text-white shadow-lg shadow-purple-100 transition hover:bg-purple-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-200 focus-visible:ring-offset-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15"><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg></span>
          {attempt.timedPart2?'Start preparation (1 minute)':'Start recording'}
        </button>
        <p className="text-center text-sm text-slate-500">{attempt.timedPart2?'Recording starts automatically after your preparation minute.':'Start when you are ready. Stop recording when you finish your answer.'}</p>
      </div>}
      {!isMock&&!attempt?.timedPart2&&phase==='recording'&&<div className="flex justify-center py-4"><button type="button" onClick={()=>{setPhase('processing');stop()}} className="inline-flex min-h-14 items-center justify-center gap-3 rounded-xl bg-red-600 px-8 py-4 font-semibold text-white shadow-lg shadow-red-100 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-200 focus-visible:ring-offset-2"><svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor"><rect width="16" height="16" rx="3"/></svg>Stop recording</button></div>}
      {(isMock||attempt?.timedPart2)&&phase==='recording'&&<div className="mt-4 text-center">
        <button type="button" disabled={recordedSeconds<minimumRecording} className="rounded-xl bg-purple-600 text-white px-6 py-3 disabled:bg-slate-200 disabled:text-slate-500" onClick={finishAnswer}>{isMock?'Finish answer & continue':'Finish my answer'}</button>
        <p className="mt-3 text-sm text-slate-500">{q?.part===2&&recordedSeconds<60
          ?`You can finish your answer in ${speakingTime(60-recordedSeconds)}.`
          :isMock?'Your answer will be saved and locked. You cannot record it again.':'You may finish now, or continue until the two-minute limit.'}</p>
      </div>}
      {!isMock&&phase==='preview'&&<div className="flex gap-3 mt-5"><button type="button" className="border rounded-xl px-5 py-3" onClick={startPractice}>Record again</button><button type="button" className="bg-purple-600 text-white rounded-xl px-5 py-3" onClick={()=>upload(blob,interrupted.current,finishedEarly.current)}>Save answer & continue</button></div>}
      {phase==='recovery'&&isMock&&current&&<p className="mt-3 text-sm text-amber-900">The question timer continues: {speakingTime(seconds)}. Retry saving the recovered recording, or continue without audio after the timer ends.</p>}
      {phase==='recovery'&&<button type="button" className="bg-purple-600 text-white rounded-xl px-5 py-3" onClick={retry}>Retry saving / resume</button>}
      {phase==='recovery'&&!isMock&&attempt&&attempt.nextIndex<attempt.questions.length&&<button type="button" className="ml-3 border rounded-xl px-5 py-3" onClick={async()=>{if(!window.confirm('Discard this unsaved recording and record this question again?'))return;try{await outbox(key(attempt),null);setBlob(null);setError('');setPhase('ready')}catch(e){setError(e.message)}}}>Record this question again</button>}
      {phase==='recovery'&&isMock&&attempt&&attempt.nextIndex<attempt.questions.length&&<button type="button" disabled={seconds>0} className="mt-3 sm:ml-3 border rounded-xl px-5 py-3 disabled:opacity-50" onClick={()=>{if(window.confirm('Continue without audio for this question? Your teacher will see that no recording was submitted.'))upload(null,true)}}>Continue without audio</button>}
    </>}
  </SpeakingTestLayout>
}
