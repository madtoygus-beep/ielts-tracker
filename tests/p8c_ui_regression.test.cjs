'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8')
const getDelta = async()=> (await import('../src/services/p8cAssignmentDelta.js')).buildP8CAssignmentDelta

test('P8C-UI1 independent editors keep unrelated assignments unchanged',async()=>{
  const f=await getDelta()
  const first=f('writing','Homework01',['Student0001','Student0002'],['Student0001'])
  assert.deepEqual(first.changes,[{studentId:'Student0002',assigned:false,expectedAssigned:true}])
  assert.equal(first.changes.some(x=>x.studentId==='Student0001'),false)
})
test('P8C-UI2 adding students never replaces the previous set',async()=>{
  const f=await getDelta()
  const result=f('mock','Mock00001',['Student0001'],['Student0001','Student0002'])
  assert.deepEqual(result.changes,[{studentId:'Student0002',assigned:true,expectedAssigned:false}])
})
test('P8C-UI3 unchanged roster never issues a mutation',async()=>{
  const f=await getDelta()
  const result=f('listening','List0001',['Student0001','Student0002'],['Student0002','Student0001'])
  assert.deepEqual(result.changes,[])
})
test('P8C-UI4 duplicate checkbox IDs do not create duplicate transactions',async()=>{
  const f=await getDelta()
  const result=f('reading','Reading1',[],['Student0001','Student0001'])
  assert.equal(result.changes.length,1)
})
test('P8C-UI5 all content editors send scoped deltas instead of full rosters',()=>{
  for(const file of ['CreateReading','CreateListening','CreateWriting','CreateVocabulary','CreateMockTest']) {
    const src=read(`src/pages/${file}.jsx`)
    assert.match(src,/buildP8CAssignmentDelta\(/)
    assert.match(src,/setAssignmentBaseline\(canonicalStudentIds\)/)
    assert.match(src,/setContentStudentAccessCall\(scopedAssignment\)/)
    assert.doesNotMatch(src,/setContentStudentAccessCall\(\{\s*contentType:[\s\S]{0,120}studentIds: assignTo/)
  }
})
test('P8C-UI6 teacher manager and one-off remove use scoped mutations',()=>{
  const src=read('src/pages/TeacherDashboard.jsx')
  assert.match(src,/buildP8CAssignmentDelta\(/)
  assert.match(src,/studentId: targetUid, assigned: false, expectedAssigned: true/)
  assert.doesNotMatch(src,/studentIds: remainingStudentIds/)
})
test('P8C-UI7 archived statuses do not grant regular student access',()=>{
  const rules=read('firestore.rules')
  assert.match(rules,/get\(accessPath\)\.data\.get\('accessType', ''\) == 'assignment'/)
  const server=read('functions/index.js')
  assert.match(server,/exports\.getMyUnassignedArchive = onCall/)
  assert.match(server,/exports\.setContentStudentAccess = onCall\(request => p8cAssignmentService\.write\(request\)\)/)
})
test('P8C-UI8 archive view has no answer-key or retry endpoints',()=>{
  const view=read('src/components/StudentArchivePanel.jsx')
  assert.match(view,/getMyUnassignedArchive/)
  assert.doesNotMatch(view,/getStudentSubmissionAttemptReview|getMyAiWritingReport|submitMockSecure|attemptControl/)
  assert.match(read('src/pages/StudentDashboard.jsx'),/resultsView === 'archive'/)
})
