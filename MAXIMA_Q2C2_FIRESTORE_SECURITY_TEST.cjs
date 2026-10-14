'use strict';
/*
 * MAXIMA Q2C-2: browser result-read isolation regression suite.
 * LOCAL FIRESTORE EMULATOR ONLY. It cannot touch production.
 * Run from the Mac's real project folder AFTER installing test dependencies:
 * npx firebase-tools emulators:exec --only firestore --project demo-maxima-tracker "node MAXIMA_Q2C2_FIRESTORE_SECURITY_TEST.cjs"
 * Even an ACTIVE assignment must NOT allow direct Firestore submission/scores
 * GET or LIST. The Cloud Function getStudentVisibleResults mediates reads.
 */
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, updateDoc, getDocs, query, where, collection
} = require('firebase/firestore');

const projectId = 'demo-maxima-tracker';
const STUDENT = 'q2c2-student';
const OTHER_STUDENT = 'q2c2-other-student';
const TEACHER = 'q2c2-teacher';
const OTHER_TEACHER = 'q2c2-other-teacher';
const ADMIN = 'q2c2-admin';
const FOREIGN = 'q2c2-foreign-student';

const cases = [
  { category: 'reading', collectionName: 'readingSubmissions', source: 'readings', field: 'readingId' },
  { category: 'listening', collectionName: 'listeningSubmissions', source: 'listenings', field: 'listeningId' },
  { category: 'writing', collectionName: 'writingSubmissions', source: 'writingHomeworks', field: 'writingId' },
  { category: 'vocabulary', collectionName: 'vocabularySubmissions', source: 'vocabularyTests', field: 'vocabularyTestId' },
  { category: 'mock', collectionName: 'mockSubmissions', source: 'mockTests', field: 'mockTestId' },
  { category: 'scores', collectionName: 'scores', source: 'mockTests', field: 'mockTestId' }
];

const ids = (category, suffix) => ({
  source: `q2c2-${category === 'scores' ? 'mock' : category}-${suffix}`,
  result: `q2c2-${category}-result-${suffix}`
});

const checks = [];
function test(label, action) { checks.push({ label, action }); }

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('SAFETY STOP: FIRESTORE_EMULATOR_HOST missing. NEVER run against production.');
  }
  const rules = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8');
  const env = await initializeTestEnvironment({ projectId, firestore: { rules } });
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'schools', 'maxima'), { status: 'active' });
      await setDoc(doc(db, 'schools', 'another-school'), { status: 'active' });
      for (const [uid, role, schoolId] of [
        [STUDENT, 'student', 'maxima'], [OTHER_STUDENT, 'student', 'maxima'],
        [TEACHER, 'teacher', 'maxima'], [OTHER_TEACHER, 'teacher', 'maxima'],
        [ADMIN, 'admin', 'maxima'], [FOREIGN, 'student', 'another-school']
      ]) {
        await setDoc(doc(db, 'users', uid), {
          role, status: 'approved', schoolId, deleted: false,
          teacherIds: role === 'student' ? [TEACHER] : []
        });
      }

      for (const item of cases) {
        for (const suffix of ['active', 'archived', 'hidden', 'unassigned']) {
          const id = ids(item.category, suffix);
          const sourceData = {
            archived: suffix === 'archived', schoolId: 'maxima',
            teacherId: TEACHER, teacherIds: [TEACHER], createdBy: TEACHER,
            title: `Q2C2 ${item.category} ${suffix}`
          };
          await setDoc(doc(db, item.source, id.source), sourceData);
          const isScore = item.category === 'scores';
          const resultData = {
            uid: STUDENT, studentId: STUDENT, schoolId: 'maxima',
            teacherId: TEACHER, teacherIds: [TEACHER], createdBy: TEACHER,
            [item.field]: id.source,
            archived: false, submittedAt: '2026-10-14T02:00:00.000Z',
            source: isScore ? 'mock_test' : 'student',
            result: { correct: 7, total: 10 },
            answers: { one: 'PRIVATE_STUDENT_ANSWER' }
          };
          await setDoc(doc(db, item.collectionName, id.result), resultData);
          if (suffix !== 'unassigned') {
            const type = isScore ? 'mock' : item.category;
            await setDoc(doc(db, 'studentAccess', `${STUDENT}_${type}_${id.source}`), {
              uid: STUDENT, studentId: STUDENT, contentType: type,
              contentId: id.source, sourceCollection: item.source,
              accessType: 'assignment', status: 'active', schoolId: 'maxima',
              adminHidden: suffix === 'hidden'
            });
          }
        }
      }
    });

    const student = env.authenticatedContext(STUDENT).firestore();
    const otherStudent = env.authenticatedContext(OTHER_STUDENT).firestore();
    const teacher = env.authenticatedContext(TEACHER).firestore();
    const otherTeacher = env.authenticatedContext(OTHER_TEACHER).firestore();
    const admin = env.authenticatedContext(ADMIN).firestore();
    const foreignStudent = env.authenticatedContext(FOREIGN).firestore();
    const guest = env.unauthenticatedContext().firestore();

    for (const item of cases) {
      const name = item.collectionName;
      for (const suffix of ['active', 'archived', 'hidden', 'unassigned']) {
        const resultId = ids(item.category, suffix).result;
        test(`${name} own ${suffix}: student GET DENIED`, () =>
          assertFails(getDoc(doc(student, name, resultId))));
        test(`${name} own ${suffix}: teacher GET ALLOWED`, () =>
          assertSucceeds(getDoc(doc(teacher, name, resultId))));
      }
      const activeId = ids(item.category, 'active').result;
      test(`${name}: own uid QUERY DENIED`, () =>
        assertFails(getDocs(query(collection(student, name), where('uid', '==', STUDENT)))));
      test(`${name}: own studentId QUERY DENIED`, () =>
        assertFails(getDocs(query(collection(student, name), where('studentId', '==', STUDENT)))));
      test(`${name}: entire collection LIST DENIED`, () =>
        assertFails(getDocs(collection(student, name))));
      test(`${name}: other student GET DENIED`, () =>
        assertFails(getDoc(doc(otherStudent, name, activeId))));
      test(`${name}: other school student GET DENIED`, () =>
        assertFails(getDoc(doc(foreignStudent, name, activeId))));
      test(`${name}: other teacher without parent ownership GET DENIED`, () =>
        assertFails(getDoc(doc(otherTeacher, name, activeId))));
      test(`${name}: anon GET DENIED`, () =>
        assertFails(getDoc(doc(guest, name, activeId))));
      test(`${name}: admin GET ALLOWED`, () =>
        assertSucceeds(getDoc(doc(admin, name, activeId))));
      test(`${name}: admin LIST ALLOWED`, () =>
        assertSucceeds(getDocs(collection(admin, name))));
      test(`${name}: teacher existing result moderation allowed`, () =>
        assertSucceeds(updateDoc(doc(teacher, name, activeId), { reviewedAt: '2026-10-14T02:20:00.000Z' })));
      test(`${name}: student direct DELETE DENIED`, async () => {
        const { deleteDoc } = require('firebase/firestore');
        await assertFails(deleteDoc(doc(student, name, activeId)));
      });
    }

    let passed = 0;
    let failed = 0;
    for (const { label, action } of checks) {
      try {
        await action();
        console.log('PASS', label);
        passed++;
      } catch (error) {
        console.error('FAIL', label, String(error?.message || error));
        failed++;
      }
    }
    console.log(`\nQ2C2 emulator rules: ${passed}/${checks.length} PASS; ${failed} FAIL`);
    if (failed) process.exitCode = 1;
  } finally {
    await env.cleanup();
  }
}

main().catch(error => {
  console.error('Q2C2 emulator could not start:', error?.stack || String(error));
  process.exitCode = 1;
});
