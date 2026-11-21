import { useEffect, useRef, useState } from 'react'
import { speakingApi, speakingLabels, speakingTime } from '../../services/speakingApi'
export default function SpeakingReport({attemptId,staff=false,admin=false,aiAvailable=false,api=speakingApi,onRetake}) {
  const [allowRetakeAi,setAllowRetakeAi]=useState(false)
  const [attempt,setAttempt]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [consent,setConsent]=useState(false),[criteria,setCriteria]=useState({}),[feedback,setFeedback]=useState(''),[urls,setUrls]=useState({}),[recoveryReason,setRecoveryReason]=useState('')
  const created=useRef([]),alive=useRef(true),evaluationInFlight=useRef(false)
  const [assessmentPending,setAssessmentPending]=useState(false)
  const remoteProcessing=!assessmentPending&&!attempt?.report&&attempt?.aiStatus==='processing'
  useEffect(()=>{let active=true;alive.current=true;api('get',{attemptId,staff}).then(a=>{if(!active)return;setAttempt(a);setCriteria(a.review?.criteria||{});setFeedback(a.review?.feedback||'')}).catch(e=>{if(active)setError(e.message)})
    return()=>{active=false;alive.current=false;created.current.forEach(u=>URL.revokeObjectURL(u));created.current=[]}
  },[attemptId,staff,api])
  const action=async fn=>{setBusy(true);setError('');try{await fn()}catch(e){setError(e.message||'The request failed.')}finally{setBusy(false)}}
  useEffect(()=>{
    if(!remoteProcessing)return
    let stopped=false,timer
    const check=async()=>{
      try{
        const latest=await api('get',{attemptId,staff})
        if(stopped)return
        setAttempt(latest);setError('')
        if(latest.aiStatus==='processing'&&!latest.report)timer=setTimeout(check,3000)
      }catch(e){if(!stopped){setError(e.message||'Could not check assessment status. Retrying…');timer=setTimeout(check,6000)}}
    }
    timer=setTimeout(check,1500)
    return()=>{stopped=true;clearTimeout(timer)}
  },[remoteProcessing,attemptId,staff,api])
  const evaluate=async()=>{
    if(evaluationInFlight.current||busy||!consent)return
    evaluationInFlight.current=true;setAssessmentPending(true);setBusy(true);setError('')
    setAttempt(v=>({...v,aiStatus:'processing'}))
    try{
      const result=await api('evaluate',{attemptId,consent:true})
      if(alive.current)setAttempt(v=>({...v,report:result,aiStatus:'completed'}))
    }catch(e){
      if(alive.current)setError(e.message||'The assessment request could not be completed.')
      try{const latest=await api('get',{attemptId,staff});if(alive.current)setAttempt(latest)}catch{/* Keep checking the saved server status without creating another AI request. */}
    }finally{evaluationInFlight.current=false;if(alive.current){setAssessmentPending(false);setBusy(false)}}
  }
  const loadAudio=q=>action(async()=>{const r=await api('audio',{attemptId,questionId:q.id,staff});const bytes=Uint8Array.from(atob(r.audio),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:r.mimeType}));created.current.push(url);setUrls(v=>({...v,[q.id]:url}))})
  if(!attempt)return <section className="rounded-xl bg-white p-6 border"><p role={error?'alert':'status'}>{error||'Loading Speaking report…'}</p></section>
  if(assessmentPending||remoteProcessing)return <section aria-busy="true" className="rounded-2xl border border-indigo-100 bg-white px-6 py-12 text-center shadow-sm sm:px-10 sm:py-16">
    <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-indigo-50"><svg aria-hidden="true" className="h-10 w-10 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none"><circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3"/><path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg></div>
    <div role="status" aria-live="polite"><h2 className="text-xl font-bold text-slate-900">AI is reviewing your Speaking</h2><p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-600">Analysing your recordings and preparing your score, transcript and feedback.</p></div>
    <p className="mt-5 text-sm text-indigo-800">Please keep this page open. Your report will appear automatically when it is ready.</p>
    <p className="mt-2 text-xs text-slate-500">Your recordings are already saved.</p>
    {error&&<p role="alert" className="mx-auto mt-5 max-w-lg rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
  </section>
  const report=attempt.report
  return <section className="rounded-2xl border bg-white p-5 sm:p-8 space-y-6">
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-xl font-bold">{attempt.title}</h2><p className="text-sm text-slate-500 mt-1">{attempt.mode==='mock'?'Mock Speaking':'Speaking practice'} · {attempt.status}</p></div><div className="text-right"><p className="text-xs text-slate-500">Teacher band</p><p className="text-3xl font-bold text-indigo-800">{attempt.review?.band?.toFixed(1)||'Pending'}</p></div></div>
    <button type="button" disabled={busy} className="text-sm text-indigo-700 disabled:opacity-50" onClick={()=>action(async()=>{setAttempt(await api('get',{attemptId,staff}))})}>Refresh report</button>
    {attempt.taskId&&!attempt.mockId&&attempt.status!=='recording'&&<div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-600">Submitted answers are locked. A new attempt requires your teacher’s permission.</p>
      {staff?<><label className="mt-3 flex items-start gap-2 text-sm text-slate-600"><input type="checkbox" checked={allowRetakeAi} disabled={busy||attempt.retakeAvailable||attempt.isLatestAttempt===false} onChange={e=>setAllowRetakeAi(e.target.checked)}/>Allow one paid AI assessment for this retake (optional)</label><button type="button" disabled={busy||attempt.retakeAvailable||attempt.isLatestAttempt===false} className="mt-3 rounded-xl border border-indigo-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 disabled:opacity-50" onClick={()=>action(async()=>{await api('allowRetake',{attemptId,allowAi:allowRetakeAi});setAttempt(v=>({...v,retakeAvailable:true}))})}>{attempt.isLatestAttempt===false?'Open the latest report to allow a retake':attempt.retakeAvailable?'Retake available':'Allow retake'}</button></>:attempt.retakeAvailable&&onRetake&&<button type="button" className="mt-3 rounded-xl bg-indigo-700 px-4 py-2 text-sm font-semibold text-white" onClick={()=>onRetake(attempt)}>Start teacher-approved retake</button>}
    </div>}
    {error&&<p role="alert" className="bg-red-50 text-red-800 rounded-xl p-3">{error}</p>}
    {attempt.review?.feedback&&<p className="rounded-xl bg-emerald-50 p-4 whitespace-pre-wrap">{attempt.review.feedback}</p>}
    {report?<><div className="rounded-xl bg-indigo-50 p-5"><p className="text-xs font-semibold uppercase text-indigo-700">AI practice estimate · unofficial</p><p className="text-4xl font-bold text-indigo-900 my-3">{report.estimatedBand?.toFixed(1) || (report.criteria ? 'Overall band unavailable' : 'Insufficient evidence')}</p><p className="text-sm leading-6">{report.criteria && report.estimatedBand == null ? 'An overall estimate requires four verified criterion scores. See each criterion below.' : report.summary}</p><p className="text-xs text-slate-500 mt-3">A limited practice sample is not an official full Speaking result. AI estimates do not replace the teacher's final band.</p></div>
      {report.criteria && <div className="space-y-3">{Object.entries(speakingLabels).map(([key, label]) => {
        const criterion = report.criteria[key]
        const evidence = criterion.evidence
        const index = evidence ? attempt.questions.findIndex(q => q.id === evidence.questionId) : -1
        return <details key={key} open={criterion.status === 'unverified' || undefined} className="border rounded-xl p-4">
          <summary className="cursor-pointer font-semibold">{label} <span className="float-right text-indigo-800">{criterion.band?.toFixed(1) ?? 'Unverified'}</span></summary>
          {index >= 0 && <figure className="mt-3 border-l-2 border-indigo-300 pl-3">
            <figcaption className="text-xs text-slate-600">From your answer · Part {attempt.questions[index].part} · Question {index + 1}</figcaption>
            <blockquote className="mt-1 text-sm">“{evidence.quote}”</blockquote>
          </figure>}
          <p className="mt-3 text-sm leading-6">{criterion.explanation}</p>
        </details>
      })}</div>}
      {report.priorities?.length>0&&<div className="rounded-xl bg-amber-50 p-4"><h3 className="font-semibold mb-2">Next steps</h3><ul className="list-disc pl-5 text-sm space-y-2">{report.priorities.map((p,i)=><li key={i}>{p}</li>)}</ul></div>}
    </>:<div className="rounded-xl bg-slate-50 p-4"><p className="text-sm">{attempt.aiStatus==='processing'?'AI assessment is processing. Refresh this report shortly.':attempt.aiStatus==='failed'?'AI assessment needs administrator attention. The recordings remain available for teacher review.':'No AI report has been requested.'}</p>
      {attempt.aiAssessmentBlockedReason&&<p className="mt-3 text-sm text-slate-600">{attempt.aiAssessmentBlockedReason}</p>}
      {!staff&&!attempt.aiAssessmentBlockedReason&&attempt.status!=='recording'&&attempt.aiStatus==='not_requested'&&<><label className="flex items-start gap-2 text-sm mt-3"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I agree to send these recordings and questions to OpenAI for this Speaking assessment using the institution’s AI allowance.</label><button type="button" className="mt-3 rounded-xl bg-indigo-700 text-white px-4 py-2 disabled:bg-slate-300" disabled={!consent||busy||!(aiAvailable||attempt.aiAvailable)} onClick={evaluate}>Assess Speaking with AI</button>{!(aiAvailable||attempt.aiAvailable)&&<p className="text-xs text-slate-500 mt-2">AI audio assessment has not been enabled. Teacher review remains available.</p>}</>}
    </div>}
    {admin&&attempt.aiStatus==='failed'&&<div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-semibold">AI assessment recovery</h3><p className="text-sm mt-2">Allow the student to request assessment again. This action does not call AI, change a grade or reset the daily quota. The student must consent again before a new paid request.</p><label className="block text-sm mt-3">Recovery reason<input aria-label="Recovery reason" className="block w-full rounded-lg border bg-white p-2 mt-1" maxLength={1000} value={recoveryReason} onChange={e=>setRecoveryReason(e.target.value)}/></label><button disabled={busy||recoveryReason.trim().length<5||attempt.aiRecoveryCount>=3} className="mt-3 rounded-lg bg-indigo-700 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={()=>action(async()=>{await api('allowAiRetry',{attemptId,reason:recoveryReason,expectedAiRequestedAt:attempt.aiRequestedAt});setAttempt(v=>({...v,aiStatus:'not_requested',aiRecoveryCount:(v.aiRecoveryCount||0)+1}))})}>Allow student to retry</button></div>}
    <div className="space-y-4">{attempt.questions.map((q,i)=>{const a=attempt.answers.find(v=>v.questionId===q.id),analysis=report?.answers?.find(v=>v.questionId===q.id);return <article key={q.id} className="rounded-xl border p-5"><h3 className="font-semibold">Part {q.part} · Question {i+1}</h3><p className="whitespace-pre-wrap text-sm text-slate-600 mt-2">{q.text}</p><div className="mt-4">{a?.duration>0?(urls[q.id]?<audio aria-label={`Question ${i+1} recording`} className="w-full" controls src={urls[q.id]}/>:<button type="button" className="border rounded-lg px-4 py-2 text-indigo-800 disabled:opacity-50" disabled={busy} onClick={()=>loadAudio(q)}>Listen to recording ({speakingTime(Math.round(a.duration))})</button>):<p className="text-sm text-slate-500">No recording submitted.</p>}</div>{a?.finishedEarly&&<p className="text-xs text-indigo-800 mt-2">The student chose to finish after the minimum one-minute recording time.</p>}{a?.interrupted&&<p className="text-xs text-amber-800 mt-2">Recording or upload was interrupted; teacher review recommended.</p>}{analysis&&<><h4 className="text-xs font-semibold uppercase mt-5 text-slate-500">Transcript · may contain recognition errors</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-7">{analysis.transcript||'No intelligible speech detected.'}</p><p className="mt-3 text-sm text-indigo-900">{analysis.feedback}</p>{analysis.corrections.map((c,n)=><div key={n} className="mt-3 rounded-lg bg-slate-50 p-3 text-sm"><p className="text-red-800">Original: {c.original}</p><p className="text-emerald-800 mt-1">Suggestion: {c.suggestion}</p><p className="text-slate-600 mt-1">{c.reason}</p></div>)}</>}</article>})}</div>
    {staff&&attempt.status!=='recording'&&<form className="border-t pt-6" onSubmit={e=>{e.preventDefault();action(async()=>{const r=await api('review',{attemptId,criteria,feedback});setAttempt(v=>({...v,review:r,status:'reviewed'}))})}}><h3 className="font-semibold mb-4">Teacher evaluation</h3><div className="grid sm:grid-cols-2 gap-4">{Object.entries(speakingLabels).map(([k,label])=><label key={k} className="text-sm">{label}<input required aria-label={label} type="number" min="0" max="9" step="0.5" className="block border rounded-lg p-2 w-full mt-1" value={criteria[k]??''} onChange={e=>setCriteria(v=>({...v,[k]:e.target.value===''?'':Number(e.target.value)}))}/></label>)}</div><label className="block text-sm mt-4">Feedback<textarea aria-label="Teacher feedback" maxLength={6000} className="block border rounded-xl w-full p-3 mt-1 min-h-24" value={feedback} onChange={e=>setFeedback(e.target.value)}/></label><button type="submit" disabled={busy} className="mt-4 bg-indigo-700 text-white rounded-xl px-5 py-3 disabled:opacity-50">Save teacher evaluation</button></form>}
  </section>
}
