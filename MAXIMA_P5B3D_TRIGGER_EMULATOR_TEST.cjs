'use strict'
// P5B-3D: actual Cloud Functions onDocumentWritten events via local Firestore
// emulator. The fixture Functions copy uses a purely synthetic provider.
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createHash, randomBytes } = require('node:crypto')
const host = process.env.FIRESTORE_EMULATOR_HOST || ''
const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
if (!/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(host) ||
    (project && project !== 'demo-maxima-tracker')) {
  console.error('REFUSED: requires local demo-maxima-tracker Emulator. No SDK loaded.')
  process.exit(2)
}
const admin = createRequire(path.join(__dirname,'functions','package.json'))('firebase-admin')
const app = admin.initializeApp({projectId:'demo-maxima-tracker'},'p5b3d-trigger-'+randomBytes(4).toString('hex'))
const db = admin.firestore(app)
const sha = v => createHash('sha256').update(v,'utf8').digest('hex')
const seed = randomBytes(5).toString('hex')
const uid = 'studp5b3d'+seed
const excluded = 'studexclude'+seed
const writingId = 'writep5b3d'+seed
const mockId = 'mockp5b3d'+seed
const linkedId = 'linkp5b3d'+seed
const month = new Date().toISOString().slice(0,7).replace('-','')
const job = (student,context,id,attempt=1) => db.doc('aiWritingEvaluations/'+sha(['ai-writing-v1',student,context,id,attempt].join('\0')))
const monthlyRef = db.doc(`aiWritingMonthlyUsage/maxima_${month}`)
const contentWriting = db.doc('writingHomeworks/'+writingId)
const contentLinked = db.doc('writingHomeworks/'+linkedId)
const contentMock = db.doc('mockTests/'+mockId)
const subWriting = db.doc(`writingSubmissions/${uid}_${writingId}`)
const subMock = db.doc(`mockSubmissions/${uid}_${mockId}`)
const subExcluded = db.doc(`writingSubmissions/${excluded}_${writingId}`)
const date = new Date().toISOString()
const at = admin.firestore.Timestamp.fromMillis(Date.now()-60000)
const mockSections = {writing:true,reading:false,listening:false}
const baseAnswer = 'Education can improve opportunity and wellbeing for the entire community.'
let count=0,failures=0
async function check(name,fn){try{await fn();count++;console.log('PASS',name)}catch(e){failures++;console.error('FAIL',name,e?.stack||e)}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const get=async ref=>{const s=await ref.get();return s.exists?s.data():null}
async function waitCompleted() {
  const start=Date.now()
  while(Date.now()-start < 60000) {
    const [w,m] = await Promise.all([get(job(uid,'homework',writingId)),get(job(uid,'mock',mockId))])
    if(w?.status==='completed' && m?.status==='completed')return {w,m}
    if(w?.status==='failed'||m?.status==='failed')throw Error('Synthetic grading failed: '+JSON.stringify({writing:w?.lastFailureCode,mock:m?.lastFailureCode}))
    await sleep(950)
  }
  throw Error('Timed out waiting for real Cloud Functions events to produce both reports')
}
async function main(){
  await Promise.all([
    db.doc('schools/maxima').set({status:'active'}),
    db.doc('aiWritingSchoolSettings/maxima').set({schoolId:'maxima',pilotEnabled:true}),
    db.doc('users/'+uid).set({role:'student',status:'approved',schoolId:'maxima',accountType:'institution'}),
    db.doc('users/'+excluded).set({role:'student',status:'approved',schoolId:'maxima',accountType:'institution'}),
    contentWriting.set({schoolId:'maxima',contentType:'task2_only',task2:{prompt:'Discuss education outcomes.',title:'Task 2'}}),
    contentLinked.set({schoolId:'maxima',contentType:'task2_only',task2:{prompt:'Discuss education outcomes.',title:'Task 2'}}),
    contentMock.set({schoolId:'maxima',mockType:'mini_mock',writingMode:'task2_only',writingId:linkedId,enabledSections:mockSections})
  ])
  await Promise.all([
    db.doc(`studentAccess/${uid}_writing_${writingId}`).set({uid,schoolId:'maxima',contentType:'writing',contentId:writingId,sourceCollection:'writingHomeworks',accessType:'assignment',status:'active',adminHidden:false}),
    db.doc(`studentAccess/${uid}_mock_${mockId}`).set({uid,schoolId:'maxima',contentType:'mock',contentId:mockId,sourceCollection:'mockTests',accessType:'assignment',status:'active',adminHidden:false}),
    db.doc(`studentAccess/${excluded}_writing_${writingId}`).set({uid:excluded,schoolId:'maxima',contentType:'writing',contentId:writingId,sourceCollection:'writingHomeworks',accessType:'assignment',status:'active',adminHidden:false}),
    db.doc(`aiWritingSponsoredPolicies/writing_${writingId}`).set({enabled:true,schoolId:'maxima',billing:'institution',context:'homework',contentType:'writing',sourceCollection:'writingHomeworks',contentId:writingId,studentIds:[uid],updatedAt:at}),
    db.doc(`aiWritingSponsoredPolicies/mock_${mockId}`).set({enabled:true,schoolId:'maxima',billing:'institution',context:'mock',contentType:'mock',sourceCollection:'mockTests',contentId:mockId,studentIds:[uid],updatedAt:at})
  ])
  await Promise.all([
    subWriting.set({uid,studentId:uid,schoolId:'maxima',writingId,attemptNumber:1,submittedAt:date,writingMode:'task2_only',task1Enabled:false,task2Enabled:true,task1Answer:'',task2Answer:baseAnswer}),
    subMock.set({uid,studentId:uid,schoolId:'maxima',mockTestId:mockId,writingId:linkedId,status:'submitted',attemptNumber:1,submittedAt:date,writingMode:'task2_only',task1Enabled:false,task2Enabled:true,enabledSections:mockSections,writingAnswers:{task1:'',task2:baseAnswer},teacherFinalScore:7,teacherNotes:'Teacher score remains independent'}),
    subExcluded.set({uid:excluded,studentId:excluded,schoolId:'maxima',writingId,attemptNumber:1,submittedAt:date,writingMode:'task2_only',task1Enabled:false,task2Enabled:true,task1Answer:'',task2Answer:baseAnswer})
  ])
  const {w,m}=await waitCompleted()
  await check('Real Writing submission triggers fake model, saved rubric',async()=>{
    assert.equal(w.billingMode,'sponsored_auto');assert.equal(w.providerModel,'p5b3d-local-fake-model')
    assert.equal(w.report.estimatedBand,6.5);assert.equal(Object.keys(w.report.task2.criteria).length,4)
  })
  await check('Real Mock submission triggers fake model, saved provisional rubric',async()=>{
    assert.equal(m.billingMode,'sponsored_auto');assert.equal(m.providerModel,'p5b3d-local-fake-model')
    assert.equal(m.report.isProvisionalMockEstimate,true);assert.equal(m.report.teacherFinalScore,null)
  })
  await check('Unselected student same Writing does not produce AI job',async()=>{
    assert.equal(await get(job(excluded,'homework',writingId)),null)
  })
  await check('No individual student credit granted or consumed',async()=>{
    assert.equal(await get(db.doc('aiWritingStudentAccess/'+uid)),null)
    const ledgers=await db.collection('aiWritingCreditOperations').get()
    assert.equal(ledgers.empty,true)
  })
  await check('Shared monthly budget reflects exactly two fake model calls',async()=>{
    const u=await get(monthlyRef)
    assert.equal(u.requestCount,2);assert.equal(u.sponsoredRequestCount,2)
    assert.equal(u.completedCount,2);assert.equal(u.pendingCount,0)
  })
  await check('Mock teacher-owned score and feedback unchanged',async()=>{
    const sub=await get(subMock)
    assert.equal(sub.teacherFinalScore,7)
    assert.equal(sub.teacherNotes,'Teacher score remains independent')
  })
  await subWriting.update({reviewed:true,review:{generalFeedback:'Local test only'}})
  await sleep(2000)
  await check('Teacher feedback update cannot trigger a second billed call',async()=>{
    assert.equal((await get(monthlyRef)).requestCount,2)
  })
  console.log(`P5B-3D real event to fake report: ${count}/${count+failures} PASS; ${failures} FAIL`)
  if(failures)process.exitCode=1
}
main().catch(e=>{console.error('P5B-3D E2E FAILED:',e?.stack||e);process.exitCode=1})
  .finally(()=>app.delete())
