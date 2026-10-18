import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const code = fs.readFileSync(new URL('../src/services/p7uiReviewPresentation.js', import.meta.url), 'utf8')
const { mockWritingDisplayStatus, isCurrentSavedAttemptMismatch } =
  await import(`data:text/javascript,${encodeURIComponent(code)}`)
const dashboard = fs.readFileSync(new URL('../src/pages/TeacherDashboard.jsx', import.meta.url), 'utf8')
const teacherPanel = fs.readFileSync(new URL('../src/components/AiWritingTeacherPanel.jsx', import.meta.url), 'utf8')

test('C19 empty Mock answer is not a pending teacher review', () => {
  const c19 = { result: { writing: { status: 'pending_review', task1WordCount: 0, task2WordCount: 0 } } }
  assert.equal(mockWritingDisplayStatus(c19), 'not_submitted')
})

test('legitimate Mock Writing text still remains pending teacher review', () => {
  assert.equal(mockWritingDisplayStatus({ writingAnswers: { task2: 'A completed essay.' }, result: { writing: { status: 'pending_review' } } }), 'pending_review')
  assert.equal(mockWritingDisplayStatus({ task1Answer: 'A map compares two periods.' }), 'pending_review')
})

test('reviewed historical Mock stays reviewed even when answer text missing', () => {
  assert.equal(mockWritingDisplayStatus({ writingReview: { status: 'reviewed', overall: 5.5 } }), 'reviewed')
  assert.equal(mockWritingDisplayStatus({ result: { writing: { status: 'reviewed', band: 9 } } }), 'reviewed')
})

test('historical teacher band is not hidden when old answer text is absent', () => {
  assert.equal(mockWritingDisplayStatus({ result: { writing: { band: 6, status: 'pending_review' } } }), 'pending_review')
  assert.equal(mockWritingDisplayStatus({ writingReview: { overall: 5.5 } }), 'pending_review')
})

test('explicitly omitted Writing is not reported as a missed submission', () => {
  assert.equal(mockWritingDisplayStatus({ enabledSections: { writing: false } }), 'not_included')
  assert.equal(mockWritingDisplayStatus({ result: { writing: { enabled: false, status: 'pending_review' } } }), 'not_included')
})

test('whitespace is not an essay, and nonzero word metadata needs an unavailable label', () => {
  assert.equal(mockWritingDisplayStatus({ writingAnswers: { task1: '  \n' } }), 'not_submitted')
  assert.equal(mockWritingDisplayStatus({ result: { writing: { task1WordCount: 140, status: 'pending_review' } } }), 'answer_unavailable')
})

test('only exact current-attempt precondition is considered an expected AI report mismatch', () => {
  const expected = { code: 'functions/failed-precondition', message: 'The selected submission is not the current saved attempt.' }
  assert.equal(isCurrentSavedAttemptMismatch(expected), true)
  assert.equal(isCurrentSavedAttemptMismatch({ ...expected, code: 'functions/permission-denied' }), false)
  assert.equal(isCurrentSavedAttemptMismatch({ ...expected, message: 'Permission denied.' }), false)
  assert.equal(isCurrentSavedAttemptMismatch(null), false)
})

test('teacher UI uses display-only Mock state and leaves stored submission unchanged', () => {
  assert.match(dashboard, /const getMockWritingStatus = submission => mockWritingDisplayStatus\(submission\)/)
  assert.match(dashboard, /Writing answer not submitted/)
  assert.match(dashboard, /getMockWritingStatus\(submission\) === 'reviewed'/)
  assert.match(dashboard, /onClick=\{\(\) => openMockWritingReview\(\{ student, mock, submission \}\)\}/)
})

test('AI report mismatch is a neutral explanation and does not bypass server authorization', () => {
  assert.match(teacherPanel, /getManagedAiWritingReportCall\(\{/)
  assert.match(teacherPanel, /isCurrentSavedAttemptMismatch\(error\)/)
  assert.match(teacherPanel, /status: 'attempt_mismatch'/)
  assert.match(teacherPanel, /The teacher review remains unchanged/)
  assert.doesNotMatch(teacherPanel, /httpsCallable\(functions, ['"](?:evaluateMyAiWriting|setAiWritingStudentAccess)['"]\)/)
})
