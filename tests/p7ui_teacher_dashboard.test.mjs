import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const helperPath = new URL('../src/services/teacherWritingReviewFallbacks.js', import.meta.url)
const helperSource = fs.readFileSync(helperPath, 'utf8')
const { buildMissingWritingReviewSources } = await import(`data:text/javascript,${encodeURIComponent(helperSource)}`)
const dashboard = fs.readFileSync(new URL('../src/pages/TeacherDashboard.jsx', import.meta.url), 'utf8')
const student = { id: 'student-1' }
const belongsToStudent = (s, st) => s.uid === st.id

test('missing Writing source still produces a reviewable entry for its student', () => {
  const actual = buildMissingWritingReviewSources({
    submissions: [{ uid: 'student-1', writingId: 'CaseSensitiveID', contentType: 'task2_only', submittedAt: '2026-10-01' }],
    writings: [], student, belongsToStudent
  })
  assert.equal(actual.length, 1)
  assert.equal(actual[0].id, 'CaseSensitiveID')
  assert.equal(actual[0].writingMode, 'task2_only')
  assert.equal(actual[0].missingContent, true)
  assert.equal(actual[0].createdAt, '2026-10-01')
})

test('visible homework is not duplicated by the fallback', () => {
  const actual = buildMissingWritingReviewSources({
    submissions: [{ uid: 'student-1', writingId: 'EssayA' }],
    writings: [{ id: 'EssayA', title: 'Essay' }], student, belongsToStudent
  })
  assert.deepEqual(actual, [])
})

test('another student submission never becomes visible', () => {
  const actual = buildMissingWritingReviewSources({
    submissions: [
      { uid: 'student-2', writingId: 'PrivateEssay' },
      { uid: 'student-1', writingId: '' },
      { uid: 'student-1', writingId: 'AllowedEssay' }
    ], writings: [], student, belongsToStudent
  })
  assert.deepEqual(actual.map(item => item.id), ['AllowedEssay'])
})

test('duplicate submissions do not create duplicate Writing sources', () => {
  const actual = buildMissingWritingReviewSources({
    submissions: [
      { uid: 'student-1', writingId: 'essayB' },
      { uid: 'student-1', writingId: 'EssayB' }
    ], writings: [], student, belongsToStudent
  })
  assert.equal(actual.length, 1)
})

test('homework has visible category controls for all four types', () => {
  for (const category of ['reading', 'writing', 'listening', 'vocabulary']) {
    assert.ok(dashboard.includes(`studentHomeworkTypeView === '${category}'`), category)
  }
  assert.ok(dashboard.includes('aria-label="Homework type"'))
})

test('Mock History offers direct teacher Writing review', () => {
  assert.ok(dashboard.includes('Open Writing Review'))
  assert.ok(dashboard.includes('onClick={() => openMockWritingReview({ student, mock, submission })}'))
})

test('Writing Homework can open its submission directly and fallback disables retakes', () => {
  assert.ok(dashboard.includes('onClick={() => openWritingReview({ student, writing, submission })}'))
  assert.ok(dashboard.includes("{writing.missingContent !== true && ("))
})
