'use strict'
// G5 synthetic Firestore onDocumentWritten events + provider spy. No Firebase
// connection, OpenAI key, network, credit usage or production state is involved.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createAiWritingSponsoredEvaluationService, isNewSubmittedAttempt
} = require('../functions/lib/aiWritingSponsoredEvaluation')
const source = require('node:fs').readFileSync('functions/index.js','utf8')
const BASE = Object.freeze({
  uid:'studentAAA',studentId:'studentAAA',schoolId:'maxima',
  mockTestId:'mockAAA',writingId:'writingAAA',status:'submitted',
  attemptNumber:1,submittedAt:'2026-10-18T10:00:00.000Z',
  enabledSections:{writing:true}, writingMode:'task2_only',
  writingAnswers:{task1:'',task2:'Original learner essay'},
  result:{writing:{status:'pending_review',band:null}}
})
function kit() {
  let providerCalls = 0, readCalls = 0, billingAttempts = 0, enabledChecks = 0
  const denyBilling = () => {billingAttempts++;throw Error('UNEXPECTED_BILLING_OR_DB_ACCESS')}
  const runner = createAiWritingSponsoredEvaluationService({
    db:{doc:denyBilling,runTransaction:denyBilling},
    FieldValue:{serverTimestamp:denyBilling},
    provider:async()=>{providerCalls++;throw Error('UNEXPECTED_PAID_AI')},
    getApiKey:()=>{enabledChecks++;return 'sk-fake-only-local-not-valid'},
    providerEnabled:()=>{enabledChecks++;return true},
    schoolIdOf:doc=>doc?.schoolId || 'maxima',
    getMockEnabledSections:()=>({writing:true}),
    getMockWritingMode:()=> 'task2_only',
    findCurrentSubmissionRecord:async()=>{readCalls++;throw Error('UNEXPECTED_GET')},
    submissionContentConfigFor:()=>({})
  })
  const metrics=()=>({providerCalls,readCalls,billingAttempts,enabledChecks})
  return {runner,metrics}
}
function event(before,after,context='mock') {
  const collection=context==='mock'?'mockSubmissions':'writingSubmissions'
  return {data:{
    before:{exists:before!=null,data:()=>before},
    after:{exists:after!=null,data:()=>after,
      ref:{id:'synthetic',path:`${collection}/synthetic`}}
  }}
}
function updated(recordChanges) {return {...BASE,...recordChanges}}

for (const [title,changes] of [
  ['teacher first review',{writingReview:{status:'reviewed',overall:'7.5'},reviewedBy:'teacherAAA',
    reviewedAt:'2026-10-18T11:00:00.000Z',result:{writing:{status:'reviewed',band:'7.5'}}}],
  ['teacher edits review',{writingReview:{status:'reviewed',overall:'8.0'},reviewedBy:'teacherAAA'}],
  ['nested AI report update',{result:{writing:{aiEvaluationId:'synthetic',status:'ai_evaluated'}}}],
  ['teacher changes score metadata',{result:{overall:7,writing:{band:7}},updatedAt:'2026-10-18T12:00:00Z'}],
  ['submittedAt change without attempt increment',{submittedAt:'2026-10-18T12:00:00.000Z'}],
  ['attempt increment without new submittedAt',{attemptNumber:2}],
  ['identity swap during claimed new attempt',{studentId:'wrongStudent',attemptNumber:2,
    submittedAt:'2026-10-18T12:00:00.000Z'}],
  ['changed institution during claimed new attempt',{schoolId:'otherSchool',attemptNumber:2,
    submittedAt:'2026-10-18T12:00:00.000Z'}],
  ['changed Mock during claimed new attempt',{mockTestId:'otherMock',attemptNumber:2,
    submittedAt:'2026-10-18T12:00:00.000Z'}],
  ['changed linked Writing during claimed new attempt',{writingId:'otherWriting',attemptNumber:2,
    submittedAt:'2026-10-18T12:00:00.000Z'}]
]) {
  test(`G5 Mock ${title} performs zero paid AI, budgets, reads or writes`, async()=>{
    const k=kit()
    const after=updated(changes)
    assert.equal(isNewSubmittedAttempt('mock', BASE, after),false)
    const response=await k.runner.submit('mock',event(BASE,after))
    assert.equal(response.status,'ignored')
    assert.deepEqual(k.metrics(),{providerCalls:0,readCalls:0,billingAttempts:0,enabledChecks:0})
  })
}
test('G5 valid new Mock attempt is still eligible for later AUTHORIZED checks',()=>{
  assert.equal(isNewSubmittedAttempt('mock',BASE,updated({attemptNumber:2,
    submittedAt:'2026-10-19T10:00:00.000Z'})),true)
})
test('G5 invalid Mock status never spends',async()=>{
  const k=kit()
  const after=updated({status:'draft',attemptNumber:2,submittedAt:'2026-10-19T10:00:00.000Z'})
  assert.equal((await k.runner.submit('mock',event(BASE,after))).status,'ignored')
  assert.deepEqual(k.metrics(),{providerCalls:0,readCalls:0,billingAttempts:0,enabledChecks:0})
})
test('G5 homework Send to Teacher never spends, even when triggers enabled',async()=>{
  const k=kit()
  const after={uid:'studentAAA',studentId:'studentAAA',schoolId:'maxima',
    writingId:'writingAAA',attemptNumber:1,submittedAt:'2026-10-18T10:00:00.000Z',
    aiReviewChoice:'teacher',aiBillingMode:'none'}
  assert.equal((await k.runner.submit('homework',event(null,after,'homework'))).status,'ignored')
  assert.deepEqual(k.metrics(),{providerCalls:0,readCalls:0,billingAttempts:0,enabledChecks:0})
})
test('G5 paid trigger and review service retain separate trusted routes',()=>{
  assert.match(source,/exports\.saveMockWritingReviewSecure = onCall/)
  assert.match(source,/exports\.autoEvaluateSponsoredMockWriting = onDocumentWritten/)
  assert.match(source,/document: 'mockSubmissions\/\{id\}'/)
  assert.match(source,/process\.env\.MAXIMA_AI_WRITING_SPONSORED_AUTO_ENABLED === 'true'/)
})
