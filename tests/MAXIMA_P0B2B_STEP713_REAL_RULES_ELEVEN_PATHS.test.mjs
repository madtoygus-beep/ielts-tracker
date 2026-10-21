// MAXIMA IELTS Tracker P0-B2B Step710: close the exact 11 old-teacher paths.
// SAFETY: Only local demo Firebase Emulator, SOURCE CANDIDATE rules in LOCAL Emulator; never deployed.
// This only loads locally patched firestore.rules into a demo Emulator; it changes no cloud data.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, getDocs, updateDoc, setDoc, collection, query, where } from 'firebase/firestore'

const PROJECT = 'demo-maxima-p0b'
const LAB_PATH = 'firestore.rules'
const EXPECTED_REAL_RULES_SHA = '9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const EXPECTED_LAB_SHA = '9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3'
const EXPECTED_INDEX_SHA = 'b93023c08fbf01895cdc42cba4b8854c3050a15f07045735bc7b30b9e5ab6618'
const OLD = 'step710_old_teacher'
const CURRENT = 'step710_current_teacher'
const STUDENT = 'step710_student'
const ADMIN = 'step710_admin'
const WRITING = 'step710_writing'
const MOCK = 'step710_mock'
const SUB = `${STUDENT}_${WRITING}`
const MOCKSUB = `${STUDENT}_${MOCK}`
const SCORE = 'step710_score'
let env
const seen = []
const dbFor = uid => env.authenticatedContext(uid).firestore()
const ref = (uid, path) => doc(dbFor(uid), path)
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')

async function privileged(callback) {
  await env.withSecurityRulesDisabled(async context => { await callback(context.firestore()) })
}
async function denied(name, promise) {
  const err = await assertFails(promise)
  assert.equal(String(err.code), 'permission-denied', `${name} must be denied by Rules`)
  seen.push(name)
  console.log(`STEP710_CLOSURE ${name} DENIED`)
}
async function seed() {
  await privileged(async db => {
    await setDoc(doc(db, 'schools/maxima'), { status: 'active' })
    for (const [id, role, extra] of [
      [CURRENT, 'teacher', {}],
      [OLD, 'teacher', {}],
      [ADMIN, 'admin', {}],
      [STUDENT, 'student', { accountType: 'institution', teacherIds: [CURRENT, OLD] }]
    ]) {
      await setDoc(doc(db, `users/${id}`), {
        role, status: 'approved', schoolId: 'maxima', deleted: false, ...extra
      })
    }
    await setDoc(doc(db, `classes/step710_current_class`), {
      schoolId: 'maxima', status: 'active', teacherId: CURRENT,
      studentIds: [STUDENT], archived: false
    })
    await setDoc(doc(db, `classes/step710_old_class`), {
      schoolId: 'maxima', status: 'active', teacherId: OLD,
      studentIds: [], archived: false
    })
    await setDoc(doc(db, `schools/maxima/teacherAcademicIndex/${CURRENT}`), {
      schemaVersion: 1, source: 'managed_active_classes',
      teacherId: CURRENT, schoolId: 'maxima', activeStudentIds: [STUDENT]
    })
    await setDoc(doc(db, `schools/maxima/teacherAcademicIndex/${OLD}`), {
      schemaVersion: 1, source: 'managed_active_classes',
      teacherId: OLD, schoolId: 'maxima', activeStudentIds: []
    })
    for (const path of [`writingHomeworks/${WRITING}`, `mockTests/${MOCK}`]) {
      await setDoc(doc(db, path), {
        schoolId: 'maxima', teacherId: CURRENT,
        teacherIds: [OLD, CURRENT], createdBy: OLD, archived: false
      })
    }
    const base = {
      schoolId: 'maxima', uid: STUDENT, studentId: STUDENT,
      teacherId: CURRENT, teacherIds: [OLD, CURRENT],
      submittedAt: '2026-10-20T12:00:00Z'
    }
    await setDoc(doc(db, `writingSubmissions/${SUB}`), {
      ...base, writingId: WRITING, task2Answer: 'SYNTHETIC DEMO DATA', reviewed: false
    })
    await setDoc(doc(db, `mockSubmissions/${MOCKSUB}`), {
      ...base, mockTestId: MOCK, result: { writing: { band: 6 } }
    })
    await setDoc(doc(db, `scores/${SCORE}`), {
      ...base, source: 'mock_test', mockTestId: MOCK, writing: 6
    })
  })
}

before(async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):8081$/,
    'STOP: require local Firestore emulator on port 8081')
  assert.equal(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECT, PROJECT,
    'STOP: only demo-maxima-p0b')
  assert.equal(execFileSync('git', ['branch','--show-current'], { encoding: 'utf8' }).trim(),
    'security/p0b-teacher-access-20261020', 'STOP: wrong branch')
  assert.doesNotThrow(() => execFileSync('git', ['merge-base', '--is-ancestor', '9c7b233', 'HEAD']), 'STOP: required approved 9c7b233 ancestor is missing')
  assert.equal(sha('firestore.rules'), EXPECTED_REAL_RULES_SHA,
    'STOP: production-source Rules file changed; inspect before retesting')
  assert.equal(sha(LAB_PATH), EXPECTED_LAB_SHA, 'STOP: local source candidate differs')
  assert.equal(sha('functions/lib/p0bAcademicMembershipIndex.js'), EXPECTED_INDEX_SHA,
    'STOP: class index module differs from Step701')
  env = await initializeTestEnvironment({ projectId: PROJECT,
    firestore: { host: '127.0.0.1', port: 8081, rules: readFileSync(LAB_PATH, 'utf8') }
  })
})
after(async () => {
  console.log(`STEP710_CLOSURE_SUMMARY DENIED=${seen.length}/11`)
  if (env) await env.cleanup()
})
beforeEach(async () => { await env.clearFirestore(); await seed() })

test('current assigned teacher and admin still have legitimate access', async () => {
  await assertSucceeds(getDoc(ref(CURRENT, `writingSubmissions/${SUB}`)))
  await assertSucceeds(getDoc(ref(CURRENT, `mockSubmissions/${MOCKSUB}`)))
  await assertSucceeds(getDoc(ref(CURRENT, `scores/${SCORE}`)))
  await assertSucceeds(updateDoc(ref(CURRENT, `writingSubmissions/${SUB}`), {
    reviewed: true, reviewedBy: CURRENT
  }))
  const authorizedList = query(collection(dbFor(CURRENT), 'writingSubmissions'),
    where('schoolId', '==', 'maxima'), where('uid', '==', STUDENT),
    where('studentId', '==', STUDENT))
  const result = await assertSucceeds(getDocs(authorizedList))
  assert.deepEqual(result.docs.map(doc => doc.id), [SUB])
  await assertSucceeds(getDoc(ref(ADMIN, `writingSubmissions/${SUB}`)))
  console.log('STEP710_POSITIVE current teacher get/review, canonical list and admin GET ALLOWED')
})

test('stale primary teacherId: four old-teacher paths are denied', async () => {
  await privileged(async db => {
    await updateDoc(doc(db, `writingSubmissions/${SUB}`), { teacherId: OLD })
    await updateDoc(doc(db, `scores/${SCORE}`), { teacherId: OLD })
  })
  await denied('STALE_PRIMARY_WRITING_GET', getDoc(ref(OLD, `writingSubmissions/${SUB}`)))
  await denied('STALE_PRIMARY_SCORE_GET', getDoc(ref(OLD, `scores/${SCORE}`)))
  await denied('STALE_PRIMARY_WRITING_LIST', getDocs(query(
    collection(dbFor(OLD), 'writingSubmissions'),
    where('schoolId', '==', 'maxima'), where('teacherId', '==', OLD)
  )))
  await denied('STALE_PRIMARY_WRITING_REVIEW', updateDoc(ref(OLD, `writingSubmissions/${SUB}`), {
    reviewed: true, reviewedBy: OLD
  }))
  // An authorized current teacher remains able to inspect historic submissions.
  await assertSucceeds(getDoc(ref(CURRENT, `writingSubmissions/${SUB}`)))
})

test('former parent/source creator: four old-teacher paths are denied', async () => {
  await privileged(async db => {
    await updateDoc(doc(db, `writingHomeworks/${WRITING}`), { teacherId: OLD })
    await updateDoc(doc(db, `mockTests/${MOCK}`), { teacherId: OLD })
  })
  await denied('OLD_PARENT_WRITING_GET', getDoc(ref(OLD, `writingSubmissions/${SUB}`)))
  await denied('OLD_PARENT_WRITING_REVIEW', updateDoc(ref(OLD, `writingSubmissions/${SUB}`), {
    reviewed: true, reviewedBy: OLD
  }))
  await denied('OLD_PARENT_MOCK_GET', getDoc(ref(OLD, `mockSubmissions/${MOCKSUB}`)))
  await denied('OLD_PARENT_SCORE_GET', getDoc(ref(OLD, `scores/${SCORE}`)))
})

test('removed from all classes and canonical index: three access paths are denied', async () => {
  await privileged(async db => {
    await updateDoc(doc(db, 'classes/step710_current_class'), { studentIds: [] })
    await updateDoc(doc(db, `schools/maxima/teacherAcademicIndex/${CURRENT}`), {
      activeStudentIds: []
    })
    await updateDoc(doc(db, `users/${STUDENT}`), { teacherIds: [OLD] })
  })
  await denied('NO_CLASS_WRITING_GET', getDoc(ref(CURRENT, `writingSubmissions/${SUB}`)))
  await denied('NO_CLASS_WRITING_REVIEW', updateDoc(ref(CURRENT, `writingSubmissions/${SUB}`), {
    reviewed: true, reviewedBy: CURRENT
  }))
  await denied('NO_CLASS_SCORE_GET', getDoc(ref(CURRENT, `scores/${SCORE}`)))
})

test('all eleven original unauthorized paths were exercised and denied', () => {
  const expected = [
    'STALE_PRIMARY_WRITING_GET', 'STALE_PRIMARY_SCORE_GET',
    'STALE_PRIMARY_WRITING_LIST', 'STALE_PRIMARY_WRITING_REVIEW',
    'OLD_PARENT_WRITING_GET', 'OLD_PARENT_WRITING_REVIEW',
    'OLD_PARENT_MOCK_GET', 'OLD_PARENT_SCORE_GET',
    'NO_CLASS_WRITING_GET', 'NO_CLASS_WRITING_REVIEW', 'NO_CLASS_SCORE_GET'
  ]
  assert.deepEqual([...seen].sort(), [...expected].sort())
  console.log('STEP710_CLOSURE 11/11 historical unauthorized paths denied')
})
