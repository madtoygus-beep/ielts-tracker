'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const {classifyLegacyIdentity} = require('../tools/p0bG4LegacyAcademicPreview.cjs')
const schoolStudent = {role:'student',status:'approved',schoolId:'maxima',accountType:'institution'}
const source = fs.readFileSync('firestore.rules', 'utf8')
const teacherUI = fs.readFileSync('src/pages/TeacherDashboard.jsx','utf8')
const work = (record, overrides={}) => classifyLegacyIdentity({
  collection:'scores',docId:'random_old_score',record,profile:schoolStudent,
  profileUid:'student123',...overrides
})

test('G4 legacy score with studentId only is a PREVIEW candidate, not a live write',()=>{
  assert.deepEqual(work({studentId:'student123'}),{
    kind:'candidate_preview_only',reason:'identity_consistent',
    updates:{uid:'student123',schoolId:'maxima'}
  })
})
test('G4 legacy score with uid only is a preview candidate',()=>{
  assert.deepEqual(work({uid:'student123',schoolId:'maxima'}).updates,{studentId:'student123'})
})
test('G4 conflicting uid/studentId cannot be migrated automatically',()=>{
  assert.equal(work({uid:'otherStudent',studentId:'student123'}).kind,'conflict')
  assert.equal(work({uid:'student123',studentId:'otherStudent'}).kind,'conflict')
})
test('G4 cross-school data never receives another school identity',()=>{
  assert.equal(work({studentId:'student123',schoolId:'otherSchool'}).kind,'conflict')
  assert.equal(work({studentId:'student123'}, {profile:{...schoolStudent,schoolId:'otherSchool'}}).kind,'manual_review')
})
test('G4 missing both identities is never assigned using guessed doc ID',()=>{
  assert.equal(work({teacherIds:['someTeacher']}).kind,'manual_review')
})
test('G4 inactive or deleted students are held for manual review',()=>{
  for (const p of [{status:'deleted'},{deleted:true},{archived:true},{role:'teacher'},
    {accountType:'individual'},{permanentDeleteInProgress:true}]) {
    assert.equal(work({uid:'student123'}, {profile:{...schoolStudent,...p}}).kind,'manual_review')
  }
})
test('G4 malformed IDs and unrelated collections cannot be preview-approved',()=>{
  assert.equal(work({uid:'student123'},{docId:'x/y'}).kind,'manual_review')
  assert.equal(work({uid:'student123'},{collection:'classes'}).kind,'manual_review')
  assert.equal(work({uid:'student123'},{profileUid:'wrongOwner'}).kind,'conflict')
})
test('G4 already canonical documents are not modified',()=>{
  assert.equal(work({uid:'student123',studentId:'student123',schoolId:'maxima'}).kind,'already_canonical')
})
test('G4 keep student answer/score identity checks in Rules; no legacy public list bypass',()=>{
  assert.match(source,/function teacherCanonicalAcademicList\(data\)/)
  assert.match(source,/data\.get\('studentId', ''\) == data\.get\('uid', ''\)/)
  assert.match(teacherUI,/buildCanonicalAcademicQuery/)
  assert.match(teacherUI,/where\('uid', '==', uid\)/)
  assert.match(teacherUI,/where\('studentId', '==', uid\)/)
})
test('G4 preview implementation contains no Firebase admin or apply path',()=>{
  const code=fs.readFileSync('tools/p0bG4LegacyAcademicPreview.cjs','utf8')
  assert.doesNotMatch(code, /require\(['"]firebase-admin|firebase deploy|gcloud /)
  assert.doesNotMatch(code, /\.update\(|\.delete\(|\.set\(|\.create\(/)
})
