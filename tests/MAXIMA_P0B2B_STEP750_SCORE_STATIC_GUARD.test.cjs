const test=require('node:test'), assert=require('node:assert/strict')
const fs=require('node:fs'), crypto=require('node:crypto')
const rules=fs.readFileSync('firestore.rules','utf8'),ui=fs.readFileSync('src/pages/TeacherDashboard.jsx','utf8')
const sha=crypto.createHash('sha256').update(rules).digest('hex')
test('Step750 exact Rules SHA and validated source',()=>assert.equal(sha,'fbd5ff8ec4b01df03a265e815f4a74ee4550144ac6b96d49a8040456718d0596'))
test('score manual CREATE has a strict key whitelist',()=>{
  assert.match(rules,/function teacherManualScoreCreate\(data\)/)
  assert.match(rules,/data\.keys\(\)\.hasOnly\(/)
})
test('Mock score CREATE is server-only and manual teacher scores remain valid',()=>{
  assert.match(rules,/function teacherCanCreateAcademicScore\(/)
  assert.match(rules,/return teacherScoreCreateBase\(data\) && teacherManualScoreCreate\(data\);/)
  assert.doesNotMatch(rules,/function teacherMockScoreCreateAgainstSubmission\(/)
})
test('Mock score UPDATE is server-only with narrowly scoped manual score edits',()=>{
  assert.match(rules,/function teacherCanUpdateAcademicScore\(/)
  assert.match(rules,/resource.data.get\('source', ''\) in \['', 'manual'\]/)
  assert.match(rules,/!resource.data.keys\(\).hasAny\(\['mockTestId', 'mockId', 'gradedByServer', 'aiEstimatedWritingBand'\]\)/)
  assert.doesNotMatch(rules,/function teacherMockScoreUpdateOnly\(/)
})
test('manual teacher update narrow and current membership bound',()=>{
  assert.match(rules,/function teacherCanUpdateAcademicScore\(/)
  assert.match(rules,/teacherScoreUpdateCurrentMembership\(resource\.data\)/)
})
test('Mock teacher review invokes server atomically and preserves objective/AI data',()=>{
  const server=fs.readFileSync('functions/lib/p0bMockWritingReviewService.js','utf8')
  assert.match(ui,/saveMockWritingReviewSecureCall\(/)
  assert.match(server,/const scoreGrade = \{/)
  const start=server.indexOf('const scoreGrade = {')
  const end=server.indexOf('const noScore =',start)
  const patch=server.slice(start,end)
  for(const field of ['writing:', 'writingSource:', 'overall:', 'updatedAt:', 'updatedBy:'])
    assert.ok(patch.includes(field),field)
  for(const field of ['uid:', 'studentId:', 'teacherId:', 'teacherIds:', 'source:',
    'schoolId:', 'attemptNumber:', 'aiEstimatedWritingBand:', 'reading:', 'listening:',
    'gradedByServer:'])assert.ok(!patch.includes(field),'Forbidden Mock patch field: '+field)
  assert.match(server,/\.\.\.result\.writing/)
  assert.match(server,/\.\.\.result,/)
})
