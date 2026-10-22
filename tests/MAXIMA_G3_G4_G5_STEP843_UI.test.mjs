import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const path = new URL('../src/services/p0bG4AcademicScoreGrouping.js',import.meta.url)
const {groupScoresByStudent} = await import(path.href)

test('G4 admin groups old scores with only studentId',()=>{
  const grouped=groupScoresByStudent([
    {id:'legacy',studentId:'learnerABC',date:'2026-08-01',overall:6.5},
    {id:'latest',uid:'learnerABC',studentId:'learnerABC',date:'2026-10-01',overall:7}
  ])
  assert.deepEqual(grouped.learnerABC.map(v=>v.id),['latest','legacy'])
})
test('G4 rejects conflicting owner fields rather than attributing to either learner',()=>{
  const grouped=groupScoresByStudent([{uid:'alice',studentId:'bob',overall:8}])
  assert.equal(Object.keys(grouped).length,0)
})
test('G4 null/malformed IDs are never used as score bucket keys',()=>{
  const grouped=groupScoresByStudent([null,{}, {uid:'a/b'}, {studentId:'  '},
    {uid:'__proto__',studentId:'__proto__'}])
  assert.deepEqual(Object.keys(grouped), ['__proto__'])
  assert.equal(grouped['__proto__'].length,1)
  assert.equal(Object.getPrototypeOf(grouped),null)
})
test('G4 UI continues to call extracted grouping helper on both score subscriptions',()=>{
  const ui=fs.readFileSync(new URL('../src/pages/TeacherDashboard.jsx',import.meta.url),'utf8')
  assert.match(ui,/import \{ groupScoresByStudent \} from '\.\.\/services\/p0bG4AcademicScoreGrouping'/)
  assert.equal((ui.match(/setScores\(groupScoresByStudent\(items\)\)/g)||[]).length,1)
  assert.equal((ui.match(/setScores\(groupScoresByStudent\(scoreItems\)\)/g)||[]).length,1)
})
