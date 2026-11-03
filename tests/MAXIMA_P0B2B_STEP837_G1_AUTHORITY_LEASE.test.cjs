'use strict'
// Step837: local-only cutover admission lease and explicit quarantine checks.
// In-memory transaction simulation, no Firebase SDK, secrets or network calls.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  withG1AuthorityLease,
  OPERATION_SET,
  QUARANTINED_OPERATIONS
} = require('../functions/lib/p0bG1AuthorityLease')
const { RELEASE, GATE_ID } = require('../functions/lib/p0bManagedClassSecureWriter')

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const FieldValue = { serverTimestamp: () => '__SERVER_TIMESTAMP__' }
const S = 'maxima'
const G = `schools/${S}/classWriteGate/${GATE_ID}`
const allowed = () => ({ schemaVersion: 1, release: RELEASE, phase: 'open' })

function fixture(gate = allowed()) {
  const entries = new Map()
  let version = 0
  let beforeCommit = () => {}
  let failDelete = false
  let txCount = 0
  if (gate) entries.set(G, { data: gate, v: ++version })
  entries.set('users/admin837', { data: { role: 'admin', status: 'approved' }, v: ++version })
  const ref = p => ({
    path: p,
    async delete() {
      if (failDelete) throw new Error('lease cleanup failed')
      if (entries.delete(p)) version++
    }
  })
  const db = {
    doc: ref,
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 2; attempt++) {
        txCount++
        const reads = new Map()
        const creates = []
        const tx = {
          async get(r) {
            const entry = entries.get(r.path)
            reads.set(r.path, entry?.v ?? 0)
            return { exists: Boolean(entry), data: () => entry?.data }
          },
          create(r, data) { creates.push([r.path, data]) }
        }
        const result = await fn(tx)
        beforeCommit(); beforeCommit = () => {}
        const conflicted = [...reads].some(([p, v]) => (entries.get(p)?.v ?? 0) !== v)
        if (conflicted) continue
        for (const [p, data] of creates) {
          assert.ok(!entries.has(p), 'document already exists')
          entries.set(p, { data, v: ++version })
        }
        return result
      }
      throw new Error('transaction retries exhausted')
    }
  }
  const run = (operation, work = async () => 'done', schoolId = S) =>
    withG1AuthorityLease({db, FieldValue, HttpsError, actorUid:'admin837', schoolId, operation}, work)
  return {
    entries, run, get transactionCount() { return txCount },
    leases: () => [...entries.keys()].filter(k => k.includes('/classAuthorityOperations/')),
    setGate(value) {
      if (value) entries.set(G, { data: value, v: ++version })
      else { entries.delete(G); ++version }
    },
    onBeforeCommit(fn) { beforeCommit = fn },
    failLeaseDelete() { failDelete = true }
  }
}
const denied = (promise, code = 'failed-precondition') =>
  assert.rejects(promise, error => error instanceof HttpsError && error.code === code)

test('all 10 institutional authority mutation exports are tracked', () => {
  assert.equal(OPERATION_SET.size, 10)
  assert.equal(QUARANTINED_OPERATIONS.size, 3)
  const source = fs.readFileSync(path.join(__dirname, '../functions/index.js'), 'utf8')
  assert.equal((source.match(/return withG1AuthorityLease\(/g) || []).length, 10)
  for (const name of OPERATION_SET) {
    const start = source.indexOf(`exports.${name} = onCall(`)
    assert.ok(start > 0, `${name} present`)
    const close = source.indexOf('\n})', start)
    assert.ok(close > start, `${name} body ends`)
    const body = source.slice(start, close)
    assert.match(body, new RegExp("operation: '" + name + "'"))
    assert.equal((body.match(/return withG1AuthorityLease\(/g) || []).length, 1)
    assert.ok(body.indexOf('return withG1AuthorityLease(') < body.search(/(?:await userRef\.set\(|await db\.runTransaction\(|await adminAuth\.createUser\(|await adminAuth\.updateUser\(|await adminAuth\.deleteUser\(|await batch\.commit\(|await schoolRef\.delete\()/),
      `${name} admission precedes direct mutations`)
  }
})

test('gate missing, closed, wrong release or malformed: deny without side effects', async () => {
  for (const gate of [null, {...allowed(), phase:'frozen'}, {...allowed(), phase:'closed'},
    {...allowed(), release:'wrong'}, {...allowed(), schemaVersion:2}]) {
    const f = fixture(gate)
    let entered = false
    await denied(f.run('createManagedUser', async () => { entered = true }))
    assert.equal(entered, false)
    assert.deepEqual(f.leases(), [])
  }
})

test('open gate creates durable lease BEFORE callback and cleans AFTER callback', async () => {
  const f = fixture()
  let sawLease = false
  const result = await f.run('restoreManagedUser', async () => {
    sawLease = f.leases().length === 1
    const doc = f.entries.get(f.leases()[0]).data
    assert.equal(doc.operation, 'restoreManagedUser')
    assert.equal(doc.actorUid, 'admin837')
    assert.equal(doc.schoolId, S)
    return 123
  })
  assert.equal(result, 123)
  assert.ok(sawLease)
  assert.deepEqual(f.leases(), [])
})

test('exception releases lease; cleanup failure remains observable/fail closed', async () => {
  const f = fixture()
  await assert.rejects(f.run('deleteManagedUser', async () => { throw Error('business failure') }),
    /business failure/)
  assert.deepEqual(f.leases(), [])
  f.failLeaseDelete()
  await assert.rejects(f.run('deleteManagedUser'), /lease cleanup failed/)
  assert.equal(f.leases().length, 1)
})

test('stale admin role or archived actor fails inside admission transaction', async () => {
  for (const actor of [{role:'teacher',status:'approved'},
    {role:'admin',status:'pending'}, {role:'admin',status:'approved',deleted:true}]) {
    const f = fixture()
    f.entries.set('users/admin837', { data: actor, v: 999 })
    let entered = false
    await denied(f.run('restoreManagedUser', async () => { entered = true }), 'permission-denied')
    assert.equal(entered, false)
    assert.deepEqual(f.leases(), [])
  }
})

test('permanent deletion remains blocked for B2C users because cleanup scans global classes', async () => {
  for (const schoolId of ['__individual__','__platform__']) {
    const f = fixture(null)
    await denied(f.run('permanentlyDeleteManagedUser', async () => { throw Error('unsafe') }, schoolId))
    assert.equal(f.transactionCount, 0)
  }
})

test('freeze between gate read and transaction commit triggers recheck and blocks admission', async () => {
  const f = fixture()
  let entered = false
  f.onBeforeCommit(() => f.setGate({...allowed(), phase:'frozen'}))
  await denied(f.run('approveManagedUser', async () => { entered = true }))
  assert.equal(entered, false)
  assert.deepEqual(f.leases(), [])
  assert.equal(f.transactionCount, 2)
})

test('freeze after admission observes outstanding lease until callback finishes', async () => {
  const f = fixture()
  let finish
  const holding = new Promise(resolve => { finish = resolve })
  let admitted
  const signalled = new Promise(resolve => { admitted = resolve })
  const op = f.run('saveManagedSchool', async () => { admitted(); await holding })
  await signalled
  assert.equal(f.leases().length, 1)
  f.setGate({...allowed(), phase:'frozen'})
  await denied(f.run('saveManagedSchool'))
  assert.equal(f.leases().length, 1)
  finish()
  await op
  assert.deepEqual(f.leases(), [])
})

test('institutional index-unsafe endpoints quarantine immediately, even if gate open', async () => {
  for (const operation of QUARANTINED_OPERATIONS) {
    const f = fixture()
    let entered = false
    await denied(f.run(operation, async () => { entered = true }))
    assert.equal(entered, false)
    assert.equal(f.transactionCount, 0)
    assert.deepEqual(f.leases(), [])
  }
})

test('individual and platform account lifecycle remains unaffected by institutional gate', async () => {
  for (const id of ['__individual__','__platform__']) {
    const f = fixture(null)
    let entered = false
    const result = await f.run('restoreManagedUser', async () => { entered = true; return 'ok' }, id)
    assert.equal(result, 'ok')
    assert.ok(entered)
    assert.equal(f.transactionCount, 0)
  }
})

test('invalid actor, school and operation fail without invoking the work', async () => {
  const f = fixture()
  await assert.rejects(f.run('unknownOperation'), /Invalid G1 authority lease contract/)
  await assert.rejects(f.run('restoreManagedUser', async () => {}, '../escape'),
    /Invalid G1 authority lease contract/)
})

test('three legacy endpoints remain retired and V2 keeps gate in transaction', () => {
  const source = fs.readFileSync(path.join(__dirname, '../functions/index.js'), 'utf8')
  const writer = fs.readFileSync(path.join(__dirname, '../functions/lib/p0bManagedClassSecureWriter.js'), 'utf8')
  for (const name of ['saveManagedClass','setManagedClassArchived','deleteManagedClass']) {
    assert.match(source, new RegExp(`exports\\.${name} = retiredManagedClassEndpoint\\(\\)`))
    assert.match(source, new RegExp(`exports\\.${name}V2 = onCall\\(`))
  }
  assert.match(writer, /const gateSnap = await tx\.get\(gateRef\)/)
})

test('package does not contain any live deployment, IAM, gate or backfill apply operation', () => {
  const helper = fs.readFileSync(path.join(__dirname, '../functions/lib/p0bG1AuthorityLease.js'), 'utf8')
  assert.doesNotMatch(helper, /firebase deploy|vercel --prod|gcloud run services update|backfill\s+--apply/)
})
