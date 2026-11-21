'use strict'
// Server-only collections, IAM uploads and authenticated byte downloads. Never mint a download token.
const {createHash,randomUUID}=require('node:crypto')
const {config,validateWav,mockOverall,CRITERIA}=require('./policy')
function createSpeakingService({db,bucket,requireStudent,requireAssignmentManager,requireAssignedMock,requireCurrentTeacherAcademicStudent,HttpsError,schoolIdOf,provider,aiEnabled=()=>false,now=()=>Date.now()}) {
  const fail=(code,message)=>{throw new HttpsError(code,message)}
  const id=v=>{if(typeof v!=='string'||! /^[a-zA-Z0-9_-]{1,180}$/.test(v))fail('invalid-argument','Invalid Speaking identifier.');return v}
  const read=async path=>{const snap=await db.doc(path).get();if(!snap.exists)fail('not-found','Speaking record not found.');return {id:snap.id,...snap.data()}}
  const attemptControlRef=(studentId,taskId)=>db.doc(`speakingAttemptControls/${createHash('sha256').update(`${studentId}\0${taskId}`).digest('hex')}`)
  async function standaloneState(studentId,taskId){
    const ref=attemptControlRef(studentId,taskId),head=await ref.get()
    if(head.exists)return {ref,...head.data()}
    // Existing recordings predate attempt controls. Resolve their current head without changing them.
    const snap=await db.collection('speakingAttempts').where('studentId','==',studentId).where('taskId','==',taskId).get()
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(a=>!a.mockId)
      .sort((a,b)=>Number(b.startedAt)-Number(a.startedAt)||b.id.localeCompare(a.id))
    const latest=rows[0]
    return {ref,latestAttemptId:latest?.id||'',attemptNumber:latest?.attemptNumber||rows.length,status:latest?.status||'',retakeOpen:false}
  }
  const staffAccess=(staff,source)=>staff.profile.role==='admin' || (schoolIdOf(staff.profile)===source.schoolId && source.teacherId===staff.uid)
  const studentAccess=async(student,source)=>{
    if(source.archived===true||source.schoolId!==student.schoolId||!(source.assignedTo||[]).includes(student.uid))fail('permission-denied','This Speaking assignment is not available.')
    // Teacher links are live; an old source assignment must not bypass a revoked academic relationship.
    const teacher=await read(`users/${source.teacherId}`)
    if(teacher.role!=='teacher'&&teacher.role!=='admin')fail('permission-denied','Assignment teacher is unavailable.')
    if(teacher.status!=='approved'||teacher.archived||teacher.deleted)fail('permission-denied','Assignment teacher is unavailable.')
    if(teacher.role==='teacher')await requireCurrentTeacherAcademicStudent({db,HttpsError,manager:{uid:source.teacherId,profile:teacher},studentId:student.uid,schoolId:student.schoolId})
  }
  async function attemptAccess(request,attemptId,staff=false) {
    const actor=staff?await requireAssignmentManager(request):await requireStudent(request)
    const attempt=await read(`speakingAttempts/${id(attemptId)}`)
    if(staff) {
      if(!staffAccess(actor,attempt))fail('permission-denied','This Speaking attempt is not available.')
      await requireCurrentTeacherAcademicStudent({db,HttpsError,manager:actor,studentId:attempt.studentId,schoolId:attempt.schoolId})
    } else {
      if(attempt.studentId!==actor.uid||attempt.schoolId!==actor.schoolId)fail('permission-denied','This Speaking attempt is not available.')
      if(attempt.mockId)await requireAssignedMock(attempt.mockId,actor)
      else {await studentAccess(actor,await read(`speakingTasks/${attempt.taskId}`));if(attempt.status==='recording'&&(await standaloneState(actor.uid,attempt.taskId)).latestAttemptId!==attempt.id)fail('failed-precondition','A newer Speaking attempt exists. Resume the current assignment.')}

    }
    return {actor,attempt}
  }
  async function writeAccess(tx,actor,attempt,staff=false){
    const [userSnap,schoolSnap]=await tx.getAll(db.doc(`users/${actor.uid}`),db.doc(`schools/${attempt.schoolId}`))
    const user=userSnap.data()
    if(!user||user.status!=='approved'||user.archived||user.deleted||user.permanentDeleteInProgress||schoolSnap.data()?.status!=='active')fail('permission-denied','Account or institution is unavailable.')
    if(staff){
      if(!['admin','teacher'].includes(user.role)||!staffAccess({uid:actor.uid,profile:user},attempt))fail('permission-denied','Staff access changed.')
      await requireCurrentTeacherAcademicStudent({db,HttpsError,manager:{uid:actor.uid,profile:user},studentId:attempt.studentId,schoolId:attempt.schoolId,tx})
    }else{
      if(user.role!=='student'||schoolIdOf(user)!==attempt.schoolId||actor.uid!==attempt.studentId)fail('permission-denied','Student access changed.')
      const sourceSnap=await tx.get(db.doc(attempt.mockId?`mockTests/${attempt.mockId}`:`speakingTasks/${attempt.taskId}`)),source=sourceSnap.data()
      if(!source||source.archived||source.deleted||source.schoolId!==attempt.schoolId)fail('permission-denied','Assignment is unavailable.')
      if(attempt.mockId){
        const access=(await tx.get(db.doc(`studentAccess/${actor.uid}_mock_${attempt.mockId}`))).data()
        if(!access||access.uid!==actor.uid||access.contentType!=='mock'||access.contentId!==attempt.mockId||access.sourceCollection!=='mockTests'||access.schoolId!==attempt.schoolId||access.status!=='active'||access.adminHidden||access.accessType!=='assignment')fail('permission-denied','Mock assignment changed.')
      }else if(!source.assignedTo?.includes(actor.uid))fail('permission-denied','Assignment was removed.')
      const teacher=(await tx.get(db.doc(`users/${attempt.teacherId}`))).data()
      if(!teacher||teacher.status!=='approved'||teacher.archived||teacher.deleted)fail('permission-denied','Assignment teacher is unavailable.')
      if(teacher.role==='teacher')await requireCurrentTeacherAcademicStudent({db,HttpsError,manager:{uid:attempt.teacherId,profile:teacher},studentId:actor.uid,schoolId:attempt.schoolId,tx})
      else if(teacher.role!=='admin')fail('permission-denied','Assignment teacher is unavailable.')
    }
  }
  const retakeAiBlocked=a=>(a.attemptNumber||a.mockAttempt||1)>1&&a.retakeAiAllowed!==true
  const publicAttempt=a=>({id:a.id,title:a.title,mode:a.mode,attemptNumber:a.attemptNumber||a.mockAttempt||1,timedPart2:a.timedPart2===true,questions:a.questions,status:a.status,nextIndex:a.nextIndex,
    current:a.current||null,answers:(a.answers||[]).map(({storagePath,sha256,...v})=>v),report:a.report||null,review:a.review||null,
    mockId:a.mockId||'',taskId:a.taskId||'',studentName:a.studentName||'Student',startedAt:a.startedAt,serverNow:now(),submittedAt:a.submittedAt||null,aiStatus:a.aiStatus||'not_requested',aiRequestedAt:a.aiRequestedAt||null,aiRecoveryCount:(a.aiRecovery||[]).length,aiAssessmentBlockedReason:retakeAiBlocked(a)?'Retakes are available for teacher review without another paid AI assessment.':'',aiAvailable:!retakeAiBlocked(a)&&aiEnabled(a.studentId)})
  async function saveTask(request) {
    const staff=await requireAssignmentManager(request),data=request.data||{}
    if(!data.id&&staff.profile.role!=='teacher')fail('permission-denied','Speaking sets are created by teachers.')
    let schoolId=schoolIdOf(staff.profile)
    if(!schoolId||schoolId.startsWith('__'))fail('failed-precondition','Select an institution account.')
    const title=String(data.title||'').trim()
    if(!title||title.length>180)fail('invalid-argument','Enter a title (up to 180 characters).')
    let validated;try{validated=config({...data.config,enabled:true},data.mode==='mock')}catch(e){fail('invalid-argument',e.message)}
    let assignedTo=[...new Set(Array.isArray(data.assignedTo)?data.assignedTo:[])]
    const original=data.id?await read(`speakingTasks/${id(data.id)}`):null
    if(original)schoolId=original.schoolId
    if(original&&data.expectedUpdatedAt!==undefined&&data.expectedUpdatedAt!==original.updatedAt)fail('aborted','This set changed while you were editing. Reload it before saving.')
    if(original&&!staffAccess(staff,original))fail('permission-denied','Only the owner can edit this task.')
    const protectedIds=[]
    for(const sid of original?.assignedTo||[]){try{await requireCurrentTeacherAcademicStudent({db,HttpsError,manager:staff,studentId:sid,schoolId})}catch(e){if(e.code!=='permission-denied')throw e;protectedIds.push(sid)}}
    assignedTo=[...new Set([...assignedTo,...protectedIds])]
    if(assignedTo.length>100)fail('invalid-argument','Assign no more than 100 students at a time.')
    for(const sid of assignedTo.filter(sid=>!protectedIds.includes(sid)))await requireCurrentTeacherAcademicStudent({db,HttpsError,manager:staff,studentId:id(sid),schoolId})
    const taskId=data.id?id(data.id):randomUUID(),ref=db.doc(`speakingTasks/${taskId}`)
    if(data.id&&!staffAccess(staff,await read(ref.path)))fail('permission-denied','Only the owner can edit this task.')
    await db.runTransaction(async tx=>{
      const [userSnap,sourceSnap]=await tx.getAll(db.doc(`users/${staff.uid}`),ref)
      const user=userSnap.data(),latest=sourceSnap.data()
      if(!user||user.status!=='approved'||user.deleted||user.archived||!['admin','teacher'].includes(user.role))fail('permission-denied','Staff access changed.')
      if(data.id&&(!latest||!staffAccess({uid:staff.uid,profile:user},latest)||latest.updatedAt!==original.updatedAt))fail('aborted','Task changed. Reload before saving.')
      for(const sid of assignedTo.filter(sid=>!protectedIds.includes(sid)))await requireCurrentTeacherAcademicStudent({db,HttpsError,manager:{uid:staff.uid,profile:user},studentId:sid,schoolId,tx})
      tx.set(ref,{title,schoolId,mode:data.mode==='mock'?'mock':'practice',teacherId:original?.teacherId||staff.uid,config:validated,assignedTo,updatedAt:now(),archived:false},{merge:true})
    })
    return {id:taskId,task:await read(ref.path)}
  }
  async function list(request) {
    const staff=request.data?.staff===true
    const actor=staff?await requireAssignmentManager(request):await requireStudent(request)
    const admin=staff&&actor.profile.role==='admin',kind=request.data?.kind||'both'
    if(!['both','tasks','attempts'].includes(kind))fail('invalid-argument','Invalid list selection.')
    const result={tasks:[],attempts:[],cursors:{tasks:null,attempts:null},aiAvailable:aiEnabled(actor.uid)}
    const names=new Map()
    const teacherName=async uid=>{
      if(!names.has(uid)){const snap=await db.doc(`users/${id(uid)}`).get();names.set(uid,snap.data()?.name||snap.data()?.displayName||'Teacher')}
      return names.get(uid)
    }
    for(const type of ['tasks','attempts']){
      if(kind!=='both'&&kind!==type)continue
      const collection=type==='tasks'?'speakingTasks':'speakingAttempts'
      let query=db.collection(collection)
      if(admin)query=query.where('schoolId','==',schoolIdOf(actor.profile))
      else if(staff)query=query.where('teacherId','==',actor.uid)
      else query=type==='tasks'?query.where('assignedTo','array-contains',actor.uid):query.where('studentId','==',actor.uid)
      query=query.orderBy('__name__')
      const cursor=request.data?.cursors?.[type]
      if(cursor)query=query.startAfter(db.doc(`${collection}/${id(cursor)}`))
      const snap=await query.limit(26).get(),page=snap.docs.slice(0,25)
      if(snap.size>25)result.cursors[type]=page.at(-1).id
      for(const item of page){
        try{
          const value={...item.data(),id:item.id}
          if(value.schoolId!==schoolIdOf(actor.profile))continue
          if(type==='tasks'){
            if(!staff){await studentAccess(actor,value);const head=await standaloneState(actor.uid,value.id);result.tasks.push({id:value.id,title:value.title,config:value.config,
              latestAttemptId:head.latestAttemptId,latestAttemptStatus:head.status,retakeAvailable:head.retakeOpen===true,nextAttemptNumber:(head.attemptNumber||0)+1})}
            else result.tasks.push({...value,teacherName:await teacherName(value.teacherId)})
          }else{
            const {attempt}=await attemptAccess(request,item.id,staff)
            result.attempts.push({id:attempt.id,title:attempt.title,mode:attempt.mode,status:attempt.status,
              taskId:attempt.taskId,mockId:attempt.mockId,studentName:attempt.studentName,
              ...(staff?{studentId:attempt.studentId,teacherName:await teacherName(attempt.teacherId)}:{}),
              startedAt:attempt.startedAt,aiStatus:attempt.aiStatus,
              review:attempt.review?{band:attempt.review.band}:null,
              report:attempt.report?{estimatedBand:attempt.report.estimatedBand}:null})
          }
        }catch(e){if(!['permission-denied','not-found','failed-precondition'].includes(e.code))throw e}
      }
    }
    result.hasMore=Boolean(result.cursors.tasks||result.cursors.attempts)
    return result
  }
  async function archiveTask(request){
    const actor=await requireAssignmentManager(request),data=request.data||{},taskId=id(data.taskId)
    if(typeof data.archived!=='boolean')fail('invalid-argument','Select archive or restore.')
    return db.runTransaction(async tx=>{
      const ref=db.doc(`speakingTasks/${taskId}`),[u,t]=await tx.getAll(db.doc(`users/${actor.uid}`),ref)
      const user=u.data(),task=t.data()
      if(!task)fail('not-found','Speaking task not found.')
      if(!user||user.status!=='approved'||user.archived||user.deleted||user.permanentDeleteInProgress||!['teacher','admin'].includes(user.role)||!staffAccess({uid:actor.uid,profile:user},task))fail('permission-denied','This task is not available for management.')
      if(task.updatedAt!==data.expectedUpdatedAt)fail('aborted','Task changed. Refresh before archiving or restoring.')
      tx.update(ref,{archived:data.archived,updatedAt:now(),updatedBy:actor.uid})
      return {id:taskId,archived:data.archived}
    })
  }
  async function allowAiRetry(request){
    const {actor,attempt}=await attemptAccess(request,request.data?.attemptId,true)
    if(actor.profile.role!=='admin')fail('permission-denied','Only an administrator may release a failed assessment.')
    const reason=String(request.data?.reason||'').trim()
    if(reason.length<5||reason.length>1000)fail('invalid-argument','Enter a short recovery reason (5–1000 characters).')
    return db.runTransaction(async tx=>{
      const ref=db.doc(`speakingAttempts/${attempt.id}`),live=(await tx.get(ref)).data()
      await writeAccess(tx,actor,live,true)
      if((await tx.get(db.doc(`users/${actor.uid}`))).data()?.role!=='admin')fail('permission-denied','Administrator role changed.')
      if(live.aiStatus!=='failed'||live.report||live.aiRequestedAt!==request.data.expectedAiRequestedAt)fail('failed-precondition','The failed assessment changed. Refresh the report.')
      const history=live.aiRecovery||[]
      if(history.length>=3)fail('resource-exhausted','Recovery limit reached; technical review is required.')
      tx.update(ref,{aiStatus:'not_requested',aiRecovery:[...history,{at:now(),by:actor.uid,reason}]})
      return {aiStatus:'not_requested'} // No model call or quota reset; student must consent again.
    })
  }
  async function start(request) {
    const student=await requireStudent(request),data=request.data||{}
    if(data.attemptId && !data.mockId){const {attempt}=await attemptAccess(request,data.attemptId);if(attempt.taskId!==data.taskId)fail('permission-denied','Attempt does not match this task.');return publicAttempt(attempt)}
    let source,questions,attemptId,standalone,mode='practice',mockId='',mockAttempt=0
    if(data.mockId){
      mockId=id(data.mockId);source=await requireAssignedMock(mockId,student)
      let validated;try{validated=config(source.speakingConfig,true)}catch(e){fail('failed-precondition',e.message)}
      if(!validated.enabled)fail('failed-precondition','Speaking is not enabled in this Mock.')
      questions=validated.questions;mode='mock'
      const submissionSnap=await db.doc(`mockSubmissions/${student.uid}_${mockId}`).get()
      const previous=submissionSnap.exists?submissionSnap.data():null
      // Existing Mock retakes are server-authorised with an open attempt control.
      const controlId=createHash('sha256').update(`${student.uid}\u001fmock\u001f${mockId}`).digest('hex')
      const controlSnap=await db.doc(`submissionAttemptControls/${controlId}`).get()
      const control=controlSnap.exists?controlSnap.data():null
      if(previous && control?.status!=='open')fail('failed-precondition','This Mock was already submitted.')
      mockAttempt=previous?Math.max(2,(previous.attemptNumber||1)+1):1
      attemptId=createHash('sha256').update(`${student.uid}\0${mockId}\0${mockAttempt}`).digest('hex')
    }else{
      source=await read(`speakingTasks/${id(data.taskId)}`);await studentAccess(student,source)
      mode=source.mode==='mock'?'mock':'practice';questions=config(source.config,mode==='mock').questions;attemptId=randomUUID()
      standalone=await standaloneState(student.uid,data.taskId)
    }
    const ref=db.doc(`speakingAttempts/${attemptId}`)
    const output=await db.runTransaction(async tx=>{
      const existing=await tx.get(ref)
      await writeAccess(tx,student,{studentId:student.uid,schoolId:student.schoolId,teacherId:source.teacherId||source.createdBy,taskId:data.taskId||'',mockId})
      if(existing.exists)return {id:attemptId,...existing.data()}
      let control
      if(standalone){
        const saved=await tx.get(standalone.ref);control=saved.exists?saved.data():standalone
        if(control.latestAttemptId){
          const latest=await tx.get(db.doc(`speakingAttempts/${id(control.latestAttemptId)}`)),value=latest.data()
          if(!value||value.studentId!==student.uid||value.taskId!==data.taskId)fail('failed-precondition','The current Speaking attempt is unavailable.')
          if(value.status==='recording')return {id:latest.id,...value}
          if(control.retakeOpen!==true)fail('failed-precondition','You have submitted this Speaking assignment. Your teacher must allow a retake.')
        }
      }
      const day=new Date(now()).toISOString().slice(0,10),quotaRef=db.doc(`speakingAttemptUsage/${student.uid}_${day}`)
      const quota=await tx.get(quotaRef),count=quota.data()?.attempts||0
      if(count>=20)fail('resource-exhausted','Daily Speaking practice limit reached. Resume an existing attempt or try tomorrow.')
      tx.set(quotaRef,{studentId:student.uid,schoolId:student.schoolId,attempts:count+1,day})
      const value={studentId:student.uid,teacherId:source.teacherId||source.createdBy,schoolId:student.schoolId,
        taskId:data.taskId||'',mockId,mockAttempt,title:source.title,studentName:student.profile.name||student.profile.displayName||'Student',mode,questions,
        ...(standalone?{attemptNumber:(control.attemptNumber||0)+1,retakeAiAllowed:control.retakeOpen===true&&control.retakeAiAllowed===true,retakeApprovedBy:control.retakeOpen===true?control.openedBy||'':''}:{}),
        timedPart2:mode==='practice'&&questions.every(q=>q.part===2),startedAt:now(),status:'recording',nextIndex:0,current:null,answers:[],aiStatus:'not_requested'}
      if(standalone)tx.set(standalone.ref,{studentId:student.uid,taskId:data.taskId,schoolId:student.schoolId,latestAttemptId:attemptId,attemptNumber:value.attemptNumber,status:'recording',retakeOpen:false,updatedAt:now()})
      tx.create(ref,value);return {id:attemptId,...value}
    })
    return publicAttempt(output)
  }
  async function beginQuestion(request) {
    const {actor,attempt}=await attemptAccess(request,request.data?.attemptId)
    const ref=db.doc(`speakingAttempts/${attempt.id}`)
    return db.runTransaction(async tx=>{
      const current=(await tx.get(ref)).data()
      await writeAccess(tx,actor,current)
      if(current.status!=='recording')fail('failed-precondition','The attempt is already submitted.')
      if(current.current&&!(current.timedPart2===true&&current.mode==='practice'&&request.data?.restartPreparation===true))return {...current.current,serverNow:now()}
      const q=current.questions[current.nextIndex]
      if(!q)fail('failed-precondition','No questions remain.')
      const startedAt=now(),recordAt=startedAt+(current.timedPart2===true?0:8000)+q.preparationSeconds*1000
      const value={index:current.nextIndex,questionId:q.id,startedAt,recordAt,deadline:recordAt+q.seconds*1000}
      tx.update(ref,{current:value});return {...value,serverNow:now()}
    })
  }
  const mockAnswerTiming=(attempt,question,data,audio)=>{
    if(attempt.mode!=='mock'&&attempt.timedPart2!==true)return false
    // Audio encoders may round packet boundaries; the server's 60-second clock remains strict.
    const early=data.finishEarly===true&&question.part===2&&audio?.duration>=59.75&&now()>=attempt.current.recordAt+60000
    if(now()<attempt.current.deadline-500&&!early)fail('failed-precondition','Part 2 can finish after at least 60 seconds of recording; other questions must run to the time limit.')
    return Boolean(early&&audio.duration<question.seconds)
  }
  async function saveAnswer(request) {
    const {actor,attempt}=await attemptAccess(request,request.data?.attemptId)
    const data=request.data||{},index=data.index
    if(!Number.isInteger(index)||index<0||index>=attempt.questions.length)fail('invalid-argument','Invalid question.')
    let audio=null
    if(data.audio)try{audio=validateWav(data.audio)}catch(e){fail('invalid-argument',e.message)}
    const question=attempt.questions[index]
    if(audio&&audio.duration>question.seconds+3)fail('invalid-argument','Recording exceeds the question time limit.')
    const hash=audio?createHash('sha256').update(audio.bytes).digest('hex'):'unanswered'
    const path=audio?`speaking-private/${attempt.schoolId}/${attempt.studentId}/${attempt.id}/${question.id}-${hash}.wav`:''
    // Check state before storage writes to avoid unbounded orphan objects from invalid/replayed uploads.
    const previous=(attempt.answers||[]).find(a=>a.index===index)
    if(previous?.sha256===hash)return publicAttempt(attempt)
    if(attempt.status!=='recording'||index!==attempt.nextIndex||!attempt.current)fail('failed-precondition','This question is already locked.')
    mockAnswerTiming(attempt,question,data,audio)
    if(audio)await bucket.file(path).save(audio.bytes,{resumable:false,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:'audio/wav',cacheControl:'private, no-store',metadata:{attemptId:attempt.id}}}).catch(e=>{if(Number(e.code)!==412)throw e})
    await db.runTransaction(async tx=>{
      const ref=db.doc(`speakingAttempts/${attempt.id}`),live=(await tx.get(ref)).data()
      await writeAccess(tx,actor,live)
      const saved=live.answers.find(a=>a.index===index)
      if(saved?.sha256===hash)return
      if(live.status!=='recording'||live.nextIndex!==index||live.current?.questionId!==question.id)fail('aborted','Question changed. Reload the saved attempt.')
      const finishedEarly=mockAnswerTiming(live,question,data,audio)
      const entry={index,questionId:question.id,storagePath:path,sha256:hash,duration:audio?.duration||0,audible:audio?.audible||false,
        savedAt:now(),finishedEarly,interrupted:data.interrupted===true||(live.mode==='mock'&&now()>live.current.deadline+30000)}
      tx.update(ref,{answers:[...live.answers,entry],nextIndex:index+1,current:null})
    })
    return publicAttempt(await read(`speakingAttempts/${attempt.id}`))
  }
  async function submit(request) {
    const {actor,attempt}=await attemptAccess(request,request.data?.attemptId)
    await db.runTransaction(async tx=>{
      const ref=db.doc(`speakingAttempts/${attempt.id}`),live=(await tx.get(ref)).data()
      await writeAccess(tx,actor,live)
      if(live.status!=='recording')return
      if(live.nextIndex!==live.questions.length)fail('failed-precondition','Finish all questions before submitting.')
      let headRef,head
      if(!live.mockId){headRef=attemptControlRef(live.studentId,live.taskId);head=await tx.get(headRef)}
      tx.update(ref,{status:'submitted',submittedAt:now()})
      if(head?.exists&&head.data().latestAttemptId===attempt.id)tx.update(headRef,{status:'submitted',updatedAt:now()})
    });return publicAttempt(await read(`speakingAttempts/${attempt.id}`))
  }
  async function allowRetake(request){
    const {actor,attempt}=await attemptAccess(request,request.data?.attemptId,true)
    if(attempt.mockId)fail('failed-precondition','Use the parent Mock retake controls for this attempt.')
    if(attempt.status==='recording')fail('failed-precondition','The student must submit before a retake can be opened.')
    const fallback=await standaloneState(attempt.studentId,attempt.taskId)
    return db.runTransaction(async tx=>{
      const live=await tx.get(db.doc(`speakingAttempts/${attempt.id}`)),saved=await tx.get(fallback.ref)
      await writeAccess(tx,actor,live.data(),true)
      const control=saved.exists?saved.data():fallback
      if(control.latestAttemptId!==attempt.id)fail('failed-precondition','Open the latest Speaking report to allow a retake.')
      if(live.data().status==='recording')fail('failed-precondition','The current attempt has not been submitted.')
      tx.set(fallback.ref,{studentId:attempt.studentId,taskId:attempt.taskId,schoolId:attempt.schoolId,latestAttemptId:attempt.id,
        attemptNumber:control.attemptNumber||1,status:live.data().status,retakeOpen:true,retakeAiAllowed:request.data?.allowAi===true,openedBy:actor.uid,openedAt:now(),updatedAt:now()})
      return {retakeAvailable:true,nextAttemptNumber:(control.attemptNumber||1)+1}
    })
  }
  async function audio(request) {
    const {attempt}=await attemptAccess(request,request.data?.attemptId,request.data?.staff===true)
    const entry=attempt.answers.find(a=>a.questionId===request.data.questionId)
    if(!entry?.storagePath)fail('not-found','No recording for this question.')
    const [bytes]=await bucket.file(entry.storagePath).download()
    if(bytes.length>6*1024*1024)fail('resource-exhausted','Audio is too large.')
    return {audio:bytes.toString('base64'),mimeType:'audio/wav'}
  }
  async function review(request) {
    const {actor,attempt}=await attemptAccess(request,request.data?.attemptId,true)
    if(attempt.status==='recording')fail('failed-precondition','The student has not submitted this attempt.')
    const criteria=Object.fromEntries(CRITERIA.map(k=>{
      const band=request.data.criteria?.[k]
      if(typeof band!=='number'||!Number.isFinite(band)||band<0||band>9||band*2%1)fail('invalid-argument','Enter four valid criterion bands.')
      return [k,band]
    }))
    const band=Math.round(CRITERIA.reduce((s,k)=>s+criteria[k],0)/4*2)/2
    const feedback=String(request.data.feedback||'').slice(0,6000)
    const value={criteria,band,feedback,reviewedAt:now(),reviewedBy:actor.uid}
    await db.runTransaction(async tx=>{
      const ref=db.doc(`speakingAttempts/${attempt.id}`),live=(await tx.get(ref)).data()
      await writeAccess(tx,actor,live,true)
      let mockRef,scoreRef,submission,score
      if(live.mockId){
        mockRef=db.doc(`mockSubmissions/${live.studentId}_${live.mockId}`);scoreRef=db.doc(`scores/${live.studentId}_${live.mockId}`)
        const [m,s]=await Promise.all([tx.get(mockRef),tx.get(scoreRef)])
        submission=m.exists?m.data():null;score=s.exists?s.data():null
        if(!submission||submission.speakingAttemptId!==attempt.id||(submission.attemptNumber||1)!==live.mockAttempt)fail('failed-precondition','Submit the matching Mock before grading Speaking.')
      }
      tx.update(ref,{review:value,status:'reviewed'})
      if(submission){
        const result={...submission.result,speaking:{enabled:true,status:'reviewed',band,source:'teacher'}}
        const overall=mockOverall(result)
        tx.update(mockRef,{result:{...result,overallEstimate:overall,finalOverall:result.writing?.effectiveBandSource==='ai'?null:overall,reviewedOverall:result.writing?.effectiveBandSource==='ai'?null:overall,overall}})
        if(score && (!score.uid||score.uid===live.studentId) && (!score.studentId||score.studentId===live.studentId) && (score.uid===live.studentId||score.studentId===live.studentId) && (score.mockTestId===live.mockId||score.mockId===live.mockId) && (!score.mockTestId||score.mockTestId===live.mockId) && (!score.mockId||score.mockId===live.mockId) && schoolIdOf(score)===live.schoolId && Number(score.attemptNumber||1)===live.mockAttempt)tx.update(scoreRef,{speaking:band,overall:overall??'',speakingSource:'teacher'})
      }
    });return value
  }
  async function evaluate(request) {
    const {actor,attempt}=await attemptAccess(request,request.data?.attemptId)
    if(attempt.status==='recording')fail('failed-precondition','Submit before requesting AI assessment.')
    if(attempt.report)return attempt.report
    if(retakeAiBlocked(attempt))fail('failed-precondition','Retakes are available for teacher review without another paid AI assessment.')
    if(request.data?.consent!==true)fail('failed-precondition','Confirm sending the recordings for AI assessment.')
    if(!aiEnabled(actor.uid))fail('failed-precondition','AI Speaking assessment is not enabled yet. Your teacher can review the recordings.')
    if(!attempt.answers.some(a=>a.audible))fail('failed-precondition','There is not enough audible speech for an AI band.')
    if(attempt.answers.reduce((n,a)=>n+Math.ceil(a.duration*32000),0)>40*1024*1024)fail('resource-exhausted','This recording set is too long for one AI assessment. Teacher review is available.')
    // Reserve a bounded school request before any paid call; failures remain reviewable and cannot auto-retry/spend twice.
    const day=new Date(now()).toISOString().slice(0,10),quotaRef=db.doc(`speakingAiUsage/${attempt.schoolId}_${day}`)
    await db.runTransaction(async tx=>{
      const ref=db.doc(`speakingAttempts/${attempt.id}`)
      const [a,q]=await Promise.all([tx.get(ref),tx.get(quotaRef)])
      await writeAccess(tx,actor,a.data())
      if(a.data().aiStatus!=='not_requested')fail('failed-precondition','An assessment was already requested. Ask the administrator if recovery is needed.')
      if((q.data()?.requests||0)>=20)fail('resource-exhausted','The daily Speaking AI limit has been reached.')
      tx.set(quotaRef,{requests:(q.data()?.requests||0)+1,schoolId:attempt.schoolId,day})
      tx.update(ref,{aiStatus:'processing',aiRequestedAt:now()})
    })
    try {
      const recordings=[]
      for(const question of attempt.questions){const entry=attempt.answers.find(a=>a.questionId===question.id);let bytes=null;if(entry?.storagePath)[bytes]=await bucket.file(entry.storagePath).download();recordings.push({question,bytes})}
      const result=await provider(recordings)
      await db.doc(`speakingAttempts/${attempt.id}`).update({report:result,aiStatus:'completed'})
      return result
    }catch(_){await db.doc(`speakingAttempts/${attempt.id}`).update({aiStatus:'failed'});fail('unavailable','AI assessment failed. Recordings are saved for teacher review; no automatic retry was made.')}
  }
  async function call(request) {
    const operations={list,saveTask,archiveTask,allowAiRetry,allowRetake,start,beginQuestion,saveAnswer,submit,audio,review,evaluate,
      get:async req=>{const {attempt}=await attemptAccess(req,req.data?.attemptId,req.data?.staff===true);const head=!attempt.mockId?await standaloneState(attempt.studentId,attempt.taskId):null;return {...publicAttempt(attempt),attemptNumber:attempt.attemptNumber||1,isLatestAttempt:!head||head.latestAttemptId===attempt.id,retakeAvailable:head?.latestAttemptId===attempt.id&&head.retakeOpen===true}}}
    const op=request.data?.op
    if(!Object.hasOwn(operations,op))fail('invalid-argument','Unknown Speaking operation.')
    return operations[op](request)
  }
  return {call,attemptAccess}
}
module.exports={createSpeakingService}
