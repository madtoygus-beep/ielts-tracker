// MAXIMA P0-B2B Step744: local demo Firestore cutover rehearsal ONLY.
// Seeds invented fixture data, rehearses exactly two index documents, and
// checks live-rule authorization through profile archival/restoration and
// class archive/re-admission. No callable deploy, cloud API, production reads,
// real student data or production writes are performed.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc } from 'firebase/firestore'

const PROJECT='demo-maxima-p0b'
const RULES='firestore.rules'
const RULES_SHA='9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const WRITER_SHA='b93023c08fbf01895cdc42cba4b8854c3050a15f07045735bc7b30b9e5ab6618'
const BRANCH='security/p0b-teacher-access-20261020'
const HEAD='9c7b233'
const SCHOOL='maxima'
const T1='step744_fake_teacher_1',T2='step744_fake_teacher_2',OLD='step744_fake_old_teacher'
const S=Array.from({length:35},(_,i)=>'step744_fake_student_'+String(i+1).padStart(2,'0'))
const now='2026-10-21T00:00:00Z'
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const require=createRequire(import.meta.url)
let env,db,app,admin,FieldValue,activeClassStudents,collectStudentIds,mutateManagedClassWithIndex
const client=(uid)=>env.authenticatedContext(uid).firestore()
const getAs=(uid,path)=>getDoc(doc(client(uid),path))
const getIndex=(t)=>db.doc(`schools/${SCHOOL}/teacherAcademicIndex/${t}`)
const live=(c)=>c.archived!==true && c.deleted!==true && c.permanentDeleteInProgress!==true
  && c.system!==true && c.isSystem!==true && String(c.name||'').trim().toLowerCase()!=='all'
  && !(typeof c.status==='string'&&c.status!=='active')
const isActive=(p,role)=>p?.role===role && p.status==='approved'&&p.deleted!==true
  &&p.archived!==true&&p.permanentDeleteInProgress!==true&&p.schoolId===SCHOOL

before(async()=>{
  assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):8081$/,'STOP: requires localhost Firestore Emulator port 8081')
  assert.equal(process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||PROJECT,PROJECT,'STOP: wrong demo project')
  assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),BRANCH,'STOP: wrong Git branch')
  assert.ok(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim().startsWith(HEAD),'STOP: wrong checkpoint')
  assert.equal(sha(RULES),RULES_SHA,'STOP: rules hash changed')
  assert.equal(sha('functions/lib/p0bAcademicMembershipIndex.js'),WRITER_SHA,'STOP: writer hash changed')
  ;({activeClassStudents,collectStudentIds,mutateManagedClassWithIndex}=require(resolve('functions/lib/p0bAcademicMembershipIndex.js')))
  const adminPath=require.resolve('firebase-admin',{paths:[resolve('functions'),process.cwd()]})
  admin=require(adminPath)
  app=admin.initializeApp({projectId:PROJECT},'step744-cutover-rehearsal')
  db=admin.firestore(app)
  db.settings({host:process.env.FIRESTORE_EMULATOR_HOST,ssl:false})
  FieldValue=admin.firestore.FieldValue
  env=await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:8081,rules:readFileSync(RULES,'utf8')}})
})
after(async()=>{if(env)await env.cleanup();if(app)await app.delete()})

beforeEach(async()=>{
  await env.clearFirestore()
  const batch=db.batch()
  batch.set(db.doc('schools/maxima'),{status:'active'})
  for(const t of [T1,T2,OLD]) batch.set(db.doc('users/'+t),{
    role:'teacher',status:'approved',deleted:false,archived:false,schoolId:SCHOOL
  })
  for(const uid of S) batch.set(db.doc('users/'+uid),{
    role:'student',status:'approved',deleted:false,archived:false,
    schoolId:SCHOOL,teacherIds:[OLD]
  })
  batch.set(db.doc('classes/step744_fake_active_1'),{
    name:'Class 1',teacherId:T1,schoolId:SCHOOL,archived:false,studentIds:S.slice(0,2)
  })
  const roster=[...S.slice(2),S[2]] // 33 unique student links, 34 roster entries
  const sizes=[6,6,6,6,6,4]
  let pos=0
  for(let i=0;i<6;i++){
    const slice=roster.slice(pos,pos+sizes[i]);pos+=sizes[i]
    batch.set(db.doc(`classes/step744_fake_active_${i+2}`),{
      name:'Class '+(i+2),teacherId:T2,schoolId:SCHOOL,archived:false,studentIds:slice
    })
  }
  assert.equal(pos,34)
  batch.set(db.doc('classes/step744_fake_system'),{
    name:'ALL',teacherId:T1,schoolId:SCHOOL,system:true,archived:false,studentIds:[S[0]]
  })
  batch.set(db.doc('classes/step744_fake_archived'),{
    name:'Old Class',teacherId:T2,schoolId:SCHOOL,archived:true,studentIds:[S[0]]
  })
  batch.set(db.doc('scores/step744_fake_legacy_score'),{
    uid:S[0],studentId:S[0],schoolId:SCHOOL,teacherId:OLD,teacherIds:[OLD],addedBy:OLD,
    source:'manual',writing:6,createdAt:now
  })
  await batch.commit()
})

// A candidate write path that runs EXCLUSIVELY against the demo Emulator.
// All source records, index absence and destination documents are read in the
// same Firestore transaction, then create() (never merge/set/overwrite) is used.
async function rehearsalBackfill(){
  return db.runTransaction(async tx=>{
    const [classSnap,schoolSnap,...indexSnaps]=await Promise.all([
      tx.get(db.collection('classes')),
      tx.get(db.doc('schools/'+SCHOOL)),
      tx.get(getIndex(T1)),tx.get(getIndex(T2)),tx.get(getIndex(OLD))
    ])
    assert.ok(schoolSnap.exists&&schoolSnap.data().status==='active','SCHOOL_INACTIVE')
    assert.equal(classSnap.size,9,'CLASS_COUNT_CHANGED')
    assert.ok(indexSnaps.every(s=>!s.exists),'INDEX_ALREADY_EXISTS')
    const active=classSnap.docs.filter(c=>live(c.data()))
    assert.equal(active.length,7,'ACTIVE_CLASS_COUNT_CHANGED')
    const plans=[]
    let rosterRefs=0
    for(const teacherId of [T1,T2]){
      const belonging=active.filter(d=>d.data().teacherId===teacherId)
      const studentIds=collectStudentIds(belonging.map(d=>d.data()),teacherId,SCHOOL)
      rosterRefs+=belonging.reduce((n,d)=>n+d.data().studentIds.length,0)
      plans.push({teacherId,studentIds,numberOfClasses:belonging.length})
    }
    assert.deepEqual(plans.map(p=>p.numberOfClasses),[1,6],'CLASS_GROUPING_CHANGED')
    assert.deepEqual(plans.map(p=>p.studentIds.length),[2,33],'MEMBERSHIP_COUNTS_CHANGED')
    assert.equal(rosterRefs,36,'ROSTER_REFERENCES_CHANGED')
    assert.ok(plans.flatMap(p=>p.studentIds).every(uid=>S.includes(uid)),'UNEXPECTED_STUDENT')
    const people=await Promise.all([...S,T1,T2].map(uid=>tx.get(db.doc('users/'+uid))))
    for(let i=0;i<S.length;i++) assert.ok(people[i].exists&&isActive(people[i].data(),'student'),'BAD_STUDENT')
    for(let i=0;i<2;i++) assert.ok(people[S.length+i].exists&&isActive(people[S.length+i].data(),'teacher'),'BAD_TEACHER')
    for(const p of plans) tx.create(getIndex(p.teacherId),{
      schemaVersion:1,teacherId:p.teacherId,schoolId:SCHOOL,source:'managed_active_classes',
      activeStudentIds:p.studentIds,updatedAt:now,updatedBy:'step744_fake_admin'
    })
    return {indexDocs:plans.length,links:plans.reduce((n,p)=>n+p.studentIds.length,0),rosterRefs}
  })
}

test('simulated pre-cutover no index then atomic two-index backfill restores authorized reads',async()=>{
  await assertFails(getAs(T1,`users/${S[0]}`))
  await assertFails(getAs(T1,'scores/step744_fake_legacy_score'))
  const report=await rehearsalBackfill()
  assert.deepEqual(report,{indexDocs:2,links:35,rosterRefs:36})
  assert.ok((await assertSucceeds(getAs(T1,`users/${S[0]}`))).exists())
  assert.ok((await assertSucceeds(getAs(T2,`users/${S[34]}`))).exists())
  assert.ok((await assertSucceeds(getAs(T1,'scores/step744_fake_legacy_score'))).exists())
  await assertFails(getAs(T2,'scores/step744_fake_legacy_score'))
  await assertFails(getAs(OLD,'scores/step744_fake_legacy_score'))
  console.log('STEP744_EMULATOR_BACKFILL INDEXES=2 LINKS=35 ROSTER=36 ACTIVE=ALLOWED OLD=DENIED')
})

test('replaying candidate backfill cannot overwrite any existing index',async()=>{
  await rehearsalBackfill()
  const prior=(await getIndex(T1).get()).data()
  await assert.rejects(rehearsalBackfill(),/INDEX_ALREADY_EXISTS/)
  assert.deepEqual((await getIndex(T1).get()).data(),prior)
  console.log('STEP744_EMULATOR_REPLAY=DENIED INDEX_UNCHANGED')
})

test('soft deleting student/teacher immediately revokes rights; admin restoration follows extant class membership',async()=>{
  await rehearsalBackfill()
  await db.doc('users/'+S[0]).update({status:'deleted',deleted:true})
  await assertFails(getAs(T1,`users/${S[0]}`))
  await assertFails(getAs(T1,'scores/step744_fake_legacy_score'))
  await db.doc('users/'+S[0]).update({status:'approved',deleted:false})
  assert.ok((await assertSucceeds(getAs(T1,'scores/step744_fake_legacy_score'))).exists())
  await db.doc('users/'+T1).update({status:'deleted',deleted:true})
  await assertFails(getAs(T1,`schools/maxima/teacherAcademicIndex/${T1}`))
  await assertFails(getAs(T1,'scores/step744_fake_legacy_score'))
  await db.doc('users/'+T1).update({status:'approved',deleted:false})
  assert.ok((await assertSucceeds(getAs(T1,'scores/step744_fake_legacy_score'))).exists())
  console.log('STEP744_ACCOUNT_STATUS STUDENT_DELETE=DENIED TEACHER_DELETE=DENIED ADMIN_RESTORE=ACTIVE_ROSTER_ONLY')
})

test('removal by class archive revokes immediately, blocked teacher re-admission and admin controlled restore',async()=>{
  await rehearsalBackfill()
  const classRef=db.doc('classes/step744_fake_active_1')
  await mutateManagedClassWithIndex({db,FieldValue,classRef,teacherId:T1,schoolId:SCHOOL,
    operation:'archive',payload:{archived:true,updatedAt:now,updatedBy:'step744_fake_admin'},
    updatedBy:'step744_fake_admin',actorRole:'admin',now})
  assert.deepEqual((await getIndex(T1).get()).data().activeStudentIds,[])
  await assertFails(getAs(T1,`users/${S[0]}`))
  await assertFails(getAs(T1,'scores/step744_fake_legacy_score'))
  await assert.rejects(mutateManagedClassWithIndex({db,FieldValue,classRef,teacherId:T1,schoolId:SCHOOL,
    operation:'archive',payload:{archived:false,updatedAt:now,updatedBy:T1},
    updatedBy:T1,actorRole:'teacher',now}),/New academic class members require admin authorization/)
  assert.equal((await classRef.get()).data().archived,true)
  await mutateManagedClassWithIndex({db,FieldValue,classRef,teacherId:T1,schoolId:SCHOOL,
    operation:'archive',payload:{archived:false,updatedAt:now,updatedBy:'step744_fake_admin'},
    updatedBy:'step744_fake_admin',actorRole:'admin',now})
  assert.deepEqual((await getIndex(T1).get()).data().activeStudentIds,S.slice(0,2))
  assert.ok((await assertSucceeds(getAs(T1,'scores/step744_fake_legacy_score'))).exists())
  console.log('STEP744_CLASS_REVOKE=IMMEDIATE TEACHER_READMISSION=DENIED ADMIN_RESTORE=ALLOWED')
})

test('account restored after index revocation does not resurrect academic access',async()=>{
  await rehearsalBackfill()
  await db.doc('users/'+S[0]).update({status:'deleted',deleted:true})
  const classRef=db.doc('classes/step744_fake_active_1')
  await mutateManagedClassWithIndex({db,FieldValue,classRef,teacherId:T1,schoolId:SCHOOL,
    operation:'archive',payload:{archived:true,updatedAt:now,updatedBy:'step744_fake_admin'},
    updatedBy:'step744_fake_admin',actorRole:'admin',now})
  await db.doc('users/'+S[0]).update({status:'approved',deleted:false})
  await assertFails(getAs(T1,`users/${S[0]}`))
  await assertFails(getAs(T1,'scores/step744_fake_legacy_score'))
  console.log('STEP744_RESTORE_AFTER_CLASS_REVOKE=DENIED')
})
