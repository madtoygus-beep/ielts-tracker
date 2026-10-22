'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8')
const server = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8')
const admin = fs.readFileSync(path.join(root, 'src/pages/AdminDashboard.jsx'), 'utf8')
const resultCollections = ['scores','readingSubmissions','listeningSubmissions','writingSubmissions','mockSubmissions','vocabularySubmissions']
function ruleFor(name) {
  const a = rules.indexOf('match /' + name + '/{')
  assert.ok(a > 0, 'Missing rules for '+name)
  return rules.slice(a, rules.indexOf('\n    }', a) + 6)
}

test('01 approved-user includes archived and permanent-delete guards', () => {
  const auth = rules.slice(rules.indexOf('function isApprovedUser()'), rules.indexOf('function isOwner(uid)'))
  assert.match(auth, /get\('archived', false\) != true/)
  assert.match(auth, /get\('permanentDeleteInProgress', false\) != true/)
})
test('02 server student Callable rejects archived and deleting profiles', () => {
  const s = server.slice(server.indexOf('async function requireStudent('), server.indexOf('function accessContentConfigFor('))
  assert.match(s, /profile\.archived === true/)
  assert.match(s, /profile\.permanentDeleteInProgress === true/)
  assert.match(s, /requireActiveSchoolForProfile/)
})
test('03 six result collections preserve teacher review and narrow admin metadata writes', () => {
  for (const name of resultCollections) {
    const block=ruleFor(name)
    assert.match(block,/adminResultArchiveOnly\(\)/,name)
    assert.doesNotMatch(block,/allow create: if isAdmin\(\)/,name)
    assert.doesNotMatch(block,/allow update: if isAdmin\(\)/,name)
    if(name==='writingSubmissions') { assert.match(block,/allow update: if adminResultArchiveOnly\(\);/); assert.doesNotMatch(block,/teacherWritingReviewOnly\(\)/) }
    if(name==='scores') assert.match(block,/teacherCan(Update|Create)AcademicScore/)
  }
})
test('04 admin update lists only archived metadata and checks G1 gate', () => {
  const helper=rules.slice(rules.indexOf('function adminResultArchiveOnly()'),rules.indexOf('// P0-B2B: server-owned class index'))
  assert.match(helper,/changed\.hasOnly\(\['archived', 'archivedAt', 'restoredAt', 'updatedAt'\]\)/)
  assert.match(helper,/schemaVersion/)
  assert.match(helper,/classWriteGate\/p0b2b/)
  assert.match(helper,/phase.*'open'/)
  assert.match(helper,/p0b2b-class-writer-v1/)
  assert.match(helper,/resource\.data\.get\('studentId'/)
})
test('05 admin browser cannot edit mock grade directly', () => {
  assert.doesNotMatch(admin, /updateDoc\(doc\(db, 'scores', editScore\.id\)/)
  assert.doesNotMatch(admin, /onClick=\{\(\) => handleEditScore\(s\)\}/)
  assert.match(admin,/Teacher review only/)
})
test('06 archive and restore UI remain present', () => {
  for(const v of ['Hide mock results','Restore mock results','Hide homework','Restore homework'])
    assert.ok(admin.includes(v),v)
  assert.match(admin,/updateResultDocumentsByStudent\(/)
})
test('07 admin login checks both account lifecycle fields', () => {
  const start=admin.indexOf('const unsubAuth = onAuthStateChanged')
  const login=admin.slice(start,admin.indexOf('setAdminSchoolId',start))
  assert.match(login,/profile\.archived === true/)
  assert.match(login,/profile\.permanentDeleteInProgress === true/)
})
test('08 no server deployed or Cloud calls in test source', () => {
  assert.doesNotMatch(fs.readFileSync(__filename,'utf8'),/execFileSync\(['"](?:gcloud|firebase|vercel)['"]/)
})
