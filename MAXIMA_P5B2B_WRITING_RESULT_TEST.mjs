import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  isInstitutionWritingStudent,
  safeAiWritingEnvelope,
  shouldShowAiWritingPanel,
  canRequestAiWriting
} from './src/services/aiWritingStudentPolicy.js'

const page = readFileSync('src/pages/StudentDashboard.jsx', 'utf8')
const writing = readFileSync('src/pages/DoWriting.jsx', 'utf8')
const panel = readFileSync('src/components/AiWritingStudentPanel.jsx', 'utf8')
const cases = []
function check(label, fn) { cases.push([label, fn]) }
const institution = { role: 'student', status: 'approved', schoolId: 'maxima', accountType: 'institution' }
const access = { pilotEnabled: true, studentEnabled: true, canEvaluate: true, creditsRemaining: 5 }
const report = { isAiEstimate: true, estimatedBand: 6.5, context: 'homework', task1: { estimatedBand: 6.5 } }

check('StudentDashboard imports shared AI Writing panel', () => assert.match(page, /import AiWritingStudentPanel from '\.\.\/components\/AiWritingStudentPanel'/))
check('StudentDashboard imports shared institution-only policy', () => assert.match(page, /import \{ isInstitutionWritingStudent \} from '\.\.\/services\/aiWritingStudentPolicy'/))
check('AI panel is inside completed Writing feedback modal', () => {
  const modal = page.indexOf('{selectedReview && (() => {')
  const mount = page.indexOf('<AiWritingStudentPanel', modal)
  const closing = page.indexOf('function StudentTodoSummary', modal)
  assert.ok(modal > 0 && mount > modal && mount < closing)
})
check('AI panel mounts only for institution students', () => assert.match(page, /isInstitutionWritingStudent\(profile\)\s*&&\s*selectedReview\.writing\?\.id/))
check('AI mount requires a real saved submission', () => assert.match(page, /selectedReview\.submission\?\.id\s*&&\s*\(\s*<AiWritingStudentPanel/))
check('AI report content ID comes from selected writing', () => assert.match(page, /contentId=\{selectedReview\.writing\.id\}/))
check('AI report attempt is normalized from selected submission', () => assert.match(page, /attemptNumber=\{submissionAttemptNumber\(selectedReview\.submission\)\}/))
check('AI panel identity is bound to user, writing and submission IDs', () => assert.match(page, /key=\{`\$\{user\?\.uid \|\| ''\}:\$\{selectedReview\.writing\.id\}:\$\{selectedReview\.submission\.id\}`\}/))
check('Results are fetched by Q2 secure server snapshot, not direct Firestore', () => assert.match(page, /const snapshot = await getStudentVisibleResultSnapshot\('writing', w\.id\)/))
check('Modal uses the selected verified submission from secure snapshot', () => assert.match(page, /setSelectedReview\(\{ writing: w, submission: selected \}\)/))
check('Modal preserves teacher reviewed score display', () => assert.match(page, /reviewed\s*\? `Overall Band \$\{review\.overall \|\| '-'\}`/))
check('Modal preserves original Task 1 answer', () => assert.match(page, /selectedReview\.submission\.task1Answer/))
check('Modal preserves original Task 2 answer', () => assert.match(page, /selectedReview\.submission\.task2Answer/))
check('Modal preserves teacher Task 1 feedback', () => assert.match(page, /review\.task1Feedback/))
check('Modal preserves teacher Task 2 feedback', () => assert.match(page, /review\.task2Feedback/))
check('Modal preserves teacher general feedback', () => assert.match(page, /review\.generalFeedback/))
check('Writing list still has Review Feedback', () => assert.match(page, /'Review Feedback' : 'View Submission'/))
check('Existing retake handling retained', () => assert.match(page, /const hasOpenRetake = writingId =>/))
check('DoWriting initial AI entry point retained', () => assert.match(writing, /<AiWritingStudentPanel/))
check('Student component never writes credits directly', () => {
  assert.doesNotMatch(panel, /updateDoc\(|setDoc\(|runTransaction\(|addDoc\(/)
  assert.doesNotMatch(page.slice(page.indexOf('function WritingHomeworkSection'), page.indexOf('function StudentTodoSummary')), /\b(updateDoc|setDoc|runTransaction|addDoc)\(/)
})
check('AI callable uses only source content ID', () => assert.match(panel, /\(\{ context: 'homework', contentId \}\)/))
check('AI score separate from teacher grade', () => assert.match(panel, /This report does not replace a teacher's assessment/))
check('No automatic AI evaluation on page mount', () => {
  const effect = panel.slice(panel.indexOf('useEffect(() => {'), panel.indexOf('const startEvaluation'))
  assert.doesNotMatch(effect, /evaluateMyAiWritingCall/)
})
check('Student must confirm credit spending', () => assert.match(panel, /window\.confirm\(/))
check('AI absent for individually enrolled users', () => assert.equal(isInstitutionWritingStudent({ ...institution, accountType: 'individual' }), false))
check('AI absent for foreign-school accounts', () => assert.equal(isInstitutionWritingStudent({ ...institution, schoolId: 'other' }), false))
check('AI absent for pending school accounts', () => assert.equal(isInstitutionWritingStudent({ ...institution, status: 'pending' }), false))
check('AI absent for deleted school accounts', () => assert.equal(isInstitutionWritingStudent({ ...institution, deleted: true }), false))
check('Existing completed AI report survives zero remaining credits', () => assert.equal(shouldShowAiWritingPanel({ ...access, creditsRemaining: 0 }, { status: 'completed' }), true))
check('No AI button while pilot disabled and no saved report', () => assert.equal(shouldShowAiWritingPanel({ ...access, pilotEnabled: false }, { status: 'not_started' }), false))
check('The same completed report cannot be recharged', () => assert.equal(canRequestAiWriting(access, { status: 'completed' }, false), false))
check('Different attempt report is marked stale', () => assert.equal(safeAiWritingEnvelope({ status: 'completed', attemptNumber: 1, report }, 2).status, 'stale_attempt'))
check('Same attempt report is readable', () => assert.equal(safeAiWritingEnvelope({ status: 'completed', attemptNumber: 1, report }, 1).status, 'completed'))
check('Existing Mock interface is unchanged', () => assert.doesNotMatch(page.slice(page.indexOf('function WritingHomeworkSection'), page.indexOf('function StudentTodoSummary')), /context:\s*'mock'/))

let errors = 0
for (const [label, fn] of cases) {
  try { await fn(); console.log('PASS', label) } catch (error) { errors++; console.error('FAIL', label, error.message) }
}
console.log(`\nP5B-2B saved Writing AI report integration: ${cases.length-errors}/${cases.length} PASS; ${errors} FAIL`)
if (errors) process.exitCode = 1
