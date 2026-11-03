import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, setDoc, updateDoc } from 'firebase/firestore'
const PROJECT='demo-maxima-audfix2-step861'
const TEACHER='audfix2-teacher', STUDENT='audfix2-student', ADMIN='audfix2-admin'
const port=Number((process.env.FIRESTORE_EMULATOR_HOST||'').split(':')[1])
let env
const client=uid=>env.authenticatedContext(uid).firestore()
async function seed(){
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore()
    await setDoc(doc(db,'schools/maxima'),{status:'active'})
    await setDoc(doc(db,'schools/maxima/classWriteGate/p0b2b'),{phase:'open',schemaVersion:1,release:'p0b2b-class-writer-v1'})
    for(const [uid,role] of [[TEACHER,'teacher'],[STUDENT,'student'],[ADMIN,'admin']]){
      await setDoc(doc(db,`users/${uid}`),{role,status:'approved',deleted:false,archived:false,schoolId:'maxima'})
    }
    await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${TEACHER}`),{
      schemaVersion:1,source:'managed_active_classes',teacherId:TEACHER,schoolId:'maxima',activeStudentIds:[STUDENT]
    })
    await setDoc(doc(db,'scores/mock'),{
      uid:STUDENT,studentId:STUDENT,schoolId:'maxima',source:'mock_test',mockTestId:'mock-1',
      writing:'6.5',overall:'6.5',reading:'6.5',listening:'6.5',writingSource:'teacher'
    })
    await setDoc(doc(db,'scores/legacyMockWithoutSource'),{
      uid:STUDENT,studentId:STUDENT,schoolId:'maxima',mockTestId:'mock-1',
      writing:'6.5',overall:'6.5',reading:'6.5',listening:'6.5',writingSource:'teacher'
    })
    await setDoc(doc(db,'scores/manual'),{
      uid:STUDENT,studentId:STUDENT,schoolId:'maxima',source:'manual',
      teacherId:TEACHER,teacherIds:[TEACHER],addedBy:TEACHER,
      date:'2026-10-22',reading:'6.5',listening:'6.5',writing:'6.5',speaking:'6.5',overall:'6.5'
    })
    await setDoc(doc(db,'writingSubmissions/writing-1'),{
      uid:STUDENT,studentId:STUDENT,schoolId:'maxima',writingId:'writing-a',
      attemptNumber:1,submittedAt:'2026-10-22T00:00:00Z',status:'submitted',reviewed:false,
      answers:{task1:'student response'},aiBillingMode:'none'
    })
  })
}
before(async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:\d+$/)
  assert.equal(process.env.GOOGLE_CLOUD_PROJECT,PROJECT)
  assert.equal(process.env.GCLOUD_PROJECT,PROJECT)
  assert.ok(port>1000&&port<=65535)
  env=await initializeTestEnvironment({projectId:PROJECT,
    firestore:{host:'127.0.0.1',port,rules:readFileSync('firestore.rules','utf8')}})
})
after(async()=>{if(env)await env.cleanup()})
beforeEach(async()=>{await env.clearFirestore();await seed()})

test('01 mock score update forbidden even to assigned active teacher',async()=>{
  await assertFails(updateDoc(doc(client(TEACHER),'scores/mock'),{
    writing:'8.0',overall:'8.0',writingSource:'teacher',updatedAt:'2026-10-22T12:00:00Z',updatedBy:TEACHER
  }))
})
test('02 legacy Mock score without source is not misclassified as manual',async()=>{
  await assertFails(updateDoc(doc(client(TEACHER),'scores/legacyMockWithoutSource'),{
    writing:'8.0',overall:'8.0',updatedAt:'2026-10-22T12:00:00Z',updatedBy:TEACHER
  }))
})
test('03 teacher cannot create a forged Mock score even with active membership',async()=>{
  await assertFails(setDoc(doc(client(TEACHER),'scores/newMock'),{
    uid:STUDENT,studentId:STUDENT,schoolId:'maxima',teacherId:TEACHER,teacherIds:[TEACHER],
    date:'2026-10-22',source:'mock_test',mockTestId:'mock-1',attemptNumber:1,
    listening:'6.0',reading:'6.0',writing:'8.0',speaking:'',overall:'7.5',writingSource:'teacher',
    createdAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T12:00:00Z',updatedBy:TEACHER,
    studentEmail:'',
  }))
})
test('04 manual score creation and editing remain available to active teacher',async()=>{
  await assertSucceeds(setDoc(doc(client(TEACHER),'scores/manualNew'),{
    uid:STUDENT,studentId:STUDENT,schoolId:'maxima',teacherId:TEACHER,teacherIds:[TEACHER],
    date:'2026-10-22',listening:'6.0',reading:'6.5',writing:'7.0',speaking:'6.0',overall:'6.5',
    addedBy:TEACHER,source:'manual'
  }))
  await assertSucceeds(updateDoc(doc(client(TEACHER),'scores/manual'),{
    writing:'7.0',overall:'7.0',updatedAt:'2026-10-22T12:00:00Z',updatedBy:TEACHER
  }))
})
test('05 teacher browser cannot forge normal Writing reviewer or review content',async()=>{
  await assertFails(updateDoc(doc(client(TEACHER),'writingSubmissions/writing-1'),{
    reviewed:true,reviewedBy:'fake-teacher',reviewedAt:'2020-01-01T00:00:00Z',review:{overall:'9.0'}
  }))
  await assertFails(updateDoc(doc(client(TEACHER),'writingSubmissions/writing-1'),{
    reviewed:true,reviewedBy:TEACHER,reviewedAt:'2026-10-22T12:00:00Z',review:{overall:'8.0'}
  }))
})
test('06 admin archival still allowed; admin cannot alter grade or review',async()=>{
  await assertSucceeds(updateDoc(doc(client(ADMIN),'scores/mock'),{
    archived:true,archivedAt:'2026-10-22T12:00:00Z',updatedAt:'2026-10-22T12:00:00Z'
  }))
  await assertFails(updateDoc(doc(client(ADMIN),'scores/mock'),{writing:'9.0'}))
  await assertFails(updateDoc(doc(client(ADMIN),'writingSubmissions/writing-1'),{reviewed:true}))
})
console.log('AUD_FIX2_RULES_CASES_DEFINED=6')
