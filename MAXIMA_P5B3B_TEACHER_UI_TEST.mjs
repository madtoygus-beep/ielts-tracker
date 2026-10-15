import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  AI_SPONSORED_SCHOOL_ID, MAX_AI_SPONSORED_STUDENTS,
  emptyAiSponsoredSelection, normalizeAiSponsoredPolicy,
  eligibleAiSponsoredStudents, buildAiSponsoredWriteRequest,
  shouldSaveAiSponsoredPolicy, shouldRetireMockAiSponsoredPolicy
} from './src/services/aiWritingSponsoredAssignmentPolicy.js'

let passed = 0
let failed = 0
const check = (name, test) => {
  try { test(); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message) }
}
const validId = 'studentID123'
const secondId = 'studentID456'
const getStudent = (id = validId, overrides = {}) => ({
  id, name: 'Student', role: 'student', status: 'approved',
  accountType: 'institution', schoolId: 'maxima', ...overrides
})
const call = (selection, assignedStudentIds = [validId]) =>
  buildAiSponsoredWriteRequest({ contentType: 'writing', contentId: 'writingABC123', selection, assignedStudentIds })
const baseline = { ok: true, contentType: 'writing', contentId: 'writingABC123', billing: 'institution', enabled: true, studentIds: [validId], configured: true }
const writing = fs.readFileSync('src/pages/CreateWriting.jsx', 'utf8')
const mock = fs.readFileSync('src/pages/CreateMockTest.jsx', 'utf8')
const component = fs.readFileSync('src/components/AiWritingSponsoredAssignmentPanel.jsx', 'utf8')
const p5b3a = fs.readFileSync('functions/lib/aiWritingSponsoredPolicy.js', 'utf8')
const previousAssignments = fs.readFileSync('functions/index.js', 'utf8')

check('Default AI sponsored policy is disabled', () => assert.deepEqual(emptyAiSponsoredSelection(), {enabled:false, studentIds:[], configured:false}))
check('School pilot ID remains Maxima only', () => assert.equal(AI_SPONSORED_SCHOOL_ID, 'maxima'))
check('Sponsored policy student cap matches backend', () => assert.equal(MAX_AI_SPONSORED_STUDENTS, 60))
check('Loaded policy recognizes selected student', () => assert.deepEqual(normalizeAiSponsoredPolicy(baseline,'writing','writingABC123'), {enabled:true,studentIds:[validId],configured:true}))
check('Server disabled policy remains disabled', () => assert.equal(normalizeAiSponsoredPolicy({...baseline,enabled:false},'writing','writingABC123').enabled,false))
check('No selected students cannot display enabled', () => assert.equal(normalizeAiSponsoredPolicy({...baseline,studentIds:[]},'writing','writingABC123').enabled,false))
check('Missing policy payload rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy(null,'writing','writingABC123')))
check('Foreign contentType policy rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,contentType:'mock'},'writing','writingABC123')))
check('Foreign content ID policy rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,contentId:'other'},'writing','writingABC123')))
check('Foreign billing source rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,billing:'student'},'writing','writingABC123')))
check('No okay status rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,ok:false},'writing','writingABC123')))
check('Non-array students rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,studentIds:'abc'},'writing','writingABC123')))
check('Duplicate stored student rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,studentIds:[validId,validId]},'writing','writingABC123')))
check('Malformed stored student rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,studentIds:['bad/uid']},'writing','writingABC123')))
check('Over-limit stored students rejected', () => assert.throws(()=>normalizeAiSponsoredPolicy({...baseline,studentIds:Array.from({length:61},(_,i)=>'student_'+i)},'writing','writingABC123')))
check('Normal Maxima student eligible', () => assert.deepEqual(eligibleAiSponsoredStudents([getStudent()],[validId]).map(s=>s.id),[validId]))
check('Legacy institution student eligible', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{accountType:undefined,schoolId:undefined})],[validId]).length,1))
check('Other school student excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{schoolId:'another'})],[validId]).length,0))
check('Individual student excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{accountType:'individual'})],[validId]).length,0))
check('Individual school excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{schoolId:'__individual__'})],[validId]).length,0))
check('Unassigned student excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent()],[]).length,0))
check('Pending student excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{status:'pending'})],[validId]).length,0))
check('Deleted student excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{deleted:true})],[validId]).length,0))
check('Archived student excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{archived:true})],[validId]).length,0))
check('Deletion in progress excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{permanentDeleteInProgress:true})],[validId]).length,0))
check('Teacher account excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent(validId,{role:'teacher'})],[validId]).length,0))
check('Malformed UID excluded', () => assert.equal(eligibleAiSponsoredStudents([getStudent('not/allowed')],['not/allowed']).length,0))
check('Student without profile ignored', () => assert.equal(eligibleAiSponsoredStudents([null],[validId]).length,0))
check('Missing arrays return safe empty', () => assert.deepEqual(eligibleAiSponsoredStudents(null,null),[]))
check('Enabled policy selects actual assigned student', () => assert.deepEqual(call({enabled:true,studentIds:[validId]}),{contentType:'writing',contentId:'writingABC123',enabled:true,studentIds:[validId]}))
check('Unassigned selected UID not granted', () => assert.deepEqual(call({enabled:true,studentIds:[validId,secondId]}).studentIds,[validId]))
check('Unassigned-only AI selection fails', () => assert.throws(()=>call({enabled:true,studentIds:[secondId]})))
check('Enabled without a selected student fails', () => assert.throws(()=>call({enabled:true,studentIds:[]})))
check('Disabled policy clears student selections', () => assert.deepEqual(call({enabled:false,studentIds:[validId]}).studentIds,[]))
check('Disabled policy ignores malformed old selections', () => assert.deepEqual(call({enabled:false,studentIds: Array(100).fill('bad/uid')}).studentIds,[]))
check('Duplicates cannot inflate selected count', () => assert.deepEqual(call({enabled:true,studentIds:[validId,validId]}).studentIds,[validId]))
check('Student IDs are deterministic sorted', () => assert.deepEqual(call({enabled:true,studentIds:[secondId,validId]},[validId,secondId]).studentIds,[validId,secondId]))
check('Mock context payload supported', () => assert.equal(buildAiSponsoredWriteRequest({contentType:'mock',contentId:'mockABC123',selection:{enabled:true,studentIds:[validId]},assignedStudentIds:[validId]}).contentType,'mock'))
check('Arbitrary context rejected', () => assert.throws(()=>buildAiSponsoredWriteRequest({contentType:'reading',contentId:'testID',selection:{enabled:true,studentIds:[validId]},assignedStudentIds:[validId]})))
check('Invalid Firestore document path rejected', () => assert.throws(()=>buildAiSponsoredWriteRequest({contentType:'mock',contentId:'../bad',selection:{enabled:false,studentIds:[]},assignedStudentIds:[]})))
check('Over 60 selected students rejected', () => {const ids=Array.from({length:61},(_,i)=>'student_'+i);assert.throws(()=>call({enabled:true,studentIds:ids},ids))})
check('Exactly 60 student selection accepted', () => {const ids=Array.from({length:60},(_,i)=>'student_'+i);assert.equal(call({enabled:true,studentIds:ids},ids).studentIds.length,60)})
check('New content with AI off avoids backend writes', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:false,selection:{enabled:false,configured:false},ready:true,schoolId:'maxima'}),false))
check('New content with AI on writes backend policy', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:false,selection:{enabled:true},ready:true,schoolId:'maxima'}),true))
check('Previously configured content can be disabled', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:false,selection:{enabled:false,configured:true},ready:true,schoolId:'maxima'}),true))
check('Editing existing content does not create unrequested AI policy', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:true,selection:{enabled:false,configured:false},ready:true,schoolId:'maxima'}),false))
check('Editing previously configured content can turn sponsored AI off', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:true,selection:{enabled:false,configured:true},ready:true,schoolId:'maxima'}),true))
check('School outside pilot never writes policy', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:true,selection:{enabled:true},ready:true,schoolId:'other'}),false))
check('Unavailable backend never writes policy', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:true,selection:{enabled:true},ready:false,schoolId:'maxima'}),false))
check('Mock without Writing cannot save AI policy', () => assert.equal(shouldSaveAiSponsoredPolicy({isEditMode:true,selection:{enabled:true},ready:true,schoolId:'maxima',hasWriting:false}),false))
const retire = options=>shouldRetireMockAiSponsoredPolicy({isEditMode:true,existingMock:{writingId:'oldResource',mockType:'full_mock'},wasWritingEnabled:true,newWritingId:'newResource',newWritingEnabled:true,configured:true,ready:true,...options})
check('Replacing Mock Writing retires old sponsor policy', () => assert.equal(retire(),true))
check('Removing Mock Writing retires old sponsor policy', () => assert.equal(retire({newWritingEnabled:false,newWritingId:''}),true))
check('Unchanged Writing source does not retire', () => assert.equal(retire({newWritingId:'oldResource'}),false))
check('New Mock does not retire', () => assert.equal(retire({isEditMode:false}),false))
check('Unconfigured Mock does not retire', () => assert.equal(retire({configured:false}),false))
check('Previously disabled Writing does not retire', () => assert.equal(retire({wasWritingEnabled:false}),false))
check('Unavailable policy cannot be silently retired', () => assert.equal(retire({ready:false}),false))
check('Missing old Mock cannot be retired', () => assert.equal(retire({existingMock:null}),false))
check('UI uses backend-sponsored getter in both pages', () => {for(const s of [writing,mock])assert.ok(s.includes("httpsCallable(functions, 'getAiWritingSponsoredPolicy')"))})
check('UI uses backend-sponsored setter in both pages', () => {for(const s of [writing,mock])assert.ok(s.includes("httpsCallable(functions, 'setAiWritingSponsoredPolicy')"))})
check('Writing UI has an independently targeted student selector', () => assert.match(writing,/contentType="writing"[\s\S]*?assignedIds=\{assignTo\}/))
check('Mock UI has an independently targeted student selector', () => assert.match(mock,/contentType="mock"[\s\S]*?assignedIds=\{assignTo\}/))
check('Teacher student selector is school restricted', () => {for(const s of [writing,mock])assert.match(s,/sponsoredSchool && \(\s*<AiWritingSponsoredAssignmentPanel/ )})
check('Teacher assignments remain canonical server callables', () => {for(const s of [writing,mock])assert.match(s,/const setContentStudentAccessCall = httpsCallable\(functions, 'setContentStudentAccess'\)/)})
check('Writing AI assignment write happens after canonical save', () => assert.ok(writing.indexOf('await setContentStudentAccessCall({')<writing.indexOf('await setSponsoredPolicyCall(buildAiSponsoredWriteRequest')))
check('Mock AI assignment write happens after canonical save', () => assert.ok(mock.indexOf('await setContentStudentAccessCall({')<mock.indexOf('await setSponsoredPolicyCall(buildAiSponsoredWriteRequest')))
check('Mock old policy retirement happens before resource mutation', () => assert.ok(mock.indexOf("contentType: 'mock', contentId: id, enabled: false") < mock.indexOf("await updateDoc(doc(db, 'mockTests', id)")))
check('Edit existing Writing loads policy after canonical memberships', () => assert.ok(writing.indexOf('const canonicalStudentIds')<writing.indexOf('await getSponsoredPolicyCall')))
check('Edit existing Mock loads policy after canonical memberships', () => assert.ok(mock.indexOf('const canonicalStudentIds')<mock.indexOf('await getSponsoredPolicyCall')))
check('AI panel has no directly payable evaluation action', () => assert.ok(!/evaluateAiWriting|openai|apiKey|fetch\(/i.test(component)))
check('Student credits not modified in P5B-3B UI', () => {for(const s of [writing,mock,component])assert.ok(!/creditsRemaining\s*=|studentCredit.*updateDoc|openAiWritingProvider/i.test(s))})
check('AI is opt in and not enabled automatically', () => assert.match(component,/checked=\{enabled && hasWriting\}/))
check('AI targets only assigned students', () => assert.match(component,/eligibleAiSponsoredStudents\(students, assignedIds\)/))
check('AI panel cannot override server policy', () => assert.match(p5b3a,/checkedStudent\(profile, access, config\.studentIds\[i\]/))
check('Both content editors retain original assignment handlers', () => {assert.match(writing,/Save & Assign Writing/);assert.match(mock,/Save Mock Changes/)})
check('Writing policy failure redirects to edit existing ID', () => assert.match(writing,/navigate\(`\/edit-writing\/\$\{savedWritingId\}`/))
check('Mock policy failure redirects to edit existing ID', () => assert.match(mock,/navigate\(`\/edit-mock\/\$\{savedMockId\}`/))
check('Mock never enables AI without Writing section', () => assert.match(mock,/hasWriting=\{activeSections\.writing && Boolean\(writingId\)\}/))
check('Assignment removal also removes selected AI IDs', () => {for(const s of [writing,mock])assert.match(s,/setSponsoredSelection\(prev => \(\{\s*\.\.\.prev, studentIds: \[\] \}\)\)/)})
check('Panel explains no student credit use', () => assert.match(component,/No student credits are deducted/))
check('Panel states model evaluations are not yet live', () => assert.match(component,/automatic model evaluation is not live yet/))
check('Existing staff dashboard not rewritten by this package', () => assert.match(previousAssignments,/exports\.setAiWritingSponsoredPolicy/))

console.log(`\nP5B-3B teacher Writing/Mock AI assignment UI: ${passed}/${passed+failed} PASS; ${failed} FAIL`)
if (failed) process.exitCode = 1
