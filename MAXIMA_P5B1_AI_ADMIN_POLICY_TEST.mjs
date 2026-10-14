import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  isEligiblePilotStudent, eligiblePilotStudents, parseCreditDelta,
  preparePilotChange, nextPendingOperation
} from './src/services/aiWritingPilotPolicy.js'

const root = dirname(fileURLToPath(import.meta.url))
let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`PASS ${name}`)
}
const good = { id: 'student_1234', role: 'student', accountType: 'institution', schoolId: 'maxima', status: 'approved', name: 'Pilot User' }
const old = { ...good, accountType: undefined }
const input = { studentId: good.id, creditsRemaining: 0, previousEnabled: false, enabled: true, delta: '5', requestId: 'pilot_test_123' }

test('Approved Maxima institution student eligible', () => assert.equal(isEligiblePilotStudent(good), true))
test('Legacy institution account eligible', () => assert.equal(isEligiblePilotStudent(old), true))
test('Individual account excluded', () => assert.equal(isEligiblePilotStudent({ ...good, accountType: 'individual' }), false))
test('Individual school excluded', () => assert.equal(isEligiblePilotStudent({ ...good, schoolId: '__individual__' }), false))
test('Platform account excluded', () => assert.equal(isEligiblePilotStudent({ ...good, accountType: 'platform' }), false))
test('Other school excluded', () => assert.equal(isEligiblePilotStudent({ ...good, schoolId: 'school_b' }), false))
test('Pending student excluded', () => assert.equal(isEligiblePilotStudent({ ...good, status: 'pending' }), false))
test('Rejected student excluded', () => assert.equal(isEligiblePilotStudent({ ...good, status: 'rejected' }), false))
test('Deleted student excluded', () => assert.equal(isEligiblePilotStudent({ ...good, deleted: true }), false))
test('Archived student excluded', () => assert.equal(isEligiblePilotStudent({ ...good, archived: true }), false))
test('Teacher and manager excluded', () => assert.equal(isEligiblePilotStudent({ ...good, role: 'teacher' }), false))
test('Unapproved legacy profile excluded by UI', () => assert.equal(isEligiblePilotStudent({ ...good, status: undefined }), false))
test('Malformed document ID excluded', () => assert.equal(isEligiblePilotStudent({ ...good, id: 'invalid id' }), false))
test('Student list excludes all non-eligible and sorts', () => {
  const a = { ...good, id: 'student_5678', name: 'Alpha' }
  assert.deepEqual(eligiblePilotStudents([good, a, { ...good, schoolId: 'other' }, { ...good, accountType: 'individual' }]).map(u=>u.id), [a.id, good.id])
})
test('Empty and invalid user collection is safe', () => assert.deepEqual(eligiblePilotStudents(null), []))
test('Whole number positive credit accepted', () => assert.equal(parseCreditDelta('5'), 5))
test('Negative credit accepted', () => assert.equal(parseCreditDelta('-2'), -2))
test('Zero credit accepted', () => assert.equal(parseCreditDelta('0'), 0))
test('Decimal credit denied', () => assert.equal(parseCreditDelta('0.5'), null))
test('Out of range credit denied', () => assert.equal(parseCreditDelta('101'), null))
test('Bad symbols denied', () => assert.equal(parseCreditDelta('5.0'), null))
test('Non-numeric credit denied', () => assert.equal(parseCreditDelta('five'), null))
test('Credit addition with enable valid', () => assert.deepEqual(preparePilotChange(input), { studentId: good.id, enabled: true, creditDelta: 5, requestId: 'pilot_test_123' }))
test('No changes denied', () => assert.throws(() => preparePilotChange({ ...input, enabled: false, delta: '0' }), /No changes/))
test('Enable with no credit denied', () => assert.throws(() => preparePilotChange({ ...input, delta: '0' }), /at least one/))
test('Withdrawal cannot overdraw balance', () => assert.throws(() => preparePilotChange({ ...input, creditsRemaining: 1, enabled: false, delta: '-2' }), /out of range/))
test('Credit cap enforced', () => assert.throws(() => preparePilotChange({ ...input, creditsRemaining: 999, delta: '5' }), /out of range/))
test('Invalid request ID denied', () => assert.throws(() => preparePilotChange({ ...input, requestId: 'a' }), /operation identifier/))
test('Malformed student ID denied', () => assert.throws(() => preparePilotChange({ ...input, studentId: 'bad uid' }), /institution student/))
test('Existing student can disable with zero adjustment', () => assert.equal(preparePilotChange({ ...input, creditsRemaining: 4, previousEnabled: true, enabled: false, delta: 0 }).enabled, false))
test('New request gets stable id', () => assert.deepEqual(nextPendingOperation(null, 'sig', ()=>'req_123456789'), { signature: 'sig', requestId: 'req_123456789' }))
test('Exact retry reuses same request ID', () => {
  const prior={signature:'s1',requestId:'req_123456789'}
  assert.strictEqual(nextPendingOperation(prior,'s1',()=>{throw new Error('must not generate new id')}), prior)
})
test('Changed request gets a new ID', () => assert.equal(nextPendingOperation({signature:'s1',requestId:'req_123456789'},'s2',()=>'req_new_123456').requestId, 'req_new_123456'))

const admin = readFileSync(resolve(root,'src/pages/AdminDashboard.jsx'),'utf8')
const panel = readFileSync(resolve(root,'src/components/AiWritingPilotPanel.jsx'),'utf8')
test('Admin imports controlled AI panel', () => assert.match(admin,/import AiWritingPilotPanel from ['"]\.\.\/components\/AiWritingPilotPanel['"]/))
test('AI navigation is independent from individual B2C', () => assert.match(admin,/id: 'aiWriting'/))
test('AI panel displayed only in selected nav', () => assert.match(admin,/adminSection === 'aiWriting' &&/))
test('Admin school ID comes from signed-in profile', () => assert.match(admin,/setAdminSchoolId\(profile\.schoolId \|\| DEFAULT_SCHOOL_ID\)/))
test('Panel uses only secure Firebase callable for read', () => assert.match(panel,/httpsCallable\(functions, 'getAdminAiWritingStudentAccess'\)/))
test('Panel uses server callable for student update', () => assert.match(panel,/httpsCallable\(functions, 'setAiWritingStudentAccess'\)/))
test('Panel uses server callable for school-wide control', () => assert.match(panel,/httpsCallable\(functions, 'setAiWritingSchoolPilot'\)/))
test('Panel checks admin school scope', () => assert.match(panel,/adminSchoolId === PILOT_SCHOOL_ID/))
test('Pilot enabling requires explicit confirmation', () => assert.match(panel,/const accepted = window.confirm\(target/))
test('Student permission writes require explicit confirmation', () => assert.match(panel,/window.confirm\(description\)/))
test('Browser never performs direct Firestore credit changes', () => assert.doesNotMatch(panel,/\bupdateDoc\s*\(|\bsetDoc\s*\(/))
test('Student UI and Mock remain unmodified by package', () => assert.doesNotMatch(panel,/DoWriting|DoMockTest/))
test('Panel has no OpenAI API secret or provider endpoint', () => assert.doesNotMatch(panel, /api\.openai\.com|OPENAI_API_KEY/))
console.log(`\nP5B-1 admin AI pilot tests: ${passed}/${passed} PASS`)
