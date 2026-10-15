import assert from 'node:assert/strict'
import fs from 'node:fs'
import { safeAiWritingEnvelope, shouldShowAiWritingPanel, canRequestAiWriting } from './src/services/aiWritingStudentPolicy.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, e?.message || e) }
}
const report = (context='homework') => ({
  isAiEstimate: true, estimatedBand: 6.5, context,
  task1: null, task2: { estimatedBand:6.5, criteria:{} },
  isProvisionalMockEstimate: context === 'mock', teacherFinalScore:null
})
const panel = fs.readFileSync('./src/components/AiWritingStudentPanel.jsx','utf8')
const mock = fs.readFileSync('./src/pages/DoMockTest.jsx','utf8')
const backend = fs.readFileSync('./functions/lib/aiWritingEvaluation.js','utf8')
const nonFunded = { pilotEnabled:true,studentEnabled:true,creditsRemaining:5,canEvaluate:true }
const noGrant = {pilotEnabled:true,studentEnabled:false,creditsRemaining:0,canEvaluate:false}

await test('Sponsored completed Writing report without student grant is normalized',()=>{
  const v=safeAiWritingEnvelope({status:'completed',attemptNumber:1,institutionFunded:true,report:report()},1)
  assert.equal(v.institutionFunded,true);assert.equal(v.status,'completed')
  assert.equal(shouldShowAiWritingPanel(noGrant,v),true)
})
await test('Sponsored completed Mock report without grant is normalized',()=>{
  const v=safeAiWritingEnvelope({status:'completed',attemptNumber:1,institutionFunded:true,report:report('mock')},1,'mock')
  assert.equal(v.institutionFunded,true);assert.equal(v.report.context,'mock')
})
await test('Mock report cannot be mislabelled as homework',()=>{
  assert.equal(safeAiWritingEnvelope({status:'completed',attemptNumber:1,report:report('mock')},1).status,'unavailable')
})
await test('Homework report cannot be mislabelled as mock',()=>{
  assert.equal(safeAiWritingEnvelope({status:'completed',attemptNumber:1,report:report()},1,'mock').status,'unavailable')
})
await test('Wrong attempt funded report never displayed',()=>{
  assert.equal(safeAiWritingEnvelope({status:'completed',attemptNumber:1,institutionFunded:true,report:report()},2).status,'stale_attempt')
})
await test('Sponsored awaiting job shows panel but cannot spend credits',()=>{
  const v=safeAiWritingEnvelope({status:'not_started',institutionFunded:true},1)
  assert.equal(shouldShowAiWritingPanel(noGrant,v),true)
  assert.equal(canRequestAiWriting(nonFunded,v,false),false)
})
await test('Sponsored processing does not allow manual evaluation',()=>{
  const v=safeAiWritingEnvelope({status:'processing',institutionFunded:true},1)
  assert.equal(v.institutionFunded,true)
  assert.equal(canRequestAiWriting(nonFunded,v,false),false)
})
await test('Sponsored failed report cannot be personally retried',()=>{
  const v=safeAiWritingEnvelope({status:'failed',institutionFunded:true,canRetry:true},1)
  assert.equal(v.canRetry,false); assert.equal(canRequestAiWriting(nonFunded,v,false),false)
})
await test('Legacy unfunded completed shape preserved',()=>{
  const v=safeAiWritingEnvelope({status:'completed',attemptNumber:1,report:report()},1)
  assert.equal('institutionFunded' in v,false)
})
await test('Legacy unfunded failed shape preserved',()=>{
  const v=safeAiWritingEnvelope({status:'failed',canRetry:true},1)
  assert.deepEqual(v,{status:'failed',canRetry:true})
})
await test('Legacy student-grant evaluation can still be requested',()=>{
  assert.equal(canRequestAiWriting(nonFunded,{status:'not_started'},false),true)
})
await test('Zero credit prevents elective request',()=>{
  assert.equal(canRequestAiWriting(noGrant,{status:'not_started'},false),false)
})
await test('Busy student cannot spend twice',()=>{
  assert.equal(canRequestAiWriting(nonFunded,{status:'not_started'},true),false)
})
await test('Mock view loads panel only on completed saved attempt',()=>{
  assert.match(mock,/completedSubmission && finalResult/)
  assert.match(mock,/isInstitutionWritingStudent\(profile\)/)
  assert.match(mock,/context="mock"/)
})
await test('Mock AI report remains separate from official grade',()=>{
  assert.match(panel,/Official Mock scores remain separate/)
  assert.match(mock,/writingReviewed/)
})
await test('Manual credit button never appears for sponsored view',()=>{
  assert.match(panel,/envelope\.institutionFunded \?/)
  assert.match(panel,/context === 'homework' &&/)
  assert.match(panel,/context === 'mock' && !envelope\.institutionFunded/)
})
await test('Sponsored feedback explicitly states no student credit was used',()=>{
  assert.match(panel,/No personal AI credits were used/)
})
await test('Mock student payload is source-ID only, not a submitted essay',()=>{
  assert.match(panel,/\(\{ context: 'mock', contentId \}\)/)
  assert.doesNotMatch(panel,/setDoc\(/)
})
await test('Backend sponsorship eligibility verifies the selected student',()=>{
  assert.match(backend,/policy\.studentIds\.includes\(evidence\.student\.uid\)/)
  assert.match(backend,/updatedMs <= submittedMs/)
})
await test('Report read does not invoke an AI provider or credit transaction',()=>{
  const section=backend.slice(backend.indexOf('async function pendingInstitutionSponsoredReport('),backend.indexOf('  return { evaluate, getReport }'))
  assert.doesNotMatch(section,/provider\(/)
  assert.doesNotMatch(section,/tx\.update\(/)
})
console.log(`P5B-3D funded student UI policy: ${passed}/${passed+failed} PASS; ${failed} FAIL`)
if(failed)process.exitCode=1
