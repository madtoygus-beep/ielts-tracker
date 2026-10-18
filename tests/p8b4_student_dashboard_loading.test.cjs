'use strict'

// P8-B4 focused behavioral regression against the actual StudentDashboard.jsx
// assignment loader. No Firebase network use, writes, or AI provider calls.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const sourceFile = path.join(process.cwd(), 'src/pages/StudentDashboard.jsx')
const source = fs.readFileSync(sourceFile, 'utf8')
const startPattern = /Promise\.allSettled\(\s*matchingAccess\.map\(async access => \{/g
const starts = [...source.matchAll(startPattern)]
assert.equal(starts.length, 1, 'Expected exactly one P8-B4 assignment Promise.allSettled loader')

const start = starts[0].index
const end = source.indexOf('.catch(error => {', start)
assert.ok(end > start, 'Expected assignment loading .catch guard')
const expression = source.slice(start, end).trim()
assert.match(expression, /\.then\(results => \{/)
assert.match(expression, /entry\.loadVersion !== loadVersion/)
assert.match(expression, /emitStudentDataError\(/)
assert.match(expression, /entry\.subscribers\.forEach\(/)

function access(id) {
  return {
    id: `assignment_${id}`,
    contentId: id,
    status: 'active',
    assignedAt: 42,
    dueAt: null,
    reviewPolicy: 'immediate',
    reviewReleaseAt: null
  }
}

function makeHarness({ accessIds, docs, initialItems = null, version = 5 }) {
  const emitted = []
  const published = []
  const warnings = []
  const requests = []
  const entry = {
    lastItems: initialItems,
    loadVersion: version,
    subscribers: new Set([items => published.push(items)])
  }

  const ctx = {
    Promise,
    Error,
    entry,
    loadVersion: version,
    matchingAccess: accessIds.map(access),
    registryKey: 'access-content:test:writing',
    config: { contentCollection: 'writingHomeworks', contentType: 'writing' },
    db: {},
    doc: (_db, collection, id) => ({ collection, id }),
    getDoc: async ref => {
      requests.push(ref)
      const response = docs[ref.id]
      if (response instanceof Error) throw response
      if (typeof response === 'function') return await response()
      if (response === undefined || response === null) {
        return { id: ref.id, exists: () => false }
      }
      return { id: ref.id, exists: () => true, data: () => response }
    },
    console: { warn: (...args) => warnings.push(args) },
    emitStudentDataError: (key, error) => emitted.push({ key, error })
  }

  async function run() {
    await vm.runInNewContext(`(async () => { await ${expression}; })()`, ctx, {
      filename: 'StudentDashboard.assignment-loader.js',
      timeout: 3000
    })
    return { entry, emitted, published, warnings, requests }
  }
  return { run, entry, emitted, published, warnings, requests }
}

test('B4: a denied content document does not hide successful assignments', async () => {
  const h = makeHarness({
    accessIds: ['ok1', 'denied', 'ok2'],
    docs: {
      ok1: { title: 'Writing task 1' },
      denied: new Error('permission-denied'),
      ok2: { title: 'Writing task 2' }
    },
    initialItems: [{ id: 'old' }]
  })
  const { entry, emitted, published, warnings, requests } = await h.run()
  assert.deepEqual(Array.from(entry.lastItems, item => item.id), ['ok1', 'ok2'])
  assert.deepEqual(Array.from(published[0], item => item.id), ['ok1', 'ok2'])
  assert.equal(entry.lastItems[0].studentAccess.id, 'assignment_ok1')
  assert.equal(requests.length, 3)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /writingHomeworks\/denied/)
  assert.equal(emitted.length, 1)
  assert.match(emitted[0].error.message, /1 of 3 writing assignment/)
})

test('B4: all successful contents preserve original assignment order and clear error', async () => {
  const h = makeHarness({
    accessIds: ['first', 'second'],
    docs: { first: { title: 'First' }, second: { title: 'Second' } }
  })
  const { entry, emitted, published, warnings } = await h.run()
  assert.deepEqual(Array.from(entry.lastItems, item => item.id), ['first', 'second'])
  assert.deepEqual(Array.from(published[0], item => item.id), ['first', 'second'])
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].error, null)
  assert.equal(warnings.length, 0)
})

test('B4: missing content stays excluded without hiding valid assigned content', async () => {
  const h = makeHarness({
    accessIds: ['present', 'removed'],
    docs: { present: { title: 'Present' }, removed: null }
  })
  const { entry, emitted, warnings } = await h.run()
  assert.deepEqual(Array.from(entry.lastItems, item => item.id), ['present'])
  assert.equal(emitted[0].error, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /missing writingHomeworks\/removed/)
})

test('B4: total getDoc failure publishes empty current list with an error, not stale content', async () => {
  const h = makeHarness({
    accessIds: ['denied1', 'denied2'],
    docs: { denied1: new Error('error 1'), denied2: new Error('error 2') },
    initialItems: [{ id: 'stale' }]
  })
  const { entry, emitted, published, warnings } = await h.run()
  assert.deepEqual(Array.from(entry.lastItems), [])
  assert.deepEqual(Array.from(published[0]), [])
  assert.equal(warnings.length, 2)
  assert.match(emitted[0].error.message, /2 of 2 writing assignment/)
})

test('B4: stale completed request cannot overwrite a newer load', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const h = makeHarness({
    accessIds: ['delayed'],
    docs: { delayed: async () => {
      await pending
      return { id: 'delayed', exists: () => true, data: () => ({ title: 'Old' }) }
    } },
    initialItems: [{ id: 'newer' }]
  })
  const running = h.run()
  h.entry.loadVersion = 6
  release()
  await running
  assert.deepEqual(h.entry.lastItems, [{ id: 'newer' }])
  assert.equal(h.published.length, 0)
  assert.equal(h.emitted.length, 0)
})
