const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { currentTeacherIndexAllowsStudent } = require('../functions/lib/aiWritingSponsoredEvaluation')
const teacherId = 'teacherABC', studentId = 'studentABC', schoolId = 'maxima'
const valid = { schemaVersion:1, source:'managed_active_classes', schoolId, teacherId,
  activeStudentIds:[studentId] }
test('G5 sponsoring needs exact canonical teacher+student index', () => {
  assert.equal(currentTeacherIndexAllowsStudent(valid,teacherId,studentId,schoolId),true)
  for (const changed of [null, {}, {...valid, activeStudentIds:[]},
    {...valid, source:'legacy_classes'}, {...valid, schemaVersion:0},
    {...valid, teacherId:'otherTeacher'}, {...valid, schoolId:'other'}]) {
    assert.equal(currentTeacherIndexAllowsStudent(changed,teacherId,studentId,schoolId),false)
  }
})
test('reservation and settlement re-read canonical index through authorized state', () => {
  const source = fs.readFileSync('functions/lib/aiWritingSponsoredEvaluation.js','utf8')
  assert.match(source, /teacherAcademicIndex\/\$\{updatedBy\}/)
  assert.match(source, /const fresh = await getAuthorizedState\(tx, refs\)/)
  assert.match(source, /currentTeacherIndexAllowsStudent\(/)
})
