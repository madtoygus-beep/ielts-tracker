import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

const PROJECT='demo-maxima-p0b'
const BASE_SHA='9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const T='step750r4_teacher', OLD='step750r4_old', ADMIN='step750r4_admin', S='step750r4_student'
const NAMES=['CACHED_FIELD_FIRST']
const EXPECTED={CACHED_FIELD_FIRST:BASE_SHA}
const sha=b=>createHash('sha256').update(b).digest('hex')
const score=(env,actor,id)=>doc(env.authenticatedContext(actor).firestore(),`scores/${id}`)
const short=e=>String(e?.message||e).replace(/\s+/g,' ').slice(0,160)
const budget=/maximum of 1000 expressions|1000 expressions|too many calls|maximum memory usage/i
const evalErr=/Type error|Null value error/i
const review={writing:'7.0',writingSource:'teacher',overall:6.5,updatedAt:'2026-10-21T00:25:00Z',updatedBy:T}
const manualReview={writing:'7.5',overall:'7.0',updatedAt:'2026-10-21T00:25:00Z',updatedBy:T}
async function prepare(env){
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async ctx=>{
    const db=ctx.firestore()
    await setDoc(doc(db,'schools/maxima'),{status:'active'})
    for(const [id,role] of [[T,'teacher'],[OLD,'teacher'],[ADMIN,'admin'],[S,'student']])
      await setDoc(doc(db,`users/${id}`),{role,status:'approved',schoolId:'maxima',deleted:false,archived:false,teacherIds:[OLD]})
    for(const [id,students] of [[T,[S]],[OLD,[]]])
      await setDoc(doc(db,`schools/maxima/teacherAcademicIndex/${id}`),{
        schemaVersion:1,source:'managed_active_classes',teacherId:id,schoolId:'maxima',activeStudentIds:students})
    await setDoc(doc(db,'scores/trustedMock'),{
      uid:S,studentId:S,schoolId:'maxima',teacherId:OLD,teacherIds:[OLD],
      source:'mock_test',mockTestId:'mock',attemptNumber:1,
      createdAt:'2026-10-21T00:00:00Z',gradedByServer:true,
      reading:6,listening:6,writing:'',overall:6,aiEstimatedWritingBand:6.5,excludedFromStats:false})
    await setDoc(doc(db,'scores/manual'),{
      uid:S,studentId:S,schoolId:'maxima',teacherId:OLD,teacherIds:[OLD],addedBy:OLD,
      source:'manual',date:'2026-10-21',listening:'6.0',reading:'6.5',writing:'7.0',speaking:'6.0',overall:'6.5'})
    // LEGACY: old score may only have uid; should remain updatable by new teacher.
    await setDoc(doc(db,'scores/legacyUidOnly'),{
      uid:S,schoolId:'maxima',teacherId:OLD,teacherIds:[OLD],source:'manual',addedBy:OLD,
      date:'2026-10-21',listening:'6.0',reading:'6.5',writing:'7.0',speaking:'6.0',overall:'6.5'})
  })
}
async function attempt(env,actor,id,patch,label,r){
  try {
    await updateDoc(score(env,actor,id),patch)
    r.unexpectedAllow++
    r.problems.push(label+': UNEXPECTEDLY_ALLOWED')
  } catch(e) {
    if(e?.code==='permission-denied') {
      r.denied++
      if(budget.test(String(e?.message||e))) {r.budget++;r.problems.push(label+': BUDGET '+short(e))}
      if(evalErr.test(String(e?.message||e))) {r.evalErr++;r.problems.push(label+': RULE_EVAL_ERROR '+short(e))}
    } else r.problems.push(label+': OTHER '+short(e))
  }
}
async function run(env,name){
  const r={candidate:name,positiveMock:false,positiveManual:false,positiveLegacy:false,denied:0,budget:0,evalErr:0,unexpectedAllow:0,problems:[],clean:false}
  await prepare(env)
  try {await updateDoc(score(env,T,'trustedMock'),review);r.positiveMock=true}
  catch(e){r.problems.push('VALID_MOCK '+short(e))}
  try {await updateDoc(score(env,T,'manual'),manualReview);r.positiveManual=true}
  catch(e){r.problems.push('VALID_MANUAL '+short(e))}
  try {await updateDoc(score(env,T,'legacyUidOnly'),manualReview);r.positiveLegacy=true}
  catch(e){r.problems.push('VALID_LEGACY '+short(e))}
  // 14 forbidden fields on a real MOCK result; legacy attribution must never be reassignable.
  const mockBad=[
    ['gradedByServer',{gradedByServer:false}],['AI',{aiEstimatedWritingBand:9}],
    ['reading',{reading:9}],['listening',{listening:9}],
    ['excludedFromStats',{excludedFromStats:true}],['teacherId',{teacherId:T}],
    ['teacherIds',{teacherIds:[T]}],['uid',{uid:OLD}],
    ['studentId',{studentId:OLD}],['source',{source:'manual'}],
    ['attemptNumber',{attemptNumber:2}],['createdAt',{createdAt:'2020-01-01'}],
    ['foreignField',{unrecognizedServerField:true}],
    ['nestedAI',{'result.writing.aiEstimatedBand':9}],
    ['date',{date:'2022-01-01'}],['badWriteBand',{writing:99}],
    ['foreignUpdatedBy',{...review,updatedBy:OLD}]
  ]
  for(const [label,delta] of mockBad) await attempt(env,T,'trustedMock',delta,'MOCK_'+label,r)
  const manualBad=[
    ['server',{gradedByServer:true}],['AI',{aiEstimatedWritingBand:9}],
    ['excluded',{excludedFromStats:true}],['teacherId',{teacherId:T}],
    ['addedBy',{addedBy:T}],['source',{source:'mock_test'}],
    ['invalidGrade',{reading:11}],['badUpdatedBy',{...manualReview,updatedBy:OLD}],
    ['unknown',{unrecognizedServerField:true}]
  ]
  for(const [label,delta] of manualBad) await attempt(env,T,'manual',delta,'MANUAL_'+label,r)
  await attempt(env,OLD,'trustedMock',{...review,updatedBy:OLD},'OLD_TEACHER_MOCK',r)
  await attempt(env,OLD,'manual',{...manualReview,updatedBy:OLD},'OLD_TEACHER_MANUAL',r)
  // Case studies with only one state changed; use trusted seed writes.
  const revoked=[
    ['INDEX_REVOKED',`schools/maxima/teacherAcademicIndex/${T}`,{activeStudentIds:[]}],
    ['TEACHER_ARCHIVED',`users/${T}`,{archived:true}],
    ['TEACHER_DELETED',`users/${T}`,{deleted:true}],
    ['TEACHER_ROLE_REMOVED',`users/${T}`,{role:'student'}],
    ['SCHOOL_SUSPENDED','schools/maxima',{status:'suspended'}],
    ['STUDENT_DELETED',`users/${S}`,{deleted:true}],
    ['STUDENT_OTHER_SCHOOL',`users/${S}`,{schoolId:'other'}]
  ]
  for(const [label,path,change] of revoked){
    await prepare(env)
    await env.withSecurityRulesDisabled(async ctx=>await updateDoc(doc(ctx.firestore(),path),change))
    await attempt(env,T,'trustedMock',review,'REVOKED_'+label,r)
  }
  r.clean=r.positiveMock&&r.positiveManual&&r.positiveLegacy
    &&r.denied===mockBad.length+manualBad.length+2+revoked.length
    &&r.budget===0&&r.evalErr===0&&r.unexpectedAllow===0&&r.problems.length===0
  return r
}

test('Step750R5 selected score update path: 3 positives and 35 clean denials',async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/,'STOP: demo emulator required')
  assert.equal(process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||PROJECT,PROJECT,'STOP: demo project only')
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),'security/p0b-teacher-access-20261020','STOP: wrong branch')
  assert.doesNotThrow(()=>execFileSync('git',['merge-base','--is-ancestor','9c7b233','HEAD']),'STOP: unexpected Git history')
  assert.equal(sha(readFileSync('firestore.rules')),BASE_SHA,'STOP: local Rules not Step750R2')
  let results=[]
  for(const name of NAMES){
    const file='firestore.rules'
    const rules=readFileSync(file,'utf8')
    assert.equal(sha(rules),EXPECTED[name],`STOP: ${name} candidate changed`)
    let env
    try {
      env=await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:8081,rules}})
      const r=await run(env,name)
      results.push(r)
      console.log(`STEP750R5_CANDIDATE ${JSON.stringify(r)}`)
    } catch(e) {
      results.push({candidate:name,clean:false,probeError:short(e)})
      console.log(`STEP750R5_CANDIDATE ${name} PROBE_ERROR=${short(e)}`)
    } finally {if(env) await env.cleanup()}
  }
  const safe=results.filter(x=>x.clean).map(x=>x.candidate)
  console.log('STEP750R5_SAFE_CANDIDATES='+JSON.stringify(safe))
  console.log('STEP750R5_ONLY_LOCAL_RULES_USED=YES')
  console.log('STEP750R5_PRODUCTION_UNTOUCHED=YES')
  assert.deepEqual(safe,NAMES,'No budget-safe verified update candidate')
})
