'use strict';
/*
 * MAXIMA Q1B - Firestore Emulator security regression tests.
 * Runs ONLY against local Firebase Emulator. NO live Firebase access.
 * Usage from the project root:
 *   npx --yes firebase-tools emulators:exec --only firestore --project demo-maxima-tracker "node MAXIMA_Q1B_FIRESTORE_SECURITY_TEST.cjs"
 * Requires @firebase/rules-unit-testing@5.0.2 and firebase@12.x.
 */

const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, deleteDoc, updateDoc } = require('firebase/firestore');

const PROJECT_ID = 'demo-maxima-tracker';
const collections = [
  ['scores', 'q1b-score', 'score'],
  ['readings', 'q1b-reading', 'source'],
  ['readingSubmissions', 'q1b-reading-submission', 'submission'],
  ['listenings', 'q1b-listening', 'source'],
  ['listeningSubmissions', 'q1b-listening-submission', 'submission'],
  ['writingHomeworks', 'q1b-writing', 'source'],
  ['writingSubmissions', 'q1b-writing-submission', 'submission'],
  ['mockTests', 'q1b-mock', 'source'],
  ['mockSubmissions', 'q1b-mock-submission', 'submission'],
  ['vocabularyTests', 'q1b-vocab', 'source'],
  ['vocabularySubmissions', 'q1b-vocab-submission', 'submission'],
];
const sourceIds = {
  readingId: 'q1b-reading',
  listeningId: 'q1b-listening',
  writingId: 'q1b-writing',
  mockTestId: 'q1b-mock',
  vocabularyTestId: 'q1b-vocab',
};
const allChecks = [];
function expectResult(label, action) {
  allChecks.push({label, action});
}

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('GUVENLIK: FIRESTORE_EMULATOR_HOST yok. Testi yalnizca Firebase emulators:exec icinde calistirin.');
  }
  const rulesPath = path.join(process.cwd(), 'firestore.rules');
  if (!fs.existsSync(rulesPath)) throw new Error('firestore.rules bulunamadi; komutu proje klasorunden calistirin.');
  const rules = fs.readFileSync(rulesPath, 'utf8');
  for (const [name] of collections) {
    const matched = rules.match(new RegExp('match\\s+/' + name + '/\\{[^}]+\\}\\s*\\{([\\s\\S]*?)(?=\\n\\s*match\\s+|\\n\\s*function\\s+|\\n\\s*//\\s*={20,}|$)'));
    if (!matched || !/allow\s+delete\s*:\s*if\s+false\s*;/.test(matched[1])) {
      throw new Error('Beklenen sunucu-disinda-silme yasagi eksik veya farkli: ' + name);
    }
  }
  console.log('11 koleksiyonda Q1B-B allow delete: if false bulgulandi.');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules },
  });
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      const users = [
        ['q1b-admin', {role:'admin',status:'approved',schoolId:'maxima',deleted:false}],
        ['q1b-teacher', {role:'teacher',status:'approved',schoolId:'maxima',deleted:false}],
        ['q1b-student', {role:'student',status:'approved',schoolId:'maxima',deleted:false,teacherIds:['q1b-teacher']}],
      ];
      await setDoc(doc(db, 'schools', 'maxima'), {status:'active'});
      for (const [uid, user] of users) await setDoc(doc(db, 'users', uid), user);
      for (const [col, id, kind] of collections) {
        const base = {
          schoolId:'maxima',
          teacherId:'q1b-teacher',teacherIds:['q1b-teacher'],createdBy:'q1b-teacher',
          uid:'q1b-student',studentId:'q1b-student',
          archived:true, ...sourceIds,
          marker:'safe-test-data-only',
        };
        await setDoc(doc(db,col,id), kind==='source' ? {...base, title:'SAFE TEST'} :
          kind==='score' ? {...base, source:'mock_test'} : {...base, status:'submitted'});
      }
    });

    const contexts = [
      ['admin',env.authenticatedContext('q1b-admin')],
      ['teacher',env.authenticatedContext('q1b-teacher')],
      ['student',env.authenticatedContext('q1b-student')],
      ['anonymous',env.unauthenticatedContext()],
    ];

    for (const [role, ctx] of contexts) {
      const db = ctx.firestore();
      for (const [col,id] of collections) {
        expectResult(role+' / '+col+' / direct-delete DENIED', async () => {
          await assertFails(deleteDoc(doc(db,col,id)));
        });
      }
    }

    const adminDB = contexts[0][1].firestore();
    const teacherDB = contexts[1][1].firestore();
    const studentDB = contexts[2][1].firestore();
    for (const [col,id] of collections) {
      expectResult('admin / '+col+' / read ALLOWED', async () => {
        const result = await assertSucceeds(getDoc(doc(adminDB,col,id)));
        if (!result.exists()) throw new Error('Silme engellendi ama test kaydi yok: '+col);
      });
      expectResult('teacher / '+col+' / owner read ALLOWED', async () => {
        const result = await assertSucceeds(getDoc(doc(teacherDB,col,id)));
        if (!result.exists()) throw new Error('Teacher beklenen test kaydini okumadi: '+col);
      });
      if (col.endsWith('Submissions') || col === 'scores') {
        expectResult('student / '+col+' / own direct-read DENIED', () =>
          assertFails(getDoc(doc(studentDB,col,id)))
        );
      }
    }
    // Existing safe admin/teacher edits remain available; moderation fields remain protected.
    expectResult('teacher / owned reading archive UPDATE ALLOWED', () => assertSucceeds(
      updateDoc(doc(teacherDB,'readings','q1b-reading'),{archived:false})
    ));
    expectResult('admin / standard submission UPDATE ALLOWED', () => assertSucceeds(
      updateDoc(doc(adminDB,'readingSubmissions','q1b-reading-submission'),{marker:'still-editable'})
    ));
    expectResult('admin / statistics tampering UPDATE DENIED', () => assertFails(
      updateDoc(doc(adminDB,'readingSubmissions','q1b-reading-submission'),{excludedFromStats:true})
    ));
    expectResult('teacher / score statistics tampering UPDATE DENIED', () => assertFails(
      updateDoc(doc(teacherDB,'scores','q1b-score'),{excludedFromStats:true})
    ));

    let passed=0,failed=0;
    for (const {label,action} of allChecks) {
      try {await action(); console.log('PASS '+label); passed++;}
      catch (err) {console.error('FAIL '+label+' : '+String(err?.message||err)); failed++;}
    }
    console.log(`\nQ1B Firestore Emulator sonucu: ${passed}/${allChecks.length} PASS, ${failed} FAIL`);
    if (failed) process.exitCode=1;
  } finally {
    await env.cleanup();
  }
}
main().catch(err=>{console.error('TEST BASLATILAMADI: '+String(err?.stack||err));process.exitCode=1});
