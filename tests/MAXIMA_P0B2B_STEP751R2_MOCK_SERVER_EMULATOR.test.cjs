'use strict'
// Real Firestore Emulator. Trusted Admin SDK service must preserve the original
// AI/objective evidence, commit both docs in one transaction, and fail closed
// after class membership is revoked.
const test=require('node:test')
const assert=require('node:assert/strict')
const {createRequire}=require('node:module')
const {join}=require('node:path')
const fr=createRequire(join(__dirname,'../functions/package.json'))
const {initializeApp,deleteApp}=fr('firebase-admin/app')
const {getFirestore}=fr('firebase-admin/firestore')
const {requireCurrentTeacherAcademicStudent}=require('../functions/lib/p0bCurrentAcademicAccess')
const {createMockWritingReviewService}=require('../functions/lib/p0bMockWritingReviewService')

const HOST=process.env.FIRESTORE_EMULATOR_HOST||''
const PROJECT=process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||''
assert.match(HOST,/^(127\.0\.0\.1|localhost):8081$/,'STOP: local emulator only')
assert.equal(PROJECT,'demo-maxima-p0b','STOP: never use Production')
const app=initializeApp({projectId:PROJECT},'step751r2-'+process.pid)
const db=getFirestore(app)
const token=process.pid.toString(36)
const schoolId='maxima'
const teacher=`step751r2_current_${token}`
const previous=`step751r2_previous_${token}`
const student=`step751r2_learner_${token}`
const admin=`step751r2_admin_${token}`
const mockId=`step751r2_mock_${token}`
const submittedAt='2026-10-21T00:25:00.000Z'
const subId=`${student}_${mockId}`
const subRef=db.doc(`mockSubmissions/${subId}`)
const scoreRef=db.doc(`scores/${subId}`)
const indexRef=db.doc(`schools/${schoolId}/teacherAcademicIndex/${teacher}`)
class HttpsError extends Error{constructor(code,message){super(message);this.code=code}}
function review(){return {
  task1Enabled:true,task2Enabled:true,task1Band:'7.0',task2Band:'7.5',
  rubric:{
    task1:{taskAchievement:'7.0',coherenceCohesion:'7',lexicalResource:'7',grammarRangeAccuracy:'7.5'},
    task2:{taskResponse:'7.5',coherenceCohesion:'7',lexicalResource:'7.0',grammarRangeAccuracy:'7.5'}
  },task1Feedback:'Teacher 1',task2Feedback:'Teacher 2',overall:'7.5',generalFeedback:'Overall review'
}}
const request=(uid=teacher)=>({auth:{uid},data:{studentId:student,submissionId:subId,
  mockTestId:mockId,attemptNumber:1,submittedAt,review:review()}})
const access=async({studentId,schoolId,manager,tx})=>
  requireCurrentTeacherAcademicStudent({db,HttpsError,manager,studentId,schoolId,tx})
const submit= createMockWritingReviewService({
  db,HttpsError,requireCurrentTeacherAcademicStudent:access,
  requireAssignmentManager:async req=>{
    const id=req.auth?.uid
    if(!id)throw new HttpsError('unauthenticated','No auth')
    const snap=await db.doc(`users/${id}`).get()
    const profile=snap.data()
    if(!profile||!['teacher','admin'].includes(profile.role)||profile.status!=='approved')
      throw new HttpsError('permission-denied','Not approved staff')
    return {uid:id,profile}
  },
  findCurrentSubmissionRecord:async(config,studentId,mockTestId)=>{
    if(config!=='mock'||studentId!==student||mockTestId!==mockId)return null
    const snap=await subRef.get()
    return snap.exists?{ref:subRef,id:subId,data:snap.data()}:null
  },
  submissionContentConfigFor:type=>type,
  matchingCurrentMockScoreForStats:async(studentId,mockTestId,schoolId,current)=>{
    const snap=await scoreRef.get()
    return snap.exists?snap:null
  },
  schoolIdOf:obj=>obj.schoolId||'maxima'
})

async function fixture(){
  const writes=[
    [`users/${teacher}`,{role:'teacher',status:'approved',schoolId}],
    [`users/${previous}`,{role:'teacher',status:'approved',schoolId}],
    [`users/${admin}`,{role:'admin',status:'approved',schoolId}],
    [`users/${student}`,{role:'student',status:'approved',accountType:'institution',schoolId,teacherIds:[previous]}],
    [`schools/${schoolId}`,{status:'active'}],
    [indexRef.path,{schemaVersion:1,source:'managed_active_classes',schoolId,teacherId:teacher,activeStudentIds:[student]}],
    [`schools/${schoolId}/teacherAcademicIndex/${previous}`,{
      schemaVersion:1,source:'managed_active_classes',schoolId,teacherId:previous,activeStudentIds:[]}],
    [subRef.path,{uid:student,studentId:student,schoolId,teacherId:previous,teacherIds:[previous],
      mockTestId:mockId,gradedByServer:true,attemptNumber:1,status:'submitted',submittedAt,
      enabledSections:{reading:true,listening:true,writing:true},
      result:{reading:{enabled:true,band:6.5,correct:25},listening:{enabled:true,band:7,correct:30},
        writing:{enabled:true,aiEstimatedBand:6.5,aiEvaluationId:'SERVER-AI-ID',
          aiProvider:'server',aiCreditsUsed:2,aiFeedback:{summary:'Original AI evidence'}},
        finalOverall:6.5,overallEstimate:6.5,overall:6.5}}],
    [scoreRef.path,{uid:student,studentId:student,schoolId,teacherId:previous,teacherIds:[previous],
      source:'mock_test',mockTestId:mockId,gradedByServer:true,attemptNumber:1,createdAt:submittedAt,
      aiEstimatedWritingBand:6.5,reading:6.5,listening:7,overall:6.5,writing:''}]
  ]
  const batch=db.batch()
  for(const [path,value] of writes)batch.set(db.doc(path),value)
  await batch.commit()
}

test.before(fixture)

test('real transaction updates human Writing and linked Mock score, never AI/objective evidence',async()=>{
  const old=(await subRef.get()).data()
  const r=await submit(request())
  assert.equal(r.ok,true)
  assert.equal(r.overall,7)
  const after=(await subRef.get()).data(),score=(await scoreRef.get()).data()
  assert.deepEqual(after.result.reading,old.result.reading)
  assert.deepEqual(after.result.listening,old.result.listening)
  assert.equal(after.result.writing.aiEstimatedBand,6.5)
  assert.equal(after.result.writing.aiEvaluationId,'SERVER-AI-ID')
  assert.equal(after.result.writing.aiCreditsUsed,2)
  assert.deepEqual(after.result.writing.aiFeedback,{summary:'Original AI evidence'})
  assert.equal(after.result.writing.band,'7.5')
  assert.equal(after.result.overall,7)
  assert.equal(score.reading,6.5)
  assert.equal(score.listening,7)
  assert.equal(score.aiEstimatedWritingBand,6.5)
  assert.equal(score.teacherId,previous)
  assert.equal(score.writing,'7.5')
  assert.equal(score.overall,7)
})

test('previous teacher lacks current index, and revocation blocks current teacher',async()=>{
  await assert.rejects(submit(request(previous)),e=>e.code==='permission-denied')
  await indexRef.update({activeStudentIds:[]})
  const before=(await subRef.get()).data()
  await assert.rejects(submit(request()),e=>e.code==='permission-denied')
  assert.deepEqual((await subRef.get()).data(),before)
})

test('admin can review support case without teacher membership',async()=>{
  const out=await submit(request(admin))
  assert.equal(out.ok,true)
  assert.equal((await subRef.get()).data().reviewedBy,admin)
})

test.after(async()=>{await deleteApp(app)})
