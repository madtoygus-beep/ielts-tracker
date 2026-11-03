import test from 'node:test'
import assert from 'node:assert/strict'
import { partialWritingSummary, objectiveOnlyAverage } from '../src/services/partialWritingPresentation.js'
const c03 = { writingMode: 'full_writing', result: { writing: { enabled:true, aiFeedbackOnly:true, task1Enabled:true, task2Enabled:true, task1WordCount:'180', task2WordCount:'0' } } }
test('C03 partial task band stays distinct from missing combined score',()=>{ const s=partialWritingSummary(c03,{feedbackOnly:true,writingMode:'full_writing',task1:{wordCount:180,estimatedBand:5},task2:null});assert.equal(s.tasks[0].label,'Task 1: AI estimate 5.0');assert.equal(s.tasks[1].label,'Task 2: no answer submitted');assert.match(s.explanation,/combined AI Writing band/);assert.equal(c03.result.writing.task2WordCount,'0') })
test('snapshot without full AI report still explains missing task accurately',()=>{const s=partialWritingSummary(c03);assert.equal(s.tasks[0].band,null);assert.equal(s.tasks[1].missing,true)})
test('single-task Writing never invents a missing second task',()=>{const s=partialWritingSummary(null,{writingMode:'task1_only',feedbackOnly:true,task1:{wordCount:18,estimatedBand:null}});assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].number,1)})
test('ordinary complete or processing report has no false partial notice',()=>{assert.equal(partialWritingSummary({result:{writing:{status:'pending_review'}}}),null);assert.equal(partialWritingSummary(null,{feedbackOnly:false,estimatedBand:7}),null)})
test('excluded Writing is not displayed as incomplete',()=>{assert.equal(partialWritingSummary({enabledSections:{writing:false},result:{writing:{aiFeedbackOnly:true}}}),null)})
test('teacher grade is preserved; limitation explicitly refers only to AI',()=>{const v=structuredClone(c03);v.result.writing.band=7;v.result.writing.status='reviewed';const before=JSON.stringify(v);assert.match(partialWritingSummary(v).explanation,/AI Writing/);assert.equal(JSON.stringify(v),before)})

test('C03 objective average is explicitly separate and excludes Writing',()=>{const sub={result:{listening:{band:6},reading:{band:4},writing:{aiFeedbackOnly:true}}};assert.equal(objectiveOnlyAverage(sub),5);assert.equal(objectiveOnlyAverage({result:{}}),null);assert.equal(objectiveOnlyAverage({enabledSections:{reading:false},result:{listening:{band:6},reading:{band:4}}}),6)})
