'use strict'
// P4-D: local, synthetic, no paid requests, no production connections.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { world, validReport, STUDENT, TEACHER, ADMIN, WRITING, MOCK, NOW, GRANTED_AT } = require('./helpers/p4d_fixture.cjs')

const denies = async (promise, code) => assert.rejects(promise, error => error?.code === code)

test('P4D-01 direct callable cannot use PERSONAL credits for Mock Writing', async () => {
  const w = world({context:'mock',credits:3,funded:false})
  await denies(w.personal.evaluate(w.request),'permission-denied')
  assert.equal(w.calls(),0)
  assert.equal(w.access().creditsRemaining,3)
  assert.equal(w.month(),undefined)
  assert.equal(w.job(),undefined)
  assert.equal(w.writes.length,0)
})

test('P4D-02 future teacher_request job cannot be taken over by a personal-credit retry', async () => {
  const w=world({funded:false, credits:3,jobStatus:'failed',jobBilling:'teacher_request'})
  await denies(w.personal.evaluate(w.request),'failed-precondition')
  assert.equal(w.calls(),0)
  assert.equal(w.access().creditsRemaining,3)
  assert.equal(w.writes.length,0)
})

test('P4D-03 Send to Teacher never uses personal provider', async()=>{
  const w=world({choice:'teacher',billing:'none',funded:false})
  await denies(w.personal.evaluate(w.request),'permission-denied')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-04 institution-paid Writing cannot be manually charged to student',async()=>{
  const w=world({choice:'ai',billing:'institution',credits:3})
  await denies(w.personal.evaluate(w.request),'permission-denied')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-05 personal evaluation reserves one credit, settles once and reuses result',async()=>{
  const w=world({credits:2,funded:false})
  assert.equal((await w.personal.evaluate(w.request)).status,'completed')
  assert.equal(w.calls(),1);assert.equal(w.access().creditsRemaining,1)
  assert.equal(w.access().creditsUsedTotal,1)
  assert.deepEqual([w.month().requestCount,w.month().pendingCount,w.month().completedCount],[1,0,1])
  const next=await w.personal.evaluate(w.request)
  assert.equal(next.reused,true);assert.equal(w.calls(),1)
  assert.equal(w.access().creditsRemaining,1)
})

test('P4D-06 two concurrent personal requests reserve once, second is processing',async()=>{
  let enter, release
  const entered=new Promise(resolve=>{enter=resolve})
  const w=world({credits:2,funded:false,provider:async()=>{enter();return new Promise(resolve=>{release=resolve})}})
  const first=w.personal.evaluate(w.request)
  await entered
  const second=await w.personal.evaluate(w.request)
  assert.equal(second.status,'processing')
  assert.equal(w.calls(),1);assert.equal(w.access().creditsRemaining,1)
  release({report:validReport(),model:'stub-model'})
  assert.equal((await first).status,'completed')
  assert.equal(w.access().creditsUsedTotal,1)
  assert.equal(w.month().requestCount,1)
})

test('P4D-07 provider failure refunds one credit, counts one API request',async()=>{
  const w=world({credits:1, funded:false,provider:async()=>{throw Error('local failure')}})
  await denies(w.personal.evaluate(w.request),'unavailable')
  assert.equal(w.calls(),1)
  assert.equal(w.access().creditsRemaining,1);assert.equal(w.access().creditsUsedTotal,0)
  assert.deepEqual([w.month().requestCount,w.month().pendingCount,w.month().completedCount],[1,0,0])
  assert.equal(w.job().status,'failed')
  const ledgers=[...w.docs.entries()].filter(([k])=>k.startsWith('aiWritingCreditOperations/'))
  assert.equal(ledgers.length,1);assert.equal(ledgers[0][1].status,'refunded')
})

test('P4D-08 malformed provider result refunds and is not exposed as completed',async()=>{
  const w=world({credits:1,funded:false,provider:async()=>({report:{invalid:true},model:'stub'})})
  await denies(w.personal.evaluate(w.request),'unavailable')
  assert.equal(w.access().creditsRemaining,1)
  assert.equal(w.job().status,'failed')
  assert.equal(w.month().pendingCount,0)
})

test('P4D-09 too-short Writing cannot reserve monthly quota or personal credit',async()=>{
  const w=world({words:40,credits:2,funded:false})
  await denies(w.personal.evaluate(w.request),'failed-precondition')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-10 pilot OFF fails without credits or API request',async()=>{
  const w=world({pilot:false,credits:2,funded:false})
  await denies(w.personal.evaluate(w.request),'permission-denied')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-11 disabled personal access fails closed',async()=>{
  const w=world({creditEnabled:false,credits:2,funded:false})
  await denies(w.personal.evaluate(w.request),'permission-denied')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-12 no personal credits fails before provider',async()=>{
  const w=world({credits:0,funded:false})
  await denies(w.personal.evaluate(w.request),'resource-exhausted')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-13 total 60 monthly paid requests caps personal billing',async()=>{
  const w=world({credits:1,funded:false,monthly:{month:'202610',schoolId:'maxima',requestCount:60,pendingCount:0,completedCount:55}})
  await denies(w.personal.evaluate(w.request),'resource-exhausted')
  assert.equal(w.calls(),0);assert.equal(w.access().creditsRemaining,1)
  assert.equal(w.month().requestCount,60);assert.equal(w.writes.length,0)
})

test('P4D-14 revoked assignment during provider call prevents paid settlement and refunds credit',async()=>{
  let w
  w=world({credits:1,funded:false,provider:async()=>{
    w.docs.get(`studentAccess/${STUDENT}_writing_${WRITING}`).status='removed'
    return {report:validReport(),model:'stub'}
  }})
  await denies(w.personal.evaluate(w.request),'unavailable')
  assert.equal(w.access().creditsRemaining,1)
  assert.equal(w.access().creditsUsedTotal,0)
  assert.equal(w.job().status,'failed')
  assert.equal(w.month().pendingCount,0)
})

test('P4D-15 read-only report never invokes provider or changes credits',async()=>{
  const w=world({funded:false,credits:2})
  const before=w.writes.length
  assert.equal((await w.personal.getReport(w.request)).status,'not_started')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,before)
})

test('P4D-16 personal mock completed report is readable, never unlocks manual retry',async()=>{
  const w=world({context:'mock',credits:2,jobStatus:'failed',jobBilling:'sponsored_auto'})
  const result=await w.personal.getReport(w.request)
  assert.equal(result.canRetry,false);assert.equal(result.institutionFunded,true)
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-17 sponsored homework with Send to Teacher is ignored at trigger',async()=>{
  const w=world({choice:'teacher',billing:'none',credits:2})
  assert.equal((await w.sponsored.submit('homework',w.event())).status,'ignored')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-18 sponsored Writing with institution choice completes without any student-credit writes',async()=>{
  const w=world({choice:'ai',billing:'institution',credits:4})
  const response=await w.sponsored.submit('homework',w.event())
  assert.equal(response.status,'completed')
  assert.equal(w.calls(),1)
  assert.equal(w.job().billingMode,'sponsored_auto')
  assert.equal(w.access().creditsRemaining,4)
  assert.equal(w.access().creditsUsedTotal,0)
  assert.equal(w.month().requestCount,1);assert.equal(w.month().sponsoredRequestCount,1)
  assert.equal(w.month().pendingCount,0);assert.equal(w.month().completedCount,1)
  assert.ok(w.writes.every(wr=>!wr.path.startsWith('aiWritingStudentAccess/') && !wr.path.startsWith('aiWritingCreditOperations/')))
})

test('P4D-19 Mock sponsored Writing runs automatically when grant predates submission',async()=>{
  const w=world({context:'mock',credits:3,choice:'teacher',billing:'none'})
  const result=await w.sponsored.submit('mock',w.event())
  assert.equal(result.status,'completed')
  assert.equal(w.calls(),1);assert.equal(w.access().creditsRemaining,3)
  assert.equal(w.job().billingMode,'sponsored_auto')
  assert.equal(w.month().requestCount,1)
})

test('P4D-20 Mock grants added after submission cannot trigger provider',async()=>{
  const w=world({context:'mock'})
  w.policyDoc().grants[STUDENT].grantedAtMs=Date.parse('2026-10-20T00:45:00.000Z')
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'ineligible')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-21 Mock Writing disabled cannot invoke sponsored provider',async()=>{
  const w=world({context:'mock'})
  w.docs.get(`mockTests/${MOCK}`).enabledSections.writing=false
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'ineligible')
  assert.equal(w.calls(),0)
})

test('P4D-22 sponsored provider off fails closed without monthly request',async()=>{
  const w=world({context:'mock',sponsoredEnabled:false})
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'disabled')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-23 sponsored pilot off fails closed',async()=>{
  const w=world({context:'mock',pilot:false})
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'ineligible')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-24 sponsored monthly budget counts student and sponsor calls together',async()=>{
  const w=world({context:'mock',monthly:{month:'202610',schoolId:'maxima',requestCount:60,pendingCount:0,completedCount:60,sponsoredRequestCount:0}})
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'budget_exhausted')
  assert.equal(w.calls(),0);assert.equal(w.writes.length,0)
})

test('P4D-25 sponsored failed provider still counts request but never touches credits',async()=>{
  const w=world({context:'mock',credits:3,provider:async()=>{throw Error('simulated fail')}})
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'failed')
  assert.equal(w.calls(),1)
  assert.equal(w.job().status,'failed')
  assert.equal(w.month().requestCount,1)
  assert.equal(w.month().pendingCount,0);assert.equal(w.month().completedCount,0)
  assert.equal(w.access().creditsRemaining,3)
})

test('P4D-26 invalid sponsored report cannot be saved as completed',async()=>{
  const w=world({context:'mock',provider:async()=>({report:{invalid:true},model:'stub'})})
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'failed')
  assert.equal(w.job().status,'failed');assert.equal(w.month().pendingCount,0)
})

test('P4D-27 sponsored student grant revoked during provider call cancels settlement',async()=>{
  let w
  w=world({context:'mock',provider:async()=>{
    w.policyDoc().studentIds=[];w.policyDoc().grants={};w.policyDoc().enabled=false
    return {report:validReport('mock'),model:'stub'}
  }})
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'failed')
  assert.equal(w.job().status,'failed');assert.equal(w.month().pendingCount,0)
  assert.equal(w.access().creditsRemaining,2)
})

test('P4D-28 duplicate sponsored event does not call provider or spend quota twice',async()=>{
  const w=world({context:'mock'})
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'completed')
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'completed')
  assert.equal(w.calls(),1);assert.equal(w.month().requestCount,1)
})

test('P4D-29 simultaneous sponsored triggers reserve one provider call',async()=>{
  let enter,release
  const entered=new Promise(resolve=>{enter=resolve})
  const w=world({context:'mock',provider:async()=>{enter();return new Promise(resolve=>{release=resolve})}})
  const first=w.sponsored.submit('mock',w.event())
  await entered
  const second=await w.sponsored.submit('mock',w.event())
  assert.equal(second.status,'already_started')
  assert.equal(w.calls(),1);assert.equal(w.month().requestCount,1)
  release({report:validReport('mock'),model:'stub'})
  assert.equal((await first).status,'completed')
})

test('P4D-30 sponsored teacher issuer must remain active to trigger billing',async()=>{
  const w=world({context:'mock',grantIssuer:TEACHER})
  w.docs.get(`users/${TEACHER}`).status='disabled'
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'ineligible')
  assert.equal(w.calls(),0)
})

test('P4D-31 sponsored teacher must retain student in active class',async()=>{
  const w=world({context:'mock',grantIssuer:TEACHER})
  w.docs.get('classes/p4dClass001').studentIds=[]
  assert.equal((await w.sponsored.submit('mock',w.event())).status,'ineligible')
  assert.equal(w.calls(),0)
})

test('P4D-32 teacher review mutation never retriggers sponsored AI',async()=>{
  const w=world({choice:'ai',billing:'institution'})
  const before={...w.submission}
  w.docs.get(w.submissionPath).reviewed=true
  assert.equal((await w.sponsored.submit('homework',w.event(before))).status,'ignored')
  assert.equal(w.calls(),0)
})

test('P4D-33 options show sponsor priority without exposing personal credits as charge route',async()=>{
  const w=world({choice:'ai',billing:'institution',credits:4})
  const options=await w.choiceService.getOptionsForStudent({uid:STUDENT,schoolId:'maxima'},WRITING)
  assert.equal(options.canChooseAi,true)
  assert.equal(options.institutionFunded,true)
  assert.equal(options.billingMode,'institution')
  assert.equal(options.creditsRemaining,4)
  assert.equal(w.writes.length,0)
})

test('P4D-34 options fail closed when both routes switched off',async()=>{
  const w=world({funded:true,pilot:false,credits:4})
  const options=await w.choiceService.getOptionsForStudent({uid:STUDENT,schoolId:'maxima'},WRITING)
  assert.equal(options.canChooseAi,false)
  assert.equal(options.reason,'pilot_off')
})
