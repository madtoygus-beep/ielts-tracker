'use strict'
// Pure UI policy tests, no browser, credentials, network, or Firebase calls.
const assert=require('node:assert/strict')
const {pathToFileURL}=require('node:url')
const path=require('node:path')
const {prepareAiWritingEvaluation,normalizeAiWritingReport,validAiWritingReport,eligibleTasks}=
  require('./functions/lib/aiWritingGrading')
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
const words=n=>Array(n).fill('practice').join(' ')
const prepared=(n1,n2,mode='full_writing',context='homework')=>prepareAiWritingEvaluation({
  context,source:{contentType:mode,task1:{prompt:'Compare two maps',image},task2:{prompt:'Explain'}},
  submission:{task1Answer:words(n1),task2Answer:words(n2)}
})
const task=()=>({criteria:Object.fromEntries([
  'taskAchievementOrResponse','coherenceAndCohesion','lexicalResource','grammaticalRangeAndAccuracy'
].map(key=>[key,{band:6.5,explanation:'A valid and clear explanation.',evidence:'practice'}])),
  overview:'Development feedback',strengths:[],priorities:['Elaborate the analysis'],corrections:[]})
const report=p=>normalizeAiWritingReport({task1:p.task1?task():null,task2:p.task2?task():null},p)
let pass=0
async function test(name,fn){await fn();pass++;console.log('PASS',name)}
async function main(){
 const m=await import(pathToFileURL(path.resolve('src/services/aiWritingStudentPolicy.js')).href)
 await test('Feedback-only band is withheld in browser envelope',()=>{
  const r=report(prepared(50,100))
  const e=m.safeAiWritingEnvelope({status:'completed',report:r,attemptNumber:1},1)
  assert.equal(e.status,'completed');assert.equal(e.report.estimatedBand,null)
  assert.equal(e.report.task1.criteria.lexicalResource.band,null)
 })
 await test('Feedback-only forged report without feedback flag rejected',()=>{
  const p=prepared(50,100), r=report(p);r.feedbackOnly=false
  assert.equal(validAiWritingReport(r,p),false)
  assert.equal(m.safeAiWritingEnvelope({status:'completed',report:r,attemptNumber:1},1).status,'unavailable')
 })
 await test('Completed full-length result preserves numeric IELTS band',()=>{
  const p=prepared(150,250),r=report(p)
  assert.equal(validAiWritingReport(r,p),true)
  assert.equal(m.safeAiWritingEnvelope({status:'completed',report:r,attemptNumber:3},3).report.estimatedBand,6.5)
 })
 await test('Feedback-only cannot be upgraded to numeric Task1 band',()=>{
  const p=prepared(149,250);const r=report(p);r.task1.estimatedBand=6.5
  assert.equal(validAiWritingReport(r,p),false)
 })
 await test('Feedback-only cannot be upgraded to criterion band',()=>{
  const p=prepared(150,249);const r=report(p);r.task2.criteria.lexicalResource.band=7
  assert.equal(validAiWritingReport(r,p),false)
 })
 await test('Task under 50 is not present, even when other task full',()=>{
  const p=prepared(49,250),r=report(p)
  assert.deepEqual(eligibleTasks(p),['task2']);assert.equal(r.task1,null)
  assert.equal(r.task2.estimatedBand,6.5);assert.equal(r.estimatedBand,null)
  assert.equal(validAiWritingReport(r,p),true)
 })
 await test('No Tasks can be rated below 50/100',()=>{
  const p=prepared(49,99);assert.deepEqual(eligibleTasks(p),[])
 })
 await test('Both blank can be submitted but are not AI-eligible',()=>{
  const p=prepared(0,0);assert.deepEqual(eligibleTasks(p),[])
 })
 await test('Too-short funded status is displayed without polling contract',()=>{
  const e=m.safeAiWritingEnvelope({status:'too_short',institutionFunded:true},1)
  assert.equal(e.status,'too_short');assert.equal(e.institutionFunded,true)
  assert.equal(m.shouldShowAiWritingPanel(null,e),true)
  assert.equal(m.canRequestAiWriting({canEvaluate:true},e,false),false)
 })
 await test('Very short personal response cannot offer AI credit action',()=>{
  const e=m.safeAiWritingEnvelope({status:'too_short'},1)
  assert.equal(m.canRequestAiWriting({canEvaluate:true},e,false),false)
 })
 await test('B2C account remains excluded from institutional UI',()=>{
  assert.equal(m.isInstitutionWritingStudent({role:'student',status:'approved',schoolId:'maxima',accountType:'individual'}),false)
 })
 await test('Mock teacher score remains separate',()=>{
  const p=prepared(150,250,'full_writing','mock'),r=report(p)
  assert.equal(r.teacherFinalScore,null);assert.equal(r.isProvisionalMockEstimate,true)
  assert.equal(validAiWritingReport(r,p),true)
 })
 await test('Report with a mismatched wordcount cannot be settled',()=>{
  const p=prepared(150,250),r=report(p);r.task1.wordCount=151
  assert.equal(validAiWritingReport(r,p),false)
 })
 await test('Official teacher scores cannot be overwritten by provider',()=>{
  const p=prepared(150,250),r=report(p);r.teacherFinalScore=7.5
  assert.equal(validAiWritingReport(r,p),false)
 })
 await test('Spoofed rounded overall band is rejected',()=>{
  const p=prepared(150,250),r=report(p);r.estimatedBand=9
  assert.equal(validAiWritingReport(r,p),false)
 })
 console.log(`\nP5C client + settlement policy: ${pass}/${pass} PASS`)
}
main().catch(e=>{console.error(e?.stack||e);process.exitCode=1})
