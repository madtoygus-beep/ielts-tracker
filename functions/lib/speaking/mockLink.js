'use strict'
const {createHash}=require('node:crypto')
const {config}=require('./policy')
// A client-supplied attempt ID cannot attach another learner's or a previous retake's audio.
async function mockSpeakingLink({db,mock,student,mockId,existing,autoSubmitted,HttpsError,now=()=>Date.now()}) {
  if(mock.speakingConfig?.enabled!==true)return null
  const questions=config(mock.speakingConfig,true).questions
  const attemptNumber=existing?Number(existing.attemptNumber||1)+1:1
  const attemptId=createHash('sha256').update(`${student.uid}\0${mockId}\0${attemptNumber}`).digest('hex')
  const ref=db.doc(`speakingAttempts/${attemptId}`),snap=await ref.get(),a=snap.exists?snap.data():null
  if(a && (a.studentId!==student.uid||a.schoolId!==student.schoolId||a.mockId!==mockId||a.mockAttempt!==attemptNumber))throw new HttpsError('permission-denied','Speaking attempt does not match this Mock.')
  if(!a||a.status==='recording') {
    if(autoSubmitted!==true)throw new HttpsError('failed-precondition','Complete Speaking before submitting this Mock.')
    // Forced Mock submission closes the audio attempt too, preserving any already saved responses.
    await db.runTransaction(async tx=>{
      const liveSnap=await tx.get(ref),live=liveSnap.exists?liveSnap.data():null
      if(live?.status==='submitted'||live?.status==='reviewed')return
      const value=live||{studentId:student.uid,studentName:student.profile.name||'Student',teacherId:mock.teacherId||mock.createdBy,
        schoolId:student.schoolId,taskId:'',mockId,mockAttempt:attemptNumber,title:mock.title,mode:'mock',questions,
        startedAt:now(),nextIndex:0,current:null,answers:[],aiStatus:'not_requested'}
      tx.set(ref,{...value,status:'submitted',submittedAt:now(),forcedSubmission:true,current:null})
    })
  }
  const latest=(await ref.get()).data()
  return {attemptId,result:{enabled:true,status:latest.review?'reviewed':'pending_review',band:latest.review?.band??null}}
}
module.exports={mockSpeakingLink}
