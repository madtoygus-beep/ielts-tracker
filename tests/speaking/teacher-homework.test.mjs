import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTeacherSpeakingHomework, teacherSpeakingHomeworkForStudent } from '../../src/services/teacherSpeakingHomework.js'
test('teacher homework shows only assigned standalone sets and this student’s latest attempt', () => {
  const tasks = [{id:'set',assignedTo:['one','two']},{id:'other',assignedTo:['two']},{id:'archived',assignedTo:['one'],archived:true}]
  const attempts = [{id:'a',taskId:'set',studentId:'one',startedAt:1,status:'submitted'},
    {id:'b',taskId:'set',studentId:'one',startedAt:2,status:'recording'},
    {id:'c',taskId:'set',studentId:'two',startedAt:4,status:'submitted'},
    {id:'d',taskId:'set',studentId:'one',mockId:'mock',startedAt:5,status:'submitted'}]
  const rows = teacherSpeakingHomeworkForStudent({tasks,attempts}, 'one')
  assert.equal(rows.length,1);assert.equal(rows[0].attempt.id,'b')
  assert.equal(teacherSpeakingHomeworkForStudent({tasks,attempts},'unassigned').length,0)
})
test('teacher homework loads every page and rejects incomplete results',async()=>{
  const calls=[]
  const api=async(op,data)=>{calls.push(data);return data.kind==='tasks'?{tasks:[{id:'two'}],attempts:[],cursors:{tasks:null}}:data.kind==='attempts'?{tasks:[],attempts:[{id:'a'}],cursors:{attempts:null}}:{tasks:[{id:'one'}],attempts:[],cursors:{tasks:'next',attempts:'next'}}}
  const result=await loadTeacherSpeakingHomework(api)
  assert.deepEqual(result.tasks.map(t=>t.id),['one','two']);assert.equal(result.attempts.length,1)
  assert.ok(calls.every(c=>c.staff===true))
  await assert.rejects(loadTeacherSpeakingHomework(async(op,data)=>{if(data.kind)throw Error('offline');return {tasks:[],attempts:[],cursors:{tasks:'next'}}}),/offline/)
})
