import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  isInstitutionWritingStudent,
  safeAiWritingAccess,
  safeAiWritingEnvelope,
  shouldShowAiWritingPanel,
  canRequestAiWriting,
  formatAiBand,
  aiWritingCriterionRows,
  readableAiWritingError
} from './src/services/aiWritingStudentPolicy.js'

const tests = []
function test(title, run) { tests.push([title, run]) }
const approved = { role: 'student', status: 'approved', schoolId: 'maxima', accountType: 'institution' }
const eligibleAccess = { schoolId: 'maxima', accountType: 'institution', pilotEnabled: true,
  studentEnabled: true, canEvaluate: true, creditsRemaining: 5 }
const sampleReport = { isAiEstimate: true, estimatedBand: 6.5, context: 'homework', task1: {
  criteria: { taskAchievementOrResponse: { band: 6.5, explanation: 'Clear', evidence: 'The city' },
    coherenceAndCohesion: { band: 6.0, explanation: 'Linking', evidence: '' },
    lexicalResource: { band: 6.5, explanation: 'Vocabulary', evidence: '' },
    grammaticalRangeAndAccuracy: { band: 6.0, explanation: 'Grammar', evidence: '' } }
} }
const completed = { status: 'completed', attemptNumber: 1, report: sampleReport }
const access = safeAiWritingAccess(eligibleAccess)
const envelope = safeAiWritingEnvelope(completed, 1)
const doWriting = readFileSync('src/pages/DoWriting.jsx', 'utf8')
const panel = readFileSync('src/components/AiWritingStudentPanel.jsx', 'utf8')
const policy = readFileSync('src/services/aiWritingStudentPolicy.js', 'utf8')
const mock = readFileSync('src/pages/DoMockTest.jsx', 'utf8')

// Institution vs individual protection.
test('Approved Maxima institution student included', () => assert.equal(isInstitutionWritingStudent(approved), true))
test('Legacy institution student with missing accountType included', () => assert.equal(isInstitutionWritingStudent({ ...approved, accountType: undefined }), true))
test('Individual account excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, accountType: 'individual' }), false))
test('Explicit individual school excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, schoolId: '__individual__' }), false))
test('Other school excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, schoolId: 'other' }), false))
test('Pending student excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, status: 'pending' }), false))
test('Rejected student excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, status: 'rejected' }), false))
test('Deleted student excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, deleted: true }), false))
test('Archived student excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, archived: true }), false))
test('Teacher role excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, role: 'teacher' }), false))
test('Admin role excluded', () => assert.equal(isInstitutionWritingStudent({ ...approved, role: 'admin' }), false))
test('Missing profile excluded', () => assert.equal(isInstitutionWritingStudent(null), false))

// Server-provided access is presented cautiously.
test('Valid permitted access normalized', () => assert.deepEqual(access, {
  pilotEnabled: true, studentEnabled: true, creditsRemaining: 5, canEvaluate: true }))
test('Invalid access payload excluded', () => assert.equal(safeAiWritingAccess([]), null))
test('Wrong school access excluded', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, schoolId: 'wrong' }), null))
test('Individual access excluded', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, accountType: 'individual' }), null))
test('School disabled denies evaluation', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, pilotEnabled: false }).canEvaluate, false))
test('Student disabled denies evaluation', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, studentEnabled: false }).canEvaluate, false))
test('Zero credits denies evaluation', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, creditsRemaining: 0 }).canEvaluate, false))
test('Client cannot override server canEvaluate', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, canEvaluate: false }).canEvaluate, false))
test('Fractional balance is not accepted', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, creditsRemaining: 3.5 }).creditsRemaining, 0))
test('Negative balance is not accepted', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, creditsRemaining: -1 }).creditsRemaining, 0))
test('Over-limit balance is not accepted', () => assert.equal(safeAiWritingAccess({ ...eligibleAccess, creditsRemaining: 1001 }).creditsRemaining, 0))

// Only the current submission attempt may show a stored report.
test('Completed current-attempt report is accepted', () => assert.deepEqual(envelope, {
  status: 'completed', report: sampleReport, attemptNumber: 1, reused: false }))
test('Previous-attempt report is rejected', () => assert.equal(safeAiWritingEnvelope(completed, 2).status, 'stale_attempt'))
test('Future-attempt report is rejected', () => assert.equal(safeAiWritingEnvelope({ ...completed, attemptNumber: 2 }, 1).status, 'stale_attempt'))
test('Unknown response status rejected', () => assert.equal(safeAiWritingEnvelope({ status: 'removed' }, 1).status, 'unavailable'))
test('Malformed completion payload rejected', () => assert.equal(safeAiWritingEnvelope({ ...completed, report: {} }, 1).status, 'unavailable'))
test('Fake non-AI score rejected', () => assert.equal(safeAiWritingEnvelope({ ...completed, report: { ...sampleReport, isAiEstimate: false } }, 1).status, 'unavailable'))
test('Mock report cannot appear as homework', () => assert.equal(safeAiWritingEnvelope({ ...completed, report: { ...sampleReport, context: 'mock' } }, 1).status, 'unavailable'))
test('NaN band rejected', () => assert.equal(safeAiWritingEnvelope({ ...completed, report: { ...sampleReport, estimatedBand: NaN } }, 1).status, 'unavailable'))
test('Not started preserved', () => assert.equal(safeAiWritingEnvelope({ status: 'not_started' }, 1).status, 'not_started'))
test('Processing preserved', () => assert.equal(safeAiWritingEnvelope({ status: 'processing' }, 1).status, 'processing'))
test('Failed retry preserved', () => assert.deepEqual(safeAiWritingEnvelope({ status: 'failed', canRetry: true }, 1), { status: 'failed', canRetry: true }))

// Display and charge safety.
test('Authorized pilot student sees panel', () => assert.equal(shouldShowAiWritingPanel(access, { status: 'not_started' }), true))
test('Non-authorized user cannot see empty panel', () => assert.equal(shouldShowAiWritingPanel({ ...access, studentEnabled: false }, { status: 'not_started' }), false))
test('Pilot disabled hides unused feature', () => assert.equal(shouldShowAiWritingPanel({ ...access, pilotEnabled: false }, { status: 'not_started' }), false))
test('Completed report remains visible at zero credits', () => assert.equal(shouldShowAiWritingPanel({ ...access, creditsRemaining: 0 }, envelope), true))
test('Completed report remains visible after pilot disabled', () => assert.equal(shouldShowAiWritingPanel({ ...access, pilotEnabled: false }, envelope), true))
test('One new evaluation allowed by default state', () => assert.equal(canRequestAiWriting(access, { status: 'not_started' }, false), true))
test('Busy request cannot repeat', () => assert.equal(canRequestAiWriting(access, { status: 'not_started' }, true), false))
test('Processing job cannot repeat', () => assert.equal(canRequestAiWriting(access, { status: 'processing' }, false), false))
test('Completed report cannot consume a second credit', () => assert.equal(canRequestAiWriting(access, envelope, false), false))
test('Unavailable report cannot trigger paid request', () => assert.equal(canRequestAiWriting(access, { status: 'unavailable' }, false), false))
test('Failed job can retry with credit', () => assert.equal(canRequestAiWriting(access, { status: 'failed' }, false), true))
test('Zero-credit failed job cannot retry', () => assert.equal(canRequestAiWriting({ ...access, canEvaluate: false }, { status: 'failed' }, false), false))
test('Estimate formatting is explicit', () => assert.equal(formatAiBand(6.5), '6.5'))
test('Invalid band displays placeholder', () => assert.equal(formatAiBand(null), '-'))
test('Four rubric criterion rows presented', () => assert.equal(aiWritingCriterionRows(sampleReport.task1, 1).length, 4))
test('Task 1 rubric wording correct', () => assert.equal(aiWritingCriterionRows(sampleReport.task1, 1)[0].label, 'Task Achievement'))
test('Task 2 rubric wording correct', () => assert.equal(aiWritingCriterionRows(sampleReport.task1, 2)[0].label, 'Task Response'))
test('Unpublished backend is explained', () => assert.match(readableAiWritingError({ code: 'functions/not-found' }), /not available yet/))
test('Permission error has safe message', () => assert.match(readableAiWritingError({ code: 'functions/permission-denied' }), /not enabled/))

// Static integration contract: no provider keys, Firestore direct reads/writes,
// or student-submitted essay text in callable parameters.
test('DoWriting imports isolated institution student policy', () => assert.match(doWriting, /isInstitutionWritingStudent/))
test('DoWriting mounts AI only after submission', () => assert.match(doWriting, /isInstitutionStudent && completedSubmission\?\.id/))
test('AI report is keyed by actual submission ID', () => assert.match(doWriting, /completedSubmission\.id\}`/))
test('DoWriting retains secure Writing submission callable', () => assert.match(doWriting, /submitWritingSecureCall\(/))
test('DoWriting retains teacher feedback section', () => assert.match(doWriting, /Teacher feedback/))
test('DoWriting retains local autosave safety', () => assert.match(doWriting, /saveDraftToStorage/))
test('DoWriting retains retake current-attempt logic', () => assert.match(doWriting, /getStudentSubmissionAttemptStateCall/))
test('AI report uses getMyAiWritingReport callable', () => assert.match(panel, /httpsCallable\(functions, 'getMyAiWritingReport'\)/))
test('AI access uses getMyAiWritingAccess callable', () => assert.match(panel, /httpsCallable\(functions, 'getMyAiWritingAccess'\)/))
test('AI evaluation uses secure server callable', () => assert.match(panel, /httpsCallable\(functions, 'evaluateMyAiWriting'/))
test('Evaluation request sends only context/contentId', () => assert.match(panel, /\(\{ context: 'homework', contentId \}\)/))
test('AI evaluation requires explicit confirmation', () => assert.match(panel, /window\.confirm/))
test('There is no automatic paid evaluation effect', () => assert.doesNotMatch(panel.slice(panel.indexOf('useEffect('), panel.indexOf('const startEvaluation')), /evaluateMyAiWritingCall\(/))
test('No direct Firestore access from component', () => assert.doesNotMatch(panel, /firebase\/firestore|setDoc\(|getDoc\(|updateDoc\(|deleteDoc\(/))
test('No API secret in client', () => assert.doesNotMatch(panel + policy, /OPENAI_API_KEY|Authorization: Bearer|sk-proj-/))
test('Teacher review button not prematurely introduced', () => assert.doesNotMatch(panel, /Send to Teacher|Send to my Teacher|Request teacher review/))
test('Student report does not use unsafe HTML', () => assert.doesNotMatch(panel, /dangerouslySetInnerHTML/))
test('AI estimate clearly disclosed', () => assert.match(panel, /not official IELTS scores/))
test('Task 2 weight disclosed', () => assert.match(panel, /Task 2 counts twice/))
test('Teacher score remains separate', () => assert.match(panel, /teacher's assessment/))
test('Existing Mock source remains untouched by this stage', () => assert.ok(mock.includes('mockTestId') || mock.includes('mockId')))

let fail = 0
for (const [title, run] of tests) {
  try { run(); console.log('PASS', title) }
  catch (error) { fail += 1; console.error('FAIL', title, error.message) }
}
console.log(`\nP5B-2 student Writing UI policy/integration: ${tests.length - fail}/${tests.length} PASS; ${fail} FAIL`)
if (fail) process.exitCode = 1
