'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createSpeakingService}=require('../../functions/lib/speaking/service')
const {config,validateWav,report,mockOverall,CRITERIA}=require('../../functions/lib/speaking/policy')
const {mockSpeakingLink}=require('../../functions/lib/speaking/mockLink')
class Fault extends Error{constructor(code,message){super(message);this.code=code}}
const question={part:1,text:'What do you enjoy learning?',seconds:30}
const full={enabled:true,questions:[question,{part:2,text:'Describe a skill you learned.',seconds:120},{part:3,text:'How should schools teach practical skills?',seconds:60}]}
function wav(seconds=1,silent=false){const b=Buffer.alloc(44+seconds*32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);if(!silent)for(let i=44;i<b.length;i+=2)b.writeInt16LE(Math.round(Math.sin(i/25)*4000),i);return b.toString('base64')}
function world(options={}){
  let time=100000,providerCalls=0,allowed=true
  const docs=new Map([
    ['users/S1',{role:'student',status:'approved',schoolId:'maxima',name:'Synthetic learner'}],
    ['users/S2',{role:'student',status:'approved',schoolId:'maxima'}],
    ['users/T2',{role:'teacher',status:'approved',schoolId:'maxima',name:'Second teacher'}],
    ['users/A1',{role:'admin',status:'approved',schoolId:'maxima'}],
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
  db.collection=name=>{
    const filters=[];let cursor='',limit=Infinity
    const q={where(field,op,value){filters.push([field,op,value]);return q},orderBy(){return q},startAfter(ref){cursor=ref.id;return q},limit(n){limit=n;return q},async get(){const rows=[...docs.keys()].filter(p=>p.startsWith(name+'/')&&p.split('/').length===2&&p.split('/').at(-1)>cursor).sort().filter(p=>filters.every(([k,op,v])=>op==='=='?docs.get(p)[k]===v:docs.get(p)[k]?.includes(v))).slice(0,limit).map(snapshot);return {docs:rows,size:rows.length}}};return q
  }
  const bucket={file:path=>({save:async(bytes,opts)=>{assert.equal(opts.metadata.metadata.firebaseStorageDownloadTokens,undefined);objects.set(path,Buffer.from(bytes))},download:async()=>[objects.get(path)]})}
  const requireStudent=async req=>{if(!req.auth?.uid)throw new Fault('unauthenticated','Sign in');const profile=docs.get(`users/${req.auth.uid}`);if(profile?.role!=='student')throw new Fault('permission-denied','Student only');return {uid:req.auth.uid,schoolId:'maxima',profile}}
  const service=createSpeakingService({db,bucket,HttpsError:Fault,requireStudent,requireAssignmentManager:async req=>{const profile=docs.get(`users/${req.auth?.uid}`);if(!['teacher','admin'].includes(profile?.role))throw new Fault('permission-denied','Staff only');return {uid:req.auth.uid,profile}},schoolIdOf:p=>p?.schoolId||'maxima',requireAssignedMock:async()=>({title:'Mock',teacherId:'T1',schoolId:'maxima',speakingConfig:full}),requireCurrentTeacherAcademicStudent:async({manager:m})=>{if(m.profile.role!=='admin'&&!allowed)throw new Fault('permission-denied','Revoked')},now:()=>time,aiEnabled:options.aiEnabled||(()=>true),provider:async()=>{providerCalls++;return {estimatedBand:5,summary:'Synthetic audio evaluation',criteria:{},answers:[]}}})
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
test('source snapshot and optional unassigned task are saved without granting all students access',async()=>{const w=world();const t=await w.call('saveTask',{title:'Library only',config:full,assignedTo:[]},'T1');assert.deepEqual(w.docs.get(`speakingTasks/${t.id}`).assignedTo,[]);assert.equal(t.task.id,t.id);assert.equal(typeof t.task.updatedAt,'number');await rejected(w.call('start',{taskId:t.id}),'permission-denied')})
test('practice: save audio privately, reuse identical retry, then lock submitted answer',async()=>{const w=world();const a=await w.call('start',{taskId:'task1'});await w.call('beginQuestion',{attemptId:a.id});const body={attemptId:a.id,index:0,audio:wav()};const first=await w.call('saveAnswer',body);assert.equal(first.answers[0].storagePath,undefined);assert.equal(first.answers[0].path,undefined);assert.equal(first.answers[0].sha256,undefined);await w.call('saveAnswer',body);assert.equal(w.objects.size,1);await w.call('submit',{attemptId:a.id});const blob=await w.call('audio',{attemptId:a.id,questionId:'q1'});assert.equal(blob.audio,wav());await rejected(w.call('saveAnswer',{...body,audio:wav(2)}),'failed-precondition')})
test('resume uses the same practice attempt, rejects mismatched task',async()=>{const w=world(),a=await w.call('start',{taskId:'task1'});assert.equal((await w.call('start',{taskId:'task1',attemptId:a.id})).id,a.id);await rejected(w.call('start',{taskId:'other',attemptId:a.id}),'permission-denied')})
test('cannot submit an incomplete practice attempt',async()=>{const w=world(),a=await w.call('start',{taskId:'task1'});await rejected(w.call('submit',{attemptId:a.id}),'failed-precondition')})
test('mock start is idempotent; early recording replacement and skipping questions are refused',async()=>{const w=world();const a=await w.call('start',{mockId:'mock1'});const b=await w.call('start',{mockId:'mock1'});assert.equal(a.id,b.id);const c=await w.call('beginQuestion',{attemptId:a.id});assert.equal(c.deadline-c.recordAt,30000);await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()}),'failed-precondition');w.advance(40000);const next=await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()});assert.equal(next.nextIndex,1);await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(2)}),'failed-precondition')})
test('mock Part 2 gets server-owned preparation and recording deadlines',async()=>{const w=world(),a=await w.call('start',{mockId:'mock1'});await w.call('beginQuestion',{attemptId:a.id});w.advance(40000);await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()});const p2=await w.call('beginQuestion',{attemptId:a.id});assert.equal(p2.recordAt-p2.startedAt,68000);assert.equal(p2.deadline-p2.recordAt,120000);w.advance(1000);assert.equal((await w.call('beginQuestion',{attemptId:a.id,restartPreparation:true})).recordAt,p2.recordAt)})
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
 w.docs.set('speakingTasks/task2',{...w.docs.get('speakingTasks/task1')})
 await rejected(w.call('start',{taskId:'task2'}),'resource-exhausted');assert.equal((await w.call('start',{taskId:'task1'})).id,a.id);assert.equal((await w.call('start',{taskId:'task1',attemptId:a.id})).id,a.id)
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
test('teacher owns set creation; admin monitors all teachers in its institution without creating sets',async()=>{
 const w=world();w.docs.set('speakingTasks/second',{...w.docs.get('speakingTasks/task1'),teacherId:'T2',title:'Other teacher set'});w.docs.set('speakingTasks/foreign',{...w.docs.get('speakingTasks/task1'),schoolId:'another',title:'Foreign'})
 const teacher=await w.call('list',{staff:true},'T1'),admin=await w.call('list',{staff:true},'A1')
 assert.deepEqual(teacher.tasks.map(t=>t.title),['Learning']);assert.equal(admin.tasks.length,2);assert(admin.tasks.some(t=>t.teacherName==='Second teacher'))
 await rejected(w.call('saveTask',{title:'Admin set',config:full,assignedTo:[]},'A1'),'permission-denied')
})
test('student list discloses only assigned sets and does not leak other assignment identities',async()=>{
 const w=world();w.docs.get('speakingTasks/task1').assignedTo.push('S2');const result=await w.call('list')
 assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].assignedTo,undefined);assert.equal(result.tasks[0].teacherId,undefined)
})
test('cursor pagination scans past 100 tasks without duplicates or losing records',async()=>{
 const w=world();for(let i=0;i<110;i++)w.docs.set(`speakingTasks/page${String(i).padStart(3,'0')}`,{...w.docs.get('speakingTasks/task1'),title:`Page ${i}`})
 const ids=[];let cursor=null
 do{const page=await w.call('list',{staff:true,kind:'tasks',cursors:{tasks:cursor}},'T1');ids.push(...page.tasks.map(t=>t.id));cursor=page.cursors.tasks}while(cursor)
 assert.equal(ids.length,111);assert.equal(new Set(ids).size,111)
})
test('archive denies student access while preserving staff recordings; another teacher cannot archive',async()=>{
 const w=world(),a=await complete(w);await rejected(w.call('archiveTask',{taskId:'task1',archived:true},'T2'),'permission-denied')
 await w.call('archiveTask',{taskId:'task1',archived:true},'T1');await rejected(w.call('get',{attemptId:a.id}),'permission-denied');assert.equal((await w.call('get',{attemptId:a.id,staff:true},'A1')).id,a.id)
 const updatedAt=w.docs.get('speakingTasks/task1').updatedAt;await rejected(w.call('archiveTask',{taskId:'task1',archived:false,expectedUpdatedAt:updatedAt-1},'A1'),'aborted')
 await w.call('archiveTask',{taskId:'task1',archived:false,expectedUpdatedAt:updatedAt},'A1');assert.equal((await w.call('get',{attemptId:a.id})).id,a.id)
})
test('admin recovery makes no paid call, preserves quota and requires student consent again',async()=>{
 const w=world(),a=await complete(w),ref=`speakingAttempts/${a.id}`;w.docs.set(ref,{...w.docs.get(ref),aiStatus:'failed',aiRequestedAt:1700});w.docs.set('speakingAiUsage/maxima_1970-01-01',{requests:7})
 const data={attemptId:a.id,expectedAiRequestedAt:1700,reason:'Issue reviewed by support'}
 await rejected(w.call('allowAiRetry',data,'T1'),'permission-denied');await w.call('allowAiRetry',data,'A1')
 assert.equal(w.calls(),0);assert.equal(w.docs.get('speakingAiUsage/maxima_1970-01-01').requests,7);assert.equal(w.docs.get(ref).aiRecovery[0].by,'A1')
 await rejected(w.call('allowAiRetry',data,'A1'),'failed-precondition');await rejected(w.call('evaluate',{attemptId:a.id,consent:false}),'failed-precondition')
 await w.call('evaluate',{attemptId:a.id,consent:true});assert.equal(w.calls(),1);assert.equal(w.docs.get('speakingAiUsage/maxima_1970-01-01').requests,8)
})
test('Mock Part 2 early finish has a strict 60-second clock and rejects materially short audio',async()=>{
 const w=world(),a=await w.call('start',{mockId:'mock1'})
 await w.call('beginQuestion',{attemptId:a.id});w.advance(40000);await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()})
 const p2=await w.call('beginQuestion',{attemptId:a.id}),body={attemptId:a.id,index:1,audio:wav(60),finishEarly:true}
 w.advance(p2.recordAt-p2.startedAt+59999)
 await rejected(w.call('saveAnswer',body),'failed-precondition');assert.equal(w.objects.size,1)
 w.advance(1)
 await rejected(w.call('saveAnswer',{...body,audio:wav(59)}),'failed-precondition')
 await rejected(w.call('saveAnswer',{...body,finishEarly:false}),'failed-precondition')
 const saved=await w.call('saveAnswer',body);assert.equal(saved.nextIndex,2);assert.equal(saved.answers[1].finishedEarly,true);assert.equal(saved.answers[1].interrupted,false)
 const again=await w.call('saveAnswer',body);assert.equal(again.nextIndex,2);assert.equal(w.objects.size,2)
 await rejected(w.call('saveAnswer',{...body,audio:wav(61)}),'failed-precondition')
})
test('early-finish flag cannot skip Mock Part 1 or its question order',async()=>{
 const w=world(),a=await w.call('start',{mockId:'mock1'});await w.call('beginQuestion',{attemptId:a.id});w.advance(20000)
 await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(),finishEarly:true}),'failed-precondition');assert.equal(w.objects.size,0)
})
test('teacher can assign and student can complete a standalone set for each individual Speaking part',async()=>{
 for(const part of [1,2,3]){
   const w=world(),task=await w.call('saveTask',{title:`Part ${part} practice`,config:{enabled:true,questions:[{...question,part}]},assignedTo:['S1']},'T1')
   let a=await w.call('start',{taskId:task.id});assert(a.questions.every(q=>q.part===part));assert.equal(a.mode,'practice')
   const timing=await w.call('beginQuestion',{attemptId:a.id});if(part===2){w.advance(timing.recordAt-timing.startedAt+60000)}await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(part===2?60:1),finishEarly:part===2});a=await w.call('submit',{attemptId:a.id});assert.equal(a.status,'submitted')
 }
})

test('Part 2-only practice has one minute preparation, a strict recording minimum, and an explicit fresh-preparation retry',async()=>{
 const w=world(),task=await w.call('saveTask',{title:'Cue card',config:{enabled:true,questions:[{...question,part:2}]},assignedTo:['S1']},'T1')
 const a=await w.call('start',{taskId:task.id});assert.equal(a.timedPart2,true)
 const timing=await w.call('beginQuestion',{attemptId:a.id});assert.equal(timing.recordAt-timing.startedAt,60000);assert.equal(timing.deadline-timing.recordAt,120000)
 w.advance(60000);await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(60),finishEarly:true}),'failed-precondition')
 w.advance(60000);await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(10),finishEarly:true}),'failed-precondition')
 const restarted=await w.call('beginQuestion',{attemptId:a.id,restartPreparation:true});assert.notEqual(restarted.recordAt,timing.recordAt)
 await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(60),finishEarly:true}),'failed-precondition')
 w.advance(120000);const saved=await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav(60),finishEarly:true});assert.equal(saved.answers[0].finishedEarly,true)
})
test('standalone full Speaking mock validates all three parts and uses automatic server timers without a parent mock',async()=>{
 const w=world();await rejected(w.call('saveTask',{title:'Invalid full test',mode:'mock',config:{enabled:true,questions:[question]},assignedTo:['S1']},'T1'),'invalid-argument')
 const task=await w.call('saveTask',{title:'Full Speaking test',mode:'mock',config:full,assignedTo:['S1']},'T1')
 const a=await w.call('start',{taskId:task.id});assert.equal(a.mode,'mock');assert.equal(a.mockId,'');assert.deepEqual(a.questions.map(q=>q.part),[1,2,3])
 const first=await w.call('beginQuestion',{attemptId:a.id});assert.equal(first.recordAt-first.startedAt,8000)
 await rejected(w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()}),'failed-precondition')
 w.advance(40000);await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()})
 const p2=await w.call('beginQuestion',{attemptId:a.id});assert.equal(p2.recordAt-p2.startedAt,68000);assert.equal(p2.deadline-p2.recordAt,120000)
 w.advance(128000);const result=await w.call('saveAnswer',{attemptId:a.id,index:1,audio:wav(60),finishEarly:true});assert.equal(result.nextIndex,2)
})
test('configured Speaking AI is available without a per-student pilot list and retains the global off switch',()=>{
 const {speakingAiEnabledFor}=require('../../functions/lib/speaking/aiAccess')
 const env={MAXIMA_SPEAKING_AI_ENABLED:'true',MAXIMA_SPEAKING_AUDIO_MODEL:'gpt-audio-1.5'}
 assert.equal(speakingAiEnabledFor('S1',env),true);assert.equal(speakingAiEnabledFor('S2',env),true)
 assert.equal(speakingAiEnabledFor('S2',{...env,MAXIMA_SPEAKING_AI_STUDENT_IDS:'S1'}),true)
 assert.equal(speakingAiEnabledFor(undefined,env),false);assert.equal(speakingAiEnabledFor(' ',env),false)
 assert.equal(speakingAiEnabledFor('S1',{}),false)
 assert.equal(speakingAiEnabledFor('S1',{...env,MAXIMA_SPEAKING_AI_ENABLED:'false'}),false)
 assert.equal(speakingAiEnabledFor('S1',{...env,MAXIMA_SPEAKING_AUDIO_MODEL:''}),false)
})
test('a newly assigned student can request AI without manual enablement; other students and removed assignments remain blocked',async()=>{
 const {speakingAiEnabledFor}=require('../../functions/lib/speaking/aiAccess')
 const env={MAXIMA_SPEAKING_AI_ENABLED:'true',MAXIMA_SPEAKING_AUDIO_MODEL:'gpt-audio-1.5'}
 const w=world({aiEnabled:id=>speakingAiEnabledFor(id,env)})
 await rejected(w.call('start',{taskId:'task1'},'S2'),'permission-denied')
 w.docs.get('speakingTasks/task1').assignedTo.push('S2')
 const a=await w.call('start',{taskId:'task1'},'S2');assert.equal(a.aiAvailable,true)
 await w.call('beginQuestion',{attemptId:a.id},'S2')
 await w.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()},'S2')
 await w.call('submit',{attemptId:a.id},'S2')
 await rejected(w.call('evaluate',{attemptId:a.id,consent:true},'S1'),'permission-denied')
 await w.call('evaluate',{attemptId:a.id,consent:true},'S2');assert.equal(w.calls(),1)
 w.docs.get('speakingTasks/task1').assignedTo=['S1']
 await rejected(w.call('get',{attemptId:a.id},'S2'),'permission-denied')
 await rejected(w.call('evaluate',{attemptId:a.id,consent:true},'S2'),'permission-denied')
 assert.equal(w.calls(),1)
})

test('submitted Speaking is locked until the owner teacher allows one retake, preserving the old report',async()=>{
 const w=world(),a=await complete(w);await w.call('evaluate',{attemptId:a.id,consent:true})
 const original=structuredClone(w.docs.get(`speakingAttempts/${a.id}`))
 await rejected(w.call('start',{taskId:'task1'}),'failed-precondition')
 await rejected(w.call('allowRetake',{attemptId:a.id}),'permission-denied')
 await rejected(w.call('allowRetake',{attemptId:a.id},'T2'),'permission-denied')
 await w.call('allowRetake',{attemptId:a.id},'T1')
 assert.equal((await w.call('get',{attemptId:a.id})).retakeAvailable,true)
 const listed=await w.call('list');assert.equal(listed.tasks[0].retakeAvailable,true)
 const attempts=await Promise.all([w.call('start',{taskId:'task1'}),w.call('start',{taskId:'task1'})])
 assert.equal(attempts[0].id,attempts[1].id);assert.notEqual(attempts[0].id,a.id)
 assert.equal(attempts[0].report,null);assert.equal(w.docs.get(`speakingAttempts/${attempts[0].id}`).attemptNumber,2)
 assert.equal(w.docs.get('speakingAttemptUsage/S1_1970-01-01').attempts,2)
 assert.deepEqual(w.docs.get(`speakingAttempts/${a.id}`),original);assert.equal(w.calls(),1)
 await rejected(w.call('allowRetake',{attemptId:a.id},'T1'),'failed-precondition')
 await w.call('beginQuestion',{attemptId:attempts[0].id});await w.call('saveAnswer',{attemptId:attempts[0].id,index:0,audio:wav()});await w.call('submit',{attemptId:attempts[0].id})
 await rejected(w.call('start',{taskId:'task1'}),'failed-precondition')
})
test('legacy submissions without attempt controls are also locked and can receive a teacher-approved retake',async()=>{
 const w=world(),a=await complete(w)
 for(const key of w.docs.keys())if(key.startsWith('speakingAttemptControls/'))w.docs.delete(key)
 await rejected(w.call('start',{taskId:'task1'}),'failed-precondition')
 const listed=await w.call('list');assert.equal(listed.tasks[0].latestAttemptId,a.id);assert.equal(listed.tasks[0].latestAttemptStatus,'submitted')
 await w.call('allowRetake',{attemptId:a.id},'T1')
 const next=await w.call('start',{taskId:'task1'});assert.notEqual(next.id,a.id)
})
test('unsubmitted answers can resume but cannot receive a retake; parent Mock retakes remain separate',async()=>{
 const w=world(),a=await w.call('start',{taskId:'task1'})
 assert.equal((await w.call('start',{taskId:'task1'})).id,a.id)
 await rejected(w.call('allowRetake',{attemptId:a.id},'T1'),'failed-precondition')
 const m=await w.call('start',{mockId:'mock1'});w.docs.get(`speakingAttempts/${m.id}`).status='submitted'
 await rejected(w.call('allowRetake',{attemptId:m.id},'T1'),'failed-precondition')
})
