'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = process.env.MAXIMA_STEP848_ROOT
if (!root) throw new Error('STEP848_ROOT_MISSING')
const sdkRequire = createRequire(path.join(root, 'functions', 'index.js'))
const admin = sdkRequire('firebase-admin')
const { classifyLegacyIdentity } = require(path.join(root, 'tools/p0bG4LegacyAcademicPreview.cjs'))
const {
  DEMO_PROJECT, SCHOOL_ID, CLASS_RELEASE, assertIsolatedEmulator,
  patchIsSafe, rehearseOne
} = require(path.join(root, 'tools/p0bG4MigrationRehearsal.cjs'))
assertIsolatedEmulator(DEMO_PROJECT)
const app = admin.initializeApp({ projectId: DEMO_PROJECT }, 'step848-rehearsal')
const db = app.firestore()
const activeUid = 'studentDemoActive848'
const inactiveUid = 'studentDemoInactive848'
const DATA = [
  ['scores', 43, 5, 2, 4],
  ['readingSubmissions', 154, 57, 0, 1],
  ['writingSubmissions', 67, 3, 0, 0],
  ['listeningSubmissions', 25, 13, 0, 0],
  ['vocabularySubmissions', 103, 4, 3, 0],
  ['mockSubmissions', 40, 6, 0, 1]
]
const candidateRefs = []
const manualRefs = []
const canonicalRefs = []
const EXPECTED = { total: 531, candidate: 93, canonical: 432, manual: 6, conflict: 0 }
const gateRef = db.doc('schools/maxima/classWriteGate/p0b2b')
const gateData = {
  phase:'frozen', schemaVersion:1, release: CLASS_RELEASE,
  g4EmulatorRehearsal: true
}
const metaFor = (c, i) => ({
  uid: activeUid, studentId: activeUid, schoolId:SCHOOL_ID,
  attemptNumber: 1, submittedAt:'2026-10-21T10:00:00.123Z',
  score: 7.0, teacherReview:{comment:'never change this'},
  syntheticMarker:`${c}-seed-${i}`,
})
function makeDoc(collection, i, kind) {
  const entry = metaFor(collection, i)
  if (kind === 'missingBoth') {
    delete entry.studentId
    delete entry.schoolId
  } else if (kind === 'missingStudent') {
    delete entry.studentId
  } else if (kind === 'manual') {
    entry.uid = inactiveUid
    entry.studentId = inactiveUid
  }
  return entry
}
async function seed() {
  await db.doc(`users/${activeUid}`).set({
    role:'student', status:'approved', accountType:'institution', schoolId:SCHOOL_ID
  })
  await db.doc(`users/${inactiveUid}`).set({
    role:'student', status:'deleted', accountType:'institution', schoolId:SCHOOL_ID
  })
  await gateRef.set(gateData)
  let batch = db.batch()
  let size = 0
  for (const [name, canonical, missingBoth, missingStudent, manual] of DATA) {
    const kinds = [
      ...Array(canonical).fill('canonical'),
      ...Array(missingBoth).fill('missingBoth'),
      ...Array(missingStudent).fill('missingStudent'),
      ...Array(manual).fill('manual')
    ]
    for (const [i,kind] of kinds.entries()) {
      const ref=db.collection(name).doc(`demo848_${String(i).padStart(3, '0')}`)
      batch.set(ref, makeDoc(name, i, kind))
      if (kind === 'canonical') canonicalRefs.push(ref)
      else if (kind === 'manual') manualRefs.push(ref)
      else candidateRefs.push(ref)
      size++
      if (size === 300) {
        await batch.commit();batch=db.batch();size=0
      }
    }
  }
  if (size) await batch.commit()
}
function kindOf(ref, data) {
  const uid=data.uid || data.studentId
  return classifyLegacyIdentity({
    collection:ref.parent.id,docId:ref.id,record:data,
    profile: uid === inactiveUid ? {
      role:'student',status:'deleted',accountType:'institution',schoolId:SCHOOL_ID
    } : {role:'student',status:'approved',accountType:'institution',schoolId:SCHOOL_ID},
    profileUid:uid
  }).kind
}
async function attempt(ref, version) {
  const snap = version ? null : await ref.get()
  return rehearseOne({db,projectId:DEMO_PROJECT,collection:ref.parent.id,
    docId:ref.id,expectedUpdateTime:version || snap.updateTime})
}

// Tests run serially. Firebase SDK uses the real Firestore Emulator, never ADC.
test('01 environment hard-fails on Production project and remote host', async () => {
  assert.throws(() => assertIsolatedEmulator('maxima-tracker'),/G4_EMULATOR_ONLY_BLOCKED/)
  await assert.rejects(rehearseOne({db,projectId:'maxima-tracker',collection:'scores',docId:'x'}), /G4_EMULATOR_ONLY_BLOCKED/)
})
test('02 seed anonymous representative 531-record profile', async () => {
  await seed()
  assert.equal(candidateRefs.length, EXPECTED.candidate)
  assert.equal(canonicalRefs.length, EXPECTED.canonical)
  assert.equal(manualRefs.length, EXPECTED.manual)
  let total = 0
  for (const [name,expectedCanonical,both,student,manual] of DATA) {
    const rows=await db.collection(name).get()
    assert.equal(rows.size,expectedCanonical+both+student+manual)
    total+=rows.size
  }
  assert.equal(total,EXPECTED.total)
  console.log('STEP848_SYNTHETIC_FIXTURE=531_TOTAL_93_CANDIDATE_6_MANUAL')
})
test('03 gate missing fails before any identity update', async () => {
  const ref=candidateRefs[0]
  await gateRef.delete()
  await assert.rejects(attempt(ref),/G4_GATE_NOT_FROZEN_OR_MISMATCHED/)
  assert.equal((await ref.get()).data().studentId,undefined)
  await gateRef.set(gateData)
})
test('04 gate open fails before identity update', async () => {
  const ref=candidateRefs[0]
  await gateRef.update({phase:'open'})
  await assert.rejects(attempt(ref),/G4_GATE_NOT_FROZEN_OR_MISMATCHED/)
  assert.equal((await ref.get()).data().studentId,undefined)
  await gateRef.update({phase:'frozen'})
})
test('05 gate wrong release and schema fail closed', async () => {
  await gateRef.update({release:'wrong-release'})
  await assert.rejects(attempt(candidateRefs[0]),/G4_GATE_NOT_FROZEN_OR_MISMATCHED/)
  await gateRef.update({release:CLASS_RELEASE,schemaVersion:2})
  await assert.rejects(attempt(candidateRefs[0]),/G4_GATE_NOT_FROZEN_OR_MISMATCHED/)
  await gateRef.update({schemaVersion:1})
})
test('06 surviving G1 authority lease blocks migration', async () => {
  const lease=db.doc('schools/maxima/classAuthorityOperations/durable-demo-lease')
  await lease.set({operation:'createManagedUser',admittedAt:'2026-10-21T09:00:00Z'})
  await assert.rejects(attempt(candidateRefs[0]),/G4_AUTHORITY_LEASE_NOT_DRAINED/)
  await lease.delete()
})
test('07 stale updateTime precondition fails without touching data', async () => {
  const ref=candidateRefs[0]
  const before=await ref.get()
  await ref.update({teacherReview:{comment:'concurrent human edit'}})
  await assert.rejects(attempt(ref,before.updateTime),/G4_STALE_RECORD_VERSION/)
  assert.equal((await ref.get()).data().studentId,undefined)
})
test('08 invalid update field or existing identity is rejected', () => {
  assert.equal(patchIsSafe({uid:activeUid},{score:9},activeUid,SCHOOL_ID),false)
  assert.equal(patchIsSafe({uid:activeUid,studentId:activeUid},{studentId:activeUid},activeUid,SCHOOL_ID),false)
  assert.equal(patchIsSafe({uid:activeUid},{studentId:activeUid},activeUid,'otherSchool'),false)
})
test('09 inactive students remain manual; identity remains untouched', async () => {
  for (const ref of manualRefs) {
    const before=(await ref.get()).data()
    assert.equal((await attempt(ref)).kind,'manual_review')
    assert.deepEqual((await ref.get()).data(), before)
  }
})
test('10 conflicted identity is not migrated', async () => {
  const ref=db.doc('scores/demo848_identity_conflict')
  await ref.set({...metaFor('scores',999),studentId:'studentDemoOther'})
  assert.equal((await attempt(ref)).kind,'conflict')
  assert.equal((await ref.get()).data().studentId,'studentDemoOther')
  await ref.delete()
})
test('11 migrate precisely 93 missing-field candidates in Emulator', async () => {
  let updated=0, missingBoth=0, missingStudent=0
  for (const ref of candidateRefs) {
    const before=(await ref.get()).data()
    const out=await attempt(ref)
    assert.equal(out.kind,'updated')
    const expectedFields=before.schoolId ? ['studentId'] : ['schoolId','studentId']
    assert.deepEqual(out.fields,expectedFields)
    const after=(await ref.get()).data()
    assert.deepEqual(after,{...before,studentId:activeUid,schoolId:SCHOOL_ID})
    assert.equal(kindOf(ref,after),'already_canonical')
    updated++
    if (before.schoolId) missingStudent++
    else missingBoth++
  }
  assert.equal(updated,93)
  assert.equal(missingBoth,88)
  assert.equal(missingStudent,5)
  console.log('STEP848_MIGRATION_REHEARSAL_UPDATED=93')
  console.log('STEP848_ONLY_STUDENT_ID_MISSING=5')
  console.log('STEP848_STUDENT_AND_SCHOOL_MISSING=88')
})
test('12 idempotent rerun and unchanged canonical + 6 manual records', async () => {
  assert.equal((await attempt(candidateRefs[0])).kind,'already_canonical')
  for (const ref of canonicalRefs) {
    const snap=await ref.get()
    assert.equal(kindOf(ref,snap.data()),'already_canonical')
    assert.deepEqual(snap.data(),metaFor(ref.parent.id,Number(ref.id.slice(-3))))
  }
  for (const ref of manualRefs) assert.equal((await attempt(ref)).kind,'manual_review')
  console.log('STEP848_REMAINING_MANUAL=6')
})
test('13 gate remains frozen, no lease exists and no production billing calls', async () => {
  const gate=(await gateRef.get()).data()
  assert.equal(gate.phase,'frozen')
  assert.equal((await db.collection('schools/maxima/classAuthorityOperations').limit(1).get()).size,0)
  assert.equal(process.env.GOOGLE_CLOUD_PROJECT,DEMO_PROJECT)
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST?.startsWith('127.0.0.1:'),true)
  console.log('STEP848_READONLY_PRODUCTION=true')
  console.log('STEP848_PAID_AI_CALLS=ZERO')
})

test.after(async () => { await app.delete() })
