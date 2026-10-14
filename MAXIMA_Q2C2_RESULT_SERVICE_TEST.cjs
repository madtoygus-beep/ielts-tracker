'use strict';
/*
 * Q2C-2 offline server-boundary tests. Extracts ACTUAL new callable source
 * from functions/index.js, then runs it with in-memory Firebase Admin stubs.
 * NO production access, NO Firebase SDK / emulator required.
 * This is NOT a substitute for Firebase emulator and production smoke tests.
 * Run: node MAXIMA_Q2C2_RESULT_SERVICE_TEST.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'functions/index.js'), 'utf8');
const begin = source.indexOf('const VISIBLE_STUDENT_RESULT_COLLECTIONS = Object.freeze({');
const end = source.indexOf('// Q2B: Learner-only historical attempt summaries.', begin);
if (begin < 0 || end <= begin) throw new Error('Q2C-2 callable markers missing.');
const serviceCode = source.slice(begin, end);

const config = {
  reading: { contentType: 'reading', sourceCollection: 'readings', submissionCollection: 'readingSubmissions', parentFields: ['readingId'] },
  listening: { contentType: 'listening', sourceCollection: 'listenings', submissionCollection: 'listeningSubmissions', parentFields: ['listeningId'] },
  writing: { contentType: 'writing', sourceCollection: 'writingHomeworks', submissionCollection: 'writingSubmissions', parentFields: ['writingId'] },
  vocabulary: { contentType: 'vocabulary', sourceCollection: 'vocabularyTests', submissionCollection: 'vocabularySubmissions', parentFields: ['vocabularyTestId', 'vocabularyId', 'testId', 'homeworkId'] },
  mock: { contentType: 'mock', sourceCollection: 'mockTests', submissionCollection: 'mockSubmissions', parentFields: ['mockTestId'] }
};
const store = new Map();
const controls = new Set();
const uid = 'q2c2-learner';
const schoolId = 'maxima';
const subscriptions = Object.keys(config);
function set(collection, id, data) { store.set(`${collection}/${id}`, structuredClone(data)); }
function snap(key) {
  const data = store.get(key);
  return { id: key.split('/').at(-1), exists: Boolean(data), data: () => data ? structuredClone(data) : undefined };
}
function collectionReader(collectionName, clauses = []) {
  return {
    where(field, operator, value) {
      if (operator !== '==') throw new Error('Unexpected query operator');
      return collectionReader(collectionName, [...clauses, { field, value }]);
    },
    async get() {
      const prefix = `${collectionName}/`;
      const docs = [...store.keys()].filter(key => key.startsWith(prefix)).map(snap)
        .filter(docSnap => clauses.every(({ field, value }) => docSnap.data()?.[field] === value));
      return { docs };
    }
  };
}
const db = {
  collection: (name) => collectionReader(name),
  doc: key => ({ key, async get() { return snap(key); } }),
  async getAll(...refs) { return refs.map(ref => snap(ref.key)); }
};
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const sandbox = {
  exports: {},
  db,
  SUBMISSION_CONTENT_CONFIG: config,
  onCall: handler => handler,
  HttpsError,
  requireStudent: async request => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in');
    const user = store.get(`users/${request.auth.uid}`);
    if (!user || user.role !== 'student' || user.status !== 'approved' || user.deleted) {
      throw new HttpsError('permission-denied', 'Student profile invalid');
    }
    if (store.get(`schools/${user.schoolId}`)?.status !== 'active') {
      throw new HttpsError('permission-denied', 'School inactive');
    }
    return { uid: request.auth.uid, schoolId: user.schoolId, profile: user };
  },
  submissionContentConfigFor: type => {
    if (!Object.prototype.hasOwnProperty.call(config, type)) {
      throw new HttpsError('invalid-argument', 'Invalid type');
    }
    return config[type];
  },
  assertDocumentId: value => {
    if (typeof value !== 'string' || !value || value.includes('/')) {
      throw new HttpsError('invalid-argument', 'Invalid ID');
    }
    return value;
  },
  requireStudentAttemptSource: async (student, conf, id) => {
    const source = store.get(`${conf.sourceCollection}/${id}`);
    const access = store.get(`studentAccess/${student.uid}_${conf.contentType}_${id}`);
    if (!source || !access || source.archived === true ||
        access.adminHidden === true || access.status !== 'active' ||
        access.accessType !== 'assignment' || access.uid !== student.uid ||
        access.sourceCollection !== conf.sourceCollection ||
        access.contentId !== id || source.schoolId !== student.schoolId ||
        access.schoolId !== student.schoolId) {
      throw new HttpsError('permission-denied', 'No active authorized assignment');
    }
    return { id, ...source };
  },
  getOpenSubmissionAttemptControl: async (conf, studentUid, id) =>
    controls.has(`${conf.contentType}:${studentUid}:${id}`) ? { data: { status: 'open' } } : null,
  submissionMatchesContent: (conf, data, id) => conf.parentFields.some(field => data[field] === id),
  submissionHasMeaningfulAnswers: (conf, data) => Boolean(
    (conf.contentType === 'writing' ? data.task1Answer || data.task2Answer :
      conf.contentType === 'mock' ? data.listeningAnswers || data.readingAnswers || data.writingAnswers : data.answers)
  ),
  uniqueStrings: values => [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))],
  schoolIdOf: value => value?.schoolId || 'maxima',
  safeString: (value, len = 5000) => String(value || '').slice(0, len),
  toPlain: value => structuredClone(value)
};
vm.runInNewContext(serviceCode, sandbox, { filename: 'functions/index.js:Q2C2' });
const call = sandbox.exports.getStudentVisibleResults;

set('users', uid, { role: 'student', status: 'approved', schoolId });
set('users', 'outsider', { role: 'student', status: 'approved', schoolId: 'other' });
set('users', 'pending', { role: 'student', status: 'pending', schoolId });
set('schools', schoolId, { status: 'active' });
set('schools', 'other', { status: 'active' });

for (const type of subscriptions) {
  const conf = config[type];
  for (const suffix of ['active', 'archived', 'hidden', 'unassigned', 'foreign']) {
    const id = `${type}-${suffix}`;
    set(conf.sourceCollection, id, {
      schoolId: suffix === 'foreign' ? 'other' : schoolId,
      archived: suffix === 'archived', title: id
    });
    if (suffix !== 'unassigned') {
      set('studentAccess', `${uid}_${type}_${id}`, {
        uid, schoolId, contentType: type, contentId: id,
        sourceCollection: conf.sourceCollection, accessType: 'assignment',
        status: 'active', adminHidden: suffix === 'hidden'
      });
    }
    set(conf.submissionCollection, `${uid}-${type}-${suffix}`, {
      uid, studentId: uid, schoolId, [conf.parentFields[0]]: id,
      submittedAt: '2026-10-14T00:00:00.000Z',
      answers: { secret: 'STUDENT_SAVED_ANSWER' },
      task1Answer: 'This is the learner writing',
      task2Answer: 'Second task text',
      result: {
        correct: 8, total: 10, band: 6.5,
        perQuestionCorrectAnswer: 'SECRET_ANSWER_KEY',
        writing: { status: 'reviewed', review: { overall: 7, task1Feedback: 'Nice structure' } }
      },
      review: { overall: 7, rubric: { coherence: { task1: 7 } } },
      excludedFromStats: type === 'reading'
    });
  }
}
for (const suffix of ['active','archived','hidden','unassigned','foreign']) {
  set('scores', `score-${suffix}`, {
    uid, studentId: uid, schoolId,
    mockTestId: `mock-${suffix}`, source: 'mock_test',
    overall: '7.0', date: '2026-10-14',
    writing: { answers: 'MUST_NOT_LEAK' },
    answers: { private: true }
  });
}
// Legacy row with a different uid MUST be skipped even if studentId is correct.
set('readingSubmissions', 'poisoned-owner', {
  uid: 'outsider', studentId: uid, schoolId, readingId: 'reading-active',
  answers: { secret: 'OTHER_STUDENT' }
});
// Other school's result, even if it matches the signed-in uid.
set('readingSubmissions', 'poisoned-school', {
  uid, studentId: uid, schoolId: 'other', readingId: 'reading-active'
});

let passed=0;
async function check(name, run) {
  try {
    await run();
    console.log('PASS', name);
    passed++;
  } catch (error) {
    console.error('FAIL', name, error?.stack || String(error));
    process.exitCode = 1;
  }
}
async function denies(name, request, errorCode) {
  await check(name, async () => {
    await assert.rejects(call(request), e => e?.code === errorCode);
  });
}
async function main() {
  const summaryRequest = { auth: { uid }, data: { mode: 'summary' } };
  let summary;
  await check('Summary authorized school student', async () => {
    summary = await call(summaryRequest);
    assert.equal(summary.ok, true);
  });
  for (const type of subscriptions) {
    const collectionName = config[type].submissionCollection;
    await check(`${type} only live assigned result is returned`, () => {
      const entries = summary.byCollection[collectionName];
      assert.equal(entries.length, 1);
      assert.equal(entries[0][config[type].parentFields[0]], `${type}-active`);
      assert.equal(entries[0].result.correct, 8);
      assert.equal(entries[0].result.band, 6.5);
      assert.equal('answers' in entries[0], false);
      assert.equal('task1Answer' in entries[0], false);
      assert.equal('perQuestionCorrectAnswer' in entries[0].result, false);
    });
  }
  await check('Mock score only live, scalar fields only', () => {
    assert.equal(summary.byCollection.scores.length, 1);
    const score = summary.byCollection.scores[0];
    assert.equal(score.overall, '7.0');
    assert.equal('writing' in score, false);
    assert.equal('answers' in score, false);
  });
  await check('Excluded statistics flag preserved', () => {
    assert.equal(summary.byCollection.readingSubmissions[0].excludedFromStats, true);
  });
  await check('Mock nested grade and teacher feedback kept without solutions', () => {
    const result = summary.byCollection.mockSubmissions[0].result;
    assert.equal(result.writing.review.overall, 7);
    assert.equal(result.writing.review.task1Feedback, 'Nice structure');
    assert.equal('perQuestionCorrectAnswer' in result, false);
  });
  for (const suffix of ['archived','hidden','unassigned','foreign']) {
    await denies(`No detail for ${suffix} Reading`, {
      auth: { uid }, data: { mode: 'detail', contentType: 'reading', contentId: `reading-${suffix}` }
    }, 'permission-denied');
  }
  await check('One submitted Reading detail includes own answers', async () => {
    const response = await call({ auth: { uid }, data: {
      mode: 'detail', contentType: 'reading', contentId: 'reading-active'
    }});
    assert.equal(response.items.length, 1);
    assert.equal(response.items[0].answers.secret, 'STUDENT_SAVED_ANSWER');
    assert.equal(response.items[0].result.correct, 8);
  });
  controls.add(`reading:${uid}:reading-active`);
  await denies('Open retake blocks old details/answers', {
    auth: { uid }, data: { mode: 'detail', contentType: 'reading', contentId: 'reading-active' }
  }, 'failed-precondition');
  await check('Open retake still allows answer-free dashboard summary', async () => {
    const response = await call(summaryRequest);
    assert.equal(response.byCollection.readingSubmissions.length, 1);
    assert.equal('answers' in response.byCollection.readingSubmissions[0], false);
  });
  await denies('Cannot request arbitrary type', {
    auth: { uid }, data: { mode: 'detail', contentType: 'other', contentId: 'reading-active' }
  }, 'invalid-argument');
  await denies('Cannot pass content filter to summary', {
    auth: { uid }, data: { mode: 'summary', contentType: 'reading' }
  }, 'invalid-argument');
  await denies('Cannot request scores in detail', {
    auth: { uid }, data: { mode: 'detail', contentType: 'scores', contentId: 'mock-active' }
  }, 'invalid-argument');
  await denies('Unsigned call rejected', { data: { mode: 'summary' } }, 'unauthenticated');
  await denies('Unapproved account rejected', { auth: { uid: 'pending' }, data: {} }, 'permission-denied');
  await check('Archive live source revokes summary immediately', async () => {
    const sourceRef = 'readings/reading-active';
    const before = store.get(sourceRef);
    store.set(sourceRef, { ...before, archived: true });
    const response = await call(summaryRequest);
    assert.equal(response.byCollection.readingSubmissions.length, 0);
    store.set(sourceRef, before);
  });
  await check('Admin hide revokes summary immediately', async () => {
    const ref = `studentAccess/${uid}_reading_reading-active`;
    const before = store.get(ref);
    store.set(ref, { ...before, adminHidden: true });
    const response = await call(summaryRequest);
    assert.equal(response.byCollection.readingSubmissions.length, 0);
    store.set(ref, before);
  });
  console.log(`\nQ2C2 offline read service: ${passed} PASS`);
}
main().catch(e => { console.error(e?.stack || String(e)); process.exitCode = 1; });
