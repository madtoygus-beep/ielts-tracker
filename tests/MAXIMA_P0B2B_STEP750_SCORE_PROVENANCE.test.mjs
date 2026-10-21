import test,{before,after,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing'
import {doc,setDoc,getDoc,updateDoc} from 'firebase/firestore'

const PROJECT='demo-maxima-p0b', SHA='9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const T='step750_teacher', OLD='step750_old', ADMIN='step750_admin', S='step750_student'
const MOCK='step750_mock',SUBMISSION=`mockSubmissions/${S}_${MOCK}`
let env,i=0
const db=uid=>env.authenticatedContext(uid).firestore()
const score=(uid,id)=>doc(db(uid),`scores/${id}`)
const fake=over=>({uid:S,studentId:S,schoolId:'maxima',teacherId:T,teacherIds:[T],...over})
const manual=(extra={})=>fake({addedBy:T,date:'2026-10-21',listening:'6.0',reading:'6.5',writing:'7.0',speaking:'6.0',overall:'6.5',...extra})
const mock=(extra={})=>fake({studentEmail:'',source:'mock_test',mockTestId:MOCK,attemptNumber:1,
  date:'2026-10-21',createdAt:'2026-10-21T00:00:00Z',listening:6,reading:6,
  writing:'6.5',speaking:'',overall:6.0,writingSource:'teacher',
  aiEstimatedWritingBand:6.5,updatedAt:'2026-10-21T00:10:00Z',updatedBy:T,...extra})
async function deniedCreate(uid,data){const id=data.source==='mock_test' && data.mockTestId===MOCK
  ? `${S}_${MOCK}` : `attack${++i}`;await assertFails(setDoc(score(uid,id),data));let exists
  await env.withSecurityRulesDisabled(async ctx=>{exists=(await getDoc(doc(ctx.firestore(),`scores/${id}`))).exists()})
  assert.equal(exists,false,'forbidden score persisted')}
async function deniedUpdate(uid,id,delta){const original=await getDoc(score(ADMIN,id));
  await assertFails(updateDoc(score(uid,id),delta))
  const now=await getDoc(score(ADMIN,id));assert.deepEqual(now.data(),original.data(),'forbidden patch modified score')}
async function privilegedSeed(){await env.withSecurityRulesDisabled(async ctx=>{
  const root=ctx.firestore();await setDoc(doc(root,'schools/maxima'),{status:'active'})
  for(const [id,role] of [[T,'teacher'],[OLD,'teacher'],[ADMIN,'admin'],[S,'student']]){
    await setDoc(doc(root,`users/${id}`),{role,status:'approved',schoolId:'maxima',deleted:false,archived:false,teacherIds:[OLD]})}
  for(const [id,students] of [[T,[S]],[OLD,[]]])
    await setDoc(doc(root,`schools/maxima/teacherAcademicIndex/${id}`),{
      schemaVersion:1,source:'managed_active_classes',schoolId:'maxima',teacherId:id,activeStudentIds:students})
  await setDoc(doc(root,SUBMISSION),{
    uid:S,studentId:S,schoolId:'maxima',studentEmail:'',mockTestId:MOCK,
    status:'submitted',gradedByServer:true,attemptNumber:1,
    submittedAt:'2026-10-21T00:00:00Z',
    enabledSections:{listening:true,reading:true,writing:true},
    result:{listening:{band:6},reading:{band:6},writing:{aiEstimatedBand:6.5}}
  })
  await setDoc(doc(root,'scores/trustedMock'),{
    uid:S,studentId:S,schoolId:'maxima',teacherId:OLD,teacherIds:[OLD],
    source:'mock_test',mockTestId:MOCK,attemptNumber:1,
    createdAt:'2026-10-21T00:00:00Z',gradedByServer:true,
    reading:6,listening:6,writing:'',overall:6,aiEstimatedWritingBand:6.5,
    excludedFromStats:false
  })
})}
before(async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/)
  assert.equal(process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||PROJECT,PROJECT)
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),
    'security/p0b-teacher-access-20261020')
  assert.doesNotThrow(()=>execFileSync('git',['merge-base','--is-ancestor','9c7b233','HEAD']))
  assert.equal(createHash('sha256').update(readFileSync('firestore.rules')).digest('hex'),SHA)
  env=await initializeTestEnvironment({projectId:PROJECT,
    firestore:{host:'127.0.0.1',port:8081,rules:readFileSync('firestore.rules','utf8')}})
})
after(async()=>{if(env)await env.cleanup()})
beforeEach(async()=>{await env.clearFirestore();await privilegedSeed()})
test('teacher manual score creates only with narrow legitimate keys and grade values',async()=>{
  await assertSucceeds(setDoc(score(T,'manualOK'),manual()))
  const snap=await assertSucceeds(getDoc(score(T,'manualOK')))
  assert.equal(snap.data().addedBy,T)
})
test('forged AI / server provenance / moderation / mock linkage rejected at manual CREATE',async()=>{
  for(const attack of [
    {gradedByServer:true},{aiEstimatedWritingBand:9},{excludedFromStats:true},
    {statsExcludedAt:'2026-01-01'}, {source:'mock_test',mockTestId:'made_up'},
    {createdAt:'2021-01-01'},{attemptNumber:42},{reviewedBy:T},
    {status:'reviewed'},{serverSignature:'fake'}
  ]) await deniedCreate(T,manual(attack))
})
test('manual score validates identities, grades, source and attribution',async()=>{
  for(const attack of [
    {studentId:T},{teacherId:OLD},{teacherIds:[OLD]}, {addedBy:OLD},
    {source:'server'}, {reading:10},{writing:-1},{overall:15},
    {speaking:'9.5'},{date:'bad-date'}, {uid:OLD}
  ]) await deniedCreate(T,manual(attack))
})
test('Mock first score requires real trusted matching canonical submission',async()=>{
  await assertSucceeds(setDoc(score(T,`${S}_${MOCK}`),mock()))
  const found=await getDoc(score(T,`${S}_${MOCK}`))
  assert.equal(found.data().aiEstimatedWritingBand,6.5)
})
test('Mock first-score CREATE rejects forged AI, attempt, source and original bands',async()=>{
  for(const attack of [
    {mockTestId:'made_up'},{attemptNumber:2},{aiEstimatedWritingBand:9},
    {listening:9},{reading:9},{createdAt:'2000-01-01T00:00:00Z'},
    {studentEmail:'other@example.com'}, {excludedFromStats:true},
    {gradedByServer:true},{reviewedBy:T},{addedBy:T},
    {writingSource:'ai'},{status:'reviewed'}
  ]) await deniedCreate(T,mock(attack))
})
test('teacher Mock review changes only Writing and derived overall while preserving server fields',async()=>{
  await assertSucceeds(updateDoc(score(T,'trustedMock'),{
    writing:'7.0',writingSource:'teacher',overall:6.5,
    updatedAt:'2026-10-21T00:15:00Z',updatedBy:T
  }))
  const after=await getDoc(score(T,'trustedMock'))
  assert.equal(after.data().gradedByServer,true)
  assert.equal(after.data().aiEstimatedWritingBand,6.5)
  assert.equal(after.data().listening,6)
  assert.equal(after.data().reading,6)
})
test('teacher cannot change provenance, objective bands or metadata on existing Mock',async()=>{
  for(const attack of [
    {gradedByServer:false},{gradingSchemaVersion:999},
    {aiEstimatedWritingBand:9}, {reading:9},{listening:9},
    {createdAt:'2001-01-01T00:00:00Z'}, {studentEmail:'faked@example.com'},
    {excludedFromStats:true},{teacherId:T},{teacherIds:[T]},
    {source:'manual'},{attemptNumber:2},{status:'reviewed'},
    {updatedBy:OLD}, {'result.writing.aiEstimatedBand':9}
  ]) await deniedUpdate(T,'trustedMock',attack)
})
test('manual score UPDATE rejects arbitrary metadata and invalid grades',async()=>{
  await assertSucceeds(setDoc(score(T,'manualFix'),manual()))
  await assertSucceeds(updateDoc(score(T,'manualFix'),{writing:'7.5',overall:'7.0',updatedBy:T}))
  for(const attack of [
    {gradedByServer:true},{aiEstimatedWritingBand:9},{excludedFromStats:true},
    {teacherId:OLD},{createdAt:'2000-01-01'}, {listening:10},
    {overall:99},{updatedBy:OLD}, {date:'2022-01-01'}
  ]) await deniedUpdate(T,'manualFix',attack)
})
test('previous teacher revoked and admin retains support repair powers',async()=>{
  await deniedCreate(OLD,manual({teacherId:OLD,teacherIds:[OLD],addedBy:OLD}))
  await deniedUpdate(OLD,'trustedMock',{writing:7,writingSource:'teacher',updatedBy:OLD})
  await assertSucceeds(updateDoc(score(ADMIN,'trustedMock'),{adminNote:'support fix'}))
})
test('canonical membership removal blocks score creates and updates immediately',async()=>{
  await env.withSecurityRulesDisabled(async ctx=>{await updateDoc(doc(ctx.firestore(),
    `schools/maxima/teacherAcademicIndex/${T}`),{activeStudentIds:[]})})
  await deniedCreate(T,manual())
  await deniedUpdate(T,'trustedMock',{writing:7,writingSource:'teacher',updatedBy:T})
})
