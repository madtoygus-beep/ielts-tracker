import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createEscapeDismissRegistry,runWithDismissLock} from '../src/services/escapeDismissPolicy.js'

function keyboard(key='Escape', extra={}) {
  const event=new Event('keydown',{cancelable:true})
  Object.assign(event,{key,isComposing:false,repeat:false,...extra})
  return event
}
test('Escape dismisses one layer; Enter, held key, composition and consumed events do nothing',()=>{
 const target=new EventTarget(),registry=createEscapeDismissRegistry(target);let closed=0
 registry.register(()=>{closed++;return true})
 for(const event of [keyboard('Enter'),keyboard('Escape',{repeat:true}),keyboard('Escape',{isComposing:true})])target.dispatchEvent(event)
 const handled=keyboard();handled.preventDefault();target.dispatchEvent(handled)
 assert.equal(closed,0)
 const event=keyboard();target.dispatchEvent(event);assert.equal(closed,1);assert.equal(event.defaultPrevented,true)
})
test('higher visible dialog closes before a lower review regardless of mount order',()=>{
 const target=new EventTarget(),registry=createEscapeDismissRegistry(target);const closed=[];let passwordOpen=true
 registry.register(()=>{if(!passwordOpen)return false;closed.push('password');passwordOpen=false;return true},20)
 registry.register(()=>{closed.push('review');return true})
 target.dispatchEvent(keyboard());assert.deepEqual(closed,['password'])
 target.dispatchEvent(keyboard());assert.deepEqual(closed,['password','review'])
})
test('a busy top layer consumes Escape without closing itself or an underlying panel',()=>{
 const target=new EventTarget(),registry=createEscapeDismissRegistry(target);let closed=0
 registry.register(()=>{closed++;return true})
 registry.register(()=>true,20)
 const event=keyboard();target.dispatchEvent(event);assert.equal(closed,0);assert.equal(event.defaultPrevented,true)
})
test('unmounted handlers never run; cleanup and remount do not duplicate actions',()=>{
 const target=new EventTarget(),registry=createEscapeDismissRegistry(target);let count=0
 const remove=registry.register(()=>{count++;return true});remove();remove();target.dispatchEvent(keyboard());assert.equal(count,0)
 const removeAgain=registry.register(()=>{count++;return true});target.dispatchEvent(keyboard());assert.equal(count,1);removeAgain();target.dispatchEvent(keyboard());assert.equal(count,1)
})
test('equal priority respects latest layer; inactive layers fall through',()=>{
 const target=new EventTarget(),registry=createEscapeDismissRegistry(target);const closed=[]
 registry.register(()=>{closed.push('older');return true});registry.register(()=>false);registry.register(()=>{closed.push('newer');return true})
 target.dispatchEvent(keyboard());assert.deepEqual(closed,['newer'])
})
test('async write locks dismissal immediately and rejects a concurrent duplicate',async()=>{
 const lock={current:false};let finish,calls=0
 const pending=runWithDismissLock(lock,()=>{calls++;return new Promise(resolve=>{finish=resolve})})
 assert.equal(lock.current,true);await runWithDismissLock(lock,()=>{calls++});assert.equal(calls,1)
 finish('saved');assert.equal(await pending,'saved');assert.equal(lock.current,false)
})
test('failed write unlocks dismissal and preserves the original error',async()=>{
 const lock={current:false};const error=new Error('save failed')
 await assert.rejects(runWithDismissLock(lock,async()=>{throw error}),e=>e===error);assert.equal(lock.current,false)
})
// Execute the actual page callback with fake setters: no Firebase, login or writes.
function pageCallback(name, context, componentStart='') {
 const text=readFileSync(new URL(`../src/pages/${name}.jsx`,import.meta.url),'utf8')
 const start=text.indexOf('useEscapeDismiss(() => {',componentStart?text.indexOf(componentStart):0)+'useEscapeDismiss(() => {'.length
 const end=text.indexOf('\n  })',start)
 assert.ok(start>0 && end>start)
 return new Function(...Object.keys(context),text.slice(start,end))(...Object.values(context))
}
function adminContext(overrides={}) {
 const closed=[];return {closed,ctx:{legacyCascadeDialog:null,editUser:null,schoolEditorOpen:false,accountCreatorOpen:false,managerCreatorOpen:false,adminSection:'overview',selfStudyTab:'learners',schoolSaving:false,accountCreating:false,managerCreating:false,editSaving:false,passwordSaving:false,setLegacyCascadeDialog:()=>closed.push('delete'),setEditUser:()=>closed.push('user'),setSchoolEditorOpen:()=>closed.push('school'),setAccountCreatorOpen:()=>closed.push('account'),setManagerCreatorOpen:()=>closed.push('manager'),...overrides}}
}
for(const [name,open,section,closed,busy] of [['institution','schoolEditorOpen','schools','school','schoolSaving'],['account','accountCreatorOpen','users','account','accountCreating'],['manager','managerCreatorOpen','selfstudy','manager','managerCreating']]) {
 test(`admin ${name}: Esc closes the visible form, preserves it while saving and ignores hidden sections`,()=>{
  const state=adminContext({[open]:true,adminSection:section,selfStudyTab:'managers'})
  assert.equal(pageCallback('AdminDashboard',state.ctx),true);assert.deepEqual(state.closed,[closed])
  state.closed.length=0;state.ctx[busy]=true;assert.equal(pageCallback('AdminDashboard',state.ctx),true);assert.deepEqual(state.closed,[])
  state.ctx.adminSection='overview';assert.equal(pageCallback('AdminDashboard',state.ctx),false)
 })
}
test('admin deletion and account edit block Escape while saving',()=>{
 for(const state of [{legacyCascadeDialog:{saving:true}},{editUser:{id:'user'},editSaving:true},{editUser:{id:'user'},passwordSaving:true}]){
  const {ctx,closed}=adminContext(state);assert.equal(pageCallback('AdminDashboard',ctx),true);assert.deepEqual(closed,[])
 }
})
test('class editor busy state protects underlying details and action menu',()=>{
 let closed=0
 const ctx={saving:true,showCreateModal:true,detailClassId:'c',openActionsId:'c',closeModal:()=>closed++,setDetailClassId:()=>closed++,setOpenActionsId:()=>closed++}
 assert.equal(pageCallback('ManageClasses',ctx),true);assert.equal(closed,0)
 ctx.saving=false;assert.equal(pageCallback('ManageClasses',ctx),true);assert.equal(closed,1)
})

function teacherContext(overrides={}) {
 const closed=[];return {closed,ctx:{legacyCascadeDialog:null,deleteDialogOpen:false,statsDialogMode:null,attemptManager:null,attemptManagerSaving:false,showPasswordModal:false,passwordSavingRef:{current:false},selectedWritingReview:null,selectedMockWritingReview:null,writingReviewSavingRef:{current:false},selectedVocabularyReview:null,selectedReview:null,selectedHomework:null,assignmentSaving:false,materialShareTarget:null,materialShareSaving:false,createMenuOpen:false,setLegacyCascadeDialog:()=>closed.push('delete'),closeDeleteDialog:()=>closed.push('resultDelete'),closeStatsDialog:()=>closed.push('stats'),closeSubmissionAttemptManager:()=>closed.push('attempt'),setShowPasswordModal:()=>closed.push('password'),setSelectedWritingReview:()=>closed.push('writing'),setSelectedMockWritingReview:()=>closed.push('mock'),resetWritingReviewForm:()=>closed.push('reset'),setSelectedVocabularyReview:()=>closed.push('vocabulary'),setSelectedReview:()=>closed.push('reading'),closeAssignmentManager:()=>closed.push('assignment'),closeMaterialShareAgain:()=>closed.push('material'),setCreateMenuOpen:()=>closed.push('menu'),...overrides}}
}
for(const [flag,busy] of [['selectedWritingReview','writingReviewSavingRef'],['selectedMockWritingReview','writingReviewSavingRef'],['showPasswordModal','passwordSavingRef']]) {
 test(`teacher ${flag}: Escape cannot hide an in-flight save`,()=>{
  const {ctx,closed}=teacherContext({[flag]:true,[busy]:{current:true}})
  assert.equal(pageCallback('TeacherDashboard',ctx),true);assert.deepEqual(closed,[])
  ctx[busy].current=false;assert.equal(pageCallback('TeacherDashboard',ctx),true);assert.ok(closed.length>0)
 })
}
test('teacher password overlay closes before underlying reading review',()=>{
 const {ctx,closed}=teacherContext({showPasswordModal:true,selectedReview:{}})
 assert.equal(pageCallback('TeacherDashboard',ctx),true);assert.deepEqual(closed,['password'])
})
