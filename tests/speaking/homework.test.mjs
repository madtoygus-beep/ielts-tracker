import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSpeakingHomework, speakingHomeworkSummary, openSpeakingHomework } from '../../src/services/speakingHomework.js'

test('assigned Speaking sets contribute once; submitted/reviewed work is completed and Mock work is excluded', () => {
  const tasks = [{id:'new'}, {id:'done'}, {id:'reviewed'}, {id:'new'}, {id:'archived',archived:true}]
  const attempts = [{id:'a',taskId:'done',status:'submitted',startedAt:1}, {id:'b',taskId:'reviewed',status:'reviewed',startedAt:2}, {id:'m',taskId:'new',mockId:'mock',status:'submitted',startedAt:3}, {id:'unassigned',taskId:'not-assigned',status:'recording',startedAt:4}]
  const result = speakingHomeworkSummary({tasks,attempts})
  assert.equal(result.total,3); assert.equal(result.completed,2)
  assert.deepEqual(result.pending.map(x=>x.id),['new'])
})
test('latest practice attempt determines completion; unfinished practice links to the exact task and resumes its attempt', () => {
  const result = speakingHomeworkSummary({tasks:[{id:'set1',title:'Cue card'}],attempts:[{id:'active',taskId:'set1',status:'recording',startedAt:20},{id:'old',taskId:'set1',status:'submitted',startedAt:10}]})
  assert.equal(result.completed,0); assert.equal(result.pending[0].attemptId,'active')
  assert.equal(result.pending[0].path,'/speaking?task=set1')
  const calls=[];globalThis.sessionStorage={setItem:(...args)=>calls.push(args)}
  try {openSpeakingHomework(result.pending[0],'student',path=>calls.push(path))} finally {delete globalThis.sessionStorage}
  assert.deepEqual(calls,[['speaking-active-student-set1','active'],'/speaking?task=set1'])
})
test('all pages of both tasks and attempts are loaded before counting completion', async () => {
  const calls=[]
  const api=async(op,data)=>{calls.push(data);if(!data.kind)return {tasks:[{id:'one'}],attempts:[],cursors:{tasks:'t1',attempts:'a1'}}
    if(data.kind==='tasks')return {tasks:[{id:'two'}],cursors:{tasks:null}}
    return {attempts:[{id:'done',taskId:'two',status:'submitted',startedAt:1}],cursors:{attempts:null}}
  }
  const result=await loadSpeakingHomework(api)
  assert.equal(result.total,2); assert.equal(result.completed,1)
  assert.deepEqual(result.pending.map(t=>t.id),['one'])
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.staff===false))
})
test('failure on a later page rejects rather than reporting a misleading partial count', async () => {
  await assert.rejects(loadSpeakingHomework(async(op,data)=>{if(!data.kind)return {tasks:[{id:'one'}],attempts:[],cursors:{tasks:'more'}};throw Error('offline')}),/offline/)
})
test('repeated cursor fails instead of an endless fetch loop', async () => {
  await assert.rejects(loadSpeakingHomework(async()=>({tasks:[],attempts:[],cursors:{tasks:'same'}})),/pagination/)
})
test('a later submission removes an earlier unfinished practice from pending homework', () => {
  const result=speakingHomeworkSummary({tasks:[{id:'set'}],attempts:[{id:'old',taskId:'set',status:'recording',startedAt:1},{id:'done',taskId:'set',status:'submitted',startedAt:2}]})
  assert.equal(result.pending.length,0);assert.equal(result.completed,1)
})

test('only a teacher-opened retake returns completed Speaking to pending homework and clears the old resume ID',()=>{
 const tasks=[{id:'set',retakeAvailable:true,nextAttemptNumber:2,latestAttemptStatus:'submitted'}]
 const result=speakingHomeworkSummary({tasks,attempts:[{id:'old',taskId:'set',status:'submitted',startedAt:1}]})
 assert.equal(result.pending.length,1);assert.equal(result.pending[0].isRetake,true);assert.equal(result.pending[0].attemptId,null);assert.equal(result.completed,0)
 const calls=[];globalThis.sessionStorage={removeItem:key=>calls.push(key)}
 try{openSpeakingHomework(result.pending[0],'student',path=>calls.push(path))}finally{delete globalThis.sessionStorage}
 assert.deepEqual(calls,['speaking-active-student-set','/speaking?task=set'])
})
