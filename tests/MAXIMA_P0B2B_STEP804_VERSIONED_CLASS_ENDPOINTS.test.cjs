'use strict'
// Step804: offline endpoint-routing and legacy-retirement regressions.
// No Firebase SDK, credentials, network or Production calls.
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const root = join(__dirname, '..')
const server = readFileSync(join(root, 'functions/index.js'), 'utf8')
const client = readFileSync(join(root, 'src/pages/ManageClasses.jsx'), 'utf8')
const gate = readFileSync(join(root, 'functions/lib/p0bManagedClassSecureWriter.js'), 'utf8')
const rules = readFileSync(join(root, 'firestore.rules'), 'utf8')
const legacy = ['saveManagedClass', 'setManagedClassArchived', 'deleteManagedClass']
const versioned = legacy.map(n => n + 'V2')

function count(expr, s) { return (s.match(expr) || []).length }
function v2Body() {
  const start = server.indexOf("exports.saveManagedClassV2 = onCall(")
  const stop = server.indexOf('function normalizeManagedAssignmentSnapshotItems(', start)
  assert.ok(start > 0 && stop > start)
  return server.slice(start, stop)
}

test('three legacy callable exports exist exactly once but are only retired stubs', () => {
  for (const name of legacy) {
    assert.equal(count(new RegExp('^exports\\.' + name + ' = ', 'gm'), server), 1)
    assert.match(server, new RegExp('exports\\.' + name +
      ' = retiredManagedClassEndpoint\\(\\)'))
    assert.doesNotMatch(server, new RegExp('exports\\.' + name +
      ' = onCall\\('))
  }
})

test('all legacy stubs throw before accessing any class or Firestore data', async () => {
  const from = server.indexOf('function retiredManagedClassEndpoint() {')
  const to = server.indexOf('exports.saveManagedClassV2 = onCall(', from)
  assert.ok(from > 0 && to > from)
  const block = server.slice(from, to)
  assert.doesNotMatch(block, /\b(?:db|FieldValue|mutateManagedClassSecure)\b/)
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code } }
  const scope = { exports: {}, onCall: (_opts, handler) => handler, HttpsError }
  vm.runInNewContext(block, scope, { timeout: 1000 })
  for (const name of legacy) {
    for (const auth of [undefined, {uid: 'teacher'}, {uid: 'admin'}]) {
      await assert.rejects(scope.exports[name]({auth, data: {schoolId: 'maxima'}}), e =>
        e.code === 'failed-precondition' && /retired/i.test(e.message))
    }
  }
})

test('three versioned callables are independently exported; no old alias', () => {
  for (const name of versioned) {
    assert.equal(count(new RegExp('^exports\\.' + name + ' = ', 'gm'), server), 1)
    assert.match(server, new RegExp('exports\\.' + name +
      " = onCall\\(\\{ invoker: 'public' \\}, async request => \\{"))
  }
  assert.equal(count(/mutateManagedClassSecure\(\{/g, v2Body()), 3)
  assert.equal(count(/expectedClassUpdateTime:/g, v2Body()), 3)
  assert.equal(count(/actorUid: manager\.uid/g, v2Body()), 3)
})

test('React page calls only versioned names; each exactly once', () => {
  for (const name of versioned) {
    assert.equal(count(new RegExp('httpsCallable\\(functions, [\'\"]' + name +
      '[\'\"]\\)', 'g'), client), 1)
  }
  for (const name of legacy) {
    assert.doesNotMatch(client, new RegExp('httpsCallable\\(functions, [\'\"]' +
      name + '[\'\"]\\)'))
  }
  assert.match(client, /await saveManagedClassCall\(\{/)
  assert.match(client, /await setManagedClassArchivedCall\(\{/)
  assert.match(client, /await deleteManagedClassCall\(\{ classId: classItem\.id \}\)/)
})

test('new callable contract retains required fields and stable success response', () => {
  const body = v2Body()
  assert.match(body, /const studentIds = assertStudentUidList\(data\.studentIds \|\| \[\]\)/)
  assert.match(body, /created: !existing/)
  assert.match(body, /classId: classRef\.id/)
  assert.match(body, /return \{ ok: true, classId, archived \}/)
  assert.match(body, /alreadyDeleted: false/)
  assert.match(body, /preservedSubmissions: true/)
  assert.match(client, /studentIds: cleanedStudentIds/)
})

test('default-deny gate is read in Firestore transaction before class mutations', () => {
  assert.match(gate, /const gateRef = db\.doc\(`schools\/\$\{schoolId\}\/classWriteGate\/\$\{GATE_ID\}`\)/)
  assert.match(gate, /return db\.runTransaction\(async tx => \{/)
  assert.match(gate, /const gateSnap = await tx\.get\(gateRef\)/)
  assert.match(gate, /gate\.phase !== 'open' \|\| gate\.release !== RELEASE/)
  assert.ok(gate.indexOf('await tx.get(gateRef)') < gate.indexOf('tx.set(classRef,'))
})

test('browser cannot edit maintenance gate under shipped Rules', () => {
  assert.match(rules, /match \/schools\/\{schoolId\} \{[\s\S]*?allow read, create, update, delete: if false;/)
  assert.doesNotMatch(rules, /match \/schools\/\{schoolId\}\/classWriteGate/)
  assert.doesNotMatch(rules, /=\*\*/)
})

test('retirement source does not deploy, delete, or alter Firebase configuration', () => {
  const config = readFileSync(join(root, 'firebase.json'), 'utf8')
  assert.deepEqual(JSON.parse(config).functions, {source: 'functions'})
  assert.doesNotMatch(v2Body(), /mutateManagedClassWithIndex\(/)
})
