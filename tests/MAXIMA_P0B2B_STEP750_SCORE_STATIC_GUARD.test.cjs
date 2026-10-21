const test=require('node:test'), assert=require('node:assert/strict')
const fs=require('node:fs'), crypto=require('node:crypto')
const rules=fs.readFileSync('firestore.rules','utf8'),ui=fs.readFileSync('src/pages/TeacherDashboard.jsx','utf8')
const sha=crypto.createHash('sha256').update(rules).digest('hex')
test('Step750 exact Rules SHA and validated source',()=>assert.equal(sha,'9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'))
test('score manual CREATE has a strict key whitelist',()=>{
  assert.match(rules,/function teacherManualScoreCreate\(data\)/)
  assert.match(rules,/data\.keys\(\)\.hasOnly\(/)
})
test('Mock CREATE binds trusted server submission',()=>{
  assert.match(rules,/function teacherMockScoreCreateAgainstSubmission\(/)
  assert.match(rules,/scoreId == data.get\('uid', ''\) \+ '_' \+ data.get\('mockTestId', ''\)/)
  assert.match(rules,/gradedByServer', false\) == true/)
})
test('Mock UPDATE has dedicated Writing-only key allowlist',()=>{
  assert.match(rules,/function teacherMockScoreUpdateOnly\(/)
  assert.match(rules,/\.hasOnly\(\['writing', 'writingSource', 'overall', 'updatedAt', 'updatedBy'\]\)/)
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
