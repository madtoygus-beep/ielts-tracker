// Step751R2: Firestore Rules Emulator - browser teachers may read active class
// Mock evidence but may NOT directly write any nested result/AI/review fields.
import test,{before,after,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {initializeTestEnvironment,assertSucceeds} from '@firebase/rules-unit-testing'
import {doc,setDoc,getDoc,updateDoc} from 'firebase/firestore'
const PROJECT='demo-maxima-p0b'
const SHA='9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const CURRENT='step751r2_t',OLD='step751r2_old',ADMIN='step751r2_admin',STUDENT='step751r2_student'
const ID='step751r2_synthetic_mock',PATH=`mockSubmissions/${ID}`
let env
const db=uid=>(uid===null ? env.unauthenticatedContext() : env.authenticatedContext(uid)).firestore()
const ref=uid=>doc(db(uid),PATH)
const oldResult=()=>({
  listening:{band:7,correct:32},reading:{band:6.5,correct:27},
  writing:{enabled:true,aiEstimatedBand:6.5,aiEvaluationId:'SERVER',aiCreditsUsed:1,
    aiFeedback:{summary:'AI Original'},status:'ai_evaluated'},
  overall:6.5,overallEstimate:6.5,reviewedOverall:null
})
const review=()=>({
  reviewedAt:'2026-10-21T00:50:18.123Z',reviewedBy:CURRENT,
  writingReview:{status:'reviewed',overall:'7.5',generalFeedback:'Good'},
  result:{...oldResult(),writing:{...oldResult().writing,status:'reviewed',band:'7.5',
    review:{overall:'7.5'}},overall:7,overallEstimate:7,reviewedOverall:7}
})
async function seed(){
  await env.withSecurityRulesDisabled(async ctx=>{
    const d=ctx.firestore()
    await setDoc(doc(d,'schools/maxima'),{status:'active'})
    for(const [id,role] of [[CURRENT,'teacher'],[OLD,'teacher'],[ADMIN,'admin'],[STUDENT,'student']]){
      await setDoc(doc(d,`users/${id}`),{
        status:'approved',role,schoolId:'maxima',archived:false,deleted:false,teacherIds:[OLD]
      })
    }
    for(const [id,members] of [[CURRENT,[STUDENT]],[OLD,[]]]){
      await setDoc(doc(d,`schools/maxima/teacherAcademicIndex/${id}`),{
        schemaVersion:1,source:'managed_active_classes',schoolId:'maxima',teacherId:id,
        activeStudentIds:members
      })
    }
    await setDoc(doc(d,PATH),{
      uid:STUDENT,studentId:STUDENT,schoolId:'maxima',teacherId:OLD,teacherIds:[OLD],
      mockTestId:'test_mock',attemptNumber:1,submittedAt:'2026-10-21T00:25:00.000Z',
      status:'submitted',gradedByServer:true,excludedFromStats:false,result:oldResult()
    })
  })
}
async function denied(uid,changes,label){
  const beforeDoc=(await getDoc(ref(ADMIN))).data()
  let err
  try{await updateDoc(ref(uid),changes);assert.fail('UNEXPECTED_BROWSER_WRITE '+label)}
  catch(e){if(e.code!=='permission-denied')throw e;err=e}
  assert.ok(!/maximum of 1000 expressions/i.test(err.message),`BUDGET_ERROR ${label}: ${err.message}`)
  assert.deepEqual((await getDoc(ref(ADMIN))).data(),beforeDoc,'MUTATED '+label)
}
before(async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/)
  assert.equal(process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||PROJECT,PROJECT)
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),
    'security/p0b-teacher-access-20261020')
  assert.doesNotThrow(()=>execFileSync('git',['merge-base','--is-ancestor','9c7b233','HEAD']))
  assert.equal(createHash('sha256').update(readFileSync('firestore.rules')).digest('hex'),SHA)
  env=await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:8081,
    rules:readFileSync('firestore.rules','utf8')}})
})
after(async()=>{if(env)await env.cleanup()})
beforeEach(async()=>{await env.clearFirestore();await seed()})

test('teacher still reads current class Mock, but dashboard-shaped direct review denied',async()=>{
  const current=await assertSucceeds(getDoc(ref(CURRENT)))
  assert.equal(current.data().result.writing.aiEstimatedBand,6.5)
  await denied(CURRENT,review(),'DIRECT_DASHBOARD_REVIEW')
})
test('former source teacher cannot read or review learner',async()=>{
  let err
  try{await getDoc(ref(OLD));assert.fail('Former teacher read allowed')}
  catch(e){if(e.code!=='permission-denied')throw e;err=e}
  assert.ok(err)
  await denied(OLD,review(),'FORMER_TEACHER')
})
test('nested AI metadata cannot be changed by teacher browser',async()=>{
  for(const [field,value] of [
    ['aiEstimatedBand',9],['aiEvaluationId','FAKE'],['aiCreditsUsed',999],
    ['aiProvider','pretender'],['aiFeedback',{summary:'FAKE'}],['aiStatus','faked']
  ]){
    const updated=review();updated.result.writing[field]=value
    await denied(CURRENT,updated,'MOCK_WRITING_AI_'+field)
  }
})
test('teacher cannot alter objective bands or top-level provenance',async()=>{
  for(const [field,value] of [['uid',CURRENT],['gradedByServer',false],
    ['attemptNumber',99],['teacherIds',[CURRENT]],['submittedAt','2021-01-01']]){
    await denied(CURRENT,{[field]:value},'IDENTITY_'+field)
  }
  await denied(CURRENT,{result:{...oldResult(),reading:{band:9}}},'READING_BAND')
})
test('teacher cannot append a fake AI field to an existing Writing review',async()=>{
  const payload=review();payload.result.writing.review.aiEstimatedBand=9
  await denied(CURRENT,payload,'FORGED_REVIEW_AI_BAND')
})
test('revoked current class membership immediately removes teacher Mock read and write',async()=>{
  await env.withSecurityRulesDisabled(async ctx=>{
    await updateDoc(doc(ctx.firestore(),`schools/maxima/teacherAcademicIndex/${CURRENT}`),{
      activeStudentIds:[]
    })
  })
  await denied(CURRENT,review(),'REMOVED_FROM_CLASS')
  await assert.rejects(getDoc(ref(CURRENT)),e=>e.code==='permission-denied')
})
test('student and anonymous actor cannot directly change submitted Mock',async()=>{
  await denied(STUDENT,review(),'STUDENT')
  await denied(null,review(),'ANONYMOUS')
})
test('admin can perform support repair but moderation stats remain backend-only',async()=>{
  await assertSucceeds(updateDoc(ref(ADMIN),{adminRepairComment:'Checked'}))
  assert.equal((await getDoc(ref(ADMIN))).data().adminRepairComment,'Checked')
  await denied(ADMIN,{excludedFromStats:true},'ADMIN_STATS_BACKEND_ONLY')
})
