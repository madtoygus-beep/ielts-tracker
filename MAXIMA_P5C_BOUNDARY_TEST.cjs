'use strict'
const assert = require('node:assert/strict')
const { eligibleTasks, requireAiEligible, buildOpenAiEvaluationRequest, normalizeAiWritingReport } = require('./functions/lib/aiWritingGrading')
const words = n => Array(n).fill('education').join(' ')
const criterion = { band: 6.5, explanation: 'Language is clear and organised.', evidence: 'education' }
const taskReport = () => ({criteria: {
 taskAchievementOrResponse: {...criterion}, coherenceAndCohesion: {...criterion},
 lexicalResource: {...criterion}, grammaticalRangeAndAccuracy: {...criterion}},
 overview:'Useful ideas', strengths:['Good ideas'], priorities:['Develop examples'], corrections:[]})
const make = (n1,n2,mode='full_writing') => ({context:'homework',writingMode:mode,
 task1Enabled:mode!=='task2_only',task2Enabled:mode!=='task1_only',
 task1:mode==='task2_only'?null:{wordCount:n1,recommendedMinimumWords:150,answer:words(n1),prompt:'Describe changes',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='},
 task2:mode==='task1_only'?null:{wordCount:n2,recommendedMinimumWords:250,answer:words(n2),prompt:'Discuss education'}})
let pass=0
function test(name,run){run();pass++;process.stdout.write('PASS '+name+'\n')}
for (const [k,at,below,full] of [['task1',50,49,150],['task2',100,99,250]]){
 const mode=k==='task1'?'task1_only':'task2_only',pos=k==='task1'?0:1
 test(k+' rejects below threshold',()=>{const p=make(pos===0?below:0,pos===1?below:0,mode);assert.deepEqual(eligibleTasks(p),[]);assert.throws(()=>requireAiEligible(p))})
 test(k+' accepts exact feedback boundary',()=>{const p=make(pos===0?at:0,pos===1?at:0,mode);assert.deepEqual(eligibleTasks(p),[k]);const r=normalizeAiWritingReport({task1:k==='task1'?taskReport():null,task2:k==='task2'?taskReport():null},p);assert.equal(r.estimatedBand,null);assert.equal(r[k].feedbackOnly,true);assert.equal(r[k].criteria.lexicalResource.band,null)})
 test(k+' band withheld one word short',()=>{const p=make(pos===0?full-1:0,pos===1?full-1:0,mode);const r=normalizeAiWritingReport({task1:k==='task1'?taskReport():null,task2:k==='task2'?taskReport():null},p);assert.equal(r[k].estimatedBand,null)})
 test(k+' band allowed on exact full boundary',()=>{const p=make(pos===0?full:0,pos===1?full:0,mode);const r=normalizeAiWritingReport({task1:k==='task1'?taskReport():null,task2:k==='task2'?taskReport():null},p);assert.equal(r.estimatedBand,6.5);assert.equal(r[k].criteria.lexicalResource.band,6.5)})
}
test('both below threshold cannot send model',()=>{assert.throws(()=>buildOpenAiEvaluationRequest(make(49,99),'gpt-5-mini'))})
test('under-limit task is not sent to model',()=>{const p=make(49,100);const r=buildOpenAiEvaluationRequest(p,'gpt-5-mini');const data=JSON.parse(r.input[1].content[0].text);assert.equal(data.task1,null);assert.equal(data.task2.wordCount,100);assert.equal(r.input[1].content.filter(c=>c.type==='input_image').length,0)})
test('one eligible task has no combined band',()=>{const p=make(49,250);const r=normalizeAiWritingReport({task1:null,task2:taskReport()},p);assert.equal(r.task1,null);assert.equal(r.task2.estimatedBand,6.5);assert.equal(r.estimatedBand,null)})
test('one feedback-only task has no combined band',()=>{const p=make(150,249);const r=normalizeAiWritingReport({task1:taskReport(),task2:taskReport()},p);assert.equal(r.estimatedBand,null);assert.equal(r.task1.estimatedBand,6.5);assert.equal(r.task2.estimatedBand,null)})
test('both full-length tasks have combined band',()=>{const p=make(150,250);const r=normalizeAiWritingReport({task1:taskReport(),task2:taskReport()},p);assert.equal(r.estimatedBand,6.5)})
test('privacy: provider store is false',()=>{assert.equal(buildOpenAiEvaluationRequest(make(150,250),'gpt-5-mini').store,false)})
console.log('P5C boundaries:',pass+'/'+pass,'PASS')
