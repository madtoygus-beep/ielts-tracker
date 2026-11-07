const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const mod=()=>import('../src/services/p8cAssignmentDelta.js')
const before=['VisibleA','HiddenLegacy','VisibleB']
test('unchanged visible selection preserves the hidden assignment',async()=>{
 const {retainUnavailableAssignments:r,buildP8CAssignmentDelta:d}=await mod()
 assert.deepEqual(d('writing','Lesson01',before,r(before,['VisibleA','VisibleB'],['HiddenLegacy'])).changes,[])
})
test('clear all removes only visible memberships',async()=>{
 const {retainUnavailableAssignments:r,buildP8CAssignmentDelta:d}=await mod()
 assert.deepEqual(d('writing','Lesson01',before,r(before,[],['HiddenLegacy'])).changes,[
  {studentId:'VisibleA',assigned:false,expectedAssigned:true},{studentId:'VisibleB',assigned:false,expectedAssigned:true}])
})
test('adding a permitted student never issues a hidden grant',async()=>{
 const {retainUnavailableAssignments:r,buildP8CAssignmentDelta:d}=await mod()
 assert.deepEqual(d('mock','Lesson01',before,r(before,['VisibleA','VisibleB','NewVisible'],['HiddenLegacy'])).changes,[
  {studentId:'NewVisible',assigned:true,expectedAssigned:false}])
})
test('roster revocation during editing protects newly hidden memberships',async()=>{
 const {retainUnavailableAssignments:r,buildP8CAssignmentDelta:d}=await mod()
 assert.deepEqual(d('listening','Lesson01',before,r(before,['VisibleA'],['HiddenLegacy','VisibleB'])).changes,[])
})
test('unavailable entries cannot create new assignments or duplicate requests',async()=>{
 const {retainUnavailableAssignments:r}=await mod()
 assert.deepEqual(r(['HiddenLegacy'],['HiddenInjected','VisibleA','VisibleA'],['HiddenLegacy','HiddenInjected']),['VisibleA','HiddenLegacy'])
})
test('a concurrent removal is not recreated by a visible-only delta',async()=>{
 const {retainUnavailableAssignments:r,buildP8CAssignmentDelta:d}=await mod()
 const server=new Set(['VisibleA','VisibleB'])
 const delta=d('reading','Lesson01',before,r(before,['VisibleA'],['HiddenLegacy']))
 for(const c of delta.changes){assert.equal(server.has(c.studentId),c.expectedAssigned);c.assigned?server.add(c.studentId):server.delete(c.studentId)}
 assert.deepEqual([...server],['VisibleA'])
})
test('modal recalculates visibility and locks full AI-policy replacement only',()=>{
 const src=fs.readFileSync('src/pages/TeacherDashboard.jsx','utf8')
 assert.match(src,/const assignmentUnknownStudentIds = uniqueCleanValues\(\[\s+\.\.\.assignmentInitiallyUnavailableIds,\s+\.\.\.assignmentBaseline\.filter\(uid => !getStudentByAnyId\(uid\)\)/)
 assert.match(src,/setAssignmentInitiallyUnavailableIds\(canonicalStudentIds\.filter/)
 assert.match(src,/const finalAssignment = retainUnavailableAssignments\(/)
 assert.match(src,/const aiReady = aiSupported && assignmentAiStatus === 'ready' &&\s+assignmentUnknownStudentIds.length === 0/)
 assert.match(src,/disabled=\{assignmentSaving \|\| assignmentUnknownStudentIds.length > 0\}/)
 assert.match(src,/disabled=\{assignmentSaving \|\| assignmentAiStatus === 'loading'\}/)
 assert.doesNotMatch(src,/Saving is blocked|Assignments were NOT saved\. Ask the school admin/)
})

test('late-arriving profiles stay protected until the editor is reopened',async()=>{
 const {retainUnavailableAssignments:r,buildP8CAssignmentDelta:d}=await mod()
 const initiallyUnavailable=['HiddenLegacy']
 const currentlyUnavailable=[]
 const protectedIds=[...new Set([...initiallyUnavailable,...currentlyUnavailable])]
 assert.deepEqual(d('writing','Lesson01',before,r(before,['VisibleA','VisibleB'],protectedIds)).changes,[])
})
