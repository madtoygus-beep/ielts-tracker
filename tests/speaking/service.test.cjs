'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createSpeakingService}=require('../../functions/lib/speaking/service')
const {config,validateWav,report,mockOverall,CRITERIA}=require('../../functions/lib/speaking/policy')
const {mockSpeakingLink}=require('../../functions/lib/speaking/mockLink')
class Fault extends Error{constructor(code,message){super(message);this.code=code}}
const question={part:1,text:'What do you enjoy learning?',seconds:30}
const full={enabled:true,questions:[question,{part:2,text:'Describe a skill you learned.',seconds:120},{part:3,text:'How should schools teach practical skills?',seconds:60}]}
function wav(seconds=1,silent=false){const b=Buffer.alloc(44+seconds*32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);if(!silent)for(let i=44;i<b.length;i+=2)b.writeInt16LE(Math.round(Math.sin(i/25)*4000),i);return b.toString('base64')}
function world(){
  let time=100000,providerCalls=0,allowed=true
  const docs=new Map([
    ['users/S1',{role:'student',status:'approved',schoolId:'maxima'}],
    ['schools/maxima',{status:'active'}],
    ['mockTests/mock1',{schoolId:'maxima',teacherId:'T1'}],
    ['studentAccess/S1_mock_mock1',{uid:'S1',schoolId:'maxima',contentType:'mock',contentId:'mock1',sourceCollection:'mockTests',status:'active',accessType:'assignment'}],
    ['users/T1',{role:'teacher',status:'approved',schoolId:'maxima'}],
    ['speakingTasks/task1',{title:'Learning',schoolId:'maxima',teacherId:'T1',assignedTo:['S1'],config:config({enabled:true,questions:[question]})}]
  ]),objects=new Map()
  const snapshot=path=>({id:path.split('/').at(-1),exists:docs.has(path),data:()=>structuredClone(docs.get(path))})
  const doc=path=>({path,id:path.split('/').at(-1),get:async()=>snapshot(path),set:async(v,opts)=>docs.set(path,opts?.merge?{...docs.get(path),...v}:structuredClone(v)),update:async v=>docs.set(path,{...docs.get(path),...structuredClone(v)})})
  let queue=Promise.resolve()
  const db={doc,runTransaction:fn=>{const result=queue.then(async()=>{const writes=[];const tx={get:async ref=>snapshot(ref.path),getAll:async(...refs)=>refs.map(r=>snapshot(r.path)),create:(r,v)=>{assert(!docs.has(r.path));writes.push([r.path,v])},set:(r,v)=>writes.push([r.path,v]),update:(r,v)=>writes.push([r.path,{...docs.get(r.path),...v}])};const value=await fn(tx);writes.forEach(([p,v])=>docs.set(p,structuredClone(v)));return value});queue=result.catch(()=>{});return result}}
  const bucket={file:path=>({save:async(bytes,opts)=>{assert.equal(opts.metadata.metadata.firebaseStorageDownloadTokens,undefined);objects.set(path,Buffer.from(bytes))},download:async()=>[objects.get(path)]})}
  const requireStudent=async req=>{if(!req.auth?.uid)throw new Fault('unauthenticated','Sign in');return {uid:req.auth.uid,schoolId:'maxima',profile:{role:'student',schoolId:'maxima',name:'Synthetic learner'}}}
  const manager={uid:'T1',profile:{role:'teacher',schoolId:'maxima'}}
  const service=createSpeakingService({db,bucket,HttpsError:Fault,requireStudent,requireAssignmentManager:async req=>{if(req.auth?.uid!=='T1')throw new Fault('permission-denied','Staff only');return manager},schoolIdOf:p=>p?.schoolId||'maxima',requireAssignedMock:async()=>({title:'Mock',teacherId:'T1',schoolId:'maxima',speakingConfig:full}),requireCurrentTeacherAcademicStudent:async()=>{if(!allowed)throw new Fault('permission-denied','Revoked')},now:()=>time,aiEnabled:()=>true,provider:async()=>{providerCalls++;return {estimatedBand:5,summary:'Synthetic audio evaluation',criteria:{},answers:[]}}})
  const call=(op,data={},uid='S1')=>service.call({auth:{uid},data:{op,...data}})
  return {docs,objects,db,service,call,advance:ms=>{time+=ms},revoke:()=>{allowed=false},calls:()=>providerCalls,student:{uid:'S1',profile:{name:'Synthetic learner'},schoolId:'maxima'}}
}
async function complete(w){let a=await w.call('start',{taskId:'task1'});await w.call('beginQuestion',{attemptId:a.id});a=await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()});return w.call('submit',{attemptId:a.id})}
const rejected=(p,code)=>assert.rejects(p,e=>e.code===code)
test('configuration: legacy mocks opt out; full Speaking requires all parts in order',()=>{assert.equal(config(undefined).enabled,false);assert.throws(()=>config({enabled:true,questions:[question]},true));assert.throws(()=>config({...full,questions:[...full.questions].reverse()},true));assert.equal(config(full,true).questions[1].preparationSeconds,60)})
test('audio header, exact length, duration and speech energy are checked',()=>{assert.equal(validateWav(wav()).duration,1);assert.equal(validateWav(wav(1,true)).audible,false);assert.throws(()=>validateWav(Buffer.from('not audio').toString('base64')));const corrupt=Buffer.from(wav(),'base64');corrupt.writeUInt32LE(44100,24);assert.throws(()=>validateWav(corrupt.toString('base64')));assert.throws(()=>validateWav(wav(131)))})
test('student cannot start an unassigned task or impersonate another learner',async()=>{const w=world();await rejected(w.call('start',{taskId:'task1'},'S2'),'permission-denied');const a=await w.call('start',{taskId:'task1'});await rejected(w.call('get',{attemptId:a.id},'S2'),'permission-denied')})
test('live teacher membership revocation blocks existing attempt/audio',async()=>{const w=world(),a=await complete(w);w.revoke();await rejected(w.call('get',{attemptId:a.id}),'permission-denied');await rejected(w.call('audio',{attemptId:a.id,questionId:'q1'}),'permission-denied')})
test('staff-only operations reject student callers',async()=>{const w=world();await rejected(w.call('saveTask',{title:'x',config:full}),'permission-denied');const a=await complete(w);await rejected(w.call('review',{attemptId:a.id,criteria:{}}),'permission-denied')})
test('source snapshot and optional unassigned task are saved without granting all students access',async()=>{const w=world();const t=await w.call('saveTask',{title:'Library only',config:full,assignedTo:[]},'T1');assert.deepEqual(w.docs.get(`speakingTasks/${t.id}`).assignedTo,[]);await rejected(w.call('start',{taskId:t.id}),'permission-denied')})
test('practice: save audio privately, reuse identical retry, then lock submitted answer',async()=>{const w=world();const a=await w.call('start',{taskId:'task1'});await w.call('beginQuestion',{attemptId:a.id});const body={attemptId:a.id,index:0,audio:wav()};const first=await w.call('saveAnswer',body);assert.equal(first.answers[0].storagePath,undefined);assert.equal(first.answers[0].path,undefined);assert.equal(first.answers[0].sha256,undefined);await w.call('saveAnswer',body);assert.equal(w.objects.size,1);await w.call('submit',{attemptId:a.id});const blob=await w.call('audio',{attemptId:a.id,questionId:'q1'});assert.equal(blob.audio,wav());await rejected(w.call('saveAnswer',{...body,audio:wav(2)}),'failed-precondition')})
test('resume uses the same practice attempt, rejects mismatched task',async()=>{const w=world(),a=await w.call('start',{taskId:'task1'});assert.equal((await w.call('start',{taskId:'task1',attemptId:a.id})).id,a.id);await rejected(w.call('start',{taskId:'other',attemptId:a.id}),'permission-denied')})
test('cannot submit an incomplete practice attempt',async()=>{const w=world(),a=await w.call('start',{taskId:'task1'});await rejected(w.call('submit',{attemptId:a.id}),'failed-precondition')})
test('mock start is idempotent; early recording replacement and skipping questions are refused',async()=>{const w=world();const a=await w.call('start',{mockId:'mock1'});const b=await w.call('start',{mockId:'mock1'});assert.equal(a.id,b.id);const c=await w.call('beginQuestion',{attemptId:a.id});assert.equal(c.deadline-c.recordAt,30000);await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()}),'failed-precondition');w.advance(40000);const next=await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()});assert.equal(next.nextIndex,1);await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(2)}),'failed-precondition')})
test('mock Part 2 gets server-owned preparation and recording deadlines',async()=>{const w=world(),a=await w.call('start',{mockId:'mock1'});await w.call('beginQuestion',{attemptId:a.id});w.advance(40000);await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()});const p2=await w.call('beginQuestion',{attemptId:a.id});assert.equal(p2.recordAt-p2.startedAt,68000);assert.equal(p2.deadline-p2.recordAt,120000)})
test('student consent and concurrency limit prevent a duplicate paid evaluation',async()=>{const w=world(),a=await complete(w);await rejected(w.call('evaluate',{attemptId:a.id,consent:false}),'failed-precondition');const results=await Promise.allSettled([w.call('evaluate',{attemptId:a.id,consent:true}),w.call('evaluate',{attemptId:a.id,consent:true})]);assert.equal(w.calls(),1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await w.call('evaluate',{attemptId:a.id,consent:true});assert.equal(w.calls(),1)})
test('silent audio cannot produce a fabricated AI grade',async()=>{const w=world();const a=await w.call('start',{taskId:'task1'});await w.call('beginQuestion',{attemptId:a.id});await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(1,true)});await w.call('submit',{attemptId:a.id});await rejected(w.call('evaluate',{attemptId:a.id,consent:true}),'failed-precondition');assert.equal(w.calls(),0)})
test('four independent teacher criterion bands determine final Speaking; AI cannot override them',async()=>{const w=world(),a=await complete(w);const criteria=Object.fromEntries(CRITERIA.map((k,i)=>[k,[6,6,5,5][i]]));const result=await w.call('review',{attemptId:a.id,criteria,feedback:'Synthetic teacher feedback'},'T1');assert.equal(result.band,5.5);const saved=w.docs.get(`speakingAttempts/${a.id}`);assert.equal(saved.review.band,5.5);await w.call('evaluate',{attemptId:a.id,consent:true});assert.equal(w.docs.get(`speakingAttempts/${a.id}`).review.band,5.5)})
test('AI output validation rejects invented correction quotations and keeps low independent bands',()=>{const raw={assessable:true,criteria:Object.fromEntries(CRITERIA.map((k,i)=>[k,{band:[2,3,3,4][i],explanation:'Synthetic evidence'}])),answers:[{questionId:'q1',transcript:'I enjoy learning',feedback:'Synthetic feedback',corrections:[]}],summary:'Limited sample',priorities:[]};assert.equal(report(raw,['q1']).estimatedBand,3);raw.answers[0].corrections=[{original:'not spoken',suggestion:'Replacement',reason:'Error'}];assert.throws(()=>report(raw,['q1']));raw.answers[0].corrections=[];assert.equal(report({...raw,assessable:false,criteria:null},['q1']).estimatedBand,null)})
test('optional Speaking prevents an incomplete four-skill overall while legacy averages remain unchanged',()=>{const r={listening:{band:6},reading:{band:7},writing:{band:5}};assert.equal(mockOverall(r),6);assert.equal(mockOverall({...r,speaking:{enabled:true,band:null}}),null);assert.equal(mockOverall({...r,speaking:{enabled:true,band:8}}),6.5)})
test('legacy Mock submit has no Speaking requirement; enabled unfinished Speaking blocks normal submit',async()=>{const w=world();assert.equal(await mockSpeakingLink({db:w.db,mock:{},student:w.student,mockId:'m',HttpsError:Fault}),null);await rejected(mockSpeakingLink({db:w.db,mock:{speakingConfig:full},student:w.student,mockId:'m',HttpsError:Fault}),'failed-precondition')})
test('forced Mock submit preserves and closes a linked unfinished Speaking attempt',async()=>{const w=world();const a=await w.call('start',{mockId:'mock1'});const linked=await mockSpeakingLink({db:w.db,mock:{speakingConfig:full},student:w.student,mockId:'mock1',autoSubmitted:true,HttpsError:Fault});assert.equal(linked.attemptId,a.id);assert.equal(w.docs.get(`speakingAttempts/${a.id}`).status,'submitted');await rejected(w.call('beginQuestion',{attemptId:a.id}),'failed-precondition')})
test('authorization is rechecked inside the write transaction after a stale preflight',async()=>{
 const w=world(),a=await w.call('start',{taskId:'task1'}),original=w.db.runTransaction
 w.db.runTransaction=fn=>{w.docs.get('users/S1').status='deleted';return original(fn)}
 await rejected(w.call('beginQuestion',{attemptId:a.id}),'permission-denied')
 assert.equal(w.docs.get(`speakingAttempts/${a.id}`).current,null)
})
test('unassigned old recipients are preserved when the teacher saves a library edit',async()=>{
 const w=world();w.revoke();await w.call('saveTask',{id:'task1',title:'Edited',config:full,assignedTo:[]},'T1')
 assert.deepEqual(w.docs.get('speakingTasks/task1').assignedTo,['S1'])
})
test('daily practice quota blocks new attempts but an existing attempt can resume',async()=>{
 const w=world(),a=await w.call('start',{taskId:'task1'});w.docs.set('speakingAttemptUsage/S1_1970-01-01',{attempts:20})
 await rejected(w.call('start',{taskId:'task1'}),'resource-exhausted');assert.equal((await w.call('start',{taskId:'task1',attemptId:a.id})).id,a.id)
})
test('Mock teacher review updates only the matching current score and four-skill Overall',async()=>{
 const w=world();let a=await w.call('start',{mockId:'mock1'})
 for(let i=0;i<3;i++){await w.call('beginQuestion',{attemptId:a.id});w.advance(300000);a=await w.call('saveAnswer',{attemptId:a.id,index:i,audio:wav()})}
 await w.call('submit',{attemptId:a.id});const result={listening:{band:6},reading:{band:7},writing:{band:5},speaking:{enabled:true,band:null}}
 w.docs.set('mockSubmissions/S1_mock1',{speakingAttemptId:a.id,attemptNumber:1,result})
 w.docs.set('scores/S1_mock1',{uid:'S1',studentId:'S1',schoolId:'maxima',mockTestId:'mock1',attemptNumber:1})
 const criteria=Object.fromEntries(CRITERIA.map(k=>[k,8]));await w.call('review',{attemptId:a.id,criteria},'T1')
 assert.equal(w.docs.get('mockSubmissions/S1_mock1').result.overall,6.5);assert.equal(w.docs.get('scores/S1_mock1').speaking,8)
 w.docs.get('scores/S1_mock1').uid='different';w.docs.get('scores/S1_mock1').studentId='different'
 await w.call('review',{attemptId:a.id,criteria:Object.fromEntries(CRITERIA.map(k=>[k,7]))},'T1');assert.equal(w.docs.get('scores/S1_mock1').speaking,8)
})
test('retake gets a different server-owned attempt and old audio cannot grade the new Mock',async()=>{
 const w=world(),a=await w.call('start',{mockId:'mock1'}),{createHash}=require('node:crypto')
 w.docs.set('mockSubmissions/S1_mock1',{attemptNumber:1,speakingAttemptId:a.id})
 const control=createHash('sha256').update('S1\u001fmock\u001fmock1').digest('hex')
 await rejected(w.call('start',{mockId:'mock1'}),'failed-precondition')
 w.docs.set(`submissionAttemptControls/${control}`,{status:'open'});const b=await w.call('start',{mockId:'mock1'});assert.notEqual(a.id,b.id)
 assert.equal(w.docs.get(`speakingAttempts/${b.id}`).mockAttempt,2)
})
