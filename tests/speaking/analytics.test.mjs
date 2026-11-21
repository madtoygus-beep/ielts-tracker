import {test} from 'node:test'
import assert from 'node:assert/strict'
import {speakingAnalytics} from '../../src/services/speakingAnalytics.js'
import {loadTeacherSpeakingHomework} from '../../src/services/teacherSpeakingHomework.js'
const attempt=(id,taskId,startedAt,extra={})=>({id,taskId,startedAt,status:'submitted',...extra})
test('Speaking averages use the latest submitted attempt; AI and teacher grades remain independent',()=>{
 const data={tasks:[{id:'one'},{id:'two'}],attempts:[attempt('a','one',1,{review:{band:8},report:{estimatedBand:7}}),attempt('b','one',2,{review:{band:6},report:{estimatedBand:5}}),attempt('c','two',3,{report:{estimatedBand:3}}),attempt('d','one',4,{status:'recording'})]}
 const s=speakingAnalytics(data)
 assert.equal(s.assigned,2);assert.equal(s.completed,1)
 assert.equal(s.teacherAverage,6);assert.equal(s.teacherCount,1)
 assert.equal(s.aiAverage,4);assert.equal(s.aiCount,2);assert.equal(s.history.length,3)
 assert.deepEqual(Object.keys(data.attempts[0].review),['band'])
})
test('staff analysis respects current student selection, roster, assignment scope and archived sets',()=>{
 const tasks=[{id:'one',assignedTo:['s1','s2','former']},{id:'archived',assignedTo:['s1'],archived:true}]
 const attempts=[attempt('a','one',1,{studentId:'s1',report:{estimatedBand:5}}),attempt('b','one',1,{studentId:'s2',review:{band:7}}),attempt('c','one',2,{studentId:'former',review:{band:9}})]
 const all=speakingAnalytics({tasks,attempts},{staff:true,allowedStudentIds:['s1','s2']})
 assert.equal(all.assigned,2);assert.equal(all.completed,2);assert.equal(all.history.length,2);assert.equal(all.teacherAverage,7)
 const one=speakingAnalytics({tasks,attempts},{staff:true,studentId:'s1',allowedStudentIds:['s1','s2']})
 assert.equal(one.assigned,1);assert.equal(one.teacherCount,0);assert.equal(one.aiAverage,5)
 assert.equal(speakingAnalytics({tasks,attempts},{staff:true,studentId:'former',allowedStudentIds:['s1','s2']}).history.length,0)
})
test('missing or malformed grades remain unavailable, zero is valid, mock history is separate from standalone completion',()=>{
 const s=speakingAnalytics({tasks:[{id:'one'}],attempts:[attempt('a','one',1,{report:{estimatedBand:null},review:{band:'9'}}),attempt('b','one',2,{mockId:'mock',report:{estimatedBand:0},review:{band:10}})]})
 assert.equal(s.aiCount,1);assert.equal(s.aiAverage,0);assert.equal(s.teacherAverage,null);assert.equal(s.completed,1)
})
test('student analytics pagination always uses student access',async()=>{
 const calls=[];await loadTeacherSpeakingHomework(async(op,data)=>{calls.push(data);return {tasks:[],attempts:[],cursors:data.kind?{}:{attempts:'next'}}},false)
 assert.equal(calls.length,2);assert.ok(calls.every(call=>call.staff===false))
})
