import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {initializeTestEnvironment} from '@firebase/rules-unit-testing'
import {doc, setDoc} from 'firebase/firestore'

const PROJECT='demo-maxima-p0b'
const SHA='9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const T='step750r2_teacher', S='step750r2_student', MOCK='step750r2_mock'
const school='maxima'
const getScore=(env,uid,id)=>doc(env.authenticatedContext(uid).firestore(),`scores/${id}`)
const manual=()=>({uid:S,studentId:S,schoolId:school,teacherId:T,teacherIds:[T],addedBy:T,
  source:'manual',date:'2026-10-21',reading:'6.0',listening:'6.5',writing:'7.0',speaking:'6.0',overall:'6.5'})
const mock=()=>({uid:S,studentId:S,schoolId:school,teacherId:T,teacherIds:[T],studentEmail:'',
  source:'mock_test',mockTestId:MOCK,attemptNumber:1,date:'2026-10-21',
  createdAt:'2026-10-21T00:00:00Z',reading:6,listening:6,writing:'6.5',speaking:'',overall:6,
  writingSource:'teacher',aiEstimatedWritingBand:6.5,updatedAt:'2026-10-21T00:10:00Z',updatedBy:T})
const seed=async(env,changes={})=>{
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore()
    const teacher={role:'teacher',schoolId:school,status:'approved',deleted:false,archived:false,
      permanentDeleteInProgress:false,...changes.teacher}
    const student={role:'student',schoolId:school,status:'approved',deleted:false,archived:false,
      permanentDeleteInProgress:false,...changes.student}
    await setDoc(doc(db,`users/${T}`),teacher)
    await setDoc(doc(db,`users/${S}`),student)
    await setDoc(doc(db,`schools/${school}`),{status:'active',...changes.school})
    if(!changes.noIndex) await setDoc(doc(db,`schools/${school}/teacherAcademicIndex/${T}`),{
      schemaVersion:1,source:'managed_active_classes',schoolId:school,teacherId:T,
      activeStudentIds:changes.noMembership?[]:[S],...changes.index})
    await setDoc(doc(db,`mockSubmissions/${S}_${MOCK}`),{
      uid:S,studentId:S,schoolId:school,studentEmail:'',mockTestId:MOCK,status:'submitted',
      gradedByServer:true,attemptNumber:1,submittedAt:'2026-10-21T00:00:00Z',
      enabledSections:{listening:true,reading:true,writing:true},
      result:{listening:{band:6},reading:{band:6},writing:{aiEstimatedBand:6.5}}
    })
  })
}
async function denied(promise,label){
  await assert.rejects(promise,e=>{
    assert.equal(e?.code,'permission-denied',label)
    assert.doesNotMatch(String(e.message),/maximum of 1000 expressions|maximum memory usage|too many calls/i,label)
    return true
  })
}
test('Step750R2 current teacher may create legitimate MANUAL and trusted MOCK',async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/,'Emulator required')
  assert.equal(process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||PROJECT,PROJECT)
  const rules=readFileSync('firestore.rules','utf8')
  assert.equal(createHash('sha256').update(rules).digest('hex'),SHA)
  const env=await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:8081,rules}})
  try{
    await seed(env)
    await setDoc(getScore(env,T,'r2_manual_positive'),manual())
    await setDoc(getScore(env,T,`${S}_${MOCK}`),mock())
    console.log('STEP750R2_LEGITIMATE_MANUAL_AND_MOCK=ALLOWED')
  }finally{await env.cleanup()}
})
test('Step750R2 score CREATE fails closed on teacher, school, learner and index revocations',async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/)
  const env=await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:8081,rules:readFileSync('firestore.rules','utf8')}})
  const cases=[
    ['TEACHER_ARCHIVED',{teacher:{archived:true}}],
    ['TEACHER_DELETED',{teacher:{deleted:true}}],
    ['TEACHER_INACTIVE',{teacher:{status:'pending'}}],
    ['NOT_A_TEACHER',{teacher:{role:'student'}}],
    ['SCHOOL_SUSPENDED',{school:{status:'suspended'}}],
    ['STUDENT_DELETED',{student:{deleted:true}}],
    ['STUDENT_INACTIVE',{student:{status:'pending'}}],
    ['STUDENT_OTHER_SCHOOL',{student:{schoolId:'other'}}],
    ['MISSING_INDEX',{noIndex:true}],
    ['REMOVED_FROM_INDEX',{noMembership:true}],
    ['TAMPERED_INDEX',{index:{teacherId:'attacker'}}],
  ]
  try{
    for(const [label,delta] of cases){
      await seed(env,delta)
      await denied(setDoc(getScore(env,T,'r2_manual_'+label),manual()),label+' MANUAL')
      await denied(setDoc(getScore(env,T,`${S}_${MOCK}`),mock()),label+' MOCK')
    }
    console.log('STEP750R2_REVOKED_STATES_DENIED='+(cases.length*2))
  }finally{await env.cleanup()}
})
