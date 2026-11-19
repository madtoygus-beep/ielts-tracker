'use strict'
// Hard-coded demo project + loopback emulator: this file must never use a live database.
const {test,before,beforeEach,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createRequire}=require('node:module')
const req=createRequire(require('node:path').resolve(__dirname,'../../functions/package.json'))
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8280'
const projectId='demo-maxima-speaking-local'
const {initializeApp,deleteApp}=req('firebase-admin/app'),{getFirestore}=req('firebase-admin/firestore')
const {initializeTestEnvironment,assertFails}=require('@firebase/rules-unit-testing')
const {doc,getDoc,setDoc}=require('firebase/firestore')
const {createSpeakingService}=require('../../functions/lib/speaking/service')
const {requireCurrentTeacherAcademicStudent}=require('../../functions/lib/p0bCurrentAcademicAccess')
const app=initializeApp({projectId},'speaking-local-emulator'),db=getFirestore(app)
class Fault extends Error{constructor(code,message){super(message);this.code=code}}
let env
const configuration={enabled:true,questions:[{part:1,text:'What practical skill do you enjoy learning?',seconds:30}]}
function wav(){const b=Buffer.alloc(32044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(Math.sin(i)*2000,i);return b.toString('base64')}
const schoolIdOf=p=>p?.schoolId||'maxima'
async function actor(request,roles){const uid=request.auth?.uid,p=uid&&(await db.doc(`users/${uid}`).get()).data();if(!p||!roles.includes(p.role)||p.status!=='approved'||p.deleted||p.archived)throw new Fault('permission-denied','Account unavailable');return {uid,profile:p,schoolId:p.schoolId}}
function service(database=db){const objects=new Map();let paidCalls=0;const handler=createSpeakingService({db:database,HttpsError:Fault,schoolIdOf,requireCurrentTeacherAcademicStudent,requireStudent:r=>actor(r,['student']),requireAssignmentManager:r=>actor(r,['teacher','admin']),requireAssignedMock:async()=>{throw Error('Mock access not used in this emulator scenario')},bucket:{file:path=>({save:async bytes=>objects.set(path,bytes),download:async()=>[objects.get(path)]})},provider:async()=>{paidCalls++;throw Error('Synthetic provider failure')},aiEnabled:()=>true});return {call:(op,data={},uid='S1')=>handler.call({auth:{uid},data:{op,...data}}),paidCalls:()=>paidCalls,objects}}
const denied=(p,code='permission-denied')=>assert.rejects(p,e=>e.code===code)
before(async()=>{env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8280,rules:fs.readFileSync('firestore.rules','utf8')}})})
beforeEach(async()=>{
 const response=await fetch(`http://127.0.0.1:8280/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'});assert(response.ok)
 const batch=db.batch();for(const [id,role] of [['T1','teacher'],['T2','teacher'],['A1','admin'],['S1','student'],['S2','student']])batch.set(db.doc(`users/${id}`),{role,status:'approved',schoolId:'maxima',name:`Synthetic ${id}`})
 batch.set(db.doc('schools/maxima'),{status:'active'})
 batch.set(db.doc('schools/maxima/teacherAcademicIndex/T1'),{teacherId:'T1',schoolId:'maxima',schemaVersion:1,source:'managed_active_classes',activeStudentIds:['S1']})
 batch.set(db.doc('schools/maxima/teacherAcademicIndex/T2'),{teacherId:'T2',schoolId:'maxima',schemaVersion:1,source:'managed_active_classes',activeStudentIds:['S2']})
 await batch.commit()
})
after(async()=>{await env?.cleanup();await db.terminate();await deleteApp(app)})
async function create(s,assignedTo=['S1']){return s.call('saveTask',{title:'Emulator Speaking',config:configuration,assignedTo},'T1')}
async function finish(s){const task=await create(s),a=await s.call('start',{taskId:task.id});await s.call('beginQuestion',{attemptId:a.id});await s.call('saveAnswer',{attemptId:a.id,index:0,audio:wav()});return s.call('submit',{attemptId:a.id})}
test('real Firestore: teacher saves unassigned library set; no automatic student access',async()=>{const s=service(),task=await create(s,[]);assert.equal((await s.call('list',{staff:true},'T1')).tasks.length,1);assert.equal((await s.call('list')).tasks.length,0);await denied(s.call('start',{taskId:task.id}))})
test('real Firestore: student audio, staff review and score round-trip use production membership helper',async()=>{const s=service(),a=await finish(s);assert.equal(s.objects.size,1);const listed=await s.call('list');assert.equal(listed.attempts[0].id,a.id);assert(!JSON.stringify(listed).includes('speaking-private/'));await denied(s.call('get',{attemptId:a.id},'S2'));await denied(s.call('get',{attemptId:a.id,staff:true},'T2'));const criteria={fluencyAndCoherence:6,lexicalResource:6,grammaticalRangeAndAccuracy:5,pronunciation:5};assert.equal((await s.call('review',{attemptId:a.id,criteria},'T1')).band,5.5);assert.equal((await s.call('get',{attemptId:a.id})).review.band,5.5)})
test('real Firestore: document-name pagination works past 100 records and scopes admin institution',async()=>{const batch=db.batch();for(let i=0;i<107;i++)batch.set(db.doc(`speakingTasks/task${String(i).padStart(3,'0')}`),{title:'Page fixture',teacherId:i%2?'T1':'T2',schoolId:'maxima',assignedTo:[],config:configuration});batch.set(db.doc('speakingTasks/foreign'),{teacherId:'T1',schoolId:'other',assignedTo:[],config:configuration});await batch.commit();const s=service(),ids=[];let cursor=null;do{const page=await s.call('list',{staff:true,kind:'tasks',cursors:{tasks:cursor}},'A1');ids.push(...page.tasks.map(t=>t.id));cursor=page.cursors.tasks}while(cursor);assert.equal(ids.length,107);assert.equal(new Set(ids).size,107)})
test('real Firestore: a class revocation before commit blocks the write without uploading audio',async()=>{const s=service(),task=await create(s),a=await s.call('start',{taskId:task.id});await db.doc('schools/maxima/teacherAcademicIndex/T1').update({activeStudentIds:[]});await denied(s.call('beginQuestion',{attemptId:a.id}));assert.equal((await db.doc(`speakingAttempts/${a.id}`).get()).data().current,null);assert.equal(s.objects.size,0)})
test('real Firestore: browser clients cannot directly read or write server-only Speaking records',async()=>{const s=service(),a=await finish(s);for(const uid of ['S1','T1','A1']){const client=env.authenticatedContext(uid).firestore();await assertFails(getDoc(doc(client,'speakingAttempts',a.id)));await assertFails(getDoc(doc(client,'speakingTasks',a.taskId)));await assertFails(setDoc(doc(client,'speakingAttempts',a.id),{review:{band:9}}))}})
test('real Firestore: failed AI request can be released by admin without another paid request',async()=>{const s=service(),a=await finish(s);await denied(s.call('evaluate',{attemptId:a.id,consent:true}),'unavailable');assert.equal(s.paidCalls(),1);const failed=await s.call('get',{attemptId:a.id,staff:true},'A1');assert.equal(failed.aiStatus,'failed');await s.call('allowAiRetry',{attemptId:a.id,reason:'Reviewed synthetic error',expectedAiRequestedAt:failed.aiRequestedAt},'A1');assert.equal(s.paidCalls(),1);assert.equal((await s.call('get',{attemptId:a.id})).aiStatus,'not_requested')})
